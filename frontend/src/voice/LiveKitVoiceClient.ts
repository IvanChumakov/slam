import {
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteTrack,
  type RoomOptions,
} from 'livekit-client';
import type {
  VoiceClient,
  VoiceConnection,
  VoiceParticipant,
  VoiceSnapshot,
} from './types';

type RoomFactory = (options: RoomOptions) => Room;

function toParticipant(participant: Participant, isLocal: boolean): VoiceParticipant {
  const microphone = participant.getTrackPublication(Track.Source.Microphone);

  return {
    identity: participant.identity,
    displayName: participant.name || participant.identity,
    isLocal,
    isMuted: !microphone || microphone.isMuted,
  };
}

export class LiveKitVoiceClient implements VoiceClient {
  private readonly room: Room;
  private readonly listeners = new Set<(snapshot: VoiceSnapshot) => void>();
  private readonly attachedTracks = new Map<RemoteTrack, HTMLMediaElement[]>();
  private connection: VoiceConnection = 'disconnected';
  private audioRoot: HTMLDivElement | null = null;
  private eventsRegistered = false;

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
    this.registerEvents();
    await this.room.connect(url, token);
    this.connection = 'connected';
    this.attachExistingAudio();
    this.emitSnapshot();
  }

  async enableMicrophone() {
    await this.room.localParticipant.setMicrophoneEnabled(true);
    this.emitSnapshot();
  }

  async setMuted(muted: boolean) {
    await this.room.localParticipant.setMicrophoneEnabled(!muted);
    this.emitSnapshot();
  }

  async enableAudio() {
    await this.room.startAudio();
    this.emitSnapshot();
  }

  async disconnect() {
    this.detachAllAudio();
    this.unregisterEvents();
    this.connection = 'disconnected';
    this.listeners.clear();
    await this.room.disconnect(true);
  }

  private readonly handleParticipantChange = () => {
    this.emitSnapshot();
  };

  private readonly handleTrackSubscribed = (track: RemoteTrack) => {
    this.attachTrack(track);
    this.emitSnapshot();
  };

  private readonly handleTrackUnsubscribed = (track: RemoteTrack) => {
    this.detachTrack(track);
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
    this.emitSnapshot();
  };

  private readonly handleAudioPlaybackChange = () => {
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
    this.room.on(RoomEvent.TrackSubscribed, this.handleTrackSubscribed);
    this.room.on(RoomEvent.TrackUnsubscribed, this.handleTrackUnsubscribed);
    this.room.on(RoomEvent.TrackMuted, this.handleParticipantChange);
    this.room.on(RoomEvent.TrackUnmuted, this.handleParticipantChange);
    this.room.on(RoomEvent.LocalTrackPublished, this.handleParticipantChange);
    this.room.on(RoomEvent.LocalTrackUnpublished, this.handleParticipantChange);
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
    this.room.off(RoomEvent.TrackSubscribed, this.handleTrackSubscribed);
    this.room.off(RoomEvent.TrackUnsubscribed, this.handleTrackUnsubscribed);
    this.room.off(RoomEvent.TrackMuted, this.handleParticipantChange);
    this.room.off(RoomEvent.TrackUnmuted, this.handleParticipantChange);
    this.room.off(RoomEvent.LocalTrackPublished, this.handleParticipantChange);
    this.room.off(RoomEvent.LocalTrackUnpublished, this.handleParticipantChange);
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

    return {
      connection: this.connection,
      participants: [localParticipant, ...remoteParticipants],
      localMuted: localParticipant.isMuted,
      needsAudioPermission: !this.room.canPlaybackAudio,
    };
  }

  private emitSnapshot() {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private attachExistingAudio() {
    for (const participant of this.room.remoteParticipants.values()) {
      for (const publication of participant.audioTrackPublications.values()) {
        if (publication.track) {
          this.attachTrack(publication.track as RemoteTrack);
        }
      }
    }
  }

  private attachTrack(track: RemoteTrack) {
    if (track.kind !== Track.Kind.Audio || this.attachedTracks.has(track)) {
      return;
    }

    const element = track.attach();
    element.autoplay = true;
    element.setAttribute('data-slam-remote-audio', '');
    this.getAudioRoot().append(element);
    this.attachedTracks.set(track, [element]);
  }

  private detachTrack(track: RemoteTrack) {
    const elements = new Set([
      ...(this.attachedTracks.get(track) ?? []),
      ...track.detach(),
    ]);
    for (const element of elements) {
      element.remove();
    }
    this.attachedTracks.delete(track);
    this.removeEmptyAudioRoot();
  }

  private detachAllAudio() {
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
