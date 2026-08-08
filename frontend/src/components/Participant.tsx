import type { VoiceParticipant } from '../voice/types';

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase())
    .join('');
}

export function Participant({ participant }: { participant: VoiceParticipant }) {
  const microphoneLabel = `${participant.displayName} microphone ${
    participant.isMuted ? 'muted' : 'on'
  }`;

  return (
    <li className={participant.isLocal ? 'participant participant-local' : 'participant'}>
      <span className="participant-avatar" aria-hidden="true">
        {initials(participant.displayName) || '•'}
      </span>
      <span className="participant-identity">
        <span className="participant-name">{participant.displayName}</span>
        {participant.isLocal ? <span className="participant-you">(you)</span> : null}
      </span>
      <span
        className={participant.isMuted ? 'mic-state mic-state-muted' : 'mic-state'}
        role="img"
        aria-label={microphoneLabel}
      >
        {participant.isMuted ? '🔇' : '🎤'}
      </span>
    </li>
  );
}
