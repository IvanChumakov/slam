import { describe, expect, it, vi } from 'vitest';
import { createAppDependencies } from './appDependencies';
import type { VoiceClient } from './voice/types';

class FakeVoiceClient implements VoiceClient {
  subscribe() {
    return () => undefined;
  }
  async connect() {}
  async enableMicrophone() {}
  async setMuted() {}
  async enableAudio() {}
  async disconnect() {}
}

describe('createAppDependencies', () => {
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
});
