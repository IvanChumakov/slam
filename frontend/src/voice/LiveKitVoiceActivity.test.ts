import { Room, RoomEvent, Track, TrackEvent, type LocalTrackPublication, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication } from 'livekit-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveKitVoiceClient } from './LiveKitVoiceClient';

const activity = vi.hoisted(() => ({
  watch: vi.fn(), unwatch: vi.fn(), reset: vi.fn(), dispose: vi.fn(),
  values: new Map<MediaStreamTrack, boolean>(), changed: () => {},
}));
vi.mock('./audioActivity', () => ({ AudioActivityObserver: class {
  constructor(changed: () => void) { activity.changed = changed; }
  watch(track: MediaStreamTrack) { activity.watch(track); }
  unwatch(track: MediaStreamTrack) { activity.unwatch(track); activity.values.delete(track); }
  speaking(track: MediaStreamTrack) { return activity.values.get(track); }
  reset() { activity.reset(); activity.values.clear(); }
  dispose() { activity.dispose(); activity.values.clear(); }
} }));

function fixture() {
  const room = new Room();
  vi.spyOn(room, 'connect').mockResolvedValue(undefined);
  vi.spyOn(room, 'disconnect').mockResolvedValue(undefined);
  vi.spyOn(room.localParticipant, 'setMicrophoneEnabled').mockResolvedValue(undefined);
  vi.spyOn(room, 'startAudio').mockResolvedValue(undefined);
  room.localParticipant.identity = 'ivan'; room.localParticipant.name = 'Ivan';
  function microphone() {
    const stream = { kind: 'audio', enabled: true, readyState: 'live', stop: vi.fn() } as unknown as MediaStreamTrack;
    const element = document.createElement('audio');
    return { kind: Track.Kind.Audio, source: Track.Source.Microphone, mediaStreamTrack: stream,
      on: vi.fn(), off: vi.fn(), attach: vi.fn(() => element), detach: vi.fn(() => [element]), stop: vi.fn(),
    } as unknown as RemoteTrack;
  }
  const localTrack = microphone(); const remoteTrack = microphone();
  const local = { source: Track.Source.Microphone, track: localTrack, isMuted: false };
  const remote = { source: Track.Source.Microphone, track: remoteTrack, isMuted: false };
  vi.spyOn(room.localParticipant, 'getTrackPublication').mockImplementation((source) => source === Track.Source.Microphone ? local as unknown as LocalTrackPublication : undefined);
  const max = { identity: 'max', name: 'Max', isSpeaking: false,
    getTrackPublication: vi.fn(() => remote), audioTrackPublications: new Map([['mic', remote]]), videoTrackPublications: new Map(),
  } as unknown as RemoteParticipant;
  room.remoteParticipants.set('max', max);
  const client = new LiveKitVoiceClient(() => room);
  const listener = vi.fn(); client.subscribe(listener);
  return { room, client, listener, local, remote, localTrack, remoteTrack, max };
}

beforeEach(() => { vi.clearAllMocks(); activity.values.clear(); });

