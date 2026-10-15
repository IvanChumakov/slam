export type VoiceConnection = 'connected' | 'reconnecting' | 'disconnected';

export type VoiceFailureStage = 'signaling' | 'rtc' | 'microphone' | 'unknown';
export type VoiceFailureCode = 'unknown' | 'permission-denied' | `sdk-${number}` |
  'connection-notallowed' | 'connection-serverunreachable' | 'connection-internalerror' |
  'connection-cancelled' | 'connection-leaverequest' | 'connection-timeout' |
  'connection-websocket' | 'connection-servicenotfound';
export type VoiceDisconnectReason = Lowercase<keyof typeof import('livekit-client').DisconnectReason> | 'unknown';

export class VoiceClientError extends Error {
  constructor(
    public readonly stage: VoiceFailureStage,
    public readonly code: VoiceFailureCode,
    public readonly disconnectReason?: VoiceDisconnectReason,
  ) {
    super(`${stage}: ${code}`);
    this.name = 'VoiceClientError';
  }
}

export type VoiceParticipant = {
  identity: string;
  displayName: string;
  avatarUrl?: string;
  isLocal: boolean;
  isMuted: boolean;
  isSpeaking: boolean;
};

export type VoiceSnapshot = {
  connection: VoiceConnection;
  disconnectReason?: VoiceDisconnectReason;
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
