import {
  Room,
  RoomEvent,
  Track,
  TrackEvent,
  type Participant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type LocalTrackPublication,
  type LocalTrack,
  type RoomOptions,
} from 'livekit-client';
import type {
  VoiceClient,
  VoiceConnection,
  VoiceParticipant,
  VoiceSnapshot,
  VoiceScreen,
} from './types';

type RoomFactory = (options: RoomOptions) => Room;

function toParticipant(participant: Participant, isLocal: boolean): VoiceParticipant {
  const microphone = participant.getTrackPublication(Track.Source.Microphone);

  return {
    identity: participant.identity,
    displayName: participant.name || participant.identity,
    isLocal,
    isMuted: !microphone || microphone.isMuted,
    isSpeaking: participant.isSpeaking,
  };
}

export class LiveKitVoiceClient implements VoiceClient {
  private readonly room: Room;
  private readonly listeners = new Set<(snapshot: VoiceSnapshot) => void>();
  private readonly attachedTracks = new Map<Track, HTMLMediaElement[]>();
  private readonly screens = new Map<Track, VoiceScreen>();
  private readonly cameras = new Map<Track, VoiceScreen>();
  private cameraTrack: LocalTrack | null = null;
  private cameraPending = false;
  private cameraIntent = false;
  private cameraOperation = 0;
  private incomingMuted = false;
  private screenSharePending = false;
  private connection: VoiceConnection = 'disconnected';
  private audioRoot: HTMLDivElement | null = null;
  private eventsRegistered = false;
  private disposed = false;

  constructor(createRoom: RoomFactory = (options) => new Room(options)) {
    this.room = createRoom({
      adaptiveStream: true,
      // Keep publishing and subscribing separate: Firefox can reject the
      // single-PC media layout during microphone/subscription renegotiation.
      singlePeerConnection: false,
    });
  }

