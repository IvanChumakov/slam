import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { JoinScreen } from './JoinScreen';

describe('JoinScreen', () => {
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
});
