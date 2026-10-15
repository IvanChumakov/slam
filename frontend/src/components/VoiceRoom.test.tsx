import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceParticipant } from '../voice/types';
import { VoiceRoom, type ConnectedRoomState } from './VoiceRoom';

const participants: VoiceParticipant[] = [
  { identity: 'ivan', displayName: 'Ivan', isLocal: true, isMuted: false, isSpeaking: false },
  { identity: 'max', displayName: 'Max', isLocal: false, isMuted: true, isSpeaking: false },
];

const navigationState = { roomId: 42, rooms: [], roomsPending: false, roomsError: null,
  switching: false, inviteUrl: null, invitePending: false, inviteError: null,
  localCamera: false, cameraSupported: true, cameras: [], cameraPending: false, soundsEnabled: true };

function renderRoom(overrides: { reconnecting?: boolean; audioBlocked?: boolean; unsupported?: boolean; pending?: boolean; cameraUnsupported?: boolean; cameraPending?: boolean; state?: Partial<ConnectedRoomState> } = {}) {
  const actions = {
    switchRoom: vi.fn().mockResolvedValue(undefined), refreshRooms: vi.fn().mockResolvedValue(undefined), fetchInvite: vi.fn().mockResolvedValue(undefined),
    setMuted: vi.fn().mockResolvedValue(undefined),
    setIncomingMuted: vi.fn().mockResolvedValue(undefined),
    setSoundsEnabled: vi.fn(),
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
        ...overrides.state,
      }}
      actions={actions}
    />,
  );
  return actions;
}