describe('fast microphone activity integration', () => {
  it('highlights both tracks without waiting for server active-speaker notifications', async () => {
    const fake = fixture(); await fake.client.connect('wss://rtc.test', 'jwt');
    expect(activity.watch).toHaveBeenCalledWith(fake.localTrack.mediaStreamTrack);
    expect(activity.watch).toHaveBeenCalledWith(fake.remoteTrack.mediaStreamTrack);
    activity.values.set(fake.localTrack.mediaStreamTrack, true);
    activity.values.set(fake.remoteTrack.mediaStreamTrack, true);
    activity.changed();
    expect(fake.listener.mock.lastCall?.[0].participants.every((participant: { isSpeaking: boolean }) => participant.isSpeaking)).toBe(true);
    expect(fake.room.localParticipant.isSpeaking).toBe(false);
    expect(fake.max.isSpeaking).toBe(false);
    await fake.client.disconnect();
  });

  it('measured silence wins over a delayed server speaking flag', async () => {
    const fake = fixture(); await fake.client.connect('wss://rtc.test', 'jwt');
    fake.room.localParticipant.isSpeaking = true; fake.max.isSpeaking = true;
    activity.values.set(fake.localTrack.mediaStreamTrack, false);
    activity.values.set(fake.remoteTrack.mediaStreamTrack, false);
    fake.room.emit(RoomEvent.ActiveSpeakersChanged, [fake.max, fake.room.localParticipant]);
    expect(fake.listener.mock.lastCall?.[0].participants.every((participant: { isSpeaking: boolean }) => !participant.isSpeaking)).toBe(true);
    await fake.client.disconnect();
  });

  it('muting clears local activity immediately and deafening retains the remote server fallback', async () => {
    const fake = fixture(); await fake.client.connect('wss://rtc.test', 'jwt');
    activity.values.set(fake.localTrack.mediaStreamTrack, true);
    activity.values.set(fake.remoteTrack.mediaStreamTrack, false);
    fake.room.localParticipant.isSpeaking = true; fake.max.isSpeaking = true;
    fake.local.isMuted = true;
    await fake.client.setMuted(true);
    expect(fake.listener.mock.lastCall?.[0].participants[0].isSpeaking).toBe(false);
    expect(activity.unwatch).toHaveBeenCalledWith(fake.localTrack.mediaStreamTrack);
    await fake.client.setIncomingMuted(true);
    expect(fake.listener.mock.lastCall?.[0].participants[1].isSpeaking).toBe(true);
    expect(activity.unwatch).toHaveBeenCalledWith(fake.remoteTrack.mediaStreamTrack);
    await fake.client.setIncomingMuted(false);
    expect(activity.watch).toHaveBeenCalledWith(fake.remoteTrack.mediaStreamTrack);
    await fake.client.disconnect();
  });

  it('rebinds analysis when an SDK microphone restart changes the input stream', async () => {
    const fake = fixture(); await fake.client.connect('wss://rtc.test', 'jwt');
    const old = fake.localTrack.mediaStreamTrack;
    const replacement = { kind: 'audio', enabled: true, readyState: 'live' } as MediaStreamTrack;
    Object.defineProperty(fake.localTrack, 'mediaStreamTrack', { value: replacement });
    const restart = vi.mocked(fake.localTrack.on).mock.calls.find(([event]) => event === TrackEvent.Restarted)?.[1];
    expect(restart).toBeDefined();
    (restart as () => void)();
    expect(activity.unwatch).toHaveBeenCalledWith(old);
    expect(activity.watch).toHaveBeenCalledWith(replacement);
    await fake.client.disconnect();
  });

  it('cleans up unsubscribe, reconnect and leave without stopping the microphone', async () => {
    const fake = fixture(); await fake.client.connect('wss://rtc.test', 'jwt');
    fake.room.emit(RoomEvent.TrackUnsubscribed, fake.remoteTrack, fake.remote as unknown as RemoteTrackPublication, fake.max);
    expect(activity.unwatch).toHaveBeenCalledWith(fake.remoteTrack.mediaStreamTrack);
    fake.room.localParticipant.isSpeaking = true;
    fake.room.emit(RoomEvent.Reconnecting);
    expect(activity.reset).toHaveBeenCalled();
    expect(fake.listener.mock.lastCall?.[0].participants.every((participant: { isSpeaking: boolean }) => !participant.isSpeaking)).toBe(true);
    fake.room.emit(RoomEvent.Reconnected);
    expect(activity.watch).toHaveBeenCalledWith(fake.localTrack.mediaStreamTrack);
    expect(fake.localTrack.mediaStreamTrack.stop).not.toHaveBeenCalled();
    await fake.client.disconnect();
    expect(activity.dispose).toHaveBeenCalledOnce();
    expect(fake.localTrack.off).toHaveBeenCalledWith(TrackEvent.Restarted, expect.any(Function));
  });
});