  subscribe(listener: (snapshot: VoiceSnapshot) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async connect(url: string, token: string) {
    if (this.disposed) return;
    this.registerEvents();
    await this.room.connect(url, token);
    if (this.disposed) {
      await this.room.disconnect(true);
      return;
    }
    this.connection = 'connected';
    this.attachExistingMedia();
    this.emitSnapshot();
  }

  async enableMicrophone() {
    if (this.disposed) return;
    await this.room.localParticipant.setMicrophoneEnabled(true);
    if (this.disposed) {
      await this.stopLateMicrophone();
      return;
    }
    this.emitSnapshot();
  }

  async setMuted(muted: boolean) {
    if (this.disposed) return;
    await this.room.localParticipant.setMicrophoneEnabled(!muted);
    if (this.disposed) {
      await this.stopLateMicrophone();
      return;
    }
    this.emitSnapshot();
  }

  private async stopLateMicrophone() {
    await this.room.localParticipant.setMicrophoneEnabled(false);
    const track = this.room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    if (track) {
      // SDK microphone mute can leave capture running; disposal must stop it.
      track.stop();
      await this.room.localParticipant.unpublishTrack(track);
    }
  }

  async setIncomingMuted(muted: boolean) {
    this.incomingMuted = muted;
    this.applyIncomingMute();
    this.emitSnapshot();
  }

  private applyIncomingMute() {
    for (const [track, elements] of this.attachedTracks) {
      if (track.kind === Track.Kind.Audio) {
        // LiveKit startAudio() unmutes elements; disabling receiver audio also
        // preserves silence on browsers that ignore element volume (iOS).
        track.mediaStreamTrack.enabled = !this.incomingMuted && !track.isMuted;
        for (const element of elements) {
          element.muted = this.incomingMuted;
          element.volume = this.incomingMuted ? 0 : 1;
        }
      }
    }
  }

  async setScreenSharing(sharing: boolean) {
    if (sharing && !this.screenShareSupported()) {
      throw new Error(
        'Screen sharing is not supported in this browser. Use a supported browser over HTTPS or localhost.',
      );
    }
    if (this.screenSharePending || this.connection !== 'connected') {
      return;
    }
    this.screenSharePending = true;
    try {
      await this.room.localParticipant.setScreenShareEnabled(sharing, { audio: true });
      // The chooser can resolve after Leave or a transport disconnect.
      if (this.snapshot().connection === 'disconnected') {
        await this.room.localParticipant.setScreenShareEnabled(false, { audio: true });
      }
      if (sharing && ![...this.screens].some(([track, screen]) =>
        screen.isLocal && track.mediaStreamTrack.readyState === 'live',
      )) {
        // Video can end before the concurrent screen-audio publication resolves.
        await this.stopScreenAudio();
      }
      this.emitSnapshot();
    } catch (error) {
      if (sharing) {
        try {
          // Video may already be published when the optional audio publish fails.
          await this.room.localParticipant.setScreenShareEnabled(false, { audio: true });
        } catch (cleanupError) {
          console.warn('Could not unpublish failed screen capture', cleanupError);
        }
        await this.stopScreenAudio().catch((cleanupError: unknown) => {
          console.warn('Could not unpublish failed screen audio', cleanupError);
        });
      }
      throw error;
    } finally {
      this.screenSharePending = false;
    }
  }

  private screenShareSupported() {
    return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  }

  private cameraSupported() {
    return typeof navigator.mediaDevices?.getUserMedia === 'function';
  }

  async setCameraEnabled(enabled: boolean) {
    if (!enabled) {
      this.cameraIntent = false;
      ++this.cameraOperation;
      this.cameraPending = false;
      const track = this.cameraTrack ?? this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
      if (track) {
        track.stop();
        this.detachTrack(track);
        this.emitSnapshot();
        await this.room.localParticipant.unpublishTrack(track, true);
        if (this.cameraTrack === track) this.cameraTrack = null;
      }
      this.emitSnapshot();
      return;
    }
    if (this.disposed || this.connection !== 'connected' || this.cameraPending || this.cameraIntent) return;
    if (!this.cameraSupported()) {
      throw new Error('Camera capture is not supported in this browser. Use HTTPS or localhost.');
    }
    const operation = ++this.cameraOperation;
    this.cameraIntent = true;
    this.cameraPending = true;
    let track: LocalTrack | undefined;
    try {
      // Capture separately so a retired permission request can never publish.
      [track] = await this.room.localParticipant.createTracks({ audio: false, video: true });
      if (!track) throw new Error('Camera capture did not return a video track.');
      if (this.disposed || this.connection !== 'connected' || operation !== this.cameraOperation) {
        track.stop();
        if (operation === this.cameraOperation) this.cameraIntent = false;
        return;
      }
      track.source = Track.Source.Camera;
      const cameraTrack = track;
      // Keep this guard after retirement: SDK reconnect can start a queued
      // restart after stop(), resetting its own manually-stopped flag.
      cameraTrack.on(TrackEvent.Restarted, () => {
        if (this.disposed || operation !== this.cameraOperation) cameraTrack.stop();
      });
      this.cameraTrack = track;
      await this.room.localParticipant.publishTrack(track, { source: Track.Source.Camera });
      if (this.disposed || operation !== this.cameraOperation) {
        track.stop();
        this.detachTrack(track);
        await this.room.localParticipant.unpublishTrack(track, true);
        return;
      }
      this.attachTrack(track, Track.Source.Camera, this.room.localParticipant, true);
      this.emitSnapshot();
    } catch (error) {
      if (operation === this.cameraOperation) this.cameraIntent = false;
      if (track) {
        track.stop();
        this.detachTrack(track);
        await this.room.localParticipant.unpublishTrack(track, true);
      }
      throw error;
    } finally {
      if (operation === this.cameraOperation) this.cameraPending = false;
      if (track && this.cameraTrack === track && !this.cameraIntent) this.cameraTrack = null;
    }
  }

  private async stopScreenAudio() {
    const audio = this.room.localParticipant
      .getTrackPublication(Track.Source.ScreenShareAudio)?.track;
    if (audio) {
      audio.stop();
      await this.room.localParticipant.unpublishTrack(audio);
    }
  }

  async enableAudio() {
    try {
      await this.room.startAudio();
    } finally {
      this.applyIncomingMute();
      this.emitSnapshot();
    }
  }

  async disconnect() {
    this.disposed = true;
    this.cameraIntent = false;
    ++this.cameraOperation;
    this.cameraTrack?.stop();
    this.detachAllMedia();
    this.unregisterEvents();
    this.connection = 'disconnected';
    this.listeners.clear();
    await this.room.disconnect(true);
  }

  private readonly handleParticipantChange = () => {
    this.applyIncomingMute();
    this.emitSnapshot();
  };

  private readonly handleTrackSubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: Participant,
  ) => {
    this.attachTrack(track, publication.source, participant);
    this.emitSnapshot();
  };

  private readonly handleTrackUnsubscribed = (track: RemoteTrack) => {
    this.detachTrack(track);
    this.emitSnapshot();
  };

