import type { VoiceParticipant } from '../voice/types';
import { useState } from 'react';
import { safeAvatarUrl } from '../telegram';
import { RoomIcon } from './RoomIcon';

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase())
    .join('');
}

export function Participant({ participant }: { participant: VoiceParticipant }) {
  const avatarUrl = safeAvatarUrl(participant.avatarUrl);
  const [failedAvatarUrl, setFailedAvatarUrl] = useState<string | undefined>();
  const isSpeaking = participant.isSpeaking && !participant.isMuted;
  const microphoneLabel = `${participant.displayName} microphone ${
    participant.isMuted ? 'muted' : 'on'
  }`;

  return (
    <li className={`participant${participant.isLocal ? ' participant-local' : ''}${isSpeaking ? ' participant-speaking' : ''}`}>
      <span className={`participant-avatar${isSpeaking ? ' participant-avatar-speaking' : ''}`} aria-hidden="true">
        {avatarUrl && avatarUrl !== failedAvatarUrl ? (
          <img key={avatarUrl} src={avatarUrl} alt="" referrerPolicy="no-referrer"
            style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit', display: 'block' }}
            onError={() => setFailedAvatarUrl(avatarUrl)} />
        ) : initials(participant.displayName) || '•'}
      </span>
      <span className="participant-identity">
        <span className="participant-name">{participant.displayName}</span>
        {participant.isLocal ? <span className="participant-you">(you)</span> : null}
        {isSpeaking ? <span className="speaking-label">Speaking</span> : null}
      </span>
      <span
        className={participant.isMuted ? 'mic-state mic-state-muted' : 'mic-state'}
        role="img"
        aria-label={microphoneLabel}
      >
        <RoomIcon name="mic" off={participant.isMuted} />
      </span>
    </li>
  );
}
