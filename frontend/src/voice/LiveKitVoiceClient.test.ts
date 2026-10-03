import {
  Room,
  ConnectionState,
  RoomEvent,
  Track,
  LocalVideoTrack,
  LocalAudioTrack,
  LocalTrackPublication,
  ParticipantEvent,
  type LocalTrack,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { VoiceApi } from '../api/voiceApi';
import { LiveKitVoiceClient } from './LiveKitVoiceClient';
import { useVoiceRoom } from './useVoiceRoom';
import type { VoiceSnapshot } from './types';

function participant(
  identity: string,
  name: string,
  muted: boolean,
): RemoteParticipant {
  return {
    identity,
    name,
    isSpeaking: false,
    audioTrackPublications: new Map(),
    videoTrackPublications: new Map(),
    getTrackPublication: vi.fn().mockReturnValue({ isMuted: muted }),
  } as unknown as RemoteParticipant;
}

function createRoom() {
  const room = new Room();
  const connect = vi.spyOn(room, 'connect').mockResolvedValue(undefined);
  const disconnect = vi.spyOn(room, 'disconnect').mockResolvedValue(undefined);
  const startAudio = vi.spyOn(room, 'startAudio').mockResolvedValue(undefined);
  const setMicrophoneEnabled = vi
    .spyOn(room.localParticipant, 'setMicrophoneEnabled')
    .mockResolvedValue(undefined);
  const setScreenShareEnabled = vi.spyOn(room.localParticipant, 'setScreenShareEnabled').mockResolvedValue(undefined);

  room.localParticipant.identity = 'ivan';
  room.localParticipant.name = 'Ivan';
  vi.spyOn(room.localParticipant, 'getTrackPublication').mockImplementation((source) => source === Track.Source.Microphone ? ({
    isMuted: false,
  } as LocalTrackPublication) : undefined);

  return { room, connect, disconnect, startAudio, setMicrophoneEnabled, setScreenShareEnabled };
}

afterEach(() => vi.unstubAllGlobals());

function mediaTrack(kind: Track.Kind, source: Track.Source) {
  const element = document.createElement(kind === Track.Kind.Audio ? 'audio' : 'video');
  const track = { kind, source, sid: `${source}-${Math.random()}`,
    mediaStreamTrack: { enabled: true, readyState: 'live' }, isMuted: false,
    attach: vi.fn().mockReturnValue(element), detach: vi.fn().mockReturnValue([element]),
  } as unknown as RemoteTrack;
  return { track, element };
}

function publishRemote(room: Room, track: RemoteTrack, source: Track.Source) {
  room.emit(RoomEvent.TrackSubscribed, track, { source } as RemoteTrackPublication,
    participant('max', 'Max', false));
}

function screenCaptureRoom() {
  class CaptureTrack extends EventTarget {
    readonly id: string;
    enabled = true;
    readyState: MediaStreamTrackState = 'live';
    constructor(readonly kind: 'audio' | 'video') {
      super();
      this.id = `capture-${kind}`;
    }
    getConstraints() { return {}; }
    getSettings() { return {}; }
    async applyConstraints() {}
    stop() { this.readyState = 'ended'; }
  }
  vi.stubGlobal('MediaStreamTrack', CaptureTrack);
  vi.stubGlobal('MediaStream', class {
    constructor(private readonly tracks: MediaStreamTrack[]) {}
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
  });
  const fake = createRoom();
  const local = fake.room.localParticipant;
  vi.mocked(local.getTrackPublication).mockRestore();
  fake.setScreenShareEnabled.mockRestore();
  local.on(ParticipantEvent.LocalTrackPublished, (publication) => {
    fake.room.emit(RoomEvent.LocalTrackPublished, publication, local);
  });
  local.on(ParticipantEvent.LocalTrackUnpublished, (publication) => {
    fake.room.emit(RoomEvent.LocalTrackUnpublished, publication, local);
  });
  const videoCapture = new CaptureTrack('video');
  const audioCapture = new CaptureTrack('audio');
  const video = new LocalVideoTrack(videoCapture as unknown as MediaStreamTrack, undefined, false);
  const audio = new LocalAudioTrack(audioCapture as unknown as MediaStreamTrack);
  video.source = Track.Source.ScreenShare;
  audio.source = Track.Source.ScreenShareAudio;
  const preview = document.createElement('video');
  vi.spyOn(video, 'attach').mockReturnValue(preview);
  const detachVideo = vi.spyOn(video, 'detach');
  const stopAudio = vi.spyOn(audio, 'stop');
  vi.spyOn(local, 'createScreenTracks').mockResolvedValue([video, audio]);
  let publicationId = 0;
  function register(track: LocalTrack) {
    const sid = `publication-${++publicationId}`;
    const publication = new LocalTrackPublication(track.kind,
      { sid, name: track.source } as ConstructorParameters<typeof LocalTrackPublication>[1], track);
    publication.source = track.source;
    track.sid = sid;
    local.trackPublications.set(sid, publication);
    if (track.kind === Track.Kind.Video) {
      local.videoTrackPublications.set(sid, publication);
    } else {
      local.audioTrackPublications.set(sid, publication);
    }
    local.emit(ParticipantEvent.LocalTrackPublished, publication);
    return publication;
  }
  // Mock only the network publish boundary; SDK setScreenShareEnabled,
  // unpublishTrack, publication clearing, and republishAllTracks stay real.
  const publisher = local as unknown as {
    publishOrRepublishTrack(track: LocalTrack): Promise<LocalTrackPublication>;
  };
  const publish = vi.spyOn(publisher, 'publishOrRepublishTrack')
    .mockImplementation(async (track) => register(track));
  return { ...fake, local, video, audio, videoCapture, audioCapture, preview,
    detachVideo, stopAudio, publish, register, CaptureTrack };
}

describe('LiveKitVoiceClient', () => {
  it('captures camera video only on explicit request and stops/unpublishes it without touching screens or microphone', async () => {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
    const fake = screenCaptureRoom();
    fake.video.source = Track.Source.Camera;
    const capture = vi.spyOn(fake.local, 'createTracks').mockResolvedValue([fake.video]);
    const stop = vi.spyOn(fake.video, 'stop');
    const unpublish = vi.spyOn(fake.local, 'unpublishTrack');
    const screen = mediaTrack(Track.Kind.Video, Track.Source.ScreenShare);
    const client = new LiveKitVoiceClient(() => fake.room);
    const listener = vi.fn(); client.subscribe(listener);
    await client.connect('wss://rtc.test', 'jwt');
    expect(capture).not.toHaveBeenCalled();
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ localCamera: false, cameras: [], cameraSupported: true }));
    publishRemote(fake.room, screen.track, Track.Source.ScreenShare);
    await client.setCameraEnabled(true);
    expect(capture).toHaveBeenCalledExactlyOnceWith({ audio: false, video: true });
    expect(fake.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(fake.setScreenShareEnabled).not.toHaveBeenCalled();
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ localCamera: true,
      cameras: [expect.objectContaining({ participantIdentity: 'ivan', isLocal: true, element: fake.preview })],
      screens: [expect.objectContaining({ participantIdentity: 'max', element: screen.element })] }));
    document.body.append(fake.preview);
    await client.setCameraEnabled(false);
    expect(stop).toHaveBeenCalled();
    expect(unpublish).toHaveBeenCalledWith(fake.video, true);
    expect(fake.local.getTrackPublication(Track.Source.Camera)).toBeUndefined();
    expect(fake.preview.isConnected).toBe(false);
    expect(screen.track.detach).not.toHaveBeenCalled();
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ localCamera: false, cameras: [], screens: [expect.anything()] }));
    fake.room.emit(RoomEvent.Reconnecting);
    await fake.local.republishAllTracks(undefined, false);
    fake.room.emit(RoomEvent.Reconnected);
    expect(capture).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ localCamera: false, cameras: [] }));
    await client.disconnect();
  });

  it.each(['disconnect', 'transport', 'off'] as const)('stops late camera capture before publishing after %s', async (retirement) => {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
    const fake = screenCaptureRoom(); fake.video.source = Track.Source.Camera;
    let resolveCapture!: (tracks: LocalTrack[]) => void;
    const capture = vi.spyOn(fake.local, 'createTracks').mockReturnValue(new Promise((resolve) => { resolveCapture = resolve; }));
    const client = new LiveKitVoiceClient(() => fake.room);
    await client.connect('wss://rtc.test', 'jwt');
    const pending = client.setCameraEnabled(true);
    await client.setCameraEnabled(true);
    expect(capture).toHaveBeenCalledOnce();
    if (retirement === 'disconnect') await client.disconnect();
    else if (retirement === 'transport') fake.room.emit(RoomEvent.Disconnected);
    else await client.setCameraEnabled(false);
    resolveCapture([fake.video]); await pending;
    expect(fake.publish).not.toHaveBeenCalled();
    expect(fake.videoCapture.readyState).toBe('ended');
    expect(fake.video.attach).not.toHaveBeenCalled();
    await client.disconnect();
  });

  it.each(['leave', 'switch', 'unmount', 'off'] as const)('never publishes late SDK camera capture after hook %s', async (retirement) => {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
    const old = screenCaptureRoom(); old.video.source = Track.Source.Camera;
    const next = createRoom();
    let resolveCapture!: (tracks: LocalTrack[]) => void;
    vi.spyOn(old.local, 'createTracks').mockReturnValue(new Promise((resolve) => { resolveCapture = resolve; }));
    const oldClient = new LiveKitVoiceClient(() => old.room);
    const nextClient = new LiveKitVoiceClient(() => next.room);
    const credentials = { livekit_url: 'wss://rtc.test', access_token: 'jwt', room: { id: 42, name: 'General' },
      participant: { identity: 'ivan', display_name: 'Ivan' } };
    const api: VoiceApi = {
      join: vi.fn().mockResolvedValueOnce(credentials).mockResolvedValue({ ...credentials, room: { id: 43, name: 'Lounge' } }),
      listRooms: vi.fn().mockResolvedValue({ current_room_id: 42, rooms: [
        { id: 42, name: 'General', online_count: 1 }, { id: 43, name: 'Lounge', online_count: 0 },
      ] }),
      createInvite: vi.fn().mockResolvedValue({ join_token: 'target', join_url: 'https://voice.test/join/target',
        room: { id: 43, name: 'Lounge' }, expires_in: 3600 }),
    };
    const createClient = vi.fn().mockReturnValueOnce(oldClient).mockReturnValueOnce(nextClient);
    const { result, unmount } = renderHook(() => useVoiceRoom({ token: 'signed', api, createClient }));
    await act(async () => result.current.join('Ivan'));
    let pending!: Promise<void>;
    act(() => { pending = result.current.setCameraEnabled(true); });
    if (retirement === 'leave') await act(async () => result.current.leave());
    else if (retirement === 'switch') await act(async () => result.current.switchRoom(43));
    else if (retirement === 'off') await act(async () => result.current.setCameraEnabled(false));
    else unmount();
    if (retirement === 'off') expect(old.disconnect).not.toHaveBeenCalled();
    else expect(old.disconnect).toHaveBeenCalledOnce();
    await act(async () => { resolveCapture([old.video]); await pending; });
    expect(old.publish).not.toHaveBeenCalled();
    expect(old.videoCapture.readyState).toBe('ended');
    expect(old.video.attach).not.toHaveBeenCalled();
    if (retirement === 'switch') {
      expect(next.connect).toHaveBeenCalledOnce();
      expect(result.current.state).toMatchObject({ phase: 'connected', localCamera: false, cameras: [], cameraPending: false });
    }
    unmount();
  });

  it('keeps camera previews through SDK republish without duplicate attachment', async () => {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
    const fake = screenCaptureRoom(); fake.video.source = Track.Source.Camera;
    vi.spyOn(fake.local, 'createTracks').mockResolvedValue([fake.video]);
    const client = new LiveKitVoiceClient(() => fake.room);
    const listener = vi.fn(); client.subscribe(listener);
    await client.connect('wss://rtc.test', 'jwt');
    await client.setCameraEnabled(true);
    fake.room.emit(RoomEvent.Reconnecting);
    await fake.local.republishAllTracks(undefined, false);
    fake.room.emit(RoomEvent.Reconnected);
    expect(fake.video.attach).toHaveBeenCalledOnce();
    expect(fake.detachVideo).not.toHaveBeenCalled();
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ localCamera: true, cameras: [expect.anything()] }));
    await client.setCameraEnabled(false);
    await client.disconnect();
  });

  it('restarts enabled camera capture through real SDK full reconnect and keeps camera Off on subsequent full reconnect', async () => {
    const fake = screenCaptureRoom(); fake.video.source = Track.Source.Camera;
    const restarted = new fake.CaptureTrack('video');
    const getUserMedia = vi.fn().mockResolvedValue(new MediaStream([restarted as unknown as MediaStreamTrack]));
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    vi.spyOn(fake.local, 'createTracks').mockResolvedValue([fake.video]);
    const restart = vi.spyOn(fake.video, 'restartTrack');
    const client = new LiveKitVoiceClient(() => fake.room);
    const listener = vi.fn(); client.subscribe(listener);
    await client.connect('wss://rtc.test', 'jwt');
    await client.setCameraEnabled(true);
    fake.room.emit(RoomEvent.Reconnecting);
    await fake.local.republishAllTracks(undefined, true);
    fake.room.emit(RoomEvent.Reconnected);
    expect(restart).toHaveBeenCalledOnce();
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: false, video: true });
    expect(fake.video.mediaStreamTrack).toBe(restarted);
    expect(restarted.readyState).toBe('live');
    expect(fake.video.attach).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ localCamera: true, cameras: [expect.anything()] }));
    await client.setCameraEnabled(false);
    await fake.local.republishAllTracks(undefined, true);
    expect(restart).toHaveBeenCalledOnce();
    expect(restarted.readyState).toBe('ended');
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ localCamera: false, cameras: [] }));
    await client.disconnect();
  });

  it.each(['off', 'disconnect', 'early-off'] as const)('stops delayed full-reconnect camera acquisition before SDK republishing after %s', async (retirement) => {
    const fake = screenCaptureRoom(); fake.video.source = Track.Source.Camera;
    const restarted = new fake.CaptureTrack('video');
    let resolveRestart!: (stream: MediaStream) => void;
    let captureStarted!: () => void;
    const started = new Promise<void>((resolve) => { captureStarted = resolve; });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockImplementation(() => {
      captureStarted();
      return new Promise<MediaStream>((resolve) => { resolveRestart = resolve; });
    }) } });
    vi.spyOn(fake.local, 'createTracks').mockResolvedValue([fake.video]);
    const client = new LiveKitVoiceClient(() => fake.room);
    const listener = vi.fn(); client.subscribe(listener);
    await client.connect('wss://rtc.test', 'jwt');
    await client.setCameraEnabled(true);
    fake.publish.mockImplementation(async (track) => {
      // SDK may republish an ended track, but no live retired capture may reach the network boundary.
      expect(track.mediaStreamTrack.readyState).toBe('ended');
      return fake.register(track);
    });
    fake.room.emit(RoomEvent.Reconnecting);
    const reconnect = fake.local.republishAllTracks(undefined, true);
    if (retirement === 'early-off') await client.setCameraEnabled(false);
    await started;
    if (retirement === 'off') await client.setCameraEnabled(false);
    else if (retirement === 'disconnect') await client.disconnect();
    resolveRestart(new MediaStream([restarted as unknown as MediaStreamTrack]));
    await reconnect;
    expect(restarted.readyState).toBe('ended');
    expect(fake.video.attach).toHaveBeenCalledOnce();
    if (retirement !== 'disconnect') {
      expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ localCamera: false, cameras: [] }));
      await client.setCameraEnabled(false);
    }
    await client.disconnect();
  });

  it('allows a fresh explicit request after reconnect interrupts unpublished capture', async () => {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
    const fake = screenCaptureRoom(); fake.video.source = Track.Source.Camera;
    let resolveCapture!: (tracks: LocalTrack[]) => void;
    const capture = vi.spyOn(fake.local, 'createTracks').mockReturnValueOnce(new Promise((resolve) => { resolveCapture = resolve; }));
    const client = new LiveKitVoiceClient(() => fake.room);
    await client.connect('wss://rtc.test', 'jwt');
    const pending = client.setCameraEnabled(true);
    fake.room.emit(RoomEvent.Reconnecting);
    resolveCapture([fake.video]); await pending;
    expect(fake.publish).not.toHaveBeenCalled();
    expect(fake.videoCapture.readyState).toBe('ended');
    fake.room.emit(RoomEvent.Reconnected);
    capture.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
    await expect(client.setCameraEnabled(true)).rejects.toThrow('Denied');
    expect(capture).toHaveBeenCalledTimes(2);
    await client.disconnect();
  });

  it('attaches existing remote cameras separately and removes their tiles on unsubscribe', async () => {
    const fake = createRoom(); const max = participant('max', 'Max', false);
    const camera = mediaTrack(Track.Kind.Video, Track.Source.Camera);
    const screen = mediaTrack(Track.Kind.Video, Track.Source.ScreenShare);
    max.videoTrackPublications.set('camera', { source: Track.Source.Camera, track: camera.track } as RemoteTrackPublication);
    max.videoTrackPublications.set('screen', { source: Track.Source.ScreenShare, track: screen.track } as RemoteTrackPublication);
    fake.room.remoteParticipants.set(max.identity, max);
    const client = new LiveKitVoiceClient(() => fake.room);
    const listener = vi.fn(); client.subscribe(listener);
    await client.connect('wss://rtc.test', 'jwt');
    expect(camera.element).toMatchObject({ autoplay: true, muted: true, playsInline: true });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ localCamera: false,
      cameras: [expect.objectContaining({ participantIdentity: 'max', isLocal: false, element: camera.element })],
      screens: [expect.objectContaining({ participantIdentity: 'max', element: screen.element })] }));
    document.body.append(camera.element);
    fake.room.emit(RoomEvent.TrackUnsubscribed, camera.track, {} as RemoteTrackPublication, max);
    expect(camera.element.isConnected).toBe(false);
    expect(camera.track.detach).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ cameras: [], screens: [expect.anything()] }));
    await client.disconnect();
  });

  it('real SDK disconnect stops camera capture and removes its publication and preview', async () => {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
    const fake = screenCaptureRoom(); fake.video.source = Track.Source.Camera;
    vi.spyOn(fake.local, 'createTracks').mockResolvedValue([fake.video]);
    const client = new LiveKitVoiceClient(() => fake.room);
    await client.connect('wss://rtc.test', 'jwt');
    await client.setCameraEnabled(true);
    document.body.append(fake.preview);
    fake.disconnect.mockRestore(); fake.room.state = ConnectionState.Connected;
    await client.disconnect();
    expect(fake.videoCapture.readyState).toBe('ended');
    expect(fake.local.getTrackPublication(Track.Source.Camera)).toBeUndefined();
    expect(fake.preview.isConnected).toBe(false);
  });

  it('publishes local camera alongside local screen video/audio and camera Off preserves both screen captures', async () => {
    const fake = screenCaptureRoom(); const screen = screenCaptureRoom();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
    fake.video.source = Track.Source.Camera;
    vi.spyOn(fake.local, 'createTracks').mockResolvedValue([fake.video]);
    const client = new LiveKitVoiceClient(() => fake.room);
    const listener = vi.fn(); client.subscribe(listener);
    await client.connect('wss://rtc.test', 'jwt');
    await fake.local.publishTrack(screen.video);
    await fake.local.publishTrack(screen.audio);
    await client.setCameraEnabled(true);
    expect(fake.local.videoTrackPublications.size).toBe(2);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ localCamera: true, localSharing: true,
      cameras: [expect.objectContaining({ element: fake.preview })], screens: [expect.objectContaining({ element: screen.preview })] }));
    await client.setCameraEnabled(false);
    expect(screen.videoCapture.readyState).toBe('live');
    expect(screen.audioCapture.readyState).toBe('live');
    expect(fake.local.getTrackPublication(Track.Source.ScreenShare)?.track).toBe(screen.video);
    expect(fake.local.getTrackPublication(Track.Source.ScreenShareAudio)?.track).toBe(screen.audio);
    expect(screen.detachVideo).not.toHaveBeenCalled();
    expect(fake.setMicrophoneEnabled).not.toHaveBeenCalled();
    await fake.local.unpublishTrack(screen.video, true);
    await fake.local.unpublishTrack(screen.audio, true);
    await client.disconnect();
  });

  it('stops failed publication and permits a fresh camera attempt without affecting microphone', async () => {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
    const fake = screenCaptureRoom(); fake.video.source = Track.Source.Camera;
    vi.spyOn(fake.local, 'createTracks').mockResolvedValue([fake.video]);
    fake.publish.mockRejectedValueOnce(new Error('Publish failed'));
    const client = new LiveKitVoiceClient(() => fake.room);
    await client.connect('wss://rtc.test', 'jwt');
    await expect(client.setCameraEnabled(true)).rejects.toThrow('Publish failed');
    expect(fake.videoCapture.readyState).toBe('ended');
    expect(fake.video.attach).not.toHaveBeenCalled();
    expect(fake.setMicrophoneEnabled).not.toHaveBeenCalled();
    const capture = vi.mocked(fake.local.createTracks);
    capture.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
    await expect(client.setCameraEnabled(true)).rejects.toThrow('Denied');
    expect(capture).toHaveBeenCalledTimes(2);
    await client.disconnect();
  });

  it('rejects unsupported and denied camera capture without changing microphone or connection', async () => {
    const fake = createRoom();
    const capture = vi.spyOn(fake.room.localParticipant, 'createTracks').mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    const client = new LiveKitVoiceClient(() => fake.room);
    const listener = vi.fn(); client.subscribe(listener);
    await client.connect('wss://rtc.test', 'jwt');
    vi.stubGlobal('navigator', { mediaDevices: {} });
    await expect(client.setCameraEnabled(true)).rejects.toThrow('not supported');
    expect(capture).not.toHaveBeenCalled();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
    await expect(client.setCameraEnabled(true)).rejects.toThrow('Denied');
    await expect(client.setCameraEnabled(true)).rejects.toThrow('Denied');
    expect(capture).toHaveBeenCalledTimes(2);
    expect(fake.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ connection: 'connected', localCamera: false }));
    await client.disconnect();
  });

  it('emits genuine speaking start/stop and clears disconnected speakers and event listeners', async () => {
    const fake = createRoom(); const max = participant('max', 'Max', false);
    fake.room.remoteParticipants.set(max.identity, max);
    const client = new LiveKitVoiceClient(() => fake.room);
    const listener = vi.fn(); client.subscribe(listener);
    await client.connect('wss://rtc.test', 'jwt');
    expect(listener.mock.lastCall?.[0].participants.every((p: VoiceSnapshot['participants'][number]) => !p.isSpeaking)).toBe(true);
    max.isSpeaking = true; fake.room.localParticipant.isSpeaking = true;
    fake.room.emit(RoomEvent.ActiveSpeakersChanged, [max, fake.room.localParticipant]);
    expect(listener.mock.lastCall?.[0].participants.every((p: VoiceSnapshot['participants'][number]) => p.isSpeaking)).toBe(true);
    max.isSpeaking = false; fake.room.localParticipant.isSpeaking = false;
    fake.room.emit(RoomEvent.ActiveSpeakersChanged, []);
    expect(listener.mock.lastCall?.[0].participants.every((p: VoiceSnapshot['participants'][number]) => !p.isSpeaking)).toBe(true);
    fake.room.remoteParticipants.delete(max.identity);
    fake.room.emit(RoomEvent.ParticipantDisconnected, max);
    expect(listener.mock.lastCall?.[0].participants.map((p: VoiceSnapshot['participants'][number]) => p.identity)).toEqual(['ivan']);
    fake.room.remoteParticipants.set(max.identity, max);
    max.isSpeaking = true; fake.room.emit(RoomEvent.Disconnected);
    expect(listener.mock.lastCall?.[0].participants.every((p: VoiceSnapshot['participants'][number]) => !p.isSpeaking)).toBe(true);
    await client.disconnect();
    expect(fake.room.listenerCount(RoomEvent.ActiveSpeakersChanged)).toBe(0);
    const count = listener.mock.calls.length;
    fake.room.emit(RoomEvent.ActiveSpeakersChanged, [max]);
    expect(listener).toHaveBeenCalledTimes(count);
  });
  it('unpublishes and stops a real SDK microphone capture that arrives after disconnect, not merely muting it', async () => {
    const fake = screenCaptureRoom();
    fake.setMicrophoneEnabled.mockRestore();
    fake.audio.source = Track.Source.Microphone;
    let resolveCapture!: (tracks: LocalTrack[]) => void;
    vi.spyOn(fake.local, 'createTracks').mockReturnValue(new Promise((resolve) => { resolveCapture = resolve; }));
    const client = new LiveKitVoiceClient(() => fake.room);
    await client.connect('wss://rtc.test', 'jwt');
    const pending = client.enableMicrophone();
    await client.disconnect();
    resolveCapture([fake.audio]); await pending;
    expect(fake.audioCapture.readyState).toBe('ended');
    expect(fake.local.getTrackPublication(Track.Source.Microphone)).toBeUndefined();
  });
  it('leaves the microphone unpublished on connect and uses real SDK capture only on explicit unmute', async () => {
    const fake = screenCaptureRoom();
    fake.setMicrophoneEnabled.mockRestore();
    fake.audio.source = Track.Source.Microphone;
    const capture = vi.spyOn(fake.local, 'createTracks').mockResolvedValue([fake.audio]);
    const client = new LiveKitVoiceClient(() => fake.room);
    await client.setIncomingMuted(true);
    await client.connect('wss://rtc.test', 'jwt');
    expect(capture).not.toHaveBeenCalled();
    expect(fake.publish).not.toHaveBeenCalled();
    expect(fake.local.getTrackPublication(Track.Source.Microphone)).toBeUndefined();
    await client.setMuted(false);
    expect(capture).toHaveBeenCalledOnce();
    expect(fake.local.getTrackPublication(Track.Source.Microphone)?.track).toBe(fake.audio);
    await client.disconnect();
    fake.audio.stop();
  });

  it('real SDK disconnect stops both local screen captures and clears publications before returning', async () => {
    const fake = screenCaptureRoom();
    const client = new LiveKitVoiceClient(() => fake.room);
    await client.connect('wss://rtc.test', 'jwt');
    await fake.local.publishTrack(fake.video);
    await fake.local.publishTrack(fake.audio);
    fake.disconnect.mockRestore();
    // Only connect/publish are network mocks; execute the real SDK teardown.
    fake.room.state = ConnectionState.Connected;
    await client.disconnect();
    expect(fake.videoCapture.readyState).toBe('ended');
    expect(fake.audioCapture.readyState).toBe('ended');
    expect(fake.local.trackPublications.size).toBe(0);
    expect(fake.preview.isConnected).toBe(false);
  });

  it('silences tracks arriving during connect before attaching them', async () => {
    const fake = createRoom();
    const audio = mediaTrack(Track.Kind.Audio, Track.Source.Microphone);
    vi.mocked(audio.track.attach).mockImplementation(() => {
      expect(audio.track.mediaStreamTrack.enabled).toBe(false);
      return audio.element;
    });
    fake.connect.mockImplementation(async () => publishRemote(fake.room, audio.track, Track.Source.Microphone));
    const client = new LiveKitVoiceClient(() => fake.room);
    await client.setIncomingMuted(true);
    await client.connect('wss://rtc.test', 'jwt');
    expect(audio.element.muted).toBe(true);
    await client.disconnect();
  });
  it('does not attach media or revive the connection when connect resolves after disconnect', async () => {
    const fake = createRoom();
    let resolveConnect!: () => void;
    fake.connect.mockReturnValue(new Promise((resolve) => { resolveConnect = resolve; }));
    const max = participant('max', 'Max', false);
    const audio = mediaTrack(Track.Kind.Audio, Track.Source.Microphone);
    max.audioTrackPublications.set('audio', { source: Track.Source.Microphone, track: audio.track } as RemoteTrackPublication);
    fake.room.remoteParticipants.set('max', max);
    const client = new LiveKitVoiceClient(() => fake.room);
    const listener = vi.fn(); client.subscribe(listener);
    const pending = client.connect('wss://rtc.test', 'jwt');
    await client.disconnect();
    resolveConnect(); await pending;
    expect(audio.track.attach).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(fake.disconnect).toHaveBeenLastCalledWith(true);
  });

  it('stops a microphone capture that completes after disconnect', async () => {
    const fake = createRoom();
    let resolveMicrophone!: () => void;
    fake.setMicrophoneEnabled.mockImplementationOnce(() => new Promise((resolve) => { resolveMicrophone = () => resolve(undefined); }));
    const client = new LiveKitVoiceClient(() => fake.room);
    await client.connect('wss://rtc.test', 'jwt');
    const pending = client.enableMicrophone();
    await client.disconnect();
    resolveMicrophone(); await pending;
    expect(fake.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
  });
  it('uses separate publishing and subscribing connections across browsers', () => {
    const fake = createRoom();
    const factory = vi.fn(() => fake.room);
    new LiveKitVoiceClient(factory);

    expect(factory).toHaveBeenCalledWith({
      adaptiveStream: true,
      singlePeerConnection: false,
    });
  });

  it('connects with backend credentials and enables the microphone', async () => {
    const fake = createRoom();
    const client = new LiveKitVoiceClient(() => fake.room);

    await client.connect('wss://rtc.test', 'jwt');
    await client.enableMicrophone();

    expect(fake.connect).toHaveBeenCalledWith('wss://rtc.test', 'jwt');
    expect(fake.setMicrophoneEnabled).toHaveBeenCalledWith(true);
  });

  it('emits authoritative participants and reconnect state without reconnecting', async () => {
    const fake = createRoom();
    const max = participant('max', 'Max', true);
    fake.room.remoteParticipants.set('max', max);
    const client = new LiveKitVoiceClient(() => fake.room);
    const listener = vi.fn();
    client.subscribe(listener);
    await client.connect('wss://rtc.test', 'jwt');

    fake.room.emit(RoomEvent.ParticipantConnected, max);
    fake.room.emit(RoomEvent.Reconnecting);

    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({
      connection: 'reconnecting',
      participants: [
        { identity: 'ivan', displayName: 'Ivan', isLocal: true, isMuted: false, isSpeaking: false },
        { identity: 'max', displayName: 'Max', isLocal: false, isMuted: true, isSpeaking: false },
      ],
      localMuted: false,
      needsAudioPermission: false,
    }));
    expect(fake.connect).toHaveBeenCalledTimes(1);
  });

  it('attaches and detaches subscribed remote audio', async () => {
    const fake = createRoom();
    const client = new LiveKitVoiceClient(() => fake.room);
    await client.connect('wss://rtc.test', 'jwt');
    const audio = document.createElement('audio');
    const track = {
      kind: Track.Kind.Audio,
      mediaStreamTrack: { enabled: true },
      attach: vi.fn().mockReturnValue(audio),
      detach: vi.fn().mockReturnValue([audio]),
    } as unknown as RemoteTrack;
    const publication = {} as RemoteTrackPublication;
    const max = participant('max', 'Max', false);

    fake.room.emit(RoomEvent.TrackSubscribed, track, publication, max);
    expect(track.attach).toHaveBeenCalledOnce();
    expect(audio.isConnected).toBe(true);

    fake.room.emit(RoomEvent.TrackUnsubscribed, track, publication, max);
    expect(track.detach).toHaveBeenCalledOnce();
    expect(audio.isConnected).toBe(false);
  });

  it('reports blocked autoplay and retries from a user action', async () => {
    const fake = createRoom();
    Object.defineProperty(fake.room, 'canPlaybackAudio', {
      configurable: true,
      value: false,
    });
    const client = new LiveKitVoiceClient(() => fake.room);
    const listener = vi.fn();
    client.subscribe(listener);
    await client.connect('wss://rtc.test', 'jwt');

    fake.room.emit(RoomEvent.AudioPlaybackStatusChanged, false);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ needsAudioPermission: true }),
    );

    await client.enableAudio();
    expect(fake.startAudio).toHaveBeenCalledOnce();
  });

  it('detaches audio, removes listeners, and stops local tracks on disconnect', async () => {
    const fake = createRoom();
    const off = vi.spyOn(fake.room, 'off');
    const client = new LiveKitVoiceClient(() => fake.room);
    await client.connect('wss://rtc.test', 'jwt');
    const audio = document.createElement('audio');
    const track = {
      kind: Track.Kind.Audio,
      mediaStreamTrack: { enabled: true },
      attach: vi.fn().mockReturnValue(audio),
      detach: vi.fn().mockReturnValue([audio]),
    } as unknown as RemoteTrack;
    fake.room.emit(
      RoomEvent.TrackSubscribed,
      track,
      {} as RemoteTrackPublication,
      participant('max', 'Max', false),
    );

    await client.disconnect();

    expect(track.detach).toHaveBeenCalledOnce();
    expect(off).toHaveBeenCalled();
    expect(fake.disconnect).toHaveBeenCalledWith(true);
  });

  it('mutes all present and future remote audio independently of microphone and video', async () => {
    const fake = createRoom();
    const client = new LiveKitVoiceClient(() => fake.room);
    const listener = vi.fn();
    client.subscribe(listener);
    await client.connect('wss://rtc.test', 'jwt');
    const microphone = mediaTrack(Track.Kind.Audio, Track.Source.Microphone);
    const screenAudio = mediaTrack(Track.Kind.Audio, Track.Source.ScreenShareAudio);
    const screen = mediaTrack(Track.Kind.Video, Track.Source.ScreenShare);
    publishRemote(fake.room, microphone.track, Track.Source.Microphone);
    await client.setIncomingMuted(true);
    publishRemote(fake.room, screenAudio.track, Track.Source.ScreenShareAudio);
    publishRemote(fake.room, screen.track, Track.Source.ScreenShare);
    expect(microphone.element.muted).toBe(true);
    expect(screenAudio.element.muted).toBe(true);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ incomingMuted: true,
      screens: [expect.objectContaining({ displayName: 'Max', element: screen.element })] }));
    expect(fake.setMicrophoneEnabled).not.toHaveBeenCalled();
    await client.setMuted(true);
    expect(screenAudio.element.muted).toBe(true);
    await client.setIncomingMuted(false);
    expect(microphone.element.muted).toBe(false);
    expect(screenAudio.element.muted).toBe(false);
    expect(fake.setMicrophoneEnabled).toHaveBeenCalledExactlyOnceWith(false);
    await client.disconnect();
    expect(screen.track.detach).toHaveBeenCalledOnce();
  });

  it('starts/stops capture with optional audio and follows browser stop publication events', async () => {
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: vi.fn() } });
    const fake = createRoom();
    const client = new LiveKitVoiceClient(() => fake.room);
    const listener = vi.fn();
    client.subscribe(listener);
    await client.connect('wss://rtc.test', 'jwt');
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ screenShareSupported: true }));
    await client.setScreenSharing(true);
    expect(fake.setScreenShareEnabled).toHaveBeenCalledWith(true, { audio: true });
    const screen = mediaTrack(Track.Kind.Video, Track.Source.ScreenShare);
    const publication = { track: screen.track, source: Track.Source.ScreenShare } as unknown as LocalTrackPublication;
    fake.room.emit(RoomEvent.LocalTrackPublished, publication, fake.room.localParticipant);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ localSharing: true,
      screens: [expect.objectContaining({ isLocal: true, element: screen.element })] }));
    expect(screen.element.muted).toBe(true);
    Object.defineProperty(screen.track.mediaStreamTrack, 'readyState', { value: 'ended' });
    fake.room.emit(RoomEvent.LocalTrackUnpublished, publication, fake.room.localParticipant);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ localSharing: false, screens: [] }));
    expect(screen.track.detach).toHaveBeenCalledOnce();
    await client.setScreenSharing(false);
    expect(fake.setScreenShareEnabled).toHaveBeenLastCalledWith(false, { audio: true });
    await client.disconnect();
  });

  it('removes unsubscribed screens and separate cameras and all media on unexpected disconnect', async () => {
    const fake = createRoom();
    const client = new LiveKitVoiceClient(() => fake.room);
    const listener = vi.fn();
    client.subscribe(listener);
    await client.connect('wss://rtc.test', 'jwt');
    const screen = mediaTrack(Track.Kind.Video, Track.Source.ScreenShare);
    const camera = mediaTrack(Track.Kind.Video, Track.Source.Camera);
    publishRemote(fake.room, camera.track, Track.Source.Camera);
    expect(camera.track.attach).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ screens: [], cameras: [expect.objectContaining({ element: camera.element })] }));
    publishRemote(fake.room, screen.track, Track.Source.ScreenShare);
    fake.room.emit(RoomEvent.TrackUnsubscribed, screen.track, {} as RemoteTrackPublication, participant('max', 'Max', false));
    expect(screen.track.detach).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ screens: [] }));
    const second = mediaTrack(Track.Kind.Video, Track.Source.ScreenShare);
    publishRemote(fake.room, second.track, Track.Source.ScreenShare);
    const local = mediaTrack(Track.Kind.Video, Track.Source.ScreenShare);
    fake.room.emit(RoomEvent.LocalTrackPublished,
      { source: Track.Source.ScreenShare, track: local.track } as unknown as LocalTrackPublication,
      fake.room.localParticipant);
    const audio = mediaTrack(Track.Kind.Audio, Track.Source.ScreenShareAudio);
    publishRemote(fake.room, audio.track, Track.Source.ScreenShareAudio);
    fake.room.emit(RoomEvent.Disconnected);
    expect(camera.track.detach).toHaveBeenCalledOnce();
    expect(second.track.detach).toHaveBeenCalledOnce();
    expect(local.track.detach).toHaveBeenCalledOnce();
    expect(audio.track.detach).toHaveBeenCalledOnce();
    expect(audio.element.isConnected).toBe(false);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ screens: [], cameras: [], localCamera: false, localSharing: false }));
    await client.disconnect();
  });

  it('rejects unsupported capture without invoking the SDK or disconnecting', async () => {
    vi.stubGlobal('navigator', { mediaDevices: {} });
    const fake = createRoom();
    const client = new LiveKitVoiceClient(() => fake.room);
    const listener = vi.fn();
    client.subscribe(listener);
    await client.connect('wss://rtc.test', 'jwt');
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ screenShareSupported: false }));
    await expect(client.setScreenSharing(true)).rejects.toThrow('Screen sharing is not supported');
    expect(fake.setScreenShareEnabled).not.toHaveBeenCalled();
    expect(fake.disconnect).not.toHaveBeenCalled();
    await client.disconnect();
  });

  it('propagates capture cancellation without disconnecting', async () => {
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: vi.fn() } });
    const fake = createRoom();
    fake.setScreenShareEnabled.mockRejectedValue(new DOMException('Cancelled', 'NotAllowedError'));
    const client = new LiveKitVoiceClient(() => fake.room);
    await client.connect('wss://rtc.test', 'jwt');
    await expect(client.setScreenSharing(true)).rejects.toThrow('Cancelled');
    expect(fake.disconnect).not.toHaveBeenCalled();
    await client.disconnect();
  });

  it('attaches existing remote microphone, shared audio, and screen once, respecting incoming mute', async () => {
    const fake = createRoom();
    const max = participant('max', 'Max', false);
    const audio = mediaTrack(Track.Kind.Audio, Track.Source.ScreenShareAudio);
    const screen = mediaTrack(Track.Kind.Video, Track.Source.ScreenShare);
    max.audioTrackPublications.set('audio', { source: Track.Source.ScreenShareAudio, track: audio.track } as RemoteTrackPublication);
    max.videoTrackPublications.set('screen', { source: Track.Source.ScreenShare, track: screen.track } as RemoteTrackPublication);
    fake.room.remoteParticipants.set('max', max);
    const client = new LiveKitVoiceClient(() => fake.room);
    await client.setIncomingMuted(true);
    await client.connect('wss://rtc.test', 'jwt');
    publishRemote(fake.room, screen.track, Track.Source.ScreenShare);
    expect(screen.track.attach).toHaveBeenCalledOnce();
    expect(audio.element.muted).toBe(true);
    await client.disconnect();
    expect(audio.track.detach).toHaveBeenCalledOnce();
    expect(screen.track.detach).toHaveBeenCalledOnce();
  });

  it('prevents duplicate capture and stops a late capture result after disconnect', async () => {
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: vi.fn() } });
    const fake = createRoom();
    let resolveCapture!: () => void;
    fake.setScreenShareEnabled.mockImplementationOnce(() => new Promise((resolve) => { resolveCapture = () => resolve(undefined); }));
    const client = new LiveKitVoiceClient(() => fake.room);
    await client.connect('wss://rtc.test', 'jwt');
    const pending = client.setScreenSharing(true);
    await client.setScreenSharing(true);
    expect(fake.setScreenShareEnabled).toHaveBeenCalledOnce();
    await client.disconnect();
    resolveCapture();
    await pending;
    expect(fake.setScreenShareEnabled).toHaveBeenLastCalledWith(false, { audio: true });
  });

  it('stops remaining shared audio when browser stop unpublishes the local video', async () => {
    const fake = createRoom();
    const audio = { stop: vi.fn() };
    const unpublish = vi.spyOn(fake.room.localParticipant, 'unpublishTrack').mockResolvedValue(undefined);
    vi.mocked(fake.room.localParticipant.getTrackPublication).mockImplementation((source) => source === Track.Source.ScreenShareAudio
      ? { track: audio } as unknown as LocalTrackPublication : undefined);
    const client = new LiveKitVoiceClient(() => fake.room);
    await client.connect('wss://rtc.test', 'jwt');
    const screen = mediaTrack(Track.Kind.Video, Track.Source.ScreenShare);
    const publication = { source: Track.Source.ScreenShare, track: screen.track } as unknown as LocalTrackPublication;
    fake.room.emit(RoomEvent.LocalTrackPublished, publication, fake.room.localParticipant);
    Object.defineProperty(screen.track.mediaStreamTrack, 'readyState', { value: 'ended' });
    fake.room.emit(RoomEvent.LocalTrackUnpublished, publication, fake.room.localParticipant);
    expect(audio.stop).toHaveBeenCalledOnce();
    expect(unpublish).toHaveBeenCalledWith(audio);
    await client.disconnect();
  });

  it('keeps incoming audio silent when SDK playback recovery forcibly unmutes elements', async () => {
    const fake = createRoom();
    const client = new LiveKitVoiceClient(() => fake.room);
    await client.connect('wss://rtc.test', 'jwt');
    const audio = mediaTrack(Track.Kind.Audio, Track.Source.ScreenShareAudio);
    publishRemote(fake.room, audio.track, Track.Source.ScreenShareAudio);
    await client.setIncomingMuted(true);
    fake.startAudio.mockImplementation(async () => {
      audio.element.muted = false;
      expect(audio.element.volume).toBe(0);
      fake.room.emit(RoomEvent.AudioPlaybackStatusChanged, true);
    });
    await client.enableAudio();
    expect(audio.element.muted).toBe(true);
    expect(audio.track.mediaStreamTrack.enabled).toBe(false);
    audio.track.mediaStreamTrack.enabled = true;
    fake.room.emit(RoomEvent.TrackUnmuted, {} as RemoteTrackPublication, participant('max', 'Max', false));
    expect(audio.track.mediaStreamTrack.enabled).toBe(false);
    await client.setIncomingMuted(false);
    expect(audio.element.volume).toBe(1);
    expect(audio.track.mediaStreamTrack.enabled).toBe(true);
    await client.disconnect();
  });

  it('cleans up a partially published screen when capture publication fails', async () => {
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: vi.fn() } });
    const fake = createRoom();
    const orphanedAudio = { stop: vi.fn() };
    const unpublish = vi.spyOn(fake.room.localParticipant, 'unpublishTrack').mockResolvedValue(undefined);
    vi.mocked(fake.room.localParticipant.getTrackPublication).mockImplementation((source) => source === Track.Source.ScreenShareAudio
      ? { track: orphanedAudio } as unknown as LocalTrackPublication : undefined);
    const screen = mediaTrack(Track.Kind.Video, Track.Source.ScreenShare);
    const publication = { source: Track.Source.ScreenShare, track: screen.track } as unknown as LocalTrackPublication;
    fake.setScreenShareEnabled.mockImplementation(async (enabled) => {
      if (enabled) {
        fake.room.emit(RoomEvent.LocalTrackPublished, publication, fake.room.localParticipant);
        throw new Error('Audio publication failed');
      }
      Object.defineProperty(screen.track.mediaStreamTrack, 'readyState', { value: 'ended' });
      fake.room.emit(RoomEvent.LocalTrackUnpublished, publication, fake.room.localParticipant);
      return undefined;
    });
    const client = new LiveKitVoiceClient(() => fake.room);
    const listener = vi.fn();
    client.subscribe(listener);
    await client.connect('wss://rtc.test', 'jwt');
    await expect(client.setScreenSharing(true)).rejects.toThrow('Audio publication failed');
    expect(screen.track.detach).toHaveBeenCalledOnce();
    expect(orphanedAudio.stop).toHaveBeenCalledOnce();
    expect(unpublish).toHaveBeenCalledWith(orphanedAudio);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ localSharing: false, screens: [], connection: 'connected' }));
    expect(fake.disconnect).not.toHaveBeenCalled();
    await client.disconnect();
  });

  it('stops deferred shared audio after browser stop while screen publication is pending', async () => {
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: vi.fn() } });
    const fake = screenCaptureRoom();
    let releaseAudio!: () => void;
    const audioReady = new Promise<void>((resolve) => { releaseAudio = resolve; });
    fake.publish.mockImplementation(async (track) => {
      if (track === fake.audio) {
        await audioReady;
      }
      return fake.register(track);
    });
    const client = new LiveKitVoiceClient(() => fake.room);
    const listener = vi.fn();
    client.subscribe(listener);
    await client.connect('wss://rtc.test', 'jwt');
    const pending = client.setScreenSharing(true);
    await vi.waitFor(() => expect(fake.local.getTrackPublication(Track.Source.ScreenShare)).toBeDefined());

    // The browser ends video; LiveKit handleTrackEnded calls unpublishTrack.
    fake.videoCapture.stop();
    await fake.local.unpublishTrack(fake.video);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ localSharing: false, screens: [] }));
    expect(fake.detachVideo).toHaveBeenCalledOnce();
    expect(fake.audioCapture.readyState).toBe('live');
    expect(fake.stopAudio).not.toHaveBeenCalled();
    releaseAudio();
    await pending;

    expect(fake.audioCapture.readyState).toBe('ended');
    expect(fake.stopAudio).toHaveBeenCalled();
    expect(fake.local.getTrackPublication(Track.Source.ScreenShareAudio)).toBeUndefined();
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ connection: 'connected', localSharing: false, screens: [] }));
    await client.disconnect();
  });

  it('preserves live screen capture and preview through SDK full reconnect unpublish(false) and republish', async () => {
    const fake = screenCaptureRoom();
    const client = new LiveKitVoiceClient(() => fake.room);
    const snapshots: VoiceSnapshot[] = [];
    const previewRoot = document.createElement('div');
    document.body.append(previewRoot);
    client.subscribe((snapshot) => {
      snapshots.push(snapshot);
      for (const screen of snapshot.screens) {
        previewRoot.append(screen.element);
      }
    });
    await client.connect('wss://rtc.test', 'jwt');
    await fake.local.publishTrack(fake.video);
    await fake.local.publishTrack(fake.audio);
    expect(fake.preview.isConnected).toBe(true);
    const unpublish = vi.spyOn(fake.local, 'unpublishTrack');
    const reconnectSnapshotStart = snapshots.length;
    fake.room.emit(RoomEvent.Reconnecting);
    await fake.local.republishAllTracks(undefined, true);
    fake.room.emit(RoomEvent.Reconnected);

    expect(fake.stopAudio).not.toHaveBeenCalled();
    expect(unpublish).toHaveBeenCalledTimes(2);
    expect(unpublish).toHaveBeenNthCalledWith(1, fake.video, false);
    expect(unpublish).toHaveBeenNthCalledWith(2, fake.audio, false);
    expect(fake.videoCapture.readyState).toBe('live');
    expect(fake.audioCapture.readyState).toBe('live');
    expect(fake.local.getTrackPublication(Track.Source.ScreenShare)?.track).toBe(fake.video);
    expect(fake.local.getTrackPublication(Track.Source.ScreenShareAudio)?.track).toBe(fake.audio);
    expect(fake.detachVideo).not.toHaveBeenCalled();
    expect(fake.video.attach).toHaveBeenCalledOnce();
    expect(fake.preview.isConnected).toBe(true);
    for (const snapshot of snapshots.slice(reconnectSnapshotStart)) {
      expect(snapshot.localSharing).toBe(true);
      expect(snapshot.screens).toHaveLength(1);
      expect(snapshot.screens[0]?.element).toBe(fake.preview);
    }
    await client.disconnect();
    expect(fake.detachVideo).toHaveBeenCalledOnce();
    expect(fake.preview.isConnected).toBe(false);
    previewRoot.remove();
    fake.video.stop();
    fake.audio.stop();
  });
});
