import { Route, Routes, useParams } from 'react-router-dom';
import { createAppDependencies } from './appDependencies';
import type { AppDependencies } from './appDependencies';
import { JoinScreen } from './components/JoinScreen';
import { VoiceRoom } from './components/VoiceRoom';
import { useVoiceRoom } from './voice/useVoiceRoom';
import type { VoiceRoomState } from './voice/useVoiceRoom';

const defaultDependencies = createAppDependencies();

function progressMessage(state: VoiceRoomState) {
  switch (state.phase) {
    case 'requestingCredentials':
      return 'Getting room access…';
    case 'connecting':
      return `Connecting to ${state.roomName || 'the voice room'}…`;
    case 'requestingMicrophone':
      return 'Requesting microphone access…';
    default:
      return undefined;
  }
}

function InviteError() {
  return (
    <section className="voice-card message-card">
      <p className="eyebrow">INVITE ERROR</p>
      <h1>This link can’t open a room</h1>
      <p className="form-error" role="alert">
        Invalid or expired invite.
      </p>
      <p className="lede">Ask your Telegram group for a fresh voice link.</p>
    </section>
  );
}

function LeftScreen({ onJoinAgain }: { onJoinAgain: () => void }) {
  return (
    <section className="voice-card message-card">
      <p className="eyebrow">CALL ENDED</p>
      <h1>You left the room.</h1>
      <p className="lede">Your microphone is off and the connection is closed.</p>
      <button className="button button-primary" onClick={onJoinAgain}>
        Join again
      </button>
    </section>
  );
}

function VoiceJoinPage({ dependencies }: { dependencies: AppDependencies }) {
  const { token = '' } = useParams();
  const { state, join, leave, setMuted, enableAudio, reset } = useVoiceRoom({
    token,
    api: dependencies.api,
    createClient: dependencies.createClient,
  });
  const busy =
    state.phase === 'requestingCredentials' ||
    state.phase === 'connecting' ||
    state.phase === 'requestingMicrophone';

  if (state.phase === 'left') {
    return <LeftScreen onJoinAgain={reset} />;
  }

  if (state.phase === 'connected' || state.phase === 'reconnecting') {
    return (
      <VoiceRoom
        state={{
          roomName: state.roomName,
          phase: state.phase,
          participants: state.participants,
          localMuted: state.localMuted,
          needsAudioPermission: state.needsAudioPermission,
        }}
        actions={{ setMuted, enableAudio, leave }}
      />
    );
  }

  return (
    <JoinScreen
      busy={busy}
      error={state.error}
      progressMessage={progressMessage(state)}
      onJoin={(name) => void join(name)}
    />
  );
}

export function App({ dependencies = defaultDependencies }: { dependencies?: AppDependencies }) {
  return (
    <main className="app-shell">
      <div className="ambient-grid" aria-hidden="true" />
      <Routes>
        <Route path="/join/:token" element={<VoiceJoinPage dependencies={dependencies} />} />
        <Route path="*" element={<InviteError />} />
      </Routes>
      <p className="privacy-note">Your voice travels through the room, not Telegram.</p>
    </main>
  );
}
