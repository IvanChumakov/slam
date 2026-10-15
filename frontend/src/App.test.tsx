import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VoiceApi } from './api/voiceApi';
import { App } from './App';
import type { AppDependencies } from './appDependencies';
import type { VoiceClient } from './voice/types';

function createDependencies() {
  const api: VoiceApi = {
    listRooms: vi.fn().mockResolvedValue({ current_room_id: 42, rooms: [{ id: 42, name: 'General', online_count: 1, participants: [{ identity: 'ivan', display_name: 'Ivan' }] }, { id: 43, name: 'Lounge', online_count: 0, participants: [] }] }),
    createInvite: vi.fn().mockResolvedValue({ join_token: 'fresh', join_url: 'https://voice.test/join/fresh', room: { id: 42, name: 'General' }, expires_in: 3600 }),
    join: vi.fn().mockResolvedValue({
      livekit_url: 'wss://rtc.test',
      access_token: 'jwt',
      room: { id: 42, name: 'General' },
      participant: { identity: 'guest_1', display_name: 'Ivan' },
    }),
  };
  const client: VoiceClient = {
    subscribe: vi.fn().mockReturnValue(vi.fn()),
    connect: vi.fn().mockResolvedValue(undefined),
    enableMicrophone: vi.fn().mockResolvedValue(undefined),
    setMuted: vi.fn().mockResolvedValue(undefined),
    setIncomingMuted: vi.fn().mockResolvedValue(undefined),
    setScreenSharing: vi.fn().mockResolvedValue(undefined),
    setCameraEnabled: vi.fn().mockResolvedValue(undefined),
    enableAudio: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  const dependencies: AppDependencies = { api, createClient: () => client };
  return { api, client, dependencies };
}

afterEach(() => vi.unstubAllGlobals());

function CurrentPath() {
  return <output data-testid="route">{useLocation().pathname}</output>;
}

describe('App', () => {
  it('keeps appearance in a global footer before and during a call without reconnecting', async () => {
    const { api, client, dependencies } = createDependencies();
    const { container } = render(<MemoryRouter initialEntries={['/join/test-token']}><App dependencies={dependencies} /></MemoryRouter>);
    const appearance = screen.getByText('Theme & colors').closest('details');
    expect(container.querySelector('.app-topbar details')).toBeNull();
    expect(container.querySelector('.app-shell > .app-footer')).toContainElement(appearance);
    await userEvent.click(screen.getByText('Theme & colors'));
    await userEvent.type(screen.getByLabelText('Your name'), 'Ivan');
    await userEvent.click(screen.getByRole('button', { name: 'Join voice' }));
    await screen.findByRole('heading', { name: 'General' });
    expect(container.querySelector('.app-shell > .app-footer')).toContainElement(appearance);
    expect(container.querySelectorAll('.control-buttons button')).toHaveLength(5);
    expect(container.querySelector('.room-controls details')).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Accent color'), 'slate');
    expect(document.documentElement.dataset.accent).toBe('slate');
    expect(api.join).toHaveBeenCalledOnce();
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('closes the old call and uses a newly navigated invite instead of the prior bearer', async () => {
    const { api, client, dependencies } = createDependencies();
    render(<MemoryRouter initialEntries={['/join/first-token']}><App dependencies={dependencies} /><Link to="/join/second-token">Other invite</Link></MemoryRouter>);
    await userEvent.type(screen.getByLabelText('Your name'), 'First');
    await userEvent.click(screen.getByRole('button', { name: 'Join voice' }));
    await screen.findByRole('heading', { name: 'General' });
    await userEvent.click(screen.getByRole('link', { name: 'Other invite' }));
    await screen.findByLabelText('Your name');
    await waitFor(() => expect(client.disconnect).toHaveBeenCalledOnce());
    await userEvent.type(screen.getByLabelText('Your name'), 'Second');
    await userEvent.click(screen.getByRole('button', { name: 'Join voice' }));
    await screen.findByRole('heading', { name: 'General' });
    expect(api.join).toHaveBeenLastCalledWith('second-token', 'Second', undefined, expect.any(AbortSignal));
  });
  it('opens an encoded Mini App room invite, verifies profile, and preserves it through switching', async () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJyb29tX2lkIjo0Mn0.signature';
    const start = `join_${btoa(token).replace(/=+$/, '')}`;
    const ready = vi.fn(); const expand = vi.fn();
    vi.stubGlobal('Telegram', { WebApp: { initData: 'signed-data', initDataUnsafe: { start_param: start, user: { username: 'unsafe' } }, ready, expand } });
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ username: 'alex', avatar_url: null })));
    vi.stubGlobal('fetch', fetcher);
    const { api, client, dependencies } = createDependencies();
    vi.mocked(api.createInvite).mockResolvedValue({ join_token: 'target', join_url: 'https://voice.test/join/target', room: { id: 43, name: 'Lounge' }, expires_in: 3600 });
    vi.mocked(api.join).mockResolvedValueOnce({ livekit_url: 'wss://rtc.test', access_token: 'jwt', room: { id: 42, name: 'General' }, participant: { identity: 'alex', display_name: 'alex' } })
      .mockResolvedValue({ livekit_url: 'wss://rtc.test', access_token: 'next', room: { id: 43, name: 'Lounge' }, participant: { identity: 'alex', display_name: 'alex' } });
    render(<MemoryRouter initialEntries={['/']}><App dependencies={dependencies} /><CurrentPath /></MemoryRouter>);
    await waitFor(() => expect(screen.getByLabelText('Your name')).toHaveValue('alex'));
    expect(screen.getByTestId('route')).toHaveTextContent(`/join/${token}`);
    expect(ready).toHaveBeenCalledOnce(); expect(expand).toHaveBeenCalledOnce();
    expect(client.enableMicrophone).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Join voice' }));
    await screen.findByRole('heading', { name: 'General' });
    expect(api.join).toHaveBeenCalledWith(token, 'alex', 'signed-data', expect.any(AbortSignal));
    await userEvent.click(screen.getByRole('button', { name: 'Lounge, 0 online' }));
    await screen.findByRole('heading', { name: 'Lounge' });
    expect(api.join).toHaveBeenLastCalledWith('target', 'alex', 'signed-data', expect.any(AbortSignal));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(client.disconnect).toHaveBeenCalledOnce();
  });

  it('protects typed names while profile verification is pending', async () => {
    vi.stubGlobal('Telegram', { WebApp: { initData: 'signed-data' } });
    let resolve!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise((done) => { resolve = done; })));
    const { dependencies } = createDependencies();
    render(<MemoryRouter initialEntries={['/join/signed-token']}><App dependencies={dependencies} /></MemoryRouter>);
    await userEvent.type(screen.getByLabelText('Your name'), 'Manual');
    await act(async () => resolve(new Response(JSON.stringify({ username: 'alex', avatar_url: null }))));
    expect(screen.getByLabelText('Your name')).toHaveValue('Manual');
  });

  it.each([401, 500])('joins as an ordinary guest when profile fails with %s', async (status) => {
    vi.stubGlobal('Telegram', { WebApp: { initData: 'untrusted', initDataUnsafe: { user: { username: 'unsafe', photo_url: 'https://images.test/unsafe' } } } });
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status }));
    vi.stubGlobal('fetch', fetcher);
    const { api, dependencies } = createDependencies();
    render(<MemoryRouter initialEntries={['/join/signed-token']}><App dependencies={dependencies} /></MemoryRouter>);
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(screen.getByLabelText('Your name')).toHaveValue('');
    expect(document.querySelector('img')).toBeNull();
    await userEvent.type(screen.getByLabelText('Your name'), 'Guest');
    await userEvent.click(screen.getByRole('button', { name: 'Join voice' }));
    await screen.findByRole('heading', { name: 'General' });
    expect(api.join).toHaveBeenCalledExactlyOnceWith('signed-token', 'Guest', undefined, expect.any(AbortSignal));
  });

  it('initializes an available SDK but does not fetch profiles for ordinary guests', () => {
    const ready = vi.fn(); const expand = vi.fn();
    vi.stubGlobal('Telegram', { WebApp: { initData: '', ready, expand } });
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const { dependencies } = createDependencies();
    render(<MemoryRouter initialEntries={['/join/signed-token']}><App dependencies={dependencies} /></MemoryRouter>);
    expect(screen.getByLabelText('Your name')).toHaveValue('');
    expect(fetcher).not.toHaveBeenCalled();
    expect(ready).toHaveBeenCalledOnce(); expect(expand).toHaveBeenCalledOnce();
  });

  it('explains how to open a room when a Mini App has no invite', () => {
    vi.stubGlobal('Telegram', { WebApp: { initData: 'signed-data' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    const { dependencies } = createDependencies();
    render(<MemoryRouter initialEntries={['/']}><App dependencies={dependencies} /></MemoryRouter>);
    expect(screen.getByText(/open a room from.*group.*card/i)).toBeInTheDocument();
    expect(screen.queryByText('Invalid or expired invite.')).not.toBeInTheDocument();
  });

  it.each(['join_%%%', 'raw.token.value', `join_${btoa('../unsafe')}`])('does not route unsafe start parameters %s', (start) => {
    const { api, dependencies } = createDependencies();
    render(<MemoryRouter initialEntries={[`/?tgWebAppStartParam=${encodeURIComponent(start)}`]}><App dependencies={dependencies} /><CurrentPath /></MemoryRouter>);
    expect(screen.getByTestId('route')).toHaveTextContent('/');
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid or expired invite.');
    expect(api.join).not.toHaveBeenCalled();
  });

  it.each(['query', 'hash'])('routes a safe start parameter from %s without an SDK', async (source) => {
    const token = 'header.payload.signature'; const start = `join_${btoa(token).replace(/=+$/, '')}`;
    const entry = source === 'query' ? `/?tgWebAppStartParam=${start}` : `/#tgWebAppStartParam=${start}`;
    const { dependencies } = createDependencies();
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    render(<MemoryRouter initialEntries={[entry]}><App dependencies={dependencies} /><CurrentPath /></MemoryRouter>);
    expect(await screen.findByLabelText('Your name')).toHaveValue('');
    expect(screen.getByTestId('route')).toHaveTextContent(`/join/${token}`);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('shows a manual link when Clipboard API is missing and copies on a fresh click when available', async () => {
    const user = userEvent.setup();
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const { client, dependencies } = createDependencies();
    try {
      render(<MemoryRouter initialEntries={['/join/signed-token']}><App dependencies={dependencies} /></MemoryRouter>);
      await user.type(screen.getByLabelText('Your name'), 'Ivan');
      await user.click(screen.getByRole('button', { name: 'Join voice' }));
      await screen.findByRole('heading', { name: 'General' });
      await user.click(screen.getByRole('button', { name: 'Share room' }));
      await screen.findByLabelText('Room invite link');
      await user.click(screen.getByRole('button', { name: 'Copy link' }));
      expect(screen.getByText('Copy was unavailable. Select and copy the link above.')).toBeInTheDocument();
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      await user.click(screen.getByRole('button', { name: 'Copy link' }));
      expect(writeText).toHaveBeenCalledWith('https://voice.test/join/fresh');
      expect(screen.getByText('Link copied.')).toBeInTheDocument();
      expect(client.disconnect).not.toHaveBeenCalled();
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
    }
  });

  it('removes the old invite and ignores late copy failures after selecting another channel', async () => {
    const user = userEvent.setup();
    let rejectCopy!: (error: Error) => void;
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockReturnValue(new Promise((_, reject) => { rejectCopy = reject; }));
    const { api, dependencies } = createDependencies();
    vi.mocked(api.createInvite).mockResolvedValueOnce({ join_token: 'fresh', join_url: 'https://voice.test/join/fresh', room: { id: 42, name: 'General' }, expires_in: 3600 })
      .mockResolvedValue({ join_token: 'lounge', join_url: 'https://voice.test/join/lounge', room: { id: 43, name: 'Lounge' }, expires_in: 3600 });
    vi.mocked(api.join).mockResolvedValueOnce({ livekit_url: 'wss://rtc.test', access_token: 'jwt', room: { id: 42, name: 'General' }, participant: { identity: 'ivan', display_name: 'Ivan' } })
      .mockResolvedValue({ livekit_url: 'wss://rtc.test', access_token: 'next', room: { id: 43, name: 'Lounge' }, participant: { identity: 'ivan', display_name: 'Ivan' } });
    render(<MemoryRouter initialEntries={['/join/signed-token']}><App dependencies={dependencies} /></MemoryRouter>);
    await user.type(screen.getByLabelText('Your name'), 'Ivan');
    await user.click(screen.getByRole('button', { name: 'Join voice' }));
    await screen.findByRole('heading', { name: 'General' });
    await user.click(screen.getByRole('button', { name: 'Share room' }));
    await screen.findByLabelText('Room invite link');
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    await user.click(screen.getByRole('button', { name: 'Lounge, 0 online' }));
    await screen.findByRole('heading', { name: 'Lounge' });
    expect(screen.queryByLabelText('Room invite link')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Share room' }));
    expect(api.createInvite).toHaveBeenLastCalledWith('lounge', 43);
    expect(await screen.findByLabelText('Room invite link')).toHaveValue('https://voice.test/join/lounge');
    await act(async () => rejectCopy(new Error('late denial')));
    expect(screen.queryByText('Copy was unavailable. Select and copy the link above.')).not.toBeInTheDocument();
    clipboard.mockRestore();
  });
  it('keeps the call connected when fetching an invite fails', async () => {
    const { api, client, dependencies } = createDependencies();
    vi.mocked(api.createInvite).mockRejectedValue(new Error('offline'));
    render(<MemoryRouter initialEntries={['/join/signed-token']}><App dependencies={dependencies} /></MemoryRouter>);
    await userEvent.type(screen.getByLabelText('Your name'), 'Ivan');
    await userEvent.click(screen.getByRole('button', { name: 'Join voice' }));
    await screen.findByRole('heading', { name: 'General' });
    await userEvent.click(screen.getByRole('button', { name: 'Share room' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invite could not be created');
    expect(screen.getByRole('button', { name: 'Leave' })).toBeEnabled();
    expect(client.disconnect).not.toHaveBeenCalled();
  });
  it('lists the current channel and switches without retyping the name, updating the route safely', async () => {
    const { api, client, dependencies } = createDependencies();
    vi.mocked(client.subscribe).mockImplementation((listener) => {
      vi.mocked(client.connect).mockImplementation(async () => listener({
        connection: 'connected', participants: [{ identity: 'ivan', displayName: 'Ivan', isLocal: true, isMuted: false, isSpeaking: false }],
        localMuted: false, incomingMuted: false, localSharing: false, screenShareSupported: true,
        screens: [], needsAudioPermission: false, localCamera: false, cameraSupported: true, cameras: [],
      }));
      return vi.fn();
    });
    vi.mocked(api.createInvite).mockResolvedValue({ join_token: 'lounge', join_url: 'https://voice.test/join/lounge', room: { id: 43, name: 'Lounge' }, expires_in: 3600 });
    vi.mocked(api.join).mockResolvedValueOnce({ livekit_url: 'wss://rtc.test', access_token: 'jwt', room: { id: 42, name: 'General' }, participant: { identity: 'ivan', display_name: 'Ivan' } })
      .mockResolvedValue({ livekit_url: 'wss://rtc.test', access_token: 'next', room: { id: 43, name: 'Lounge' }, participant: { identity: 'ivan', display_name: 'Ivan' } });
    vi.mocked(api.listRooms).mockResolvedValueOnce({ current_room_id: 42, rooms: [{ id: 42, name: 'General', online_count: 1, participants: [{ identity: 'ivan', display_name: 'Ivan' }] }, { id: 43, name: 'Lounge', online_count: 0, participants: [] }] })
      .mockResolvedValue({ current_room_id: 43, rooms: [{ id: 42, name: 'General', online_count: 0, participants: [] }, { id: 43, name: 'Lounge', online_count: 1, participants: [{ identity: 'ivan', display_name: 'Ivan' }] }] });
    const replace = vi.spyOn(window.history, 'replaceState');
    render(<MemoryRouter initialEntries={['/join/signed-token']}><App dependencies={dependencies} /></MemoryRouter>);
    await userEvent.type(screen.getByLabelText('Your name'), 'Ivan');
    await userEvent.click(screen.getByRole('button', { name: 'Join voice' }));
    expect(await screen.findByRole('button', { name: 'General, 1 online, current channel' })).toHaveAttribute('aria-current', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Lounge, 0 online' }));
    expect(await screen.findByRole('heading', { name: 'Lounge' })).toBeInTheDocument();
    expect(api.join).toHaveBeenLastCalledWith('lounge', 'Ivan', undefined, expect.any(AbortSignal));
    expect(client.disconnect).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith(window.history.state, '', '/join/lounge');
    replace.mockRestore();
  });

  it('fetches a fresh current-room link and provides explicit Copy with a manual fallback on denial', async () => {
    const user = userEvent.setup();
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    const { api, client, dependencies } = createDependencies();
    render(<MemoryRouter initialEntries={['/join/signed-token']}><App dependencies={dependencies} /></MemoryRouter>);
    await user.type(screen.getByLabelText('Your name'), 'Ivan');
    await user.click(screen.getByRole('button', { name: 'Join voice' }));
    await screen.findByRole('heading', { name: 'General' });
    await user.click(screen.getByRole('button', { name: 'Share room' }));
    expect(api.createInvite).toHaveBeenCalledWith('signed-token', 42);
    expect(await screen.findByLabelText('Room invite link')).toHaveValue('https://voice.test/join/fresh');
    expect(clipboard).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(await screen.findByText('Copy was unavailable. Select and copy the link above.')).toBeInTheDocument();
    expect(client.disconnect).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Share room' }));
    expect(api.createInvite).toHaveBeenCalledTimes(2);
    clipboard.mockRestore();
  });
  it('explains that room access is being requested while the backend responds', async () => {
    let resolveJoin: ((value: Awaited<ReturnType<VoiceApi['join']>>) => void) | undefined;
    const pendingJoin = new Promise<Awaited<ReturnType<VoiceApi['join']>>>((resolve) => {
      resolveJoin = resolve;
    });
    const { api, dependencies } = createDependencies();
    vi.mocked(api.join).mockReturnValue(pendingJoin);
    render(
      <MemoryRouter initialEntries={['/join/signed-token']}>
        <App dependencies={dependencies} />
      </MemoryRouter>,
    );

    await userEvent.type(screen.getByLabelText('Your name'), 'Ivan');
    await userEvent.click(screen.getByRole('button', { name: 'Join voice' }));

    expect(screen.getByRole('status')).toHaveTextContent('Getting room access…');

    await act(async () => {
      resolveJoin?.({
        livekit_url: 'wss://rtc.test',
        access_token: 'jwt',
        room: { id: 42, name: 'General' },
        participant: { identity: 'guest_1', display_name: 'Ivan' },
      });
      await pendingJoin;
    });
  });

  it('joins with the route token and renders the backend room name', async () => {
    const { api, client, dependencies } = createDependencies();
    render(
      <MemoryRouter initialEntries={['/join/signed-token']}>
        <App dependencies={dependencies} />
      </MemoryRouter>,
    );

    await userEvent.type(screen.getByLabelText('Your name'), 'Ivan');
    await userEvent.click(screen.getByRole('button', { name: 'Join voice' }));

    expect(await screen.findByRole('heading', { name: 'General' })).toBeInTheDocument();
    expect(api.join).toHaveBeenCalledWith('signed-token', 'Ivan', undefined, expect.any(AbortSignal));
    expect(client.enableMicrophone).toHaveBeenCalledOnce();
  });

  it('leaves cleanly and can return to the join screen', async () => {
    const { client, dependencies } = createDependencies();
    render(
      <MemoryRouter initialEntries={['/join/signed-token']}>
        <App dependencies={dependencies} />
      </MemoryRouter>,
    );
    await userEvent.type(screen.getByLabelText('Your name'), 'Ivan');
    await userEvent.click(screen.getByRole('button', { name: 'Join voice' }));
    await screen.findByRole('heading', { name: 'General' });

    await userEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(await screen.findByText('You left the room.')).toBeInTheDocument();
    expect(client.disconnect).toHaveBeenCalledOnce();

    await userEvent.click(screen.getByRole('button', { name: 'Join again' }));
    expect(screen.getByRole('heading', { name: 'Join the conversation' })).toBeInTheDocument();
  });

  it('wires independent audio and sharing controls and keeps them visible after cancellation', async () => {
    const { client, dependencies } = createDependencies();
    vi.mocked(client.subscribe).mockImplementation((listener) => {
      vi.mocked(client.connect).mockImplementation(async () => listener({
        connection: 'connected', participants: [], localMuted: false, incomingMuted: false,
        localSharing: false, screenShareSupported: true, screens: [], needsAudioPermission: false,
        localCamera: false, cameraSupported: true, cameras: [],
      }));
      return vi.fn();
    });
    vi.mocked(client.setScreenSharing).mockRejectedValue(new DOMException('Cancelled', 'NotAllowedError'));
    render(<MemoryRouter initialEntries={['/join/signed-token']}><App dependencies={dependencies} /></MemoryRouter>);
    await userEvent.type(screen.getByLabelText('Your name'), 'Ivan');
    await userEvent.click(screen.getByRole('button', { name: 'Join voice' }));
    await screen.findByRole('heading', { name: 'General' });
    await userEvent.click(screen.getByRole('button', { name: 'Room audio' }));
    expect(client.setIncomingMuted).toHaveBeenCalledWith(true);
    expect(client.setMuted).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Camera' })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(screen.getByRole('button', { name: 'Camera' }));
    expect(client.setCameraEnabled).toHaveBeenCalledWith(true);
    expect(client.setMuted).not.toHaveBeenCalled();
    expect(client.setScreenSharing).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Screen sharing' }));
    expect(client.setScreenSharing).toHaveBeenCalledWith(true);
    expect(await screen.findByRole('alert')).toHaveTextContent('Screen sharing was cancelled');
    expect(screen.getByRole('button', { name: 'Screen sharing' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Microphone' })).toBeEnabled();
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('shows an invalid invite instead of a blank page for unknown routes', () => {
    const { dependencies } = createDependencies();
    render(
      <MemoryRouter initialEntries={['/']}>
        <App dependencies={dependencies} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Invalid or expired invite.');
  });
});
