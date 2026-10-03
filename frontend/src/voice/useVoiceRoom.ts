import { useCallback, useEffect, useRef, useState } from 'react';
import { VoiceApiError, type VoiceApi, type JoinVoiceResponse, type ListRoomsResponse } from '../api/voiceApi';
import { voiceErrorMessage } from './errorMessages';
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
      error: 'Disconnected from the voice room. Try joining again.',
    };
  }

  if (snapshot.connection === 'reconnecting') {
    return { ...sharedState, phase: 'reconnecting', error: null };
  }

  if (previous.phase === 'reconnecting') {
    return { ...sharedState, phase: 'connected', error: null };
  }

  return sharedState;
}

export function useVoiceRoom({ token, api, createClient, onTokenChange }: UseVoiceRoomOptions) {
  const [state, setState] = useState<VoiceRoomState>(initialState);
  const clientRef = useRef<VoiceClient | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const joiningRef = useRef<number | null>(null);
  const connectingOperationRef = useRef<number | null>(null);
  const intentionalDisconnectRef = useRef(false);
  const microphonePendingRef = useRef(false);
  const incomingPendingRef = useRef(false);
  const screenSharePendingRef = useRef(false);
  const cameraPendingRef = useRef(false);
  const cameraOperationRef = useRef(0);
  const operationRef = useRef(0);
  const roomsRequestRef = useRef(0);
  const inviteRequestRef = useRef(0);
  const tokenRef = useRef(token);
  const nameRef = useRef('');
  const preferencesRef = useRef({ localMuted: false, incomingMuted: false });
  const cleanupRef = useRef<Promise<void> | null>(null);
  const cleanupClientRef = useRef<VoiceClient | null>(null);

  const cancelPendingRequests = useCallback(() => {
    ++operationRef.current;
    ++roomsRequestRef.current;
    ++inviteRequestRef.current;
  }, []);

  const releaseClient = useCallback(async () => {
    const unsubscribe = unsubscribeRef.current;
    const client = clientRef.current;
    unsubscribeRef.current = null;
    clientRef.current = null;
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

  const refreshRooms = useCallback(async () => {
    const operation = operationRef.current;
    const request = ++roomsRequestRef.current;
    const currentToken = tokenRef.current;
    setState((previous) => ({ ...previous, roomsPending: true, roomsError: null }));
    try {
      const listing = await api.listRooms(currentToken);
      if (operation !== operationRef.current || request !== roomsRequestRef.current) return;
      setState((previous) => ({ ...previous, rooms: listing.rooms, roomsPending: false }));
    } catch (error) {
      if (operation !== operationRef.current || request !== roomsRequestRef.current) return;
      setState((previous) => ({ ...previous, roomsPending: false, roomsError: voiceErrorMessage(error) }));
    }
  }, [api]);

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
    unsubscribeRef.current = client.subscribe((snapshot) => {
      if (clientRef.current !== client || intentionalDisconnectRef.current) return;
      // Remote media can emit the client's initial disconnected state during connect.
      if (snapshot.connection === 'disconnected' && !transportConnected) return;
      if (snapshot.connection !== 'disconnected') transportConnected = true;
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

      const operation = ++operationRef.current;
      joiningRef.current = operation;
      ++inviteRequestRef.current;
      nameRef.current = displayName;
      intentionalDisconnectRef.current = false;
      setState((previous) => ({ ...initialState, ...preferencesRef.current, roomId: previous.roomId,
        roomName: previous.roomName, phase: 'requestingCredentials' }));

      try {
        const credentials = await api.join(tokenRef.current, displayName);
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
          roomId: previous.roomId,
          roomName: previous.roomName,
          phase: 'error',
          error: voiceErrorMessage(error),
        }));
      } finally {
        if (operation === operationRef.current) intentionalDisconnectRef.current = false;
        if (joiningRef.current === operation) joiningRef.current = null;
      }
    },
    [api, connectClient, refreshRooms, releaseClient],
  );

  const switchRoom = useCallback(async (roomId: number) => {
    if (joiningRef.current || !clientRef.current || state.phase !== 'connected' ||
      microphonePendingRef.current || incomingPendingRef.current || roomId === state.roomId ||
      !state.rooms.some((room) => room.id === roomId)) return;
    const operation = ++operationRef.current;
    joiningRef.current = operation;
    ++roomsRequestRef.current;
    ++inviteRequestRef.current;
    setState((previous) => ({ ...previous, switching: true, roomsPending: false, inviteUrl: null, invitePending: false, inviteError: null, error: null }));
    let leavingOldRoom = false;
    try {
      const invite = await api.createInvite(tokenRef.current, roomId);
      if (operation !== operationRef.current) return;
      const credentials = await api.join(invite.join_token, nameRef.current);
      if (operation !== operationRef.current) return;
      if (credentials.room.id !== roomId) throw new VoiceApiError('invalid-response');
      leavingOldRoom = true;
      intentionalDisconnectRef.current = true;
      await releaseClient();
      if (operation !== operationRef.current) return;
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
        switching: false, error: voiceErrorMessage(error) }));
    } finally {
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
    intentionalDisconnectRef.current = true;
    cancelPendingRequests();
    // Metadata/factory results are cancellable immediately. A started transport
    // retains its lock until its late completion has also been disconnected.
    if (connectingOperationRef.current === null) joiningRef.current = null;
    setState({ ...initialState, phase: 'left' });
    await releaseClient().catch(() => undefined);
    intentionalDisconnectRef.current = false;
  }, [cancelPendingRequests, releaseClient]);

  const setMuted = useCallback(async (muted: boolean) => {
    const client = clientRef.current;
    if (!client || joiningRef.current || microphonePendingRef.current) {
      return;
    }
    microphonePendingRef.current = true;
    setState((previous) => ({ ...previous, microphonePending: true, error: null }));
    try {
      await client.setMuted(muted);
      if (clientRef.current === client) {
        preferencesRef.current.localMuted = muted;
        setState((previous) => ({ ...previous, localMuted: muted }));
      }
    } catch (error) {
      if (clientRef.current === client) {
        setState((previous) => ({ ...previous, error: voiceErrorMessage(error) }));
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
    try {
      await client.setIncomingMuted(muted);
      if (clientRef.current === client) {
        preferencesRef.current.incomingMuted = muted;
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
    intentionalDisconnectRef.current = false;
    preferencesRef.current = { localMuted: false, incomingMuted: false };
    setState(initialState);
  }, []);

  useEffect(() => {
    return () => {
      intentionalDisconnectRef.current = true;
      cancelPendingRequests();
      void releaseClient().catch(() => undefined);
    };
  }, [cancelPendingRequests, releaseClient]);

  const retry = useCallback(() => join(nameRef.current), [join]);

  return { state, join, leave, switchRoom, refreshRooms, fetchInvite, retry, setMuted, setIncomingMuted, setScreenSharing, setCameraEnabled, enableAudio, reset };
}
