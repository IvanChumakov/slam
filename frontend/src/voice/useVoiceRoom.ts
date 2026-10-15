import { useCallback, useEffect, useRef, useState } from 'react';
import { VoiceApiError, type VoiceApi, type JoinVoiceResponse, type ListRoomsResponse } from '../api/voiceApi';
import { voiceErrorMessage } from './errorMessages';
import { createRoomSounds } from './roomSounds';
import { VoiceClientError } from './types';
import type {
  VoiceClient,
  VoiceClientFactory,
  VoiceParticipant,
  VoiceScreen,
  VoiceSnapshot,
} from './types';

export type VoiceRoomPhase =
  | 'idle'
  | 'requestingCredentials'
  | 'connecting'
  | 'requestingMicrophone'
  | 'connected'
  | 'reconnecting'
  | 'left'
  | 'error';

export type VoiceRoomState = {
  phase: VoiceRoomPhase;
  roomName: string;
  roomId: number | null;
  rooms: ListRoomsResponse['rooms'];
  roomsPending: boolean;
  roomsError: string | null;
  switching: boolean;
  inviteUrl: string | null;
  invitePending: boolean;
  inviteError: string | null;
  participants: VoiceParticipant[];
  localMuted: boolean;
  needsAudioPermission: boolean;
  incomingMuted: boolean;
  soundsEnabled: boolean;
  localSharing: boolean;
  screenShareSupported: boolean;
  screens: VoiceScreen[];
  localCamera: boolean;
  cameraSupported: boolean;
  cameras: VoiceScreen[];
  cameraPending: boolean;
  screenSharePending: boolean;
  microphonePending: boolean;
  error: string | null;
};

type UseVoiceRoomOptions = {
  token: string;
  api: VoiceApi;
  createClient: VoiceClientFactory;
  onTokenChange?: (token: string) => void;
  telegramInitData?: string;
};

const initialState: VoiceRoomState = {
  phase: 'idle',
  roomName: '',
  roomId: null,
  rooms: [],
  roomsPending: false,
  roomsError: null,
  switching: false,
  inviteUrl: null,
  invitePending: false,
  inviteError: null,
  participants: [],
  localMuted: false,
  needsAudioPermission: false,
  incomingMuted: false,
  soundsEnabled: true,
  localSharing: false,
  screenShareSupported: false,
  screens: [],
  localCamera: false,
  cameraSupported: false,
  cameras: [],
  cameraPending: false,
  screenSharePending: false,
  microphonePending: false,
  error: null,
};

function connectionErrorMessage(error: unknown): string {
  if (error instanceof VoiceApiError) {
    if (error.code === 'join-timeout') return 'The voice API did not respond within 30 seconds. Try again.';
    if (error.code === 'join-cancelled') return 'The voice API join request was cancelled. Try again.';
  }
  if (error instanceof VoiceClientError) {
    if (error.stage === 'microphone' && error.code === 'permission-denied') {
      return 'Microphone access was denied. Allow access in your browser and try again.';
    }
    const stage = { signaling: 'Voice signaling connection', rtc: 'Voice RTC connection setup', microphone: 'Microphone setup', unknown: 'Voice connection' }[error.stage];
    return `${stage} failed (${error.code}${error.disconnectReason ? `; ${error.disconnectReason}` : ''}). Try again.`;
  }
  return voiceErrorMessage(error);
}

function applySnapshot(
  previous: VoiceRoomState,
  snapshot: VoiceSnapshot,
): VoiceRoomState {
  const sharedState = {
    ...previous,
    participants: snapshot.participants,
    localMuted: snapshot.localMuted,
    needsAudioPermission: snapshot.needsAudioPermission,
    incomingMuted: snapshot.incomingMuted,
    localSharing: snapshot.localSharing,
    screenShareSupported: snapshot.screenShareSupported,
    screens: snapshot.screens,
    localCamera: snapshot.localCamera,
    cameraSupported: snapshot.cameraSupported,
    cameras: snapshot.cameras,
  };

  if (snapshot.connection === 'disconnected') {
    return {
      ...sharedState,
      phase: 'error',
      localCamera: false,
      cameras: [],
      cameraPending: false,
      participants: snapshot.participants.map((participant) => ({ ...participant, isSpeaking: false })),
      error: snapshot.disconnectReason
        ? `Disconnected from the voice room (${snapshot.disconnectReason}). Try joining again.`
        : 'Disconnected from the voice room. Try joining again.',
    };
  }

  if (snapshot.connection === 'reconnecting') {
    return { ...sharedState, phase: 'reconnecting', roomsPending: false, error: null };
  }

  if (previous.phase === 'reconnecting') {
    return { ...sharedState, phase: 'connected', error: null };
  }

  return sharedState;
}

