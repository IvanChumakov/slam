import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { VoiceParticipant } from '../voice/types';
import { VoiceRoom } from './VoiceRoom';

const participants: VoiceParticipant[] = [
  { identity: 'ivan', displayName: 'Ivan', isLocal: true, isMuted: false },
  { identity: 'max', displayName: 'Max', isLocal: false, isMuted: true },
];

function renderRoom(overrides: { reconnecting?: boolean; audioBlocked?: boolean } = {}) {
  const actions = {
    setMuted: vi.fn().mockResolvedValue(undefined),
    enableAudio: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn().mockResolvedValue(undefined),
  };
  render(
    <VoiceRoom
      state={{
        roomName: 'General',
        phase: overrides.reconnecting ? 'reconnecting' : 'connected',
        participants,
        localMuted: false,
        needsAudioPermission: Boolean(overrides.audioBlocked),
      }}
      actions={actions}
    />,
  );
  return actions;
}

describe('VoiceRoom', () => {
  it('shows participants and their microphone states', () => {
    renderRoom();

    expect(screen.getByRole('heading', { name: 'General' })).toBeInTheDocument();
    expect(screen.getByText('Ivan')).toBeInTheDocument();
    expect(screen.getByText('(you)')).toBeInTheDocument();
    expect(screen.getByLabelText('Ivan microphone on')).toBeInTheDocument();
    expect(screen.getByLabelText('Max microphone muted')).toBeInTheDocument();
  });

  it('mutes the local microphone from the room controls', async () => {
    const actions = renderRoom();

    await userEvent.click(screen.getByRole('button', { name: 'Mute' }));

    expect(actions.setMuted).toHaveBeenCalledWith(true);
  });

  it('shows reconnect and blocked-audio recovery actions', async () => {
    const actions = renderRoom({ reconnecting: true, audioBlocked: true });

    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting…');
    await userEvent.click(screen.getByRole('button', { name: 'Enable audio' }));

    expect(actions.enableAudio).toHaveBeenCalledOnce();
  });

  it('leaves the room from the destructive action', async () => {
    const actions = renderRoom();

    await userEvent.click(screen.getByRole('button', { name: 'Leave' }));

    expect(actions.leave).toHaveBeenCalledOnce();
  });
});
