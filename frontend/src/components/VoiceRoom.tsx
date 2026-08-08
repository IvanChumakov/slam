import type { VoiceParticipant } from '../voice/types';
import type { VoiceRoomPhase } from '../voice/useVoiceRoom';
import { ConnectionStatus } from './ConnectionStatus';
import { Participant } from './Participant';

export type ConnectedRoomState = {
  roomName: string;
  phase: Extract<VoiceRoomPhase, 'connected' | 'reconnecting'>;
  participants: VoiceParticipant[];
  localMuted: boolean;
  needsAudioPermission: boolean;
};

export type VoiceRoomActions = {
  setMuted(muted: boolean): Promise<void>;
  enableAudio(): Promise<void>;
  leave(): Promise<void>;
};

type VoiceRoomProps = {
  state: ConnectedRoomState;
  actions: VoiceRoomActions;
};

export function VoiceRoom({ state, actions }: VoiceRoomProps) {
  return (
    <section className="voice-card room-card" aria-labelledby="room-name">
      <header className="room-header">
        <div className="card-heading">
          <span className="voice-rail voice-rail-live" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <div>
            <p className="eyebrow">VOICE ROOM</p>
            <h1 id="room-name">{state.roomName}</h1>
          </div>
        </div>
        <ConnectionStatus phase={state.phase} />
      </header>

      {state.needsAudioPermission ? (
        <aside className="audio-notice">
          <div>
            <strong>Audio is paused</strong>
            <p>Your browser needs one more tap to play the room.</p>
          </div>
          <button className="button button-secondary" onClick={() => void actions.enableAudio()}>
            Enable audio
          </button>
        </aside>
      ) : null}

      <div className="participant-section">
        <div className="section-label">
          <h2>In the room</h2>
          <span>{state.participants.length}</span>
        </div>
        {state.participants.length > 0 ? (
          <ul className="participant-list">
            {state.participants.map((participant) => (
              <Participant key={participant.identity} participant={participant} />
            ))}
          </ul>
        ) : (
          <p className="empty-room">Waiting for participants…</p>
        )}
      </div>

      <footer className="room-controls">
        <button
          className="button button-primary"
          onClick={() => void actions.setMuted(!state.localMuted)}
          disabled={state.phase === 'reconnecting'}
        >
          {state.localMuted ? 'Unmute' : 'Mute'}
        </button>
        <button className="button button-danger" onClick={() => void actions.leave()}>
          Leave
        </button>
      </footer>
    </section>
  );
}
