import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { createAppDependencies } from './appDependencies';
import type { AppDependencies } from './appDependencies';
import { JoinScreen } from './components/JoinScreen';
import { VoiceRoom } from './components/VoiceRoom';
import { Appearance } from './components/Appearance';
import { useVoiceRoom } from './voice/useVoiceRoom';
import type { VoiceRoomState } from './voice/useVoiceRoom';
import { decodeTelegramJoinToken, getTelegramLaunch, loadTelegramProfile, type TelegramProfile } from './telegram';

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

function MiniAppEntry({ launch }: { launch: ReturnType<typeof getTelegramLaunch> }) {
  const token = decodeTelegramJoinToken(launch.startParam);
  if (token) return <Navigate to={`/join/${encodeURIComponent(token)}`} replace />;
  if (!launch.initData || launch.startParam) return <InviteError />;
  return (
    <section className="voice-card message-card">
      <p className="eyebrow">SLAM VOICE</p>
      <h1>Choose a voice room</h1>
      <p className="lede">Open a room from your Telegram group's room card.</p>
    </section>
  );
}

type VoiceJoinProps = {
  dependencies: AppDependencies;
  profile: TelegramProfile | null;
  telegramInitData?: string;
};

function VoiceJoinPage(props: VoiceJoinProps) {
  const { token = '' } = useParams();
  return <VoiceJoinSession key={token} {...props} />;
}

function VoiceJoinSession({ dependencies, profile, telegramInitData }: VoiceJoinProps) {
  const { token = '' } = useParams();
  const { state, join, leave, switchRoom, refreshRooms, fetchInvite, retry, setMuted, setIncomingMuted, setSoundsEnabled, setScreenSharing, setCameraEnabled, enableAudio, reset } = useVoiceRoom({
    token,
    api: dependencies.api,
    createClient: dependencies.createClient,
    telegramInitData,
    onTokenChange: (nextToken) => {
      try {
        // Preserve React Router's history metadata; do not reload/remount the call.
        window.history.replaceState(window.history.state, '', `/join/${encodeURIComponent(nextToken)}`);
      } catch {
        // Restricted history must not interrupt a room connection.
      }
    },
  });
  const busy =
    state.phase === 'requestingCredentials' ||
    state.phase === 'connecting' ||
    state.phase === 'requestingMicrophone';

  if (state.phase === 'left') {
    return <LeftScreen onJoinAgain={reset} />;
  }

  if (state.phase === 'error' && state.roomId !== null) {
    return (
      <section className="voice-card message-card">
        <p className="eyebrow">CONNECTION FAILED</p>
        <h1>{state.roomName}</h1>
        <p className="form-error room-error" role="alert">{state.error}</p>
        <button className="button button-primary" onClick={() => void retry()}>Retry connection</button>
        <button className="button button-danger" onClick={() => void leave()}>Leave</button>
      </section>
    );
  }

  if (state.phase === 'connected' || state.phase === 'reconnecting' || state.switching) {
    return (
      <VoiceRoom
        state={state}
        actions={{ setMuted, setIncomingMuted, setSoundsEnabled, setScreenSharing, setCameraEnabled, enableAudio, leave, switchRoom, refreshRooms, fetchInvite }}
      />
    );
  }

  return (
    <>
      <JoinScreen
        profile={profile}
        busy={busy}
        error={state.error}
        progressMessage={progressMessage(state)}
        onJoin={(name) => void join(name)}
      />
      {busy ? <button className="button button-danger" onClick={() => void leave()}>Leave</button> : null}
    </>
  );
}

export function App({ dependencies = defaultDependencies }: { dependencies?: AppDependencies }) {
  const location = useLocation();
  const [launch, setLaunch] = useState(() => getTelegramLaunch(location));
  const [profile, setProfile] = useState<TelegramProfile | null>(null);
  useEffect(() => {
    const sdkReady = () => {
      const loaded = getTelegramLaunch(window.location);
      try { loaded.webApp?.ready?.(); } catch { /* SDK availability must not block guest access. */ }
      try { loaded.webApp?.expand?.(); } catch { /* Expansion is optional. */ }
      if (loaded.webApp) setLaunch((previous) => {
        const initData = previous.initData || loaded.initData;
        const startParam = previous.startParam || loaded.startParam;
        return initData === previous.initData && startParam === previous.startParam
          ? previous : { ...loaded, initData, startParam };
      });
    };
    const script = document.querySelector('script[data-telegram-sdk]');
    script?.addEventListener('load', sdkReady);
    sdkReady();
    return () => script?.removeEventListener('load', sdkReady);
  }, []);
  useEffect(() => {
    if (!launch.initData) return;
    let active = true;
    const loader = dependencies.loadTelegramProfile ?? loadTelegramProfile;
    void loader(launch.initData).then((verified) => {
      if (active) setProfile(verified);
    }).catch(() => {
      if (active) setProfile(null);
    });
    return () => { active = false; };
  }, [dependencies.loadTelegramProfile, launch]);
  return (
    <main className="app-shell">
      <div className="app-topbar"><span className="brand">Slam <span>voice</span></span></div>
      <Routes>
        <Route path="/" element={<MiniAppEntry launch={launch} />} />
        <Route path="/join/:token" element={<VoiceJoinPage dependencies={dependencies} profile={profile} telegramInitData={profile ? launch.initData : undefined} />} />
        <Route path="*" element={<InviteError />} />
      </Routes>
      <footer className="app-footer">
        <p className="privacy-note">Your voice travels through the room, not Telegram.</p>
        <Appearance />
      </footer>
    </main>
  );
}
