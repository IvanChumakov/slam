import { useState } from 'react';
import type { FormEvent } from 'react';

type JoinScreenProps = {
  busy: boolean;
  error: string | null;
  onJoin: (displayName: string) => void;
};

export function JoinScreen({ busy, error, onJoin }: JoinScreenProps) {
  const [name, setName] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const errorText = validationError ?? error;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const displayName = name.trim();

    if (!displayName) {
      setValidationError('Enter your name');
      return;
    }

    setValidationError(null);
    onJoin(displayName);
  }

  return (
    <section className="voice-card join-card" aria-labelledby="join-title">
      <header className="card-heading">
        <span className="voice-rail" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <div>
          <p className="eyebrow">SLAM VOICE</p>
          <h1 id="join-title">Join the conversation</h1>
        </div>
      </header>

      <p className="lede">Drop into your group’s voice room.</p>

      <form className="join-form" onSubmit={handleSubmit} noValidate>
        <label htmlFor="display-name">Your name</label>
        <input
          id="display-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={32}
          autoComplete="nickname"
          placeholder="Ivan"
          aria-describedby={errorText ? 'join-error' : undefined}
          aria-invalid={Boolean(errorText)}
          disabled={busy}
          autoFocus
        />
        {errorText ? (
          <p className="form-error" id="join-error" role="alert">
            {errorText}
          </p>
        ) : null}
        <button className="button button-primary" disabled={busy} type="submit">
          {busy ? 'Connecting…' : 'Join voice'}
        </button>
      </form>
    </section>
  );
}