export function useVoiceRoom({ token, api, createClient, onTokenChange, telegramInitData }: UseVoiceRoomOptions) {
  const [state, setState] = useState<VoiceRoomState>(initialState);
  const clientRef = useRef<VoiceClient | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const joiningRef = useRef<number | null>(null);
  const joinAbortRef = useRef<AbortController | null>(null);
  const connectingOperationRef = useRef<number | null>(null);
  const intentionalDisconnectRef = useRef(false);
  const microphonePendingRef = useRef(false);
  const incomingPendingRef = useRef(false);
  const screenSharePendingRef = useRef(false);
  const cameraPendingRef = useRef(false);
  const cameraOperationRef = useRef(0);
  const operationRef = useRef(0);
  const roomsRequestRef = useRef(0);
  const roomsInFlightRef = useRef(0);
  const inviteRequestRef = useRef(0);
  const tokenRef = useRef(token);
  const profileContextRef = useRef<{ initData?: string } | null>(null);
  const nameRef = useRef('');
  const preferencesRef = useRef({ localMuted: false, incomingMuted: false });
  const cleanupRef = useRef<Promise<void> | null>(null);
  const cleanupClientRef = useRef<VoiceClient | null>(null);
  const soundsRef = useRef<ReturnType<typeof createRoomSounds> | null>(null);
  const soundsEnabledRef = useRef(true);
  const soundConnectedRef = useRef(false);

  const setSoundsEnabled = useCallback((enabled: boolean) => {
    soundsEnabledRef.current = enabled;
    soundsRef.current?.setEnabled(enabled);
    if (enabled) soundsRef.current?.unlock();
    setState((previous) => ({ ...previous, soundsEnabled: enabled }));
  }, []);

  const cancelPendingRequests = useCallback(() => {
    joinAbortRef.current?.abort();
    joinAbortRef.current = null;
    ++operationRef.current;
    ++roomsRequestRef.current;
    ++inviteRequestRef.current;
  }, []);

  const releaseClient = useCallback(async () => {
    const unsubscribe = unsubscribeRef.current;
    const client = clientRef.current;
    unsubscribeRef.current = null;
    clientRef.current = null;
    soundConnectedRef.current = false;
    microphonePendingRef.current = false;
    incomingPendingRef.current = false;
    screenSharePendingRef.current = false;
    cameraPendingRef.current = false;
    ++cameraOperationRef.current;
    unsubscribe?.();

    if (client) cleanupClientRef.current = client;
    if (!cleanupRef.current && cleanupClientRef.current) {
      const retiringClient = cleanupClientRef.current;
      // Retain failed teardown ownership, but share an in-flight cleanup attempt.
      cleanupRef.current = retiringClient.disconnect().then(() => {
        cleanupClientRef.current = null;
      }).finally(() => {
        cleanupRef.current = null;
      });
    }
    await cleanupRef.current;
  }, []);

  const loadRooms = useCallback(async (background: boolean, isActive: () => boolean = () => true) => {
    if (background && roomsInFlightRef.current > 0) return;
    const operation = operationRef.current;
    const request = ++roomsRequestRef.current;
    const currentToken = tokenRef.current;
    ++roomsInFlightRef.current;
    // Keep last-known counts marked stale until a verified listing succeeds.
    if (!background) setState((previous) => ({ ...previous, roomsPending: true }));
    try {
      const listing = await api.listRooms(currentToken);
      if (!isActive() || operation !== operationRef.current || request !== roomsRequestRef.current) return;
      setState((previous) => ({ ...previous, rooms: listing.rooms, roomsPending: false, roomsError: null }));
    } catch (error) {
      if (!isActive() || operation !== operationRef.current || request !== roomsRequestRef.current) return;
      setState((previous) => ({ ...previous, roomsPending: false, roomsError: voiceErrorMessage(error) }));
    } finally {
      --roomsInFlightRef.current;
    }
  }, [api]);

  const refreshRooms = useCallback(() => loadRooms(false), [loadRooms]);

  useEffect(() => {
    if (state.phase !== 'connected' || state.switching) return;
    let active = true;
    const operation = operationRef.current;
    const timer = window.setInterval(() => {
      if (operation !== operationRef.current || joiningRef.current || !clientRef.current) return;
      void loadRooms(true, () => active);
    }, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [loadRooms, state.phase, state.roomId, state.switching]);

  const connectClient = useCallback(async (credentials: JoinVoiceResponse, operation: number) => {
    const preferences = { ...preferencesRef.current };
    await releaseClient();
    if (operation !== operationRef.current) return;
    const client = await createClient();
    if (operation !== operationRef.current) {
      await client.disconnect();
      return;
    }
    clientRef.current = client;
    // Initialize receiver silence before connect can attach any remote tracks.
    if (preferences.incomingMuted) await client.setIncomingMuted(true);
    if (operation !== operationRef.current) return;
    let ready = false;
    let transportConnected = false;
    let lastSnapshot: VoiceSnapshot | null = null;
    let membershipGeneration = 0;
    unsubscribeRef.current = client.subscribe((snapshot) => {
      if (clientRef.current !== client || intentionalDisconnectRef.current) return;
      // Remote media can emit the client's initial disconnected state during connect.
      if (snapshot.connection === 'disconnected' && !transportConnected) return;
      if (snapshot.connection !== 'disconnected') transportConnected = true;
      if (snapshot.connection !== 'connected') {
        ++membershipGeneration;
        ++roomsRequestRef.current;
      }
      if (ready && snapshot.connection === 'connected' && lastSnapshot?.connection === 'connected') {
        const previous = new Set(lastSnapshot.participants.filter((participant) => !participant.isLocal).map((participant) => participant.identity));
        const current = new Set(snapshot.participants.filter((participant) => !participant.isLocal).map((participant) => participant.identity));
        const joined = [...current].some((identity) => !previous.has(identity));
        const left = [...previous].some((identity) => !current.has(identity));
        if (joined || left) {
          const generation = membershipGeneration;
          // LiveKit removes participants before emitting Reconnecting on a full restart.
          queueMicrotask(() => {
            if (clientRef.current !== client || intentionalDisconnectRef.current || generation !== membershipGeneration) return;
            if (joined) soundsRef.current?.play('participantJoin');
            if (left) soundsRef.current?.play('participantLeave');
          });
        }
      }
      lastSnapshot = snapshot;
      if (ready) preferencesRef.current = { localMuted: snapshot.localMuted, incomingMuted: snapshot.incomingMuted };
      setState((previous) => applySnapshot(previous, snapshot));
      if (snapshot.connection === 'disconnected') {
        cancelPendingRequests();
        if (connectingOperationRef.current === null) joiningRef.current = null;
        void releaseClient().catch(() => undefined);
      }
    });
    connectingOperationRef.current = operation;
    try {
      await client.connect(credentials.livekit_url, credentials.access_token);
      transportConnected = true;
      if (operation !== operationRef.current) {
        await client.disconnect();
        return;
      }
      // A muted switch must never capture/publish and then mute the microphone.
      if (!preferences.localMuted) {
        setState((previous) => ({ ...previous, phase: 'requestingMicrophone' }));
        await client.enableMicrophone();
        if (operation !== operationRef.current) {
          await client.disconnect();
          return;
        }
      }
      ready = true;
      soundConnectedRef.current = true;
      soundsRef.current?.play('join');
      setState((previous) => ({ ...previous, ...preferences, phase: 'connected', switching: false, error: null }));
    } finally {
      if (connectingOperationRef.current === operation) connectingOperationRef.current = null;
    }
  }, [cancelPendingRequests, createClient, releaseClient]);

  const join = useCallback(
    async (displayName: string) => {
      if (joiningRef.current || clientRef.current) {
        return;
      }

      soundsRef.current?.unlock();

      const operation = ++operationRef.current;
      joinAbortRef.current?.abort();
      const joinAbort = new AbortController();
      joinAbortRef.current = joinAbort;
      joiningRef.current = operation;
      ++inviteRequestRef.current;
      nameRef.current = displayName;
      intentionalDisconnectRef.current = false;
      setState((previous) => ({ ...initialState, ...preferencesRef.current, soundsEnabled: soundsEnabledRef.current, roomId: previous.roomId,
        roomName: previous.roomName, phase: 'requestingCredentials' }));

      try {
        profileContextRef.current ??= { initData: telegramInitData };
        const selectedProfile = profileContextRef.current.initData;
        const credentials = await api.join(tokenRef.current, displayName, selectedProfile, joinAbort.signal);
        if (operation !== operationRef.current) return;
        setState((previous) => ({
          ...previous,
          phase: 'connecting',
          roomName: credentials.room.name,
          roomId: credentials.room.id,
        }));

        await connectClient(credentials, operation);
        if (operation === operationRef.current) void refreshRooms();
      } catch (error) {
        if (operation !== operationRef.current) return;
        intentionalDisconnectRef.current = true;
        if (clientRef.current) await releaseClient().catch(() => undefined);
        if (operation !== operationRef.current) return;
        setState((previous) => ({
          ...initialState,
          ...preferencesRef.current,
          soundsEnabled: soundsEnabledRef.current,
          roomId: previous.roomId,
          roomName: previous.roomName,
          phase: 'error',
          error: connectionErrorMessage(error),
        }));
      } finally {
        if (joinAbortRef.current === joinAbort) joinAbortRef.current = null;
        if (operation === operationRef.current) intentionalDisconnectRef.current = false;
        if (joiningRef.current === operation) joiningRef.current = null;
      }
    },
    [api, connectClient, refreshRooms, releaseClient, telegramInitData],
  );

  const switchRoom = useCallback(async (roomId: number) => {
    if (joiningRef.current || !clientRef.current || state.phase !== 'connected' ||
      microphonePendingRef.current || incomingPendingRef.current || roomId === state.roomId ||
      !state.rooms.some((room) => room.id === roomId)) return;
    soundsRef.current?.unlock();
    const operation = ++operationRef.current;
    joinAbortRef.current?.abort();
    const joinAbort = new AbortController();
    joinAbortRef.current = joinAbort;
    joiningRef.current = operation;
    ++roomsRequestRef.current;
    ++inviteRequestRef.current;
    setState((previous) => ({ ...previous, switching: true, roomsPending: false, inviteUrl: null, invitePending: false, inviteError: null, error: null }));
    let leavingOldRoom = false;
    try {
      const invite = await api.createInvite(tokenRef.current, roomId);
      if (operation !== operationRef.current) return;
      const selectedProfile = profileContextRef.current?.initData;
      const credentials = await api.join(invite.join_token, nameRef.current, selectedProfile, joinAbort.signal);
      if (operation !== operationRef.current) return;
      if (credentials.room.id !== roomId) throw new VoiceApiError('invalid-response');
      leavingOldRoom = true;
      intentionalDisconnectRef.current = true;
      const wasConnected = soundConnectedRef.current;
      await releaseClient();
      if (operation !== operationRef.current) return;
      if (wasConnected) soundsRef.current?.play('leave');
      tokenRef.current = invite.join_token;
      onTokenChange?.(invite.join_token);
      intentionalDisconnectRef.current = false;
      setState((previous) => ({ ...previous, phase: 'connecting', roomId, roomName: credentials.room.name,
        participants: [], localSharing: false, screens: [], screenSharePending: false, microphonePending: false,
        localCamera: false, cameraSupported: false, cameras: [], cameraPending: false, needsAudioPermission: false }));
      await connectClient(credentials, operation);
      if (operation === operationRef.current) void refreshRooms();
    } catch (error) {
      if (operation !== operationRef.current) return;
      if (leavingOldRoom && clientRef.current) await releaseClient().catch(() => undefined);
      if (operation !== operationRef.current) return;
      setState((previous) => ({ ...previous, phase: leavingOldRoom ? 'error' : previous.phase,
        ...(leavingOldRoom ? { localCamera: false, cameras: [], cameraPending: false } : {}),
        switching: false, error: connectionErrorMessage(error) }));
    } finally {
      if (joinAbortRef.current === joinAbort) joinAbortRef.current = null;
      if (operation === operationRef.current) intentionalDisconnectRef.current = false;
      if (joiningRef.current === operation) joiningRef.current = null;
    }
  }, [api, connectClient, onTokenChange, refreshRooms, releaseClient, state.phase, state.roomId, state.rooms]);

  const fetchInvite = useCallback(async () => {
    if (!clientRef.current || joiningRef.current || state.roomId === null || state.phase !== 'connected' || state.invitePending) return;
    const operation = operationRef.current;
    const request = ++inviteRequestRef.current;
    setState((previous) => ({ ...previous, invitePending: true, inviteUrl: null, inviteError: null }));
    try {
      const invite = await api.createInvite(tokenRef.current, state.roomId);
      if (operation !== operationRef.current || request !== inviteRequestRef.current) return;
      if (invite.room.id !== state.roomId) throw new VoiceApiError('invalid-response');
      setState((previous) => ({ ...previous, inviteUrl: invite.join_url, invitePending: false }));
    } catch (error) {
      if (operation !== operationRef.current || request !== inviteRequestRef.current) return;
      setState((previous) => ({ ...previous, invitePending: false, inviteError: voiceErrorMessage(error) }));
    }
  }, [api, state.invitePending, state.phase, state.roomId]);

  const leave = useCallback(async () => {
    soundsRef.current?.unlock();
    const wasConnected = soundConnectedRef.current;
    intentionalDisconnectRef.current = true;
    cancelPendingRequests();
    const operation = operationRef.current;
    // Metadata/factory results are cancellable immediately. A started transport
    // retains its lock until its late completion has also been disconnected.
    if (connectingOperationRef.current === null) joiningRef.current = null;
    setState({ ...initialState, soundsEnabled: soundsEnabledRef.current, phase: 'left' });
    await releaseClient().then(() => {
      if (wasConnected && operation === operationRef.current) soundsRef.current?.play('leave');
    }).catch(() => undefined);
    intentionalDisconnectRef.current = false;
  }, [cancelPendingRequests, releaseClient]);

  const setMuted = useCallback(async (muted: boolean) => {
    const client = clientRef.current;
    if (!client || joiningRef.current || microphonePendingRef.current) {
      return;
    }
    microphonePendingRef.current = true;
    soundsRef.current?.unlock();
    const changed = preferencesRef.current.localMuted !== muted;
    setState((previous) => ({ ...previous, microphonePending: true, error: null }));
    try {
      await client.setMuted(muted);
      if (clientRef.current === client) {
        preferencesRef.current.localMuted = muted;
        if (changed) soundsRef.current?.play(muted ? 'mute' : 'unmute');
        setState((previous) => ({ ...previous, localMuted: muted }));
      }
    } catch (error) {
      if (clientRef.current === client) {
        setState((previous) => ({ ...previous, error: connectionErrorMessage(error) }));
      }
    } finally {
      if (clientRef.current === client) {
        microphonePendingRef.current = false;
        setState((previous) => ({ ...previous, microphonePending: false }));
      }
    }
  }, []);

  const setIncomingMuted = useCallback(async (muted: boolean) => {
    const client = clientRef.current;
    if (!client || joiningRef.current || incomingPendingRef.current) {
      return;
    }
    incomingPendingRef.current = true;
    soundsRef.current?.unlock();
    const changed = preferencesRef.current.incomingMuted !== muted;
    try {
      await client.setIncomingMuted(muted);
      if (clientRef.current === client) {
        preferencesRef.current.incomingMuted = muted;
        if (changed) soundsRef.current?.play(muted ? 'audioOff' : 'audioOn');
        setState((previous) => ({ ...previous, incomingMuted: muted }));
      }
    } catch {
      if (clientRef.current === client) {
        setState((previous) => ({ ...previous, error: 'Room audio could not be changed. Try again.' }));
      }
    } finally {
      if (clientRef.current === client) incomingPendingRef.current = false;
    }
  }, []);

  const setScreenSharing = useCallback(async (sharing: boolean) => {
    const client = clientRef.current;
    if (!client || joiningRef.current || screenSharePendingRef.current) {
      return;
    }
    screenSharePendingRef.current = true;
    setState((previous) => ({ ...previous, screenSharePending: true, error: null }));
    try {
      await client.setScreenSharing(sharing);
    } catch (error) {
      if (clientRef.current === client) {
        const cancelled =
          (error instanceof DOMException || error instanceof Error) &&
          (error.name === 'NotAllowedError' || error.name === 'AbortError');
        setState((previous) => ({
          ...previous,
          error: cancelled
            ? 'Screen sharing was cancelled or permission was denied. You can try again.'
            : 'Screen sharing could not be changed. Try again in a supported browser over HTTPS or localhost.',
        }));
      }
    } finally {
      if (clientRef.current === client) {
        screenSharePendingRef.current = false;
        setState((previous) => ({ ...previous, screenSharePending: false }));
      }
    }
  }, []);

  const enableAudio = useCallback(async () => {
    const client = clientRef.current;
    if (!client || joiningRef.current) return;
    soundsRef.current?.unlock();
    try {
      await client.enableAudio();
    } catch {
      if (clientRef.current !== client) return;
      setState((previous) => ({
        ...previous,
        error: 'Audio could not start. Tap Enable audio to try again.',
      }));
    }
  }, []);

  const setCameraEnabled = useCallback(async (enabled: boolean) => {
    const client = clientRef.current;
    if (!client || (enabled && (joiningRef.current || cameraPendingRef.current || state.phase !== 'connected'))) return;
    const operation = ++cameraOperationRef.current;
    cameraPendingRef.current = true;
    setState((previous) => ({ ...previous, cameraPending: true, error: null }));
    try {
      await client.setCameraEnabled(enabled);
    } catch (error) {
      if (clientRef.current === client && operation === cameraOperationRef.current) {
        const denied = error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'AbortError');
        setState((previous) => ({ ...previous, error: denied
          ? 'Camera access was cancelled or permission was denied. You can try again.'
          : 'Camera could not be changed. Check your device and use a supported browser over HTTPS or localhost.' }));
      }
    } finally {
      if (clientRef.current === client && operation === cameraOperationRef.current) {
        cameraPendingRef.current = false;
        setState((previous) => ({ ...previous, cameraPending: false }));
      }
    }
  }, [state.phase]);

  const reset = useCallback(() => {
    profileContextRef.current = null;
    intentionalDisconnectRef.current = false;
    preferencesRef.current = { localMuted: false, incomingMuted: false };
    setState({ ...initialState, soundsEnabled: soundsEnabledRef.current });
  }, []);

  useEffect(() => {
    const sounds = createRoomSounds();
    sounds.setEnabled(soundsEnabledRef.current);
    soundsRef.current = sounds;
    return () => {
      sounds.dispose();
      soundsRef.current = null;
      intentionalDisconnectRef.current = true;
      cancelPendingRequests();
      void releaseClient().catch(() => undefined);
    };
  }, [cancelPendingRequests, releaseClient]);

  const retry = useCallback(() => join(nameRef.current), [join]);

  return { state, join, leave, switchRoom, refreshRooms, fetchInvite, retry, setMuted, setIncomingMuted, setSoundsEnabled, setScreenSharing, setCameraEnabled, enableAudio, reset };
}
