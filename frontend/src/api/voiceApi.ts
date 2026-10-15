export type VoiceRoomInfo = { id: number; name: string };
export type ChannelParticipant = { identity: string; display_name: string };
export type ChannelInfo = VoiceRoomInfo & { online_count: number; participants: ChannelParticipant[] };
export type ListRoomsResponse = {
  current_room_id: number;
  rooms: ChannelInfo[];
};
export type CreateInviteResponse = {
  join_token: string;
  join_url: string;
  room: VoiceRoomInfo;
  expires_in: number;
};

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
  | 'join-timeout'
  | 'join-cancelled'
  | 'invalid-response';

export class VoiceApiError extends Error {
  constructor(public readonly code: VoiceApiErrorCode, public readonly status?: number) {
    super(code);
    this.name = 'VoiceApiError';
  }
}

export interface VoiceApi {
  join(joinToken: string, displayName: string, telegramInitData?: string, signal?: AbortSignal): Promise<JoinVoiceResponse>;
  listRooms(joinToken: string): Promise<ListRoomsResponse>;
  createInvite(joinToken: string, roomId: number): Promise<CreateInviteResponse>;
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
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRoom(value: unknown): value is VoiceRoomInfo {
  return isRecord(value) && Number.isSafeInteger(value.id) && (value.id as number) > 0 && isNonemptyString(value.name);
}

function isListRoomsResponse(value: unknown): value is ListRoomsResponse {
  if (!isRecord(value) || !Array.isArray(value.rooms)) return false;
  return value.rooms.every(isChannel) &&
    value.rooms.some((room: VoiceRoomInfo) => room.id === value.current_room_id) &&
    new Set(value.rooms.map((room: VoiceRoomInfo) => room.id)).size === value.rooms.length;
}

function isChannel(value: unknown): value is ChannelInfo {
  if (!isRecord(value)) return false;
  const { online_count, participants } = value;
  if (!isRoom(value) || !Number.isSafeInteger(online_count) ||
    (online_count as number) < 0 || !Array.isArray(participants)) return false;
  if (!participants.every((participant: unknown): participant is ChannelParticipant =>
    isRecord(participant) && isNonemptyString(participant.identity) && isNonemptyString(participant.display_name))) return false;
  return participants.length === online_count &&
    new Set(participants.map((participant) => participant.identity)).size === participants.length;
}

function isCreateInviteResponse(value: unknown, roomId: number): value is CreateInviteResponse {
  if (!isRecord(value) || !isRoom(value.room) || value.room.id !== roomId ||
    !isNonemptyString(value.join_token) || !isNonemptyString(value.join_url) ||
    !Number.isSafeInteger(value.expires_in) || (value.expires_in as number) <= 0) return false;
  try {
    const url = new URL(value.join_url);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password &&
      url.pathname === `/join/${encodeURIComponent(value.join_token)}`;
  } catch {
    return false;
  }
}

function isJoinVoiceResponse(value: unknown): value is JoinVoiceResponse {
  if (!isRecord(value) || !isRoom(value.room) || !isRecord(value.participant)) {
    return false;
  }

  return (
    isNonemptyString(value.livekit_url) &&
    isNonemptyString(value.access_token) &&
    isNonemptyString(value.participant.identity) &&
    isNonemptyString(value.participant.display_name)
  );
}

function createMockApi(config: VoiceApiConfig): VoiceApi {
  const rooms: ChannelInfo[] = [{ id: 42, name: 'General', online_count: 0, participants: [] }, { id: 43, name: 'Lounge', online_count: 0, participants: [] }];
  const roomForToken = (token: string) => {
    const match = /^mock-room-(\d+)-/.exec(token);
    const room = rooms.find((room) => room.id === (match ? Number(match[1]) : 42));
    if (!room) throw new VoiceApiError('invalid-invite');
    return room;
  };
  return {
    async listRooms(joinToken) {
      return { current_room_id: roomForToken(joinToken).id, rooms: rooms.map((room) => ({ ...room })) };
    },
    async createInvite(joinToken, roomId) {
      roomForToken(joinToken);
      const room = rooms.find((room) => room.id === roomId);
      if (!room) throw new VoiceApiError('invalid-invite');
      const token = `mock-room-${roomId}-${crypto.randomUUID()}`;
      return { join_token: token, join_url: `${globalThis.location.origin}/join/${token}`, room: { id: room.id, name: room.name }, expires_in: 3600 };
    },
    async join(joinToken, displayName) {
      const room = roomForToken(joinToken);
      return {
        livekit_url: config.devLiveKitUrl || 'wss://rtc.example.invalid',
        access_token: config.devLiveKitToken || 'mock-livekit-token',
        room: { id: room.id, name: room.name },
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

  async function post<T>(path: string, payload: object, validate: (value: unknown) => value is T, signal?: AbortSignal): Promise<T> {
    const controller = path === 'join' ? new AbortController() : undefined;
    if (controller && signal?.aborted) throw new VoiceApiError('join-cancelled');
    let status: number | undefined;
    let cancelled: VoiceApiError | undefined;
    let rejectCancellation: (error: VoiceApiError) => void = () => undefined;
    const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject; });
    const cancel = (code: 'join-timeout' | 'join-cancelled') => {
      if (cancelled) return;
      cancelled = new VoiceApiError(code, status);
      rejectCancellation(cancelled);
      controller?.abort();
    };
    const onAbort = () => cancel('join-cancelled');
    const timer = controller ? setTimeout(() => cancel('join-timeout'), 30_000) : undefined;
    if (controller) signal?.addEventListener('abort', onAbort, { once: true });

    const request = async () => {
      let response: Response;
      try {
        const baseUrl = config.apiUrl.replace(/\/+$/, '');
        response = await fetchImpl(`${baseUrl}/api/voice/${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          ...(controller ? { signal: controller.signal } : {}),
        });
      } catch {
        throw cancelled ?? new VoiceApiError('backend-unavailable');
      }
      // An abort-ignoring implementation must not start parsing a late response.
      if (cancelled) throw cancelled;
      status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
        ? response.status : undefined;

      if ([401, 403, 404].includes(response.status)) {
        throw new VoiceApiError('invalid-invite', status);
      }
      if (!response.ok) {
        throw new VoiceApiError('backend-unavailable', status);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw cancelled ?? new VoiceApiError('invalid-response', status);
      }

      if (!validate(body)) {
        throw new VoiceApiError('invalid-response', status);
      }

      return body;
    };
    try {
      // Race the entire operation, including json(), even if a mock/polyfill ignores abort.
      return await (controller ? Promise.race([request(), cancellation]) : request());
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (controller) signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    join(joinToken, displayName, telegramInitData, signal) {
      return post('join', { join_token: joinToken, display_name: displayName,
        ...(telegramInitData ? { telegram_init_data: telegramInitData } : {}),
      }, isJoinVoiceResponse, signal);
    },
    listRooms(joinToken) {
      return post('rooms', { join_token: joinToken }, isListRoomsResponse);
    },
    createInvite(joinToken, roomId) {
      return post('invite', { join_token: joinToken, room_id: roomId }, (value): value is CreateInviteResponse => isCreateInviteResponse(value, roomId));
    },
  };
}
