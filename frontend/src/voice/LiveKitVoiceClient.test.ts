import {
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type TrackPublication,
} from 'livekit-client';
import { describe, expect, it, vi } from 'vitest';
import { LiveKitVoiceClient } from './LiveKitVoiceClient';

function participant(
  identity: string,
  name: string,
  muted: boolean,
): RemoteParticipant {
  return {
    identity,
    name,
    audioTrackPublications: new Map(),
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

  room.localParticipant.identity = 'ivan';
  room.localParticipant.name = 'Ivan';
  vi.spyOn(room.localParticipant, 'getTrackPublication').mockReturnValue({
    isMuted: false,
  } as TrackPublication);

  return { room, connect, disconnect, startAudio, setMicrophoneEnabled };
}

describe('LiveKitVoiceClient', () => {
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

    expect(listener).toHaveBeenLastCalledWith({
      connection: 'reconnecting',
      participants: [
        { identity: 'ivan', displayName: 'Ivan', isLocal: true, isMuted: false },
        { identity: 'max', displayName: 'Max', isLocal: false, isMuted: true },
      ],
      localMuted: false,
      needsAudioPermission: false,
    });
    expect(fake.connect).toHaveBeenCalledTimes(1);
  });

  it('attaches and detaches subscribed remote audio', async () => {
    const fake = createRoom();
    const client = new LiveKitVoiceClient(() => fake.room);
    await client.connect('wss://rtc.test', 'jwt');
    const audio = document.createElement('audio');
    const track = {
      kind: Track.Kind.Audio,
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
});
