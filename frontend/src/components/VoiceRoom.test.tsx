import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceParticipant } from '../voice/types';
import { VoiceRoom } from './VoiceRoom';

const participants: VoiceParticipant[] = [
  { identity: 'ivan', displayName: 'Ivan', isLocal: true, isMuted: false, isSpeaking: false },
  { identity: 'max', displayName: 'Max', isLocal: false, isMuted: true, isSpeaking: false },
];

const navigationState = { roomId: 42, rooms: [], roomsPending: false, roomsError: null,
  switching: false, inviteUrl: null, invitePending: false, inviteError: null,
  localCamera: false, cameraSupported: true, cameras: [], cameraPending: false };

function renderRoom(overrides: { reconnecting?: boolean; audioBlocked?: boolean; unsupported?: boolean; pending?: boolean; cameraUnsupported?: boolean; cameraPending?: boolean } = {}) {
  const actions = {
    switchRoom: vi.fn().mockResolvedValue(undefined), refreshRooms: vi.fn().mockResolvedValue(undefined), fetchInvite: vi.fn().mockResolvedValue(undefined),
    setMuted: vi.fn().mockResolvedValue(undefined),
    setIncomingMuted: vi.fn().mockResolvedValue(undefined),
    setScreenSharing: vi.fn().mockResolvedValue(undefined),
    setCameraEnabled: vi.fn().mockResolvedValue(undefined),
    enableAudio: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn().mockResolvedValue(undefined),
  };
  render(
    <VoiceRoom
      state={{
        ...navigationState,
        cameraSupported: !overrides.cameraUnsupported, cameraPending: Boolean(overrides.cameraPending),
        roomName: 'General',
        phase: overrides.reconnecting ? 'reconnecting' : 'connected',
        participants,
        localMuted: false,
        needsAudioPermission: Boolean(overrides.audioBlocked),
        incomingMuted: false, localSharing: false, screens: [],
        screenShareSupported: !overrides.unsupported,
        screenSharePending: Boolean(overrides.pending), microphonePending: false, error: null,
      }}
      actions={actions}
    />,
  );
  return actions;
}

