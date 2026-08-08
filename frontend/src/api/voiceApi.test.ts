import { describe, expect, it, vi } from 'vitest';
import { VoiceApiError, createVoiceApi } from './voiceApi';

const joinResponse = {
  livekit_url: 'wss://rtc.example.ru',
  access_token: 'jwt',
  room: { id: 42, name: 'General' },
  participant: { identity: 'guest_1', display_name: 'Ivan' },
};

describe('createVoiceApi', () => {
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
