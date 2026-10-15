import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceApiError, createVoiceApi } from './voiceApi';

const joinResponse = {
  livekit_url: 'wss://rtc.example.ru',
  access_token: 'jwt',
  room: { id: 42, name: 'General' },
  participant: { identity: 'guest_1', display_name: 'Ivan' },
};

describe('createVoiceApi', () => {
  afterEach(() => vi.useRealTimers());

  it.each(['headers', 'body'] as const)('bounds join %s to 30 seconds without retrying POST', async (stage) => {
    vi.useFakeTimers();
    const json = vi.fn(() => new Promise<unknown>(() => undefined));
    const fetchImpl = vi.fn().mockImplementation(() => stage === 'headers'
      ? new Promise<Response>(() => undefined)
      : Promise.resolve({ ok: true, status: 200, json } as unknown as Response));
    const api = createVoiceApi({ apiUrl: '', useMock: false }, fetchImpl);
    let failure: unknown;
    const pending = api.join('secret-invite', 'Ivan').catch((error: unknown) => { failure = error; });
    await vi.advanceTimersByTimeAsync(29999);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(failure).toMatchObject({ code: 'join-timeout', ...(stage === 'body' ? { status: 200 } : {}) });
    await pending;
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['headers', 'body'] as const)('cancels join during %s even when the implementation ignores abort', async (stage) => {
    vi.useFakeTimers();
    let resolve!: (value: Response) => void;
    const json = vi.fn(() => new Promise<unknown>(() => undefined));
    const fetchImpl = vi.fn().mockImplementation(() => stage === 'headers'
      ? new Promise<Response>((done) => { resolve = done; })
      : Promise.resolve({ ok: true, status: 200, json } as unknown as Response));
    const api = createVoiceApi({ apiUrl: '', useMock: false }, fetchImpl);
    const controller = new AbortController();
    let failure: unknown;
    const pending = api.join('invite', 'Ivan', undefined, controller.signal).catch((error: unknown) => { failure = error; });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort('secret cancellation reason');
    await vi.advanceTimersByTimeAsync(0);
    expect(failure).toMatchObject({ code: 'join-cancelled' });
    await pending;
    if (stage === 'headers') resolve(new Response(JSON.stringify(joinResponse)));
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(JSON.stringify(failure)).not.toContain('secret');
  });

  it('does not POST an already cancelled join and allows a fresh manual retry', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify(joinResponse)));
    const api = createVoiceApi({ apiUrl: '', useMock: false }, fetchImpl);
    const controller = new AbortController(); controller.abort();
    await expect(api.join('invite', 'Ivan', undefined, controller.signal)).rejects.toMatchObject({ code: 'join-cancelled' });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(api.join('invite', 'Ivan')).resolves.toEqual(joinResponse);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('retains only safe HTTP status and not response secrets', async () => {
    const api = createVoiceApi({ apiUrl: '', useMock: false }, vi.fn().mockResolvedValue(new Response('JWT initData invite turn:password SDP', { status: 503 })));
    const error = await api.join('secret', 'Ivan').catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'backend-unavailable', status: 503, message: 'backend-unavailable' });
    expect(JSON.stringify(error)).not.toMatch(/JWT|initData|invite|turn:|SDP/);
  });
  it('includes verified Telegram init data only when supplied', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify(joinResponse)));
    const api = createVoiceApi({ apiUrl: '', useMock: false }, fetchImpl);
    await api.join('signed', 'Alex', 'verified-data');
    expect(fetchImpl).toHaveBeenLastCalledWith('/api/voice/join', expect.objectContaining({ body: JSON.stringify({ join_token: 'signed', display_name: 'Alex', telegram_init_data: 'verified-data' }) }));
    await api.join('signed', 'Guest');
    expect(fetchImpl).toHaveBeenLastCalledWith('/api/voice/join', expect.objectContaining({ body: JSON.stringify({ join_token: 'signed', display_name: 'Guest' }) }));
  });
  const rooms = { current_room_id: 42, rooms: [{ id: 42, name: 'General', online_count: 1, participants: [{ identity: 'ivan', display_name: 'Ivan' }] }, { id: 43, name: 'Lounge', online_count: 0, participants: [] }] };
  const invite = { join_token: 'target', join_url: 'https://voice.test/join/target', room: { id: 43, name: 'Lounge' }, expires_in: 3600 };

  it('posts room listing and targeted invite requests using the current bearer', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(rooms)))
      .mockResolvedValueOnce(new Response(JSON.stringify(invite)));
    const api = createVoiceApi({ apiUrl: 'https://api.test/', useMock: false }, fetchImpl);
    await expect(api.listRooms('signed')).resolves.toEqual(rooms);
    await expect(api.createInvite('signed', 43)).resolves.toEqual(invite);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'https://api.test/api/voice/rooms', expect.objectContaining({ method: 'POST', body: JSON.stringify({ join_token: 'signed' }) }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://api.test/api/voice/invite', expect.objectContaining({ method: 'POST', body: JSON.stringify({ join_token: 'signed', room_id: 43 }) }));
  });

  it.each([
    { ...rooms, rooms: [{ ...rooms.rooms[0], participants: undefined }] },
    { ...rooms, rooms: [{ ...rooms.rooms[0], participants: null }] },
    { ...rooms, rooms: [{ ...rooms.rooms[0], participants: [] }] },
    { ...rooms, rooms: [{ ...rooms.rooms[0], participants: [{ identity: '', display_name: 'Ivan' }] }] },
    { ...rooms, rooms: [{ ...rooms.rooms[0], participants: [{ identity: 'ivan', display_name: ' ' }] }] },
    { ...rooms, rooms: [{ ...rooms.rooms[0], online_count: 2, participants: [rooms.rooms[0].participants[0], rooms.rooms[0].participants[0]] }] },
  ])('rejects missing, inconsistent or duplicate channel rosters: %j', async (body) => {
    const api = createVoiceApi({ apiUrl: '', useMock: false }, vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
    await expect(api.listRooms('signed')).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it.each([
    { current_room_id: 42, rooms: [] },
    { ...rooms, current_room_id: 99 },
    { ...rooms, rooms: [{ id: 42, name: '', online_count: 0 }] },
    { ...rooms, rooms: [{ id: 42, name: 'General', online_count: -1 }] },
    { ...rooms, rooms: [{ id: 42, name: 'General', online_count: 1.5 }] },
    { ...rooms, rooms: [rooms.rooms[0], rooms.rooms[0]] },
    { ...rooms, rooms: [{ id: 42.5, name: 'General', online_count: 0 }] },
    { ...rooms, rooms: [{ id: 42, name: 'General', online_count: '0' }] },
  ])('rejects malformed room lists: %j', async (body) => {
    const api = createVoiceApi({ apiUrl: '', useMock: false }, vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
    await expect(api.listRooms('signed')).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it.each([
    { ...invite, join_token: '' }, { ...invite, join_url: 'javascript:alert(1)' },
    { ...invite, expires_in: 0 }, { ...invite, room: { id: 42, name: 'General' } },
    { ...invite, join_url: 'https://voice.test/join/old' }, { ...invite, room: { id: 43, name: '' } },
  ])('rejects malformed or wrong-target invites: %j', async (body) => {
    const api = createVoiceApi({ apiUrl: '', useMock: false }, vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
    await expect(api.createInvite('signed', 43)).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it.each([401, 403, 404, 500])('maps new endpoint errors %s', async (status) => {
    const api = createVoiceApi({ apiUrl: '', useMock: false }, vi.fn().mockImplementation(async () => new Response(null, { status })));
    const code = status === 500 ? 'backend-unavailable' : 'invalid-invite';
    await expect(api.listRooms('signed')).rejects.toMatchObject({ code });
    await expect(api.createInvite('signed', 43)).rejects.toMatchObject({ code });
  });

  it('maps network and JSON errors on both new endpoints', async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(new Response('not json'));
    const api = createVoiceApi({ apiUrl: '', useMock: false }, fetchImpl);
    await expect(api.listRooms('signed')).rejects.toMatchObject({ code: 'backend-unavailable' });
    await expect(api.createInvite('signed', 43)).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('mock invites join the selected existing room and reject unknown rooms', async () => {
    const api = createVoiceApi({ apiUrl: '', useMock: true });
    expect((await api.listRooms('signed')).rooms).toHaveLength(2);
    const target = await api.createInvite('signed', 43);
    expect((await api.join(target.join_token, 'Ivan')).room).toEqual({ id: 43, name: 'Lounge' });
    expect((await api.listRooms(target.join_token)).current_room_id).toBe(43);
    await expect(api.createInvite('signed', 99)).rejects.toMatchObject({ code: 'invalid-invite' });
  });
  it('posts the unchanged token and display name to the shared endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(joinResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const api = createVoiceApi(
      { apiUrl: 'http://localhost:8000/', useMock: false },
      fetchImpl,
    );

    await expect(api.join('signed.token', 'Ivan')).resolves.toEqual(joinResponse);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:8000/api/voice/join',
      {
        signal: expect.any(AbortSignal),
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          join_token: 'signed.token',
          display_name: 'Ivan',
        }),
      },
    );
  });

  it.each([401, 403, 404])('maps status %s to an invalid invite', async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status }));
    const api = createVoiceApi({ apiUrl: '', useMock: false }, fetchImpl);

    await expect(api.join('bad-token', 'Ivan')).rejects.toMatchObject({
      code: 'invalid-invite',
    });
  });

  it('maps network failures to backend unavailable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const api = createVoiceApi({ apiUrl: '', useMock: false }, fetchImpl);

    await expect(api.join('token', 'Ivan')).rejects.toMatchObject({
      code: 'backend-unavailable',
    });
  });

  it('rejects a successful response with an incompatible shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ room: null }), { status: 200 }),
    );
    const api = createVoiceApi({ apiUrl: '', useMock: false }, fetchImpl);

    await expect(api.join('token', 'Ivan')).rejects.toEqual(
      new VoiceApiError('invalid-response', 200),
    );
  });

  it('returns the production response shape in mock mode', async () => {
    const api = createVoiceApi({
      apiUrl: '',
      useMock: true,
      devLiveKitUrl: 'wss://dev.example.test',
      devLiveKitToken: 'dev-token',
    });

    await expect(api.join('token', 'Max')).resolves.toEqual({
      livekit_url: 'wss://dev.example.test',
      access_token: 'dev-token',
      room: { id: 42, name: 'General' },
      participant: {
        identity: expect.stringMatching(/^guest_/),
        display_name: 'Max',
      },
    });
  });
});
