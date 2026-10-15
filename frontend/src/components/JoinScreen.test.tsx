import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { JoinScreen } from './JoinScreen';

describe('JoinScreen', () => {
  it('does not focus the name field on entry', () => {
    render(<JoinScreen busy={false} error={null} onJoin={vi.fn()} />);
    expect(screen.getByLabelText('Your name')).not.toHaveFocus();
  });
  it('derives an editable name from a verified profile without overwriting typing', async () => {
    const onJoin = vi.fn();
    const view = render(<JoinScreen busy={false} error={null} onJoin={onJoin} />);
    await userEvent.type(screen.getByLabelText('Your name'), 'Manual');
    view.rerender(<JoinScreen busy={false} error={null} onJoin={onJoin} profile={{ username: 'telegram', avatarUrl: undefined }} />);
    expect(screen.getByLabelText('Your name')).toHaveValue('Manual');
    await userEvent.clear(screen.getByLabelText('Your name'));
    view.rerender(<JoinScreen busy={false} error={null} onJoin={onJoin} profile={{ username: 'newname', avatarUrl: undefined }} />);
    expect(screen.getByLabelText('Your name')).toHaveValue('');
  });

  it('prefills a verified username while keeping submission editable and photo optional', async () => {
    const onJoin = vi.fn();
    render(<JoinScreen busy={false} error={null} onJoin={onJoin} profile={{ username: 'alex', avatarUrl: undefined }} />);
    expect(screen.getByLabelText('Your name')).toHaveValue('alex');
    expect(document.querySelector('img')).toBeNull();
    await userEvent.clear(screen.getByLabelText('Your name'));
    await userEvent.type(screen.getByLabelText('Your name'), 'Guest');
    await userEvent.click(screen.getByRole('button', { name: 'Join voice' }));
    expect(onJoin).toHaveBeenCalledWith('Guest');
  });
  it('trims a valid display name before joining', async () => {
    const onJoin = vi.fn();
    render(<JoinScreen busy={false} error={null} onJoin={onJoin} />);

    await userEvent.type(screen.getByLabelText('Your name'), '  Ivan  ');
    await userEvent.click(screen.getByRole('button', { name: 'Join voice' }));

    expect(onJoin).toHaveBeenCalledWith('Ivan');
  });

  it('rejects an empty trimmed name', async () => {
    const onJoin = vi.fn();
    render(<JoinScreen busy={false} error={null} onJoin={onJoin} />);

    await userEvent.type(screen.getByLabelText('Your name'), '   ');
    await userEvent.click(screen.getByRole('button', { name: 'Join voice' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Enter your name');
    expect(screen.getByLabelText('Your name')).toHaveFocus();
    expect(onJoin).not.toHaveBeenCalled();
  });

  it('limits display names to 32 characters', () => {
    render(<JoinScreen busy={false} error={null} onJoin={vi.fn()} />);

    expect(screen.getByLabelText('Your name')).toHaveAttribute('maxlength', '32');
  });

  it('disables input and submit while joining', () => {
    render(<JoinScreen busy error={null} onJoin={vi.fn()} />);

    expect(screen.getByLabelText('Your name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Connecting…' })).toBeDisabled();
  });

  it('explains the active connection step', () => {
    render(
      <JoinScreen
        busy
        error={null}
        progressMessage="Requesting microphone access…"
        onJoin={vi.fn()}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      'Requesting microphone access…',
    );
  });

  it('offers an explicit retry after a recoverable error', () => {
    render(
      <JoinScreen
        busy={false}
        error="The voice service is unavailable. Try again."
        onJoin={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });
});
