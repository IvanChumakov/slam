import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VoiceApiError } from '../api/voiceApi';
import type { VoiceApi } from '../api/voiceApi';
import type { VoiceClient, VoiceSnapshot } from './types';
import { useVoiceRoom } from './useVoiceRoom';

const credentials = {
  livekit_url: 'wss://rtc.test',
  access_token: 'jwt',
  room: { id: 42, name: 'General' },
  participant: { identity: 'guest_1', display_name: 'Ivan' },
};

function createFakeVoiceClient() {
  let listener: (snapshot: VoiceSnapshot) => void = () => undefined;
  const unsubscribe = vi.fn();
  const client: VoiceClient = {
    subscribe: vi.fn((next) => {
      listener = next;
      return unsubscribe;
    }),
    connect: vi.fn().mockResolvedValue(undefined),
    enableMicrophone: vi.fn().mockResolvedValue(undefined),
    setMuted: vi.fn().mockResolvedValue(undefined),
    enableAudio: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };

  return {
    client,
    unsubscribe,
    emit(snapshot: VoiceSnapshot) {
      listener(snapshot);
    },
  };
}

function createApi(): VoiceApi {
  return { join: vi.fn().mockResolvedValue(credentials) };
}

describe('useVoiceRoom', () => {
  it('connects once and requests the microphone after credentials arrive', async () => {
    const voice = createFakeVoiceClient();
    const api = createApi();
    const { result } = renderHook(() =>
      useVoiceRoom({ token: 'signed', api, createClient: () => voice.client }),
    );

    await act(async () => {
      await Promise.all([result.current.join('Ivan'), result.current.join('Ivan')]);
    });

    expect(api.join).toHaveBeenCalledTimes(1);
    expect(api.join).toHaveBeenCalledWith('signed', 'Ivan');
    expect(voice.client.connect).toHaveBeenCalledWith('wss://rtc.test', 'jwt');
    expect(voice.client.enableMicrophone).toHaveBeenCalledOnce();
    expect(result.current.state).toMatchObject({
      phase: 'connected',
      roomName: 'General',
      error: null,
    });
  });

  it('takes participants and reconnect state from the existing client', async () => {
    const voice = createFakeVoiceClient();
    const { result } = renderHook(() =>
      useVoiceRoom({ token: 'signed', api: createApi(), createClient: () => voice.client }),
    );
    await act(async () => result.current.join('Ivan'));

    act(() => {
      voice.emit({
        connection: 'reconnecting',
        participants: [
          { identity: 'max', displayName: 'Max', isLocal: false, isMuted: true },
        ],
        localMuted: false,
        needsAudioPermission: false,
      });
    });

    expect(result.current.state.phase).toBe('reconnecting');
    expect(result.current.state.participants[0]?.displayName).toBe('Max');
    expect(voice.client.connect).toHaveBeenCalledTimes(1);

    act(() => {
      voice.emit({
        connection: 'connected',
        participants: [],
        localMuted: false,
        needsAudioPermission: false,
      });
    });
    expect(result.current.state.phase).toBe('connected');
  });

  it('delegates microphone and audio controls to the active client', async () => {
    const voice = createFakeVoiceClient();
    const { result } = renderHook(() =>
      useVoiceRoom({ token: 'signed', api: createApi(), createClient: () => voice.client }),
    );
    await act(async () => result.current.join('Ivan'));

    await act(async () => {
      await result.current.setMuted(true);
      await result.current.enableAudio();
    });

    expect(voice.client.setMuted).toHaveBeenCalledWith(true);
    expect(voice.client.enableAudio).toHaveBeenCalledOnce();
  });

  it('disconnects, unsubscribes, and clears room state on leave', async () => {
    const voice = createFakeVoiceClient();
    const { result } = renderHook(() =>
      useVoiceRoom({ token: 'signed', api: createApi(), createClient: () => voice.client }),
    );
    await act(async () => result.current.join('Ivan'));

    await act(async () => result.current.leave());

    expect(voice.unsubscribe).toHaveBeenCalledOnce();
    expect(voice.client.disconnect).toHaveBeenCalledOnce();
    expect(result.current.state).toMatchObject({
      phase: 'left',
      participants: [],
      roomName: '',
    });
  });

  it('cleans up a partial connection after microphone denial', async () => {
    const voice = createFakeVoiceClient();
    vi.mocked(voice.client.enableMicrophone).mockRejectedValue(
      new DOMException('Permission denied', 'NotAllowedError'),
    );
    const { result } = renderHook(() =>
      useVoiceRoom({ token: 'signed', api: createApi(), createClient: () => voice.client }),
    );

    await act(async () => result.current.join('Ivan'));

    expect(voice.client.disconnect).toHaveBeenCalledOnce();
    expect(result.current.state).toMatchObject({
      phase: 'error',
      error: 'Microphone access was denied. Allow access in your browser and try again.',
    });
  });

  it('shows a specific invalid invite error without creating a client', async () => {
    const api: VoiceApi = {
      join: vi.fn().mockRejectedValue(new VoiceApiError('invalid-invite')),
    };
    const createClient = vi.fn();
    const { result } = renderHook(() =>
      useVoiceRoom({ token: 'expired', api, createClient }),
    );

    await act(async () => result.current.join('Ivan'));

    expect(createClient).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({
      phase: 'error',
      error: 'Invalid or expired invite.',
    });
  });

  it('turns an unexpected disconnect into a recoverable error', async () => {
    const voice = createFakeVoiceClient();
    const { result } = renderHook(() =>
      useVoiceRoom({ token: 'signed', api: createApi(), createClient: () => voice.client }),
    );
    await act(async () => result.current.join('Ivan'));

    act(() => {
      voice.emit({
        connection: 'disconnected',
        participants: [],
        localMuted: false,
        needsAudioPermission: false,
      });
    });

    expect(result.current.state).toMatchObject({
      phase: 'error',
      error: 'Disconnected from the voice room. Try joining again.',
    });
  });
});
