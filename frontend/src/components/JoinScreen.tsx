import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { TelegramProfile } from '../telegram';

type JoinScreenProps = {
  busy: boolean;
  error: string | null;
  progressMessage?: string;
  onJoin: (displayName: string) => void;
  profile?: TelegramProfile | null;
};

export function JoinScreen({
  busy,
  error,
  progressMessage,
  onJoin,
  profile,
}: JoinScreenProps) {
  const [customName, setCustomName] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const name = customName ?? profile?.username ?? '';
  const [validationError, setValidationError] = useState<string | null>(null);
  const errorText = validationError ?? error;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const displayName = name.trim();

    if (!displayName) {
      setValidationError('Enter your name');
      nameRef.current?.focus();
      return;
    }

    setValidationError(null);
    onJoin(displayName);
  }

  return (
    <section className="voice-card join-card" aria-labelledby="join-title">
      <header className="card-heading">
        <div>
          <p className="eyebrow">SLAM VOICE</p>
          <h1 id="join-title">Join the conversation</h1>
        </div>
      </header>

      <p className="lede">Drop into your group’s voice room.</p>

      <form className="join-form" onSubmit={handleSubmit} noValidate>
        <label htmlFor="display-name">Your name</label>
        <input
          ref={nameRef}
          id="display-name"
          value={name}
          onChange={(event) => setCustomName(event.target.value)}
          maxLength={32}
          autoComplete="nickname"
          placeholder="Ivan"
          aria-describedby={
            errorText ? 'join-error' : progressMessage ? 'join-progress' : undefined
          }
          aria-invalid={Boolean(errorText)}
          disabled={busy}
        />
        {errorText ? (
          <p className="form-error" id="join-error" role="alert">
            {errorText}
          </p>
        ) : null}
        {progressMessage ? (
          <p className="join-progress" id="join-progress" role="status">
            <span className="progress-spinner" aria-hidden="true" />
            {progressMessage}
          </p>
        ) : null}
        <button className="button button-primary" disabled={busy} type="submit">
          {busy ? 'Connecting…' : error ? 'Try again' : 'Join voice'}
        </button>
      </form>
    </section>
  );
}
