import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceApi } from '../api/voiceApi';
import { voiceErrorMessage } from './errorMessages';
import type {
  VoiceClient,
  VoiceClientFactory,
  VoiceParticipant,
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
  participants: VoiceParticipant[];
  localMuted: boolean;
  needsAudioPermission: boolean;
  error: string | null;
};

type UseVoiceRoomOptions = {
  token: string;
  api: VoiceApi;
  createClient: VoiceClientFactory;
};

const initialState: VoiceRoomState = {
  phase: 'idle',
  roomName: '',
  participants: [],
  localMuted: false,
  needsAudioPermission: false,
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
  };

  if (snapshot.connection === 'disconnected') {
    return {
      ...sharedState,
      phase: 'error',
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

export function useVoiceRoom({ token, api, createClient }: UseVoiceRoomOptions) {
  const [state, setState] = useState<VoiceRoomState>(initialState);
  const clientRef = useRef<VoiceClient | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const joiningRef = useRef(false);
  const intentionalDisconnectRef = useRef(false);

  const releaseClient = useCallback(async () => {
    const unsubscribe = unsubscribeRef.current;
    const client = clientRef.current;
    unsubscribeRef.current = null;
    clientRef.current = null;
    unsubscribe?.();

    if (client) {
      try {
        await client.disconnect();
      } catch {
        // Local state is still cleared if the transport already disappeared.
      }
    }
  }, []);

  const handleSnapshot = useCallback((snapshot: VoiceSnapshot) => {
    if (intentionalDisconnectRef.current) {
      return;
    }
    setState((previous) => applySnapshot(previous, snapshot));
  }, []);

  const join = useCallback(
    async (displayName: string) => {
      if (joiningRef.current || clientRef.current) {
        return;
      }

      joiningRef.current = true;
      intentionalDisconnectRef.current = false;
      setState({ ...initialState, phase: 'requestingCredentials' });

      try {
        const credentials = await api.join(token, displayName);
        setState((previous) => ({
          ...previous,
          phase: 'connecting',
          roomName: credentials.room.name,
        }));

        const client = await createClient();
        clientRef.current = client;
        unsubscribeRef.current = client.subscribe(handleSnapshot);

        await client.connect(credentials.livekit_url, credentials.access_token);
        setState((previous) => ({ ...previous, phase: 'requestingMicrophone' }));

        await client.enableMicrophone();
        setState((previous) => ({ ...previous, phase: 'connected', error: null }));
      } catch (error) {
        intentionalDisconnectRef.current = true;
        await releaseClient();
        setState({
          ...initialState,
          phase: 'error',
          error: voiceErrorMessage(error),
        });
      } finally {
        intentionalDisconnectRef.current = false;
        joiningRef.current = false;
      }
    },
    [api, createClient, handleSnapshot, releaseClient, token],
  );

  const leave = useCallback(async () => {
    intentionalDisconnectRef.current = true;
    joiningRef.current = false;
    await releaseClient();
    setState({ ...initialState, phase: 'left' });
    intentionalDisconnectRef.current = false;
  }, [releaseClient]);

  const setMuted = useCallback(async (muted: boolean) => {
    try {
      await clientRef.current?.setMuted(muted);
    } catch (error) {
      setState((previous) => ({
        ...previous,
        phase: 'error',
        error: voiceErrorMessage(error),
      }));
    }
  }, []);

  const enableAudio = useCallback(async () => {
    try {
      await clientRef.current?.enableAudio();
    } catch {
      setState((previous) => ({
        ...previous,
        error: 'Audio could not start. Tap Enable audio to try again.',
      }));
    }
  }, []);

  const reset = useCallback(() => {
    joiningRef.current = false;
    intentionalDisconnectRef.current = false;
    setState(initialState);
  }, []);

  useEffect(() => {
    return () => {
      intentionalDisconnectRef.current = true;
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      const client = clientRef.current;
      clientRef.current = null;
      if (client) {
        void client.disconnect();
      }
    };
  }, []);

  return { state, join, leave, setMuted, enableAudio, reset };
}
