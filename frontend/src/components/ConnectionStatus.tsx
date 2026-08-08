import type { VoiceRoomPhase } from '../voice/useVoiceRoom';

export function ConnectionStatus({ phase }: { phase: VoiceRoomPhase }) {
  const reconnecting = phase === 'reconnecting';

  return (
    <p className={reconnecting ? 'connection-status status-warning' : 'connection-status'} role="status">
      <span className="status-dot" aria-hidden="true" />
      {reconnecting ? 'Reconnecting…' : 'Connected'}
    </p>
  );
}
