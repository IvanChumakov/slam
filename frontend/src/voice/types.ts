export type VoiceConnection = 'connected' | 'reconnecting' | 'disconnected';

export type VoiceParticipant = {
  identity: string;
  displayName: string;
  isLocal: boolean;
  isMuted: boolean;
};

export type VoiceSnapshot = {
  connection: VoiceConnection;
  participants: VoiceParticipant[];
  localMuted: boolean;
  needsAudioPermission: boolean;
};

export interface VoiceClient {
  subscribe(listener: (snapshot: VoiceSnapshot) => void): () => void;
  connect(url: string, token: string): Promise<void>;
  enableMicrophone(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  enableAudio(): Promise<void>;
  disconnect(): Promise<void>;
}
