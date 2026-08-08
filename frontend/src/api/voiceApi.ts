export type JoinVoiceResponse = {
  livekit_url: string;
  access_token: string;
  room: {
    id: number;
    name: string;
  };
  participant: {
    identity: string;
    display_name: string;
  };
};

export type VoiceApiErrorCode =
  | 'invalid-invite'
  | 'backend-unavailable'
  | 'invalid-response';

export class VoiceApiError extends Error {
  constructor(public readonly code: VoiceApiErrorCode) {
    super(code);
    this.name = 'VoiceApiError';
  }
}

export interface VoiceApi {
  join(joinToken: string, displayName: string): Promise<JoinVoiceResponse>;
}

export type VoiceApiConfig = {
  apiUrl: string;
  useMock: boolean;
  devLiveKitUrl?: string;
  devLiveKitToken?: string;
};

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isJoinVoiceResponse(value: unknown): value is JoinVoiceResponse {
  if (!isRecord(value) || !isRecord(value.room) || !isRecord(value.participant)) {
    return false;
  }

  return (
    typeof value.livekit_url === 'string' &&
    typeof value.access_token === 'string' &&
    typeof value.room.id === 'number' &&
    typeof value.room.name === 'string' &&
    typeof value.participant.identity === 'string' &&
    typeof value.participant.display_name === 'string'
  );
}

function createMockApi(config: VoiceApiConfig): VoiceApi {
  return {
    async join(_joinToken, displayName) {
      return {
        livekit_url: config.devLiveKitUrl || 'wss://rtc.example.invalid',
        access_token: config.devLiveKitToken || 'mock-livekit-token',
        room: { id: 42, name: 'General' },
        participant: {
          identity: `guest_${crypto.randomUUID().slice(0, 8)}`,
          display_name: displayName,
        },
      };
    },
  };
}

export function createVoiceApi(
  config: VoiceApiConfig,
  fetchImpl: FetchLike = globalThis.fetch,
): VoiceApi {
  if (config.useMock) {
    return createMockApi(config);
  }

  return {
    async join(joinToken, displayName) {
      let response: Response;

      try {
        const baseUrl = config.apiUrl.replace(/\/+$/, '');
        response = await fetchImpl(`${baseUrl}/api/voice/join`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            join_token: joinToken,
            display_name: displayName,
          }),
        });
      } catch {
        throw new VoiceApiError('backend-unavailable');
      }

      if ([401, 403, 404].includes(response.status)) {
        throw new VoiceApiError('invalid-invite');
      }
      if (!response.ok) {
        throw new VoiceApiError('backend-unavailable');
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new VoiceApiError('invalid-response');
      }

      if (!isJoinVoiceResponse(body)) {
        throw new VoiceApiError('invalid-response');
      }

      return body;
    },
  };
}
