export type VoiceRoomInfo = { id: number; name: string };
export type ListRoomsResponse = {
  current_room_id: number;
  rooms: (VoiceRoomInfo & { online_count: number })[];
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
  | 'invalid-response';

export class VoiceApiError extends Error {
  constructor(public readonly code: VoiceApiErrorCode) {
    super(code);
    this.name = 'VoiceApiError';
  }
}

export interface VoiceApi {
  join(joinToken: string, displayName: string): Promise<JoinVoiceResponse>;
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
  return value.rooms.every((room: unknown) => isRecord(room) &&
    Number.isSafeInteger(room.online_count) && (room.online_count as number) >= 0 && isRoom(room)) &&
    value.rooms.some((room: VoiceRoomInfo) => room.id === value.current_room_id) &&
    new Set(value.rooms.map((room: VoiceRoomInfo) => room.id)).size === value.rooms.length;
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
  const rooms = [{ id: 42, name: 'General', online_count: 0 }, { id: 43, name: 'Lounge', online_count: 0 }];
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

  async function post<T>(path: string, payload: object, validate: (value: unknown) => value is T): Promise<T> {
    let response: Response;

    try {
      const baseUrl = config.apiUrl.replace(/\/+$/, '');
      response = await fetchImpl(`${baseUrl}/api/voice/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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

    if (!validate(body)) {
      throw new VoiceApiError('invalid-response');
    }

    return body;
  }

  return {
    join(joinToken, displayName) {
      return post('join', { join_token: joinToken, display_name: displayName }, isJoinVoiceResponse);
    },
    listRooms(joinToken) {
      return post('rooms', { join_token: joinToken }, isListRoomsResponse);
    },
    createInvite(joinToken, roomId) {
      return post('invite', { join_token: joinToken, room_id: roomId }, (value): value is CreateInviteResponse => isCreateInviteResponse(value, roomId));
    },
  };
}
