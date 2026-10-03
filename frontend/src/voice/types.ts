export type VoiceConnection = 'connected' | 'reconnecting' | 'disconnected';

export type VoiceParticipant = {
  identity: string;
  displayName: string;
  isLocal: boolean;
  isMuted: boolean;
  isSpeaking: boolean;
};

export type VoiceSnapshot = {
  connection: VoiceConnection;
  participants: VoiceParticipant[];
  localMuted: boolean;
  needsAudioPermission: boolean;
  incomingMuted: boolean;
  localSharing: boolean;
  screenShareSupported: boolean;
  screens: VoiceScreen[];
  localCamera: boolean;
  cameraSupported: boolean;
  cameras: VoiceScreen[];
};

export type VoiceScreen = {
  id: string;
  participantIdentity: string;
  displayName: string;
  isLocal: boolean;
  element: HTMLVideoElement;
};

export interface VoiceClient {
  subscribe(listener: (snapshot: VoiceSnapshot) => void): () => void;
  connect(url: string, token: string): Promise<void>;
  enableMicrophone(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setIncomingMuted(muted: boolean): Promise<void>;
  setScreenSharing(sharing: boolean): Promise<void>;
  setCameraEnabled(enabled: boolean): Promise<void>;
  enableAudio(): Promise<void>;
  disconnect(): Promise<void>;
}

export type VoiceClientFactory = () => VoiceClient | Promise<VoiceClient>;
