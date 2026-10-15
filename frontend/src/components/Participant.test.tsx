import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { VoiceParticipant } from '../voice/types';
import styles from '../styles.css?raw';
import { Participant } from './Participant';

const participant: VoiceParticipant = {
  identity: 'alex',
  displayName: 'Alex Morgan',
  isLocal: false,
  isMuted: false,
  isSpeaking: true,
};

describe('Participant speaking visuals', () => {
  it('renders a safe avatar in the existing ring, falls back on error, and recovers on URL change', () => {
    const view = render(<Participant participant={{ ...participant, avatarUrl: 'https://images.test/old' }} />);
    const image = view.container.querySelector('img')!;
    expect(image).toHaveAttribute('alt', '');
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(image).toHaveStyle({ objectFit: 'cover' });
    expect(image.parentElement).toHaveClass('participant-avatar-speaking');
    fireEvent.error(image);
    expect(screen.getByText('AM')).toBeInTheDocument();
    view.rerender(<Participant participant={{ ...participant, avatarUrl: 'https://images.test/new' }} />);
    expect(view.container.querySelector('img')).toHaveAttribute('src', 'https://images.test/new');
    fireEvent.error(image);
    expect(view.container.querySelector('img')).toHaveAttribute('src', 'https://images.test/new');
  });

  it('keeps initials for unsafe avatar URLs', () => {
    render(<Participant participant={{ ...participant, avatarUrl: 'https://user:pass@images.test/photo' }} />);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('AM')).toBeInTheDocument();
  });
  it('highlights the avatar only while an unmuted participant is speaking', () => {
    const view = render(<Participant participant={participant} />);
    const avatar = screen.getByText('AM');
    expect(avatar).toHaveClass('participant-avatar-speaking');
    expect(screen.getByRole('listitem')).toHaveClass('participant-speaking');
    expect(screen.getByText('Speaking')).toBeInTheDocument();

    view.rerender(<Participant participant={{ ...participant, isSpeaking: false }} />);
    expect(avatar).not.toHaveClass('participant-avatar-speaking');
    expect(screen.getByRole('listitem')).not.toHaveClass('participant-speaking');
    expect(screen.queryByText('Speaking')).not.toBeInTheDocument();
  });

  it('suppresses stale speaking highlights when the microphone is muted', () => {
    render(<Participant participant={{ ...participant, isMuted: true }} />);
    expect(screen.getByText('AM')).not.toHaveClass('participant-avatar-speaking');
    expect(screen.getByRole('listitem')).not.toHaveClass('participant-speaking');
    expect(screen.queryByText('Speaking')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Alex Morgan microphone muted' })).toBeInTheDocument();
  });

  it('uses the theme green for the avatar ring and soft glow', () => {
    const rule = styles.match(/\.participant-avatar-speaking\s*\{([^}]+)\}/)?.[1];
    expect(rule).toContain('border-color: var(--online)');
    expect(rule).toContain('box-shadow:');
    expect(rule).toContain('color-mix(in srgb, var(--online)');
  });

  it('uses short transitions and appearance fades with the existing reduced-motion override', () => {
    expect(styles).toMatch(/\.button,[\s\S]*?transition: [^;]*160ms/);
    expect(styles).toMatch(/\.participant,[\s\S]*?animation: appear 160ms ease-out/);
    expect(styles).toMatch(/@keyframes appear\s*\{\s*from\s*\{\s*opacity: 0;?\s*\}\s*to\s*\{\s*opacity: 1;?\s*\}\s*\}/);
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*, \*::before, \*::after\s*\{[^}]*animation: none !important;[^}]*transition: none !important;/);
  });
});
