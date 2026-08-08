# Web Voice Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the responsive React web client that joins a LiveKit audio room from `/join/:token` and supports participants, remote audio, mute, leave, reconnect, mock API development, and recoverable errors.

**Architecture:** Keep all implementation under `frontend/`. A typed API adapter owns the fixed backend contract, a `VoiceClient` interface isolates LiveKit, and `useVoiceRoom` owns the connection state machine; React components only render state and call commands.

**Tech Stack:** React 19.2.8, TypeScript 6.0.3, Vite 8.2.1, React Router 7.18.2, LiveKit Client 2.21.0, Vitest 4.1.10, React Testing Library 16.3.2, ESLint 10.8.1, plain CSS.

## Global Constraints

- Keep application code, tests, tooling, and documentation inside `frontend/`; do not edit `/backend` or `/infra`.
- Keep `POST /api/voice/join` request fields `join_token` and `display_name`, and the response shape from `telegram_voice_team_spec.md`, unchanged.
- The route is `/join/:token`; the frontend passes the token to the backend without validating its signature.
- Trim display names, reject empty names, and enforce a maximum of 32 characters.
- Do not store a LiveKit API secret in frontend files or environment variables.
- Do not add video, screen sharing, text chat, authentication, registration, recording, multiple voice channels, or Telegram Mini App behavior.
- Before Task 3 and Task 6, run `git fetch --all --prune` and inspect `git log --all -20 --oneline --decorate`; adapt only frontend boundaries if a shared contract changed.
- Follow red-green-refactor for every production behavior: add one failing test, observe the expected failure, add minimal code, and rerun the focused and full test suites.

---

### Task 1: Frontend toolchain and validated join form

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/tsconfig.json`
- Create: `frontend/tsconfig.app.json`
- Create: `frontend/tsconfig.node.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/eslint.config.js`
- Create: `frontend/index.html`
- Create: `frontend/src/vite-env.d.ts`
- Create: `frontend/src/test/setup.ts`
- Create: `frontend/src/components/JoinScreen.test.tsx`
- Create: `frontend/src/components/JoinScreen.tsx`

**Interfaces:**
- Produces: `JoinScreen({ busy, error, onJoin })`, where `onJoin(trimmedDisplayName: string): void` receives a non-empty name of at most 32 characters.

- [ ] **Step 1: Add the test/lint/build toolchain**

Create `package.json` with scripts `dev`, `build`, `lint`, and `test`; pin the versions from the plan header. Configure Vite with React and jsdom tests, strict TypeScript project references, Testing Library setup, and flat ESLint rules for TypeScript and React hooks. `index.html` must contain `<div id="root"></div>` and load `/src/main.tsx`.

```json
{
  "name": "slam-voice-client",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "lint": "eslint .",
    "test": "vitest run"
  },
  "dependencies": {
    "livekit-client": "2.21.0",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "react-router-dom": "7.18.2"
  },
  "devDependencies": {
    "@eslint/js": "10.0.1",
    "@testing-library/jest-dom": "7.0.0",
    "@testing-library/react": "16.3.2",
    "@testing-library/user-event": "14.6.3",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.4",
    "@vitejs/plugin-react": "6.0.5",
    "eslint": "10.8.1",
    "eslint-plugin-react-hooks": "7.1.1",
    "eslint-plugin-react-refresh": "0.5.3",
    "globals": "17.9.0",
    "jsdom": "30.0.1",
    "typescript": "6.0.3",
    "typescript-eslint": "8.66.0",
    "vite": "8.2.1",
    "vitest": "4.1.10"
  }
}
```

- [ ] **Step 2: Write the failing join-form tests**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { JoinScreen } from './JoinScreen';

describe('JoinScreen', () => {
  it('trims a valid display name before joining', async () => {
    const onJoin = vi.fn();
    render(<JoinScreen busy={false} error={null} onJoin={onJoin} />);
    await userEvent.type(screen.getByLabelText('Your name'), '  Ivan  ');
    await userEvent.click(screen.getByRole('button', { name: 'Join Voice' }));
    expect(onJoin).toHaveBeenCalledWith('Ivan');
  });

  it('rejects an empty trimmed name', async () => {
    render(<JoinScreen busy={false} error={null} onJoin={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Your name'), '   ');
    await userEvent.click(screen.getByRole('button', { name: 'Join Voice' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter your name');
  });

  it('disables input and submit while joining', () => {
    render(<JoinScreen busy error={null} onJoin={vi.fn()} />);
    expect(screen.getByLabelText('Your name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Connecting…' })).toBeDisabled();
  });
});
```