  private readonly handleLocalTrackPublished = (publication: LocalTrackPublication) => {
    if (
      publication.track &&
      (publication.source === Track.Source.ScreenShare ||
        (publication.source === Track.Source.Camera && this.cameraIntent)) &&
      !this.disposed &&
      this.connection !== 'disconnected'
    ) {
      this.attachTrack(publication.track, publication.source, this.room.localParticipant, true);
    }
    this.emitSnapshot();
  };

  private readonly handleLocalTrackUnpublished = (publication: LocalTrackPublication) => {
    const screenCaptureState = publication.source === Track.Source.ScreenShare
      ? publication.track?.mediaStreamTrack.readyState
      : undefined;
    if (screenCaptureState === 'live' || (publication.source === Track.Source.Camera &&
      this.cameraIntent && !this.disposed && publication.track?.mediaStreamTrack.readyState === 'live')) {
      // Full reconnect unpublishes with stopOnUnpublish=false, then republishes
      // the same capture. Keep its preview and do not stop the companion audio.
      this.emitSnapshot();
      return;
    }
    if (publication.track) {
      this.detachTrack(publication.track);
    }
    if (screenCaptureState === 'ended' && !this.screenSharePending) {
      // Browser Stop can end video without ending a separately captured audio track.
      void this.stopScreenAudio().catch((error: unknown) => {
        console.warn('Could not unpublish stopped screen audio', error);
      });
    }
    this.emitSnapshot();
  };

  private readonly handleReconnecting = () => {
    this.connection = 'reconnecting';
    this.emitSnapshot();
  };

  private readonly handleReconnected = () => {
    this.connection = 'connected';
    this.emitSnapshot();
  };

  private readonly handleDisconnected = () => {
    this.connection = 'disconnected';
    this.cameraIntent = false;
    ++this.cameraOperation;
    this.cameraTrack?.stop();
    this.detachAllMedia();
    this.emitSnapshot();
  };

  private readonly handleAudioPlaybackChange = () => {
    this.applyIncomingMute();
    this.emitSnapshot();
  };

  private registerEvents() {
    if (this.eventsRegistered) {
      return;
    }
    this.eventsRegistered = true;

    this.room.on(RoomEvent.ParticipantConnected, this.handleParticipantChange);
    this.room.on(RoomEvent.ParticipantDisconnected, this.handleParticipantChange);
    this.room.on(RoomEvent.ParticipantNameChanged, this.handleParticipantChange);
    this.room.on(RoomEvent.ActiveSpeakersChanged, this.handleParticipantChange);
    this.room.on(RoomEvent.TrackSubscribed, this.handleTrackSubscribed);
    this.room.on(RoomEvent.TrackUnsubscribed, this.handleTrackUnsubscribed);
    this.room.on(RoomEvent.TrackMuted, this.handleParticipantChange);
    this.room.on(RoomEvent.TrackUnmuted, this.handleParticipantChange);
    this.room.on(RoomEvent.LocalTrackPublished, this.handleLocalTrackPublished);
    this.room.on(RoomEvent.LocalTrackUnpublished, this.handleLocalTrackUnpublished);
    this.room.on(RoomEvent.Reconnecting, this.handleReconnecting);
    this.room.on(RoomEvent.Reconnected, this.handleReconnected);
    this.room.on(RoomEvent.Disconnected, this.handleDisconnected);
    this.room.on(
      RoomEvent.AudioPlaybackStatusChanged,
      this.handleAudioPlaybackChange,
    );
  }

  private unregisterEvents() {
    if (!this.eventsRegistered) {
      return;
    }
    this.eventsRegistered = false;

    this.room.off(RoomEvent.ParticipantConnected, this.handleParticipantChange);
    this.room.off(RoomEvent.ParticipantDisconnected, this.handleParticipantChange);
    this.room.off(RoomEvent.ParticipantNameChanged, this.handleParticipantChange);
    this.room.off(RoomEvent.ActiveSpeakersChanged, this.handleParticipantChange);
    this.room.off(RoomEvent.TrackSubscribed, this.handleTrackSubscribed);
    this.room.off(RoomEvent.TrackUnsubscribed, this.handleTrackUnsubscribed);
    this.room.off(RoomEvent.TrackMuted, this.handleParticipantChange);
    this.room.off(RoomEvent.TrackUnmuted, this.handleParticipantChange);
    this.room.off(RoomEvent.LocalTrackPublished, this.handleLocalTrackPublished);
    this.room.off(RoomEvent.LocalTrackUnpublished, this.handleLocalTrackUnpublished);
    this.room.off(RoomEvent.Reconnecting, this.handleReconnecting);
    this.room.off(RoomEvent.Reconnected, this.handleReconnected);
    this.room.off(RoomEvent.Disconnected, this.handleDisconnected);
    this.room.off(
      RoomEvent.AudioPlaybackStatusChanged,
      this.handleAudioPlaybackChange,
    );
  }

