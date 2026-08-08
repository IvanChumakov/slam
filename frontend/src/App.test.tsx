import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { VoiceApi } from './api/voiceApi';
import { App } from './App';
import type { AppDependencies } from './appDependencies';
import type { VoiceClient } from './voice/types';

function createDependencies() {
  const api: VoiceApi = {
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
    enableAudio: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  const dependencies: AppDependencies = { api, createClient: () => client };
  return { api, client, dependencies };
}

describe('App', () => {
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
    expect(api.join).toHaveBeenCalledWith('signed-token', 'Ivan');
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
