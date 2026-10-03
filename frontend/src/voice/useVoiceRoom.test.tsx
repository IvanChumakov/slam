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

const cameraOff = { localCamera: false, cameraSupported: true, cameras: [] };

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
    setIncomingMuted: vi.fn().mockResolvedValue(undefined),
    setScreenSharing: vi.fn().mockResolvedValue(undefined),
    setCameraEnabled: vi.fn().mockResolvedValue(undefined),
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
  return { join: vi.fn().mockResolvedValue(credentials),
    listRooms: vi.fn().mockResolvedValue({ current_room_id: 42, rooms: [{ id: 42, name: 'General', online_count: 1 }, { id: 43, name: 'Lounge', online_count: 0 }] }),
    createInvite: vi.fn().mockResolvedValue({ join_token: 'target', join_url: 'https://voice.test/join/target', room: { id: 43, name: 'Lounge' }, expires_in: 3600 }),
  };
}

describe('useVoiceRoom', () => {
  it('lets Off cancel pending enable and ignores stale completion while a newer enable is pending', async () => {
    const voice = createFakeVoiceClient();
    let rejectOld!: (error: unknown) => void;
    let resolveNew!: () => void;
    vi.mocked(voice.client.setCameraEnabled)
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }))
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve; }));
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api: createApi(), createClient: () => voice.client }));
    await act(async () => result.current.join('Ivan'));
    let old!: Promise<void>; let next!: Promise<void>;
    act(() => { old = result.current.setCameraEnabled(true); });
    await act(async () => result.current.setCameraEnabled(false));
    expect(voice.client.setCameraEnabled).toHaveBeenNthCalledWith(2, false);
    expect(result.current.state.cameraPending).toBe(false);
    act(() => { next = result.current.setCameraEnabled(true); });
    await act(async () => { rejectOld(new DOMException('Denied', 'NotAllowedError')); await old; });
    expect(result.current.state).toMatchObject({ cameraPending: true, error: null });
    await act(async () => result.current.setCameraEnabled(true));
    expect(voice.client.setCameraEnabled).toHaveBeenCalledTimes(3);
    await act(async () => { resolveNew(); await next; });
    expect(result.current.state.cameraPending).toBe(false);
  });
  it('starts camera off and keeps camera denial nonfatal with independent screen controls', async () => {
    const voice = createFakeVoiceClient();
    let rejectCapture!: (error: unknown) => void;
    vi.mocked(voice.client.setCameraEnabled).mockReturnValue(new Promise((_, reject) => { rejectCapture = reject; }));
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api: createApi(), createClient: () => voice.client }));
    await act(async () => result.current.join('Ivan'));
    expect(result.current.state).toMatchObject({ localCamera: false, cameras: [], cameraPending: false });
    expect(voice.client.setCameraEnabled).not.toHaveBeenCalled();
    let pending!: Promise<void>;
    act(() => { pending = result.current.setCameraEnabled(true); });
    expect(result.current.state.cameraPending).toBe(true);
    await act(async () => { await result.current.setCameraEnabled(true); await result.current.setScreenSharing(true); });
    expect(voice.client.setCameraEnabled).toHaveBeenCalledOnce();
    expect(voice.client.setScreenSharing).toHaveBeenCalledWith(true);
    await act(async () => { rejectCapture(new DOMException('Denied', 'NotAllowedError')); await pending; });
    expect(result.current.state).toMatchObject({ phase: 'connected', cameraPending: false, localCamera: false });
    expect(result.current.state.error).toContain('Camera');
    expect(voice.client.disconnect).not.toHaveBeenCalled();
    expect(voice.client.enableMicrophone).toHaveBeenCalledOnce();
    expect(voice.client.setMuted).not.toHaveBeenCalled();
  });

  it.each(['leave', 'switch', 'unmount'] as const)('retires a pending camera without blocking %s or applying late errors', async (retirement) => {
    const old = createFakeVoiceClient(); const next = createFakeVoiceClient(); const api = createApi();
    vi.mocked(api.join).mockResolvedValueOnce(credentials).mockResolvedValue({ ...credentials, room: { id: 43, name: 'Lounge' } });
    let rejectCapture!: (error: unknown) => void;
    vi.mocked(old.client.setCameraEnabled).mockReturnValue(new Promise((_, reject) => { rejectCapture = reject; }));
    const factory = vi.fn().mockReturnValueOnce(old.client).mockReturnValueOnce(next.client);
    const { result, unmount } = renderHook(() => useVoiceRoom({ token: 'signed', api, createClient: factory }));
    await act(async () => result.current.join('Ivan'));
    let pending!: Promise<void>;
    act(() => { pending = result.current.setCameraEnabled(true); });
    if (retirement === 'leave') await act(async () => result.current.leave());
    else if (retirement === 'switch') await act(async () => result.current.switchRoom(43));
    else unmount();
    expect(old.client.disconnect).toHaveBeenCalledOnce();
    if (retirement !== 'unmount') expect(result.current.state).toMatchObject({ localCamera: false, cameras: [], cameraPending: false, error: null });
    await act(async () => { rejectCapture(new DOMException('Denied', 'NotAllowedError')); await pending; });
    if (retirement === 'switch') {
      expect(result.current.state).toMatchObject({ phase: 'connected', cameraPending: false, error: null });
      expect(next.client.setCameraEnabled).not.toHaveBeenCalled();
    }
  });

  it('takes camera and speaking snapshots and keeps the old camera during switch metadata lookup', async () => {
    const old = createFakeVoiceClient(); const next = createFakeVoiceClient(); const api = createApi();
    let resolveInvite!: () => void;
    vi.mocked(api.createInvite).mockReturnValue(new Promise((resolve) => { resolveInvite = () => resolve({
      join_token: 'target', join_url: 'https://voice.test/join/target', room: { id: 43, name: 'Lounge' }, expires_in: 3600,
    }); }));
    vi.mocked(api.join).mockResolvedValueOnce(credentials).mockResolvedValue({ ...credentials, room: { id: 43, name: 'Lounge' } });
    const factory = vi.fn().mockReturnValueOnce(old.client).mockReturnValueOnce(next.client);
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api, createClient: factory }));
    await act(async () => result.current.join('Ivan'));
    const camera = { id: 'camera', participantIdentity: 'ivan', displayName: 'Ivan', isLocal: true, element: document.createElement('video') };
    const snapshot: VoiceSnapshot = { connection: 'connected', participants: [
      { identity: 'ivan', displayName: 'Ivan', isLocal: true, isMuted: true, isSpeaking: true },
    ], localMuted: true, needsAudioPermission: false, incomingMuted: false,
    localSharing: false, screenShareSupported: true, screens: [], localCamera: true, cameraSupported: true, cameras: [camera] };
    act(() => old.emit(snapshot));
    expect(result.current.state).toMatchObject({ localCamera: true, cameras: [camera], participants: [{ isSpeaking: true }] });
    let switching!: Promise<void>;
    act(() => { switching = result.current.switchRoom(43); });
    expect(old.client.disconnect).not.toHaveBeenCalled();
    expect(result.current.state.localCamera).toBe(true);
    await act(async () => result.current.setCameraEnabled(true));
    expect(old.client.setCameraEnabled).not.toHaveBeenCalled();
    await act(async () => { resolveInvite(); await switching; });
    expect(old.client.disconnect).toHaveBeenCalledOnce();
    expect(result.current.state).toMatchObject({ phase: 'connected', localCamera: false, cameras: [], cameraPending: false, participants: [] });
    expect(next.client.setCameraEnabled).not.toHaveBeenCalled();
    act(() => old.emit(snapshot));
    expect(result.current.state.localCamera).toBe(false);
  });
  it('ignores preconnected remote-audio snapshots while joining an occupied room', async () => {
    const voice = createFakeVoiceClient();
    const snapshot: VoiceSnapshot = { ...cameraOff, connection: 'disconnected', participants: [
      { identity: 'max', displayName: 'Max', isLocal: false, isMuted: false, isSpeaking: false },
    ], localMuted: true, incomingMuted: false, localSharing: false, screenShareSupported: true, screens: [], needsAudioPermission: false };
    let resolveConnect!: () => void;
    vi.mocked(voice.client.connect).mockImplementation(() => {
      voice.emit(snapshot);
      return new Promise((resolve) => { resolveConnect = resolve; });
    });
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api: createApi(), createClient: () => voice.client }));
    let pending!: Promise<void>;
    act(() => { pending = result.current.join('Ivan'); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(voice.client.connect).toHaveBeenCalledOnce();
    expect(voice.client.disconnect).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe('connecting');
    await act(async () => {
      voice.emit({ ...snapshot, connection: 'connected' });
      resolveConnect();
      await pending;
    });
    expect(voice.client.enableMicrophone).toHaveBeenCalledOnce();
    expect(result.current.state.phase).toBe('connected');
  });

  it('still cleans up a rejected initial connect after preconnected snapshots', async () => {
    const voice = createFakeVoiceClient();
    vi.mocked(voice.client.connect).mockImplementation(async () => {
      voice.emit({ ...cameraOff, connection: 'disconnected', participants: [], localMuted: true, incomingMuted: false,
        localSharing: false, screenShareSupported: true, screens: [], needsAudioPermission: false });
      throw new VoiceApiError('backend-unavailable');
    });
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api: createApi(), createClient: () => voice.client }));
    await act(async () => result.current.join('Ivan'));
    expect(voice.client.disconnect).toHaveBeenCalledOnce();
    expect(voice.client.enableMicrophone).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe('error');
    expect(result.current.state.error).toBeTruthy();
  });

  it.each([true, false])('cancels a real disconnect during microphone setup with connected snapshot=%s', async (emitConnected) => {
    const voice = createFakeVoiceClient();
    const snapshot: VoiceSnapshot = { ...cameraOff, connection: 'connected', participants: [], localMuted: true, incomingMuted: false,
      localSharing: false, screenShareSupported: true, screens: [], needsAudioPermission: false };
    vi.mocked(voice.client.connect).mockImplementation(async () => {
      if (emitConnected) voice.emit(snapshot);
    });
    let resolveMicrophone!: () => void;
    vi.mocked(voice.client.enableMicrophone).mockReturnValue(new Promise((resolve) => { resolveMicrophone = resolve; }));
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api: createApi(), createClient: () => voice.client }));
    let pending!: Promise<void>;
    act(() => { pending = result.current.join('Ivan'); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.state.phase).toBe('requestingMicrophone');
    await act(async () => voice.emit({ ...snapshot, connection: 'disconnected' }));
    expect(voice.client.disconnect).toHaveBeenCalled();
    expect(result.current.state.phase).toBe('error');
    await act(async () => { resolveMicrophone(); await pending; });
    expect(result.current.state.phase).toBe('error');
  });
  it('retries rejected old-room teardown before creating another client', async () => {
    const old = createFakeVoiceClient(); const next = createFakeVoiceClient(); const api = createApi();
    vi.mocked(api.join).mockResolvedValueOnce(credentials).mockResolvedValueOnce({ ...credentials, room: { id: 43, name: 'Lounge' } }).mockResolvedValue(credentials);
    vi.mocked(old.client.disconnect).mockRejectedValue(new Error('teardown failed'));
    const factory = vi.fn().mockReturnValueOnce(old.client).mockReturnValueOnce(next.client);
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api, createClient: factory }));
    await act(async () => result.current.join('Ivan'));
    await act(async () => result.current.switchRoom(43));
    expect(result.current.state.phase).toBe('error');
    expect(factory).toHaveBeenCalledOnce();
    const failedAttempts = vi.mocked(old.client.disconnect).mock.calls.length;
    await act(async () => result.current.retry());
    expect(old.client.disconnect).toHaveBeenCalledTimes(failedAttempts + 1);
    expect(factory).toHaveBeenCalledOnce();
    expect(result.current.state.phase).toBe('error');
    let resolveCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { resolveCleanup = resolve; });
    vi.mocked(old.client.disconnect).mockReturnValue(cleanup);
    let pending!: Promise<void>;
    act(() => { pending = result.current.retry(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(factory).toHaveBeenCalledOnce();
    expect(next.client.connect).not.toHaveBeenCalled();
    await act(async () => { resolveCleanup(); await pending; });
    expect(next.client.connect).toHaveBeenCalledOnce();
    expect(result.current.state.phase).toBe('connected');
  });

  it('retries failed Leave teardown when joining again instead of retaining a rejected barrier', async () => {
    const old = createFakeVoiceClient(); const next = createFakeVoiceClient(); const api = createApi();
    vi.mocked(old.client.disconnect).mockRejectedValueOnce(new Error('teardown failed'));
    const factory = vi.fn().mockReturnValueOnce(old.client).mockReturnValueOnce(next.client);
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api, createClient: factory }));
    await act(async () => result.current.join('Ivan'));
    await act(async () => result.current.leave());
    expect(old.client.disconnect).toHaveBeenCalledOnce();
    expect(result.current.state.phase).toBe('left');
    act(() => result.current.reset());
    await act(async () => result.current.join('Max'));
    expect(old.client.disconnect).toHaveBeenCalledTimes(2);
    expect(next.client.connect).toHaveBeenCalledOnce();
    expect(api.join).toHaveBeenLastCalledWith('signed', 'Max');
    expect(result.current.state.phase).toBe('connected');
  });

  it.each(['invite', 'credentials'] as const)('retries after unexpected disconnect before cancelled target %s resolves', async (stage) => {
    const old = createFakeVoiceClient(); const next = createFakeVoiceClient(); const api = createApi();
    const targetCredentials = { ...credentials, room: { id: 43, name: 'Lounge' } };
    const targetInvite = { join_token: 'target', join_url: 'https://voice.test/join/target', room: { id: 43, name: 'Lounge' }, expires_in: 3600 };
    let resolveMetadata!: () => void;
    if (stage === 'invite') {
      vi.mocked(api.createInvite).mockReturnValueOnce(new Promise((resolve) => { resolveMetadata = () => resolve(targetInvite); }));
    } else {
      vi.mocked(api.join).mockResolvedValueOnce(credentials).mockReturnValueOnce(new Promise((resolve) => { resolveMetadata = () => resolve(targetCredentials); }));
    }
    const factory = vi.fn().mockReturnValueOnce(old.client).mockReturnValueOnce(next.client);
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api, createClient: factory }));
    await act(async () => result.current.join('Ivan'));
    let switching!: Promise<void>;
    act(() => { switching = result.current.switchRoom(43); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => old.emit({ ...cameraOff, connection: 'disconnected', participants: [], localMuted: true, incomingMuted: true, localSharing: false, screenShareSupported: true, screens: [], needsAudioPermission: false }));
    expect(result.current.state.phase).toBe('error');
    await act(async () => result.current.retry());
    expect(next.client.connect).toHaveBeenCalledOnce();
    expect(next.client.setIncomingMuted).toHaveBeenCalledWith(true);
    expect(next.client.enableMicrophone).not.toHaveBeenCalled();
    expect(api.join).toHaveBeenLastCalledWith('signed', 'Ivan');
    expect(result.current.state).toMatchObject({ phase: 'connected', roomId: 42, switching: false });
    const requestsBeforeLateResponse = vi.mocked(api.join).mock.calls.length;
    await act(async () => { resolveMetadata(); await switching; });
    expect(api.join).toHaveBeenCalledTimes(requestsBeforeLateResponse);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(next.client.disconnect).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({ phase: 'connected', roomId: 42 });
  });
  it('can rejoin after Leave without waiting for a cancelled metadata request', async () => {
    const old = createFakeVoiceClient(); const next = createFakeVoiceClient(); const api = createApi();
    let resolveInvite!: (value: Awaited<ReturnType<VoiceApi['createInvite']>>) => void;
    vi.mocked(api.createInvite).mockReturnValue(new Promise((resolve) => { resolveInvite = resolve; }));
    const factory = vi.fn().mockReturnValueOnce(old.client).mockReturnValueOnce(next.client);
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api, createClient: factory }));
    await act(async () => result.current.join('Ivan'));
    let pending!: Promise<void>;
    act(() => { pending = result.current.switchRoom(43); });
    await act(async () => result.current.leave());
    act(() => result.current.reset());
    await act(async () => result.current.join('Max'));
    expect(next.client.connect).toHaveBeenCalledOnce();
    expect(api.join).toHaveBeenLastCalledWith('signed', 'Max');
    await act(async () => { resolveInvite({ join_token: 'target', join_url: 'https://voice.test/join/target', room: { id: 43, name: 'Lounge' }, expires_in: 3600 }); await pending; });
    expect(result.current.state).toMatchObject({ phase: 'connected', roomId: 42 });
  });

  it('a cancelled credential request cannot release a newer connection operation lock', async () => {
    const api = createApi(); const voice = createFakeVoiceClient();
    let resolveCredentials!: (value: typeof credentials) => void;
    vi.mocked(api.join).mockReturnValueOnce(new Promise((resolve) => { resolveCredentials = resolve; }));
    let resolveConnect!: () => void;
    vi.mocked(voice.client.connect).mockReturnValue(new Promise((resolve) => { resolveConnect = resolve; }));
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api, createClient: () => voice.client }));
    let oldPending!: Promise<void>; let newPending!: Promise<void>;
    act(() => { oldPending = result.current.join('Ivan'); });
    await act(async () => result.current.leave());
    act(() => result.current.reset());
    act(() => { newPending = result.current.join('Max'); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(voice.client.connect).toHaveBeenCalledOnce();
    await act(async () => { resolveCredentials(credentials); await oldPending; });
    await act(async () => result.current.join('Third'));
    expect(api.join).toHaveBeenCalledTimes(2);
    await act(async () => { resolveConnect(); await newPending; });
    expect(result.current.state.phase).toBe('connected');
  });
  it('releases an unexpectedly disconnected client before retrying', async () => {
    const old = createFakeVoiceClient(); const next = createFakeVoiceClient(); const api = createApi();
    const factory = vi.fn().mockReturnValueOnce(old.client).mockReturnValueOnce(next.client);
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api, createClient: factory }));
    await act(async () => result.current.join('Ivan'));
    await act(async () => old.emit({ ...cameraOff, connection: 'disconnected', participants: [], localMuted: true, incomingMuted: false, localSharing: false, screenShareSupported: true, screens: [], needsAudioPermission: false }));
    await act(async () => result.current.retry());
    expect(old.client.disconnect).toHaveBeenCalledOnce();
    expect(next.client.connect).toHaveBeenCalledOnce();
    expect(result.current.state.phase).toBe('connected');
  });

  it('allows switching with a pending screen chooser and ignores its late result', async () => {
    const old = createFakeVoiceClient(); const next = createFakeVoiceClient(); const api = createApi();
    vi.mocked(api.join).mockResolvedValueOnce(credentials).mockResolvedValue({ ...credentials, room: { id: 43, name: 'Lounge' } });
    let rejectCapture!: (error: Error) => void;
    vi.mocked(old.client.setScreenSharing).mockReturnValue(new Promise((_, reject) => { rejectCapture = reject; }));
    const factory = vi.fn().mockReturnValueOnce(old.client).mockReturnValueOnce(next.client);
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api, createClient: factory }));
    await act(async () => result.current.join('Ivan'));
    let pending!: Promise<void>;
    act(() => { pending = result.current.setScreenSharing(true); });
    await act(async () => result.current.switchRoom(43));
    await act(async () => { rejectCapture(new DOMException('Cancelled', 'AbortError')); await pending; });
    expect(result.current.state).toMatchObject({ phase: 'connected', roomId: 43, error: null, screenSharePending: false, screens: [] });
    expect(next.client.setScreenSharing).not.toHaveBeenCalled();
  });

  it('does not switch while an incoming mute operation is pending', async () => {
    const old = createFakeVoiceClient(); const api = createApi();
    let resolveMute!: () => void;
    vi.mocked(old.client.setIncomingMuted).mockReturnValue(new Promise((resolve) => { resolveMute = resolve; }));
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api, createClient: () => old.client }));
    await act(async () => result.current.join('Ivan'));
    let pending!: Promise<void>;
    act(() => { pending = result.current.setIncomingMuted(true); });
    await act(async () => result.current.switchRoom(43));
    expect(api.createInvite).not.toHaveBeenCalled();
    await act(async () => { resolveMute(); await pending; });
    expect(result.current.state.incomingMuted).toBe(true);
  });

  it('keeps retry available after repeated target connection failures', async () => {
    const old = createFakeVoiceClient(); const failed = createFakeVoiceClient(); const failedAgain = createFakeVoiceClient(); const api = createApi();
    vi.mocked(api.join).mockResolvedValueOnce(credentials).mockResolvedValue({ ...credentials, room: { id: 43, name: 'Lounge' } });
    vi.mocked(failed.client.connect).mockRejectedValue(new Error('failed'));
    vi.mocked(failedAgain.client.connect).mockRejectedValue(new Error('failed again'));
    const factory = vi.fn().mockReturnValueOnce(old.client).mockReturnValueOnce(failed.client).mockReturnValueOnce(failedAgain.client);
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api, createClient: factory }));
    await act(async () => result.current.join('Ivan'));
    await act(async () => result.current.switchRoom(43));
    await act(async () => result.current.retry());
    expect(result.current.state).toMatchObject({ phase: 'error', roomId: 43, roomName: 'Lounge' });
  });

  it('ignores late audio recovery errors from the previous client', async () => {
    const old = createFakeVoiceClient(); const next = createFakeVoiceClient(); const api = createApi();
    vi.mocked(api.join).mockResolvedValueOnce(credentials).mockResolvedValue({ ...credentials, room: { id: 43, name: 'Lounge' } });
    let rejectAudio!: (error: Error) => void;
    vi.mocked(old.client.enableAudio).mockReturnValue(new Promise((_, reject) => { rejectAudio = reject; }));
    const factory = vi.fn().mockReturnValueOnce(old.client).mockReturnValueOnce(next.client);
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api, createClient: factory }));
    await act(async () => result.current.join('Ivan'));
    let pending!: Promise<void>;
    act(() => { pending = result.current.enableAudio(); });
    await act(async () => result.current.switchRoom(43));
    await act(async () => { rejectAudio(new Error('late')); await pending; });
    expect(result.current.state.error).toBeNull();
  });

  it('Leave cancels target connect and unmount cancels a lazy client factory', async () => {
    const old = createFakeVoiceClient(); const next = createFakeVoiceClient(); const api = createApi();
    vi.mocked(api.join).mockResolvedValueOnce(credentials).mockResolvedValue({ ...credentials, room: { id: 43, name: 'Lounge' } });
    let resolveConnect!: () => void;
    vi.mocked(next.client.connect).mockReturnValue(new Promise((resolve) => { resolveConnect = resolve; }));
    const factory = vi.fn().mockReturnValueOnce(old.client).mockReturnValueOnce(next.client);
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api, createClient: factory }));
    await act(async () => result.current.join('Ivan'));
    let pending!: Promise<void>;
    act(() => { pending = result.current.switchRoom(43); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => result.current.leave());
    await act(async () => { resolveConnect(); await pending; });
    expect(next.client.enableMicrophone).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe('left');
    let resolveClient!: (client: VoiceClient) => void;
    const lazy = new Promise<VoiceClient>((resolve) => { resolveClient = resolve; });
    const fresh = createFakeVoiceClient();
    const hook = renderHook(() => useVoiceRoom({ token: 'signed', api: createApi(), createClient: () => lazy }));
    act(() => { pending = hook.result.current.join('Ivan'); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    hook.unmount();
    await act(async () => { resolveClient(fresh.client); await pending; });
    expect(fresh.client.connect).not.toHaveBeenCalled();
    expect(fresh.client.disconnect).toHaveBeenCalledOnce();
  });

  it('does not connect a second room until old disconnect has settled', async () => {
    const old = createFakeVoiceClient(); const next = createFakeVoiceClient(); const api = createApi();
    vi.mocked(api.join).mockResolvedValueOnce(credentials).mockResolvedValue({ ...credentials, room: { id: 43, name: 'Lounge' } });
    let resolveDisconnect!: () => void;
    vi.mocked(old.client.disconnect).mockReturnValue(new Promise((resolve) => { resolveDisconnect = resolve; }));
    const factory = vi.fn().mockReturnValueOnce(old.client).mockReturnValueOnce(next.client);
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api, createClient: factory }));
    await act(async () => result.current.join('Ivan'));
    let pending!: Promise<void>;
    act(() => { pending = result.current.switchRoom(43); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(next.client.connect).not.toHaveBeenCalled();
    await act(async () => { resolveDisconnect(); await pending; });
    expect(next.client.connect).toHaveBeenCalledOnce();
  });
  it('preloads credentials and switches only after old cleanup, preserving name and both mutes without microphone publication', async () => {
    const old = createFakeVoiceClient();
    const next = createFakeVoiceClient();
    const api = createApi();
    vi.mocked(api.join).mockResolvedValueOnce(credentials).mockResolvedValueOnce({ ...credentials, room: { id: 43, name: 'Lounge' } });
    const factory = vi.fn().mockReturnValueOnce(old.client).mockReturnValueOnce(next.client);
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api, createClient: factory }));
    await act(async () => result.current.join('Ivan'));
    act(() => old.emit({ ...cameraOff, connection: 'connected', participants: [], localMuted: true, incomingMuted: true, localSharing: true, screenShareSupported: true, screens: [], needsAudioPermission: false }));
    vi.mocked(old.client.disconnect).mockImplementation(async () => {
      expect(api.join).toHaveBeenLastCalledWith('target', 'Ivan');
      expect(next.client.connect).not.toHaveBeenCalled();
    });
    vi.mocked(next.client.connect).mockImplementation(async () => {
      expect(old.unsubscribe).toHaveBeenCalledOnce();
      expect(old.client.disconnect).toHaveBeenCalledOnce();
      expect(next.client.setIncomingMuted).toHaveBeenCalledWith(true);
    });
    await act(async () => result.current.switchRoom(43));
    expect(next.client.enableMicrophone).not.toHaveBeenCalled();
    expect(next.client.setMuted).not.toHaveBeenCalled();
    expect(next.client.setScreenSharing).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({ phase: 'connected', roomId: 43, roomName: 'Lounge', localMuted: true, incomingMuted: true, localSharing: false, screens: [] });
    await act(async () => result.current.setMuted(false));
    expect(next.client.setMuted).toHaveBeenCalledWith(false);
    await act(async () => result.current.fetchInvite());
    expect(api.createInvite).toHaveBeenLastCalledWith('target', 43);
    act(() => old.emit({ ...cameraOff, connection: 'disconnected', participants: [], localMuted: false, incomingMuted: false, localSharing: false, screenShareSupported: true, screens: [], needsAudioPermission: false }));
    expect(result.current.state.phase).toBe('connected');
  });

  it('keeps the call connected on list or switch metadata errors', async () => {
    const voice = createFakeVoiceClient();
    const api = createApi();
    vi.mocked(api.listRooms).mockRejectedValue(new VoiceApiError('backend-unavailable'));
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api, createClient: () => voice.client }));
    await act(async () => result.current.join('Ivan'));
    expect(result.current.state.phase).toBe('connected');
    expect(result.current.state.roomsError).toBeTruthy();
    vi.mocked(api.listRooms).mockResolvedValue({ current_room_id: 42, rooms: [{ id: 42, name: 'General', online_count: 1 }, { id: 43, name: 'Lounge', online_count: 0 }] });
    await act(async () => result.current.refreshRooms());
    vi.mocked(api.join).mockRejectedValue(new VoiceApiError('backend-unavailable'));
    await act(async () => result.current.switchRoom(43));
    expect(result.current.state).toMatchObject({ phase: 'connected', roomId: 42, switching: false });
    expect(voice.client.disconnect).not.toHaveBeenCalled();
  });

  it('serializes switches and Leave cancels a pending invite before creating a client', async () => {
    const voice = createFakeVoiceClient();
    const api = createApi();
    let resolveInvite!: (value: Awaited<ReturnType<VoiceApi['createInvite']>>) => void;
    vi.mocked(api.createInvite).mockReturnValue(new Promise((resolve) => { resolveInvite = resolve; }));
    const factory = vi.fn(() => voice.client);
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api, createClient: factory }));
    await act(async () => result.current.join('Ivan'));
    let pending!: Promise<void>;
    act(() => { pending = result.current.switchRoom(43); });
    await act(async () => result.current.switchRoom(43));
    expect(api.createInvite).toHaveBeenCalledOnce();
    await act(async () => result.current.leave());
    await act(async () => { resolveInvite({ join_token: 'target', join_url: 'https://voice.test/join/target', room: { id: 43, name: 'Lounge' }, expires_in: 3600 }); await pending; });
    expect(factory).toHaveBeenCalledOnce();
    expect(api.join).toHaveBeenCalledOnce();
    expect(result.current.state.phase).toBe('left');
  });

  it('Leave cancels late initial credentials and late connect without requesting microphone', async () => {
    const voice = createFakeVoiceClient();
    const api = createApi();
    let resolveJoin!: (value: typeof credentials) => void;
    vi.mocked(api.join).mockReturnValueOnce(new Promise((resolve) => { resolveJoin = resolve; }));
    const factory = vi.fn(() => voice.client);
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api, createClient: factory }));
    let pending!: Promise<void>;
    act(() => { pending = result.current.join('Ivan'); });
    await act(async () => result.current.leave());
    await act(async () => { resolveJoin(credentials); await pending; });
    expect(factory).not.toHaveBeenCalled();
    let resolveConnect!: () => void;
    vi.mocked(voice.client.connect).mockReturnValueOnce(new Promise((resolve) => { resolveConnect = resolve; }));
    act(() => result.current.reset());
    act(() => { pending = result.current.join('Ivan'); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => result.current.leave());
    await act(async () => { resolveConnect(); await pending; });
    expect(voice.client.enableMicrophone).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe('left');
  });

  it('clears a failed target client and retries the target without retyping the name', async () => {
    const old = createFakeVoiceClient(); const failed = createFakeVoiceClient(); const retry = createFakeVoiceClient();
    const api = createApi();
    vi.mocked(api.join).mockResolvedValueOnce(credentials).mockResolvedValue({ ...credentials, room: { id: 43, name: 'Lounge' } });
    vi.mocked(failed.client.connect).mockRejectedValue(new Error('connect failed'));
    const factory = vi.fn().mockReturnValueOnce(old.client).mockReturnValueOnce(failed.client).mockReturnValueOnce(retry.client);
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api, createClient: factory }));
    await act(async () => result.current.join('Ivan'));
    await act(async () => result.current.switchRoom(43));
    expect(failed.client.disconnect).toHaveBeenCalledOnce();
    expect(result.current.state.phase).toBe('error');
    await act(async () => result.current.retry());
    expect(api.join).toHaveBeenLastCalledWith('target', 'Ivan');
    expect(result.current.state).toMatchObject({ phase: 'connected', roomId: 43 });
  });

  it('ignores a share invite resolving after a switch or Leave', async () => {
    const api = createApi(); const old = createFakeVoiceClient(); const next = createFakeVoiceClient();
    vi.mocked(api.join).mockResolvedValueOnce(credentials).mockResolvedValue({ ...credentials, room: { id: 43, name: 'Lounge' } });
    let resolveInvite!: (value: Awaited<ReturnType<VoiceApi['createInvite']>>) => void;
    vi.mocked(api.createInvite).mockReturnValueOnce(new Promise((resolve) => { resolveInvite = resolve; }));
    const factory = vi.fn().mockReturnValueOnce(old.client).mockReturnValueOnce(next.client);
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api, createClient: factory }));
    await act(async () => result.current.join('Ivan'));
    let pending!: Promise<void>;
    act(() => { pending = result.current.fetchInvite(); });
    await act(async () => result.current.switchRoom(43));
    await act(async () => { resolveInvite({ join_token: 'old', join_url: 'https://voice.test/join/old', room: { id: 42, name: 'General' }, expires_in: 3600 }); await pending; });
    expect(result.current.state.inviteUrl).toBeNull();
    vi.mocked(api.createInvite).mockReturnValueOnce(new Promise((resolve) => { resolveInvite = resolve; }));
    act(() => { pending = result.current.fetchInvite(); });
    await act(async () => result.current.leave());
    await act(async () => { resolveInvite({ join_token: 'new', join_url: 'https://voice.test/join/new', room: { id: 43, name: 'Lounge' }, expires_in: 3600 }); await pending; });
    expect(result.current.state).toMatchObject({ phase: 'left', inviteUrl: null });
  });
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
        ...cameraOff,
        participants: [
          { identity: 'max', displayName: 'Max', isLocal: false, isMuted: true, isSpeaking: false },
        ],
        localMuted: false,
        needsAudioPermission: false,
        incomingMuted: false, localSharing: false, screenShareSupported: true, screens: [],
      });
    });

    expect(result.current.state.phase).toBe('reconnecting');
    expect(result.current.state.participants[0]?.displayName).toBe('Max');
    expect(voice.client.connect).toHaveBeenCalledTimes(1);

    act(() => {
      voice.emit({
        connection: 'connected',
        ...cameraOff,
        participants: [],
        localMuted: false,
        needsAudioPermission: false,
        incomingMuted: false, localSharing: false, screenShareSupported: true, screens: [],
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
      ...createApi(),
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
        ...cameraOff,
        participants: [],
        localMuted: false,
        needsAudioPermission: false,
        incomingMuted: false, localSharing: false, screenShareSupported: true, screens: [],
      });
    });

    expect(result.current.state).toMatchObject({
      phase: 'error',
      error: 'Disconnected from the voice room. Try joining again.',
    });
  });

  it('keeps the room connected after chooser cancellation and prevents concurrent share toggles', async () => {
    const voice = createFakeVoiceClient();
    let rejectCapture!: (error: unknown) => void;
    vi.mocked(voice.client.setScreenSharing).mockReturnValue(new Promise((_, reject) => { rejectCapture = reject; }));
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api: createApi(), createClient: () => voice.client }));
    await act(async () => result.current.join('Ivan'));
    let pending!: Promise<void>;
    act(() => { pending = result.current.setScreenSharing(true); });
    expect(result.current.state.screenSharePending).toBe(true);
    await act(async () => result.current.setScreenSharing(true));
    expect(voice.client.setScreenSharing).toHaveBeenCalledOnce();
    await act(async () => { rejectCapture(new DOMException('Cancelled', 'NotAllowedError')); await pending; });
    expect(result.current.state).toMatchObject({ phase: 'connected', localSharing: false,
      screenSharePending: false, error: 'Screen sharing was cancelled or permission was denied. You can try again.' });
    expect(voice.client.disconnect).not.toHaveBeenCalled();
    await act(async () => { await result.current.setIncomingMuted(true); await result.current.setMuted(true); });
    expect(voice.client.setIncomingMuted).toHaveBeenCalledWith(true);
    expect(voice.client.setMuted).toHaveBeenCalledWith(true);
  });

  it('does not hide room controls on microphone toggle failure', async () => {
    const voice = createFakeVoiceClient();
    vi.mocked(voice.client.setMuted).mockRejectedValue(new Error('failed'));
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api: createApi(), createClient: () => voice.client }));
    await act(async () => result.current.join('Ivan'));
    await act(async () => result.current.setMuted(true));
    expect(result.current.state.phase).toBe('connected');
    expect(result.current.state.microphonePending).toBe(false);
    expect(result.current.state.error).toBeTruthy();
  });

  it('ignores a late chooser rejection after Leave', async () => {
    const voice = createFakeVoiceClient();
    let rejectCapture!: (error: unknown) => void;
    vi.mocked(voice.client.setScreenSharing).mockReturnValue(new Promise((_, reject) => { rejectCapture = reject; }));
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api: createApi(), createClient: () => voice.client }));
    await act(async () => result.current.join('Ivan'));
    let pending!: Promise<void>;
    act(() => { pending = result.current.setScreenSharing(true); });
    await act(async () => result.current.leave());
    await act(async () => { rejectCapture(new DOMException('Cancelled', 'AbortError')); await pending; });
    expect(result.current.state).toMatchObject({ phase: 'left', screenSharePending: false, error: null, screens: [] });
  });

  it('guards pending microphone toggles independently of incoming audio', async () => {
    const voice = createFakeVoiceClient();
    let resolveMute!: () => void;
    vi.mocked(voice.client.setMuted).mockReturnValue(new Promise((resolve) => { resolveMute = resolve; }));
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api: createApi(), createClient: () => voice.client }));
    await act(async () => result.current.join('Ivan'));
    let pending!: Promise<void>;
    act(() => { pending = result.current.setMuted(true); });
    expect(result.current.state.microphonePending).toBe(true);
    await act(async () => { await result.current.setMuted(true); await result.current.setIncomingMuted(true); });
    expect(voice.client.setMuted).toHaveBeenCalledOnce();
    expect(voice.client.setIncomingMuted).toHaveBeenCalledOnce();
    await act(async () => { resolveMute(); await pending; });
    expect(result.current.state.microphonePending).toBe(false);
  });

  it('takes sharing and independent mute states from snapshots and disconnects on unmount', async () => {
    const voice = createFakeVoiceClient();
    const { result, unmount } = renderHook(() => useVoiceRoom({ token: 'signed', api: createApi(), createClient: () => voice.client }));
    await act(async () => result.current.join('Ivan'));
    const screen = { id: 'screen', participantIdentity: 'ivan', displayName: 'Ivan', isLocal: true, element: document.createElement('video') };
    const snapshot: VoiceSnapshot = { ...cameraOff, connection: 'connected', participants: [], localMuted: true,
      incomingMuted: false, localSharing: true, screenShareSupported: true, screens: [screen], needsAudioPermission: false };
    act(() => voice.emit(snapshot));
    expect(result.current.state).toMatchObject({ localMuted: true, incomingMuted: false,
      localSharing: true, screens: [screen], screenShareSupported: true });
    act(() => voice.emit({ ...snapshot, localSharing: false, screens: [], incomingMuted: true }));
    expect(result.current.state).toMatchObject({ localMuted: true, incomingMuted: true, localSharing: false, screens: [] });
    unmount();
    expect(voice.unsubscribe).toHaveBeenCalledOnce();
    expect(voice.client.disconnect).toHaveBeenCalledOnce();
  });
});