  private snapshot(): VoiceSnapshot {
    const localParticipant = toParticipant(this.room.localParticipant, true);
    const remoteParticipants = [...this.room.remoteParticipants.values()]
      .map((participant) => toParticipant(participant, false))
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
    const participants = [localParticipant, ...remoteParticipants];
    if (this.connection === 'disconnected') {
      for (const participant of participants) participant.isSpeaking = false;
    }

    return {
      connection: this.connection,
      participants,
      localMuted: localParticipant.isMuted,
      needsAudioPermission: !this.room.canPlaybackAudio,
      incomingMuted: this.incomingMuted,
      localSharing: [...this.screens.values()].some((screen) => screen.isLocal),
      screenShareSupported: this.screenShareSupported(),
      screens: [...this.screens.values()],
      localCamera: [...this.cameras.values()].some((camera) => camera.isLocal),
      cameraSupported: this.cameraSupported(),
      cameras: [...this.cameras.values()],
    };
  }

  private emitSnapshot() {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private attachExistingMedia() {
    for (const participant of this.room.remoteParticipants.values()) {
      for (const publication of participant.audioTrackPublications.values()) {
        if (publication.track) {
          this.attachTrack(publication.track, publication.source, participant);
        }
      }
      for (const publication of participant.videoTrackPublications.values()) {
        if (publication.track && (publication.source === Track.Source.ScreenShare || publication.source === Track.Source.Camera)) {
          this.attachTrack(publication.track, publication.source, participant);
        }
      }
    }
  }

  private attachTrack(
    track: Track,
    source: Track.Source,
    participant: Participant,
    isLocal = false,
  ) {
    if (
      this.attachedTracks.has(track) ||
      (track.kind !== Track.Kind.Audio && (track.kind !== Track.Kind.Video ||
        (source !== Track.Source.ScreenShare && source !== Track.Source.Camera)))
    ) {
      return;
    }

    if (track.kind === Track.Kind.Audio) {
      track.mediaStreamTrack.enabled = !this.incomingMuted && !track.isMuted;
    }
    const element = track.attach();
    element.autoplay = true;
    if (track.kind === Track.Kind.Audio) {
      element.muted = this.incomingMuted;
      element.setAttribute('data-slam-remote-audio', '');
      this.getAudioRoot().append(element);
    } else {
      const video = element as HTMLVideoElement;
      video.muted = true;
      video.playsInline = true;
      const media = source === Track.Source.Camera ? this.cameras : this.screens;
      media.set(track, {
        id: track.sid || `${participant.identity}-${source === Track.Source.Camera ? 'camera' : 'screen'}`,
        participantIdentity: participant.identity,
        displayName: participant.name || participant.identity,
        isLocal,
        element: video,
      });
    }
    this.attachedTracks.set(track, [element]);
    this.applyIncomingMute();
  }

  private detachTrack(track: Track) {
    if (!this.attachedTracks.has(track)) {
      return;
    }
    const elements = new Set([
      ...(this.attachedTracks.get(track) ?? []),
      ...track.detach(),
    ]);
    for (const element of elements) {
      element.remove();
    }
    this.attachedTracks.delete(track);
    this.screens.delete(track);
    this.cameras.delete(track);
    this.removeEmptyAudioRoot();
  }

  private detachAllMedia() {
    for (const track of [...this.attachedTracks.keys()]) {
      this.detachTrack(track);
    }
    this.audioRoot?.remove();
    this.audioRoot = null;
  }

  private getAudioRoot() {
    if (!this.audioRoot) {
      this.audioRoot = document.createElement('div');
      this.audioRoot.className = 'remote-audio-root';
      this.audioRoot.setAttribute('aria-hidden', 'true');
      document.body.append(this.audioRoot);
    }
    return this.audioRoot;
  }

  private removeEmptyAudioRoot() {
    if (this.audioRoot && this.audioRoot.childElementCount === 0) {
      this.audioRoot.remove();
      this.audioRoot = null;
    }
  }
}
