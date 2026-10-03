import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppDependencies } from './appDependencies';
import type { VoiceClient } from './voice/types';

class FakeVoiceClient implements VoiceClient {
  subscribe() {
    return () => undefined;
  }
  async connect() {}
  async enableMicrophone() {}
  async setMuted() {}
  async setIncomingMuted() {}
  async setScreenSharing() {}
  async setCameraEnabled() {}
  async enableAudio() {}
  async disconnect() {}
}

describe('createAppDependencies', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads the LiveKit adapter only when a join creates a client', async () => {
    const loadVoiceClient = vi.fn().mockResolvedValue({
      LiveKitVoiceClient: FakeVoiceClient,
    });
    const dependencies = createAppDependencies(
      {} as ImportMetaEnv,
      loadVoiceClient,
    );

    expect(loadVoiceClient).not.toHaveBeenCalled();

    await expect(dependencies.createClient()).resolves.toBeInstanceOf(FakeVoiceClient);
    expect(loadVoiceClient).toHaveBeenCalledOnce();
  });

  it('uses VITE_API_URL for the production join endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          livekit_url: 'wss://rtc.test',
          access_token: 'jwt',
          room: { id: 42, name: 'General' },
          participant: { identity: 'guest_1', display_name: 'Ivan' },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchImpl);
    const dependencies = createAppDependencies({
      VITE_API_URL: 'https://api.example.test',
      VITE_USE_MOCK_API: 'false',
    } as ImportMetaEnv);

    await dependencies.api.join('signed', 'Ivan');

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.test/api/voice/join',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('uses development LiveKit credentials without HTTP in mock mode', async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const dependencies = createAppDependencies({
      VITE_USE_MOCK_API: 'true',
      VITE_DEV_LIVEKIT_URL: 'wss://dev.example.test',
      VITE_DEV_LIVEKIT_TOKEN: 'dev-token',
    } as ImportMetaEnv);

    const response = await dependencies.api.join('local', 'Max');

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      livekit_url: 'wss://dev.example.test',
      access_token: 'dev-token',
      participant: { display_name: 'Max' },
    });
  });
});