describe('VoiceRoom', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () { this.open = true; this.querySelector<HTMLButtonElement>('button')?.focus(); };
    HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
  });
  it('shows explicit independent audio states and an initially off camera', async () => {
    const actions = renderRoom();
    expect(screen.getByText('Mic on')).toBeInTheDocument();
    expect(screen.getByText('Room audio on')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Camera' })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(screen.getByRole('button', { name: 'Camera' }));
    expect(actions.setCameraEnabled).toHaveBeenCalledWith(true);
    expect(actions.setMuted).not.toHaveBeenCalled();
    expect(actions.setScreenSharing).not.toHaveBeenCalled();
    expect(screen.queryByText('Speaking')).not.toBeInTheDocument();
  });

  it('opens a channels dialog and restores focus after Escape', async () => {
    renderRoom();
    const trigger = screen.getByRole('button', { name: 'Channels' });
    await userEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Group channels' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('allows keyboard users to dismiss a control tooltip without moving focus', async () => {
    renderRoom();
    const microphone = screen.getByRole('button', { name: 'Microphone' });
    await userEvent.click(microphone);
    await userEvent.keyboard('{Escape}');
    expect(screen.getByText('Mute microphone')).toHaveAttribute('hidden');
    expect(microphone).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByText('Mute room audio')).not.toHaveAttribute('hidden');
  });

  it('matches camera speaking state by identity, keeps screens separate, and removes video on unmount', () => {
    const camera = document.createElement('video');
    const shared = document.createElement('video');
    const view = render(<VoiceRoom state={{ ...navigationState, roomName: 'General', phase: 'connected',
      participants: [{ ...participants[0], isSpeaking: true }, { ...participants[1], displayName: 'Ivan' }],
      localMuted: false, incomingMuted: false, localSharing: false, needsAudioPermission: false,
      screenShareSupported: true, screenSharePending: false, microphonePending: false, error: null,
      cameras: [{ id: 'cam', participantIdentity: 'max', displayName: 'Ivan', isLocal: false, element: camera }],
      screens: [{ id: 'screen', participantIdentity: 'ivan', displayName: 'Ivan', isLocal: true, element: shared }],
    }} actions={{ switchRoom: vi.fn(), refreshRooms: vi.fn(), fetchInvite: vi.fn(), setMuted: vi.fn(),
      setIncomingMuted: vi.fn(), setScreenSharing: vi.fn(), setCameraEnabled: vi.fn(), enableAudio: vi.fn(), leave: vi.fn() }} />);
    expect(screen.getByText('Speaking')).toBeInTheDocument();
    expect(camera.closest('figure')).not.toHaveClass('media-speaking');
    expect(shared.closest('figure')).toHaveClass('media-speaking');
    expect(screen.getByRole('heading', { name: 'Cameras' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Shared screens' })).toBeInTheDocument();
    view.unmount();
    expect(camera.isConnected).toBe(false);
    expect(shared.isConnected).toBe(false);
  });
  it('shows participants and their microphone states', () => {
    renderRoom();

    expect(screen.getByRole('heading', { name: 'General' })).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Participants' })).getByText('Ivan')).toBeInTheDocument();
    expect(screen.getByText('(you)')).toBeInTheDocument();
    expect(screen.getByLabelText('Ivan microphone on')).toBeInTheDocument();
    expect(screen.getByLabelText('Max microphone muted')).toBeInTheDocument();
  });

  it('mutes the local microphone from the room controls', async () => {
    const actions = renderRoom();

    await userEvent.click(screen.getByRole('button', { name: 'Microphone' }));

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

  it('offers separate incoming audio and screen sharing controls', async () => {
    const actions = renderRoom();
    await userEvent.click(screen.getByRole('button', { name: 'Room audio' }));
    expect(actions.setIncomingMuted).toHaveBeenCalledWith(true);
    expect(actions.setMuted).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Screen sharing' }));
    expect(actions.setScreenSharing).toHaveBeenCalledWith(true);
  });

  it('explains unsupported capture and disables only screen sharing', () => {
    renderRoom({ unsupported: true });
    expect(screen.getByRole('button', { name: 'Screen sharing' })).toBeDisabled();
    expect(screen.getByText(/Screen sharing is not supported/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Room audio' })).toBeEnabled();
  });

  it('disables sharing while the chooser is pending but keeps Leave available', () => {
    renderRoom({ pending: true });
    expect(screen.getByRole('button', { name: 'Screen sharing' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Leave' })).toBeEnabled();
  });

  it('allows withdrawing a pending camera request without affecting other media or leaving', async () => {
    const actions = renderRoom({ cameraPending: true });
    expect(screen.getByRole('button', { name: 'Camera' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Camera' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Camera' })).toHaveTextContent('Cancel');
    expect(screen.getByRole('button', { name: 'Camera' })).toHaveAccessibleDescription('Cancel camera request');
    expect(screen.getByRole('button', { name: 'Microphone' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Leave' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Camera' }));
    expect(actions.setCameraEnabled).toHaveBeenCalledExactlyOnceWith(false);
    expect(actions.setMuted).not.toHaveBeenCalled();
    expect(actions.setIncomingMuted).not.toHaveBeenCalled();
    expect(actions.setScreenSharing).not.toHaveBeenCalled();
    expect(actions.leave).not.toHaveBeenCalled();
  });

  it('explains unsupported camera capture without disabling screen sharing', () => {
    renderRoom({ cameraUnsupported: true });
    expect(screen.getByRole('button', { name: 'Camera' })).toBeDisabled();
    expect(screen.getByText(/Camera capture is not supported/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Screen sharing' })).toBeEnabled();
  });

  it('renders local and remote screens while muted and removes video on unsubscribe/unmount', () => {
    const local = document.createElement('video');
    const remote = document.createElement('video');
    const state = { ...navigationState, roomName: 'General', phase: 'connected' as const, participants,
      localMuted: true, incomingMuted: true, localSharing: true, needsAudioPermission: false,
      screenShareSupported: true, screenSharePending: false, microphonePending: false,
      error: 'Screen sharing could not start. Try again.',
      screens: [{ id: 'local', participantIdentity: 'ivan', displayName: 'Ivan', isLocal: true, element: local },
        { id: 'remote', participantIdentity: 'max', displayName: 'Max', isLocal: false, element: remote }] };
    const actions = { switchRoom: vi.fn(), refreshRooms: vi.fn(), fetchInvite: vi.fn(), setMuted: vi.fn(), setIncomingMuted: vi.fn(), setScreenSharing: vi.fn(), setCameraEnabled: vi.fn(), enableAudio: vi.fn(), leave: vi.fn() };
    const view = render(<VoiceRoom state={state} actions={actions} />);
    expect(local.isConnected).toBe(true);
    expect(remote.isConnected).toBe(true);
    expect(screen.getByRole('button', { name: 'Screen sharing' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Screen sharing' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Microphone' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Microphone' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Room audio' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Room audio' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('alert')).toHaveTextContent(state.error);
    view.rerender(<VoiceRoom state={{ ...state, screens: [] }} actions={actions} />);
    expect(remote.isConnected).toBe(false);
    view.unmount();
    expect(local.isConnected).toBe(false);
  });
});