- [ ] **Step 3: Run the test and verify RED**

Run: `cd frontend && npm install && npm test -- src/components/JoinScreen.test.tsx`

Expected: FAIL because `./JoinScreen` does not exist.

- [ ] **Step 4: Implement the minimal accessible form**

```tsx
import { FormEvent, useState } from 'react';

type JoinScreenProps = {
  busy: boolean;
  error: string | null;
  onJoin: (displayName: string) => void;
};

export function JoinScreen({ busy, error, onJoin }: JoinScreenProps) {
  const [name, setName] = useState('');
  const [validation, setValidation] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setValidation('Enter your name');
      return;
    }
    setValidation(null);
    onJoin(trimmed);
  }

  return (
    <section className="voice-card" aria-labelledby="join-title">
      <p className="eyebrow">SLAM VOICE</p>
      <h1 id="join-title">Join the conversation</h1>
      <p className="lede">Drop into your group’s voice room.</p>
      <form onSubmit={submit} noValidate>
        <label htmlFor="display-name">Your name</label>
        <input
          id="display-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={32}
          autoComplete="nickname"
          disabled={busy}
        />
        {(validation || error) && <p role="alert">{validation ?? error}</p>}
        <button className="primary-button" disabled={busy} type="submit">
          {busy ? 'Connecting…' : 'Join Voice'}
        </button>
      </form>
    </section>
  );
}
```

- [ ] **Step 5: Verify GREEN and commit**

Run: `cd frontend && npm test -- src/components/JoinScreen.test.tsx && npm run lint`

Expected: 3 tests pass and ESLint exits 0.

Commit: `git add frontend && git commit -m "feat(frontend): scaffold join form"`

---

### Task 2: Fixed join API and production-shaped mock

**Files:**
- Create: `frontend/src/api/voiceApi.test.ts`
- Create: `frontend/src/api/voiceApi.ts`

**Interfaces:**
- Produces: `VoiceApi.join(joinToken: string, displayName: string): Promise<JoinVoiceResponse>`.
- Produces: `createVoiceApi(config, fetchImpl)` with explicit config for deterministic tests.

- [ ] **Step 1: Write failing HTTP and mock-contract tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createVoiceApi } from './voiceApi';

