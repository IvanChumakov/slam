import { createVoiceApi } from './api/voiceApi';
import type { VoiceApi } from './api/voiceApi';
import type { VoiceClient, VoiceClientFactory } from './voice/types';

export type AppDependencies = {
  api: VoiceApi;
  createClient: VoiceClientFactory;
};

type VoiceClientModule = {
  LiveKitVoiceClient: new () => VoiceClient;
};

type VoiceClientLoader = () => Promise<VoiceClientModule>;

const loadDefaultVoiceClient: VoiceClientLoader = () =>
  import('./voice/LiveKitVoiceClient');

export function createAppDependencies(
  env: ImportMetaEnv = import.meta.env,
  loadVoiceClient: VoiceClientLoader = loadDefaultVoiceClient,
): AppDependencies {
  return {
    api: createVoiceApi({
      apiUrl: env.VITE_API_URL || '',
      useMock: env.VITE_USE_MOCK_API === 'true',
      devLiveKitUrl: env.VITE_DEV_LIVEKIT_URL,
      devLiveKitToken: env.VITE_DEV_LIVEKIT_TOKEN,
    }),
    createClient: async () => {
      const { LiveKitVoiceClient } = await loadVoiceClient();
      return new LiveKitVoiceClient();
    },
  };
}
