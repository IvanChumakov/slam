import { describe, expect, it, vi } from 'vitest';
import { VoiceApiError, createVoiceApi } from './voiceApi';

const joinResponse = {
  livekit_url: 'wss://rtc.example.ru',
  access_token: 'jwt',
  room: { id: 42, name: 'General' },
  participant: { identity: 'guest_1', display_name: 'Ivan' },
};

describe('createVoiceApi', () => {
  const rooms = { current_room_id: 42, rooms: [{ id: 42, name: 'General', online_count: 1 }, { id: 43, name: 'Lounge', online_count: 0 }] };
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
      new VoiceApiError('invalid-response'),
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