describe('createVoiceApi', () => {
  it('posts the unchanged token and display name to the shared endpoint', async () => {
    const response = {
      livekit_url: 'wss://rtc.example.ru', access_token: 'jwt',
      room: { id: 42, name: 'General' },
      participant: { identity: 'guest_1', display_name: 'Ivan' },
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), { status: 200 }),
    );
    const api = createVoiceApi(
      { apiUrl: 'http://localhost:8000', useMock: false }, fetchImpl,
    );
    await expect(api.join('signed.token', 'Ivan')).resolves.toEqual(response);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:8000/api/voice/join',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ join_token: 'signed.token', display_name: 'Ivan' }),
      }),
    );
  });

  it('maps 401, 403, and 404 to an invalid invite', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    await expect(createVoiceApi(
      { apiUrl: '', useMock: false }, fetchImpl,
    ).join('bad', 'Ivan')).rejects.toMatchObject({ code: 'invalid-invite' });
  });

  it('returns the production response shape in mock mode', async () => {
    const result = await createVoiceApi({
      apiUrl: '', useMock: true,
      devLiveKitUrl: 'wss://dev.example.test', devLiveKitToken: 'dev-token',
    }).join('token', 'Max');
    expect(result).toEqual({
      livekit_url: 'wss://dev.example.test', access_token: 'dev-token',
      room: { id: 42, name: 'General' },
      participant: { identity: expect.stringMatching(/^guest_/), display_name: 'Max' },
    });
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `cd frontend && npm test -- src/api/voiceApi.test.ts`

Expected: FAIL because `createVoiceApi` does not exist.

- [ ] **Step 3: Implement the contract, status mapping, and mock**

```ts
export type JoinVoiceResponse = {
  livekit_url: string;
  access_token: string;
  room: { id: number; name: string };
  participant: { identity: string; display_name: string };
};

export type VoiceApiErrorCode = 'invalid-invite' | 'backend-unavailable' | 'invalid-response';

export class VoiceApiError extends Error {
  constructor(public readonly code: VoiceApiErrorCode) {
    super(code);
  }
}

export interface VoiceApi {
  join(joinToken: string, displayName: string): Promise<JoinVoiceResponse>;
}

type VoiceApiConfig = {
  apiUrl: string;
  useMock: boolean;
  devLiveKitUrl?: string;
  devLiveKitToken?: string;
};

export function createVoiceApi(
  config: VoiceApiConfig,
  fetchImpl: typeof fetch = fetch,
): VoiceApi {
  if (config.useMock) {
    return {
      async join(_joinToken, displayName) {
        return {
          livekit_url: config.devLiveKitUrl || 'wss://rtc.example.invalid',
          access_token: config.devLiveKitToken || 'mock-livekit-token',
          room: { id: 42, name: 'General' },
          participant: {
            identity: `guest_${crypto.randomUUID().slice(0, 8)}`,
            display_name: displayName,
          },
        };
      },
    };
  }

  return {
    async join(joinToken, displayName) {
      let response: Response;
      try {
        response = await fetchImpl(`${config.apiUrl.replace(/\/$/, '')}/api/voice/join`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ join_token: joinToken, display_name: displayName }),
        });
      } catch {
        throw new VoiceApiError('backend-unavailable');
      }
      if ([401, 403, 404].includes(response.status)) throw new VoiceApiError('invalid-invite');
      if (!response.ok) throw new VoiceApiError('backend-unavailable');
      try {
        return (await response.json()) as JoinVoiceResponse;
      } catch {
        throw new VoiceApiError('invalid-response');
      }
    },
  };
}
```

- [ ] **Step 4: Verify GREEN and commit**

Run: `cd frontend && npm test -- src/api/voiceApi.test.ts && npm test`

Expected: all API and join-form tests pass.

Commit: `git add frontend/src/api && git commit -m "feat(frontend): add voice join API"`

---

### Task 3: Voice state machine with duplicate-join and cleanup guarantees

**Files:**
- Create: `frontend/src/voice/types.ts`
- Create: `frontend/src/voice/useVoiceRoom.test.tsx`
- Create: `frontend/src/voice/useVoiceRoom.ts`
- Create: `frontend/src/voice/errorMessages.ts`

**Interfaces:**
- Consumes: `VoiceApi.join(token, displayName)` from Task 2.
- Produces: `VoiceClient` with `subscribe`, `connect`, `enableMicrophone`, `setMuted`, `enableAudio`, and `disconnect`.
- Produces: `useVoiceRoom({ token, api, createClient })` returning `{ state, join, leave, setMuted, enableAudio, reset }`.

- [ ] **Step 1: Refresh and inspect teammates' commits**

Run: `git fetch --all --prune && git log --all -20 --oneline --decorate`

Expected: inspect any commits newer than the current base; do not merge automatically. If the shared API differs, stop and report the incompatible fields before editing.

- [ ] **Step 2: Define the voice boundary and write failing hook tests**

```ts
export type VoiceParticipant = {
  identity: string;
  displayName: string;
  isLocal: boolean;
  isMuted: boolean;
};

export type VoiceSnapshot = {
  connection: 'connected' | 'reconnecting' | 'disconnected';
  participants: VoiceParticipant[];
  localMuted: boolean;
  needsAudioPermission: boolean;
};

export interface VoiceClient {
  subscribe(listener: (snapshot: VoiceSnapshot) => void): () => void;
  connect(url: string, token: string): Promise<void>;
  enableMicrophone(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  enableAudio(): Promise<void>;
  disconnect(): Promise<void>;
}
```

```tsx
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useVoiceRoom } from './useVoiceRoom';
import type { VoiceClient, VoiceSnapshot } from './types';

function fakeClient() {
  let listener: (snapshot: VoiceSnapshot) => void = () => undefined;
  const client: VoiceClient = {
    subscribe: vi.fn((next) => { listener = next; return () => undefined; }),
    connect: vi.fn().mockResolvedValue(undefined),
    enableMicrophone: vi.fn().mockResolvedValue(undefined),
    setMuted: vi.fn().mockResolvedValue(undefined),
    enableAudio: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  return { client, emit: (snapshot: VoiceSnapshot) => listener(snapshot) };
}

describe('useVoiceRoom', () => {
  it('connects once and requests the microphone after credentials arrive', async () => {
    const voice = fakeClient();
    const api = { join: vi.fn().mockResolvedValue({
      livekit_url: 'wss://rtc.test', access_token: 'jwt',
      room: { id: 42, name: 'General' },
      participant: { identity: 'guest_1', display_name: 'Ivan' },
    }) };
    const { result } = renderHook(() => useVoiceRoom({
      token: 'signed', api, createClient: () => voice.client,
    }));
    await act(async () => {
      await Promise.all([result.current.join('Ivan'), result.current.join('Ivan')]);
    });
    expect(api.join).toHaveBeenCalledTimes(1);
    expect(voice.client.connect).toHaveBeenCalledWith('wss://rtc.test', 'jwt');
    expect(voice.client.enableMicrophone).toHaveBeenCalledOnce();
    expect(result.current.state.phase).toBe('connected');
  });

  it('shows reconnect status from the existing client', async () => {
    const voice = fakeClient();
    const api = { join: vi.fn().mockResolvedValue({ livekit_url: 'wss://rtc.test',
      access_token: 'jwt', room: { id: 42, name: 'General' },
      participant: { identity: 'guest_1', display_name: 'Ivan' } }) };
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api,
      createClient: () => voice.client }));
    await act(() => result.current.join('Ivan'));
    act(() => voice.emit({ connection: 'reconnecting', participants: [],
      localMuted: false, needsAudioPermission: false }));
    expect(result.current.state.phase).toBe('reconnecting');
    expect(voice.client.connect).toHaveBeenCalledTimes(1);
  });

  it('disconnects and clears room state on leave', async () => {
    const voice = fakeClient();
    const api = { join: vi.fn().mockResolvedValue({ livekit_url: 'wss://rtc.test',
      access_token: 'jwt', room: { id: 42, name: 'General' },
      participant: { identity: 'guest_1', display_name: 'Ivan' } }) };
    const { result } = renderHook(() => useVoiceRoom({ token: 'signed', api,
      createClient: () => voice.client }));
    await act(() => result.current.join('Ivan'));
    await act(() => result.current.leave());
    expect(voice.client.disconnect).toHaveBeenCalledOnce();
    expect(result.current.state).toMatchObject({ phase: 'left', participants: [] });
  });
});
```

- [ ] **Step 3: Run the hook test and verify RED**

Run: `cd frontend && npm test -- src/voice/useVoiceRoom.test.tsx`

Expected: FAIL because `useVoiceRoom` does not exist.

- [ ] **Step 4: Implement the state machine and error mapping**

Implement `useVoiceRoom` with a synchronous `joiningRef` guard, one client per
join, a subscription cleanup ref, and a leaving ref. State must contain:

```ts
export type VoiceRoomState = {
  phase: 'idle' | 'requestingCredentials' | 'connecting' |
    'requestingMicrophone' | 'connected' | 'reconnecting' | 'left' | 'error';
  roomName: string;
  participants: VoiceParticipant[];
  localMuted: boolean;
  needsAudioPermission: boolean;
  error: string | null;
};
```

The join sequence is exactly `api.join` → `client.subscribe` → `client.connect`
→ `client.enableMicrophone`. On every catch, unsubscribe, call
`client.disconnect`, clear refs, and map errors as follows:

```ts
export function errorMessage(error: unknown): string {
  if (error instanceof VoiceApiError) {
    if (error.code === 'invalid-invite') return 'Invalid or expired invite.';
    if (error.code === 'backend-unavailable') return 'The voice service is unavailable. Try again.';
    return 'The voice service returned an invalid response.';
  }
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'Microphone access was denied. Allow access in your browser and try again.';
  }
  return 'Could not connect to the voice room. Try again.';
}
```

Snapshot handling replaces participants and mute/audio flags; it changes only
the phase for reconnecting, reconnected, and unexpected disconnected events.
`leave` marks intentional exit before disconnecting so the disconnect event
cannot overwrite `left` with an error.

- [ ] **Step 5: Verify GREEN and commit**

Run: `cd frontend && npm test -- src/voice/useVoiceRoom.test.tsx && npm test`

Expected: all hook, API, and form tests pass.

Commit: `git add frontend/src/voice && git commit -m "feat(frontend): add voice room state machine"`

---

### Task 4: LiveKit SDK adapter and remote audio lifecycle

**Files:**
- Create: `frontend/src/voice/LiveKitVoiceClient.test.ts`
- Create: `frontend/src/voice/LiveKitVoiceClient.ts`

**Interfaces:**
- Consumes: `VoiceClient`, `VoiceSnapshot`, and `VoiceParticipant` from Task 3.
- Produces: `new LiveKitVoiceClient()` implementing the complete `VoiceClient` interface.

- [ ] **Step 1: Write failing adapter tests around an injected room port**

Create a minimal fake room with event registration, local/remote participant
maps, `connect`, `disconnect`, `startAudio`, and local
`setMicrophoneEnabled`. Assert these behaviors separately:

```ts
it('connects with backend credentials and enables the microphone', async () => {
  const room = createFakeRoom();
  const client = new LiveKitVoiceClient(() => room.port);
  await client.connect('wss://rtc.test', 'jwt');
  await client.enableMicrophone();
  expect(room.connect).toHaveBeenCalledWith('wss://rtc.test', 'jwt');
  expect(room.setMicrophoneEnabled).toHaveBeenCalledWith(true);
});

it('emits participants and reconnect state without reconnecting manually', async () => {
  const room = createFakeRoom();
  const client = new LiveKitVoiceClient(() => room.port);
  const listener = vi.fn();
  client.subscribe(listener);
  room.remoteParticipants.set('max', fakeParticipant('max', 'Max', true));
  room.emit('participantConnected');
  room.emit('reconnecting');
  expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({
    connection: 'reconnecting',
    participants: expect.arrayContaining([
      expect.objectContaining({ identity: 'max', displayName: 'Max', isMuted: true }),
    ]),
  }));
  expect(room.connect).not.toHaveBeenCalled();
});

it('reports blocked audio and retries it from a user action', async () => {
  const room = createFakeRoom({ canPlaybackAudio: false });
  const client = new LiveKitVoiceClient(() => room.port);
  const listener = vi.fn();
  client.subscribe(listener);
  room.emit('audioPlaybackStatusChanged');
  expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({
    needsAudioPermission: true,
  }));
  await client.enableAudio();
  expect(room.startAudio).toHaveBeenCalledOnce();
});

it('removes all listeners and detaches tracks on disconnect', async () => {
  const room = createFakeRoom();
  const client = new LiveKitVoiceClient(() => room.port);
  await client.disconnect();
  expect(room.removeAllListeners).toHaveBeenCalledOnce();
  expect(room.disconnect).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the adapter test and verify RED**

Run: `cd frontend && npm test -- src/voice/LiveKitVoiceClient.test.ts`

Expected: FAIL because `LiveKitVoiceClient` does not exist.

- [ ] **Step 3: Implement the LiveKit adapter**

Use `Room`, `RoomEvent`, and `Track.Source.Microphone`. Register handlers for
`ParticipantConnected`, `ParticipantDisconnected`, `TrackSubscribed`,
`TrackUnsubscribed`, `TrackMuted`, `TrackUnmuted`, `Reconnecting`, `Reconnected`,
`Disconnected`, and `AudioPlaybackStatusChanged`. Each handler emits one fresh
snapshot derived from `room.localParticipant` and `room.remoteParticipants`.

Remote subscribed audio tracks call `track.attach()` and append the returned
audio element to a private, visually hidden container owned by the adapter.
Unsubscribed tracks call `track.detach()` and remove each element. `disconnect`
detaches every tracked element, removes the container, unregisters listeners,
and disconnects the room. `enableAudio` delegates to `room.startAudio()`.

Mute state is read from the microphone publication:

```ts
function participantView(participant: Participant, isLocal: boolean): VoiceParticipant {
  const microphone = participant.getTrackPublication(Track.Source.Microphone);
  return {
    identity: participant.identity,
    displayName: participant.name || participant.identity,
    isLocal,
    isMuted: !microphone || microphone.isMuted,
  };
}
```

`setMuted(muted)` calls
`room.localParticipant.setMicrophoneEnabled(!muted)` and then emits a snapshot.
Do not call `connect` from reconnect events; LiveKit owns reconnection.

- [ ] **Step 4: Verify GREEN and commit**

Run: `cd frontend && npm test -- src/voice/LiveKitVoiceClient.test.ts && npm test && npm run lint`

Expected: adapter tests and the full suite pass; lint exits 0.

Commit: `git add frontend/src/voice && git commit -m "feat(frontend): integrate LiveKit audio"`

---

### Task 5: Routed room UI, participants, controls, status, and recovery

**Files:**
- Create: `frontend/src/components/Participant.tsx`
- Create: `frontend/src/components/ConnectionStatus.tsx`
- Create: `frontend/src/components/VoiceRoom.tsx`
- Create: `frontend/src/components/VoiceRoom.test.tsx`
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/App.test.tsx`
- Create: `frontend/src/main.tsx`

**Interfaces:**
- Consumes: `JoinScreen`, `useVoiceRoom`, and `LiveKitVoiceClient`.
- Produces: route `/join/:token`, connected room UI, missing-token error, post-leave UI, and all user controls.

- [ ] **Step 1: Write failing room-control tests**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { VoiceRoom } from './VoiceRoom';

const participants = [
  { identity: 'ivan', displayName: 'Ivan', isLocal: true, isMuted: false },
  { identity: 'max', displayName: 'Max', isLocal: false, isMuted: true },
];

it('shows participant microphone state and toggles the local microphone', async () => {
  const setMuted = vi.fn();
  render(<VoiceRoom roomName="General" phase="connected" participants={participants}
    localMuted={false} needsAudioPermission={false} onSetMuted={setMuted}
    onEnableAudio={vi.fn()} onLeave={vi.fn()} />);
  expect(screen.getByText('Ivan')).toBeInTheDocument();
  expect(screen.getByLabelText('Max microphone muted')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Mute' }));
  expect(setMuted).toHaveBeenCalledWith(true);
});

it('offers audio recovery and leave', async () => {
  const enableAudio = vi.fn();
  const leave = vi.fn();
  render(<VoiceRoom roomName="General" phase="reconnecting" participants={participants}
    localMuted needsAudioPermission onSetMuted={vi.fn()}
    onEnableAudio={enableAudio} onLeave={leave} />);
  expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Enable Audio' }));
  await userEvent.click(screen.getByRole('button', { name: 'Leave' }));
  expect(enableAudio).toHaveBeenCalledOnce();
  expect(leave).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Write failing route-flow tests**

Render `App` inside `MemoryRouter` with injected fake `VoiceApi` and
`VoiceClient`. Assert `/join/signed-token` submits the URL token, renders room
name `General` after join, renders `You left the room` after Leave, and restores
the join screen after `Join Again`. Assert `/` renders `Invalid or expired
invite.` and never calls the API.

- [ ] **Step 3: Run UI tests and verify RED**

Run: `cd frontend && npm test -- src/components/VoiceRoom.test.tsx src/App.test.tsx`

Expected: FAIL because `VoiceRoom` and `App` do not exist.

- [ ] **Step 4: Implement focused presentation components and route flow**

`Participant` renders initials, display name, `(you)` for local users, and an
accessible `🎤` or `🔇` state. `ConnectionStatus` renders `Connected`,
`Reconnecting…`, or `Disconnected` with a status dot. `VoiceRoom` renders the
room name, participant list, conditional `Enable Audio`, mute/unmute, and Leave.

`App` reads `token` with `useParams`, constructs one configured API and one
client factory, and calls `useVoiceRoom`. Phase mapping is exact:

```tsx
if (!token) return <InviteError />;
if (state.phase === 'left') return <LeftScreen onJoinAgain={reset} />;
if (state.phase === 'connected' || state.phase === 'reconnecting') {
  return <VoiceRoom roomName={state.roomName} phase={state.phase}
    participants={state.participants} localMuted={state.localMuted}
    needsAudioPermission={state.needsAudioPermission} onSetMuted={setMuted}
    onEnableAudio={enableAudio} onLeave={leave} />;
}
return <JoinScreen busy={[
  'requestingCredentials', 'connecting', 'requestingMicrophone',
].includes(state.phase)} error={state.error} onJoin={join} />;
```

`main.tsx` renders `App` inside `BrowserRouter` and imports `styles.css`.

- [ ] **Step 5: Verify GREEN and commit**

Run: `cd frontend && npm test && npm run lint`

Expected: all component, route, hook, adapter, and API tests pass; lint exits 0.

Commit: `git add frontend/src && git commit -m "feat(frontend): add voice room interface"`

---

### Task 6: Responsive styling, environment contract, documentation, and release checks

**Files:**
- Create: `frontend/src/styles.css`
- Create: `frontend/.env.example`
- Create: `frontend/README.md`
- Modify: `frontend/src/App.test.tsx`

**Interfaces:**
- Consumes: all prior frontend behavior.
- Produces: production build, documented mock/real modes, accessible mobile-first dark UI, and an explicit manual integration checklist.

- [ ] **Step 1: Refresh and inspect teammates' commits again**

Run: `git fetch --all --prune && git log --all -20 --oneline --decorate`

Expected: inspect new commits and verify `POST /api/voice/join` still matches
`JoinVoiceResponse`. Do not modify teammates' files or merge unrelated work.

- [ ] **Step 2: Add a failing environment-wiring test**

Add an `App` test that supplies the production environment factory, submits
`Ivan`, and asserts the fetch request URL combines `VITE_API_URL` with
`/api/voice/join`. Add a mock-mode test asserting no HTTP request occurs and the
returned development credentials reach the fake voice client.

Run: `cd frontend && npm test -- src/App.test.tsx`

Expected: FAIL until `App` exports and uses an environment-to-dependencies
factory that reads `VITE_API_URL`, `VITE_USE_MOCK_API`,
`VITE_DEV_LIVEKIT_URL`, and `VITE_DEV_LIVEKIT_TOKEN`.

- [ ] **Step 3: Wire environment configuration and verify GREEN**

Implement the factory with `VITE_USE_MOCK_API === 'true'`, an empty-string
fallback for `VITE_API_URL`, and optional dev LiveKit values. Do not read or
document a LiveKit secret.

Run: `cd frontend && npm test -- src/App.test.tsx && npm test`

Expected: environment tests and the full suite pass.

- [ ] **Step 4: Add the dark responsive design**

Define CSS custom properties for charcoal page/panel colors, blue-violet
primary actions, green status, red danger, muted text, borders, and focus rings.
Use a centered mobile-first shell with `min-height: 100dvh`, safe-area padding,
a panel max width of 520px, 48px minimum controls, visible `:focus-visible`,
stacked mobile actions, and a desktop media query at 640px. Include
`prefers-reduced-motion: reduce` and do not hide status text by color alone.

- [ ] **Step 5: Document environment and manual integration checks**

Create `.env.example` containing only:

```dotenv
VITE_API_URL=http://localhost:8000
VITE_USE_MOCK_API=false
VITE_DEV_LIVEKIT_URL=
VITE_DEV_LIVEKIT_TOKEN=
```

Document install/dev/test/lint/build commands, mock mode, real backend mode,
and manual checks for two browsers, remote audio, microphone denial and retry,
mute/unmute, participant leave, autoplay recovery, reconnect, invalid token,
backend failure, Android browser, and iPhone browser.

- [ ] **Step 6: Run final automated verification**

Run: `cd frontend && npm test && npm run lint && npm run build`

Expected: all tests pass, ESLint exits 0, TypeScript succeeds, and Vite writes
`frontend/dist/` without errors.

Run: `git status --short && git diff --check && git diff main...HEAD --stat`

Expected: no whitespace errors; changed source files are confined to
`frontend/` plus `docs/superpowers/`; `frontend/dist/` and `node_modules/` are
not tracked.

- [ ] **Step 7: Commit the completed frontend**

Commit: `git add frontend docs/superpowers && git commit -m "docs(frontend): document voice client setup"`

Do not merge, rebase, or push without an explicit user request.