describe('VoiceRoom', () => {
  it.each([
    { state: {}, expected: ['On', 'On', 'Off', 'Off'] },
    { state: { localMuted: true, incomingMuted: true, localCamera: true, localSharing: true }, expected: ['Off', 'Off', 'On', 'On'] },
    { state: { needsAudioPermission: true }, expected: ['On', 'Paused', 'Off', 'Off'] },
    { state: { needsAudioPermission: true, incomingMuted: true }, expected: ['On', 'Off', 'Off', 'Off'] },
    { state: { microphonePending: true, cameraPending: true, screenSharePending: true }, expected: ['Wait', 'On', 'Pending', 'Wait'] },
    { state: { cameraSupported: false, screenShareSupported: false }, expected: ['On', 'On', 'N/A', 'N/A'] },
  ])('shows media states inside their buttons without hover: $expected', ({ state, expected }) => {
    renderRoom({ state });
    ['Microphone', 'Room audio', 'Camera', 'Screen sharing'].forEach((name, index) => {
      expect(within(screen.getByRole('button', { name })).getByText(expected[index])).toBeVisible();
    });
    expect(within(screen.getByLabelText('Room controls')).getAllByRole('button')).toHaveLength(5);
  });
  it('shows current live names and remote channel rosters without switching', async () => {
    const state = { ...navigationState, phase: 'connected' as const, roomName: 'General', participants,
      rooms: [{ id: 42, name: 'General', online_count: 1, participants: [{ identity: 'old', display_name: 'Old name' }] },
        { id: 43, name: 'Lounge', online_count: 2, participants: [{ identity: 'anna', display_name: 'Anna' }, { identity: 'sam', display_name: 'Sam' }] }],
      localMuted: false, needsAudioPermission: false, incomingMuted: false, localSharing: false,
      screens: [], screenShareSupported: true, screenSharePending: false, microphonePending: false, error: null };
    const actions = { switchRoom: vi.fn(), refreshRooms: vi.fn(), fetchInvite: vi.fn(), setMuted: vi.fn(),
      setIncomingMuted: vi.fn(), setSoundsEnabled: vi.fn(), setScreenSharing: vi.fn(), setCameraEnabled: vi.fn(), enableAudio: vi.fn(), leave: vi.fn() };
    const view = render(<VoiceRoom state={state} actions={actions} />);
    const rail = screen.getByRole('complementary', { name: 'Group channels' });
    const own = within(rail).getByRole('list', { name: 'Participants in General' });
    expect(within(own).getByText('Ivan')).toBeInTheDocument();
    expect(within(own).getByText('Max')).toBeInTheDocument();
    expect(within(own).getByText('You')).toBeInTheDocument();
    expect(within(rail).queryByText('Old name')).not.toBeInTheDocument();
    expect(within(rail).getByText('Anna')).toBeInTheDocument();
    expect(within(rail).getByText('Sam')).toBeInTheDocument();
    expect(actions.switchRoom).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Channels' }));
    expect(within(screen.getByRole('dialog')).getByText('Anna')).toBeInTheDocument();
    view.rerender(<VoiceRoom state={{ ...state, roomsError: 'Unavailable' }} actions={actions} />);
    expect(within(rail).getByRole('list', { name: 'Participants in Lounge (last known)' })).toHaveTextContent('Anna');
    expect(within(rail).getByRole('list', { name: 'Participants in General' })).toHaveTextContent('Ivan');
    view.rerender(<VoiceRoom state={{ ...state, rooms: [state.rooms[0], { ...state.rooms[1], online_count: 1, participants: [state.rooms[1].participants[1]] }] }} actions={actions} />);
    expect(within(rail).queryByText('Anna')).not.toBeInTheDocument();
    expect(within(rail).getByRole('list', { name: 'Participants in Lounge' })).toHaveTextContent('Sam');
  });
  it('uses all LiveKit participants for the current count and labels every other count stale until API recovery', async () => {
    const state = { ...navigationState, phase: 'connected' as const, roomName: 'General', participants,
      rooms: [{ id: 42, name: 'General', online_count: 99, participants: Array.from({ length: 99 }, (_, index) => ({ identity: `old${index}`, display_name: `Old ${index}` })) },
        { id: 43, name: 'Lounge', online_count: 4, participants: Array.from({ length: 4 }, (_, index) => ({ identity: `guest${index}`, display_name: `Guest ${index}` })) },
        { id: 44, name: 'Quiet', online_count: 0, participants: [] }],
      localMuted: false, needsAudioPermission: false, incomingMuted: false, localSharing: false,
      screens: [], screenShareSupported: true, screenSharePending: false, microphonePending: false, error: null };
    const actions = { switchRoom: vi.fn(), refreshRooms: vi.fn(), fetchInvite: vi.fn(), setMuted: vi.fn(),
      setIncomingMuted: vi.fn(), setSoundsEnabled: vi.fn(), setScreenSharing: vi.fn(), setCameraEnabled: vi.fn(), enableAudio: vi.fn(), leave: vi.fn() };
    const view = render(<VoiceRoom state={state} actions={actions} />);
    expect(screen.getByRole('button', { name: 'General, 2 online, current channel' })).toHaveTextContent('2 online');
    expect(screen.getByRole('button', { name: 'Lounge, 4 online' })).toHaveTextContent('4 online');
    view.rerender(<VoiceRoom state={{ ...state, roomsError: 'Unavailable' }} actions={actions} />);
    expect(screen.getByRole('button', { name: 'General, 2 online, current channel' })).toHaveTextContent('2 online');
    expect(screen.getByRole('button', { name: 'Lounge, 4 online (last known)' })).toHaveTextContent('4 online (last known)');
    expect(screen.getByRole('button', { name: 'Quiet, 0 online (last known)' })).toHaveTextContent('0 online (last known)');
    await userEvent.click(screen.getByRole('button', { name: 'Channels' }));
    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getByRole('button', { name: 'General, 2 online, current channel' })).toHaveTextContent('2 online');
    expect(within(drawer).getByRole('button', { name: 'Quiet, 0 online (last known)' })).toHaveTextContent('0 online (last known)');
    view.rerender(<VoiceRoom state={{ ...state, roomsPending: true, roomsError: 'Unavailable' }} actions={actions} />);
    expect(within(drawer).getByRole('button', { name: 'Lounge, 4 online (last known)' })).toBeInTheDocument();
    view.rerender(<VoiceRoom state={state} actions={actions} />);
    expect(within(drawer).getByRole('button', { name: 'Lounge, 4 online' })).toBeInTheDocument();
    expect(screen.queryByText(/last known/)).not.toBeInTheDocument();
  });
  it('offers a notification sound toggle independent of microphone and room audio', async () => {
    const actions = renderRoom();
    const toggle = screen.getByRole('button', { name: 'Notification sounds' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(toggle);
    expect(actions.setSoundsEnabled).toHaveBeenCalledWith(false);
    expect(actions.setMuted).not.toHaveBeenCalled();
    expect(actions.setIncomingMuted).not.toHaveBeenCalled();
  });
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
      setIncomingMuted: vi.fn(), setSoundsEnabled: vi.fn(), setScreenSharing: vi.fn(), setCameraEnabled: vi.fn(), enableAudio: vi.fn(), leave: vi.fn() }} />);
    expect(screen.getByText('Speaking')).toBeInTheDocument();
    expect(camera.closest('figure')).not.toHaveClass('media-speaking');
    expect(shared.closest('figure')).toHaveClass('media-speaking');
    expect(screen.getByRole('heading', { name: 'Cameras' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Shared screens' })).toBeInTheDocument();
    const sharedSection = screen.getByRole('region', { name: 'Shared screens' });
    expect(sharedSection.compareDocumentPosition(screen.getByRole('list', { name: 'Participants' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sharedSection.compareDocumentPosition(screen.getByRole('region', { name: 'Cameras' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    const actions = { switchRoom: vi.fn(), refreshRooms: vi.fn(), fetchInvite: vi.fn(), setMuted: vi.fn(), setIncomingMuted: vi.fn(), setSoundsEnabled: vi.fn(), setScreenSharing: vi.fn(), setCameraEnabled: vi.fn(), enableAudio: vi.fn(), leave: vi.fn() };
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
