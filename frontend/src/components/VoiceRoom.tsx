import { useEffect, useRef, useState } from 'react';
import type { VoiceScreen } from '../voice/types';
import type { VoiceRoomState } from '../voice/useVoiceRoom';
import { ConnectionStatus } from './ConnectionStatus';
import { Participant } from './Participant';
import { RoomIcon } from './RoomIcon';

export type ConnectedRoomState = VoiceRoomState;

export type VoiceRoomActions = {
  setMuted(muted: boolean): Promise<void>;
  setIncomingMuted(muted: boolean): Promise<void>;
  setScreenSharing(sharing: boolean): Promise<void>;
  setCameraEnabled(enabled: boolean): Promise<void>;
  enableAudio(): Promise<void>;
  leave(): Promise<void>;
  switchRoom(roomId: number): Promise<void>;
  refreshRooms(): Promise<void>;
  fetchInvite(): Promise<void>;
};

type VoiceRoomProps = {
  state: ConnectedRoomState;
  actions: VoiceRoomActions;
};

function RoomVideo({ screen, camera = false, speaking }: { screen: VoiceScreen; camera?: boolean; speaking: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { element } = screen;
  useEffect(() => {
    containerRef.current?.append(element);
    return () => element.remove();
  }, [element]);

  return (
    <figure className={`${camera ? 'camera-tile' : 'shared-screen'}${speaking ? ' media-speaking' : ''}`}>
      <div ref={containerRef} className="screen-video" aria-label={`${screen.displayName} ${camera ? 'camera' : 'shared screen'}`} />
      <figcaption>{screen.displayName}{screen.isLocal ? ' (you)' : ''}{camera ? '' : ' sharing'}{speaking ? ' · Speaking' : ''}</figcaption>
    </figure>
  );
}

function RoomInvite({ url }: { url: string }) {
  const [message, setMessage] = useState('Select and copy this link, or use Copy link.');
  const [pending, setPending] = useState(false);
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);
  async function copy() {
    setPending(true);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      // This call runs directly from the click, not after the invite API awaits.
      await navigator.clipboard.writeText(url);
      if (activeRef.current) setMessage('Link copied.');
    } catch {
      if (activeRef.current) setMessage('Copy was unavailable. Select and copy the link above.');
    } finally {
      if (activeRef.current) setPending(false);
    }
  }
  return (
    <div className="room-invite">
      <label htmlFor="room-invite-url">Room invite link</label>
      <input id="room-invite-url" readOnly value={url} onFocus={(event) => event.currentTarget.select()} />
      <button className="button button-secondary" onClick={() => void copy()} disabled={pending}>Copy link</button>
      <p className="screen-share-help" role="status">{message}</p>
    </div>
  );
}

export function VoiceRoom({ state, actions }: VoiceRoomProps) {
  const drawerRef = useRef<HTMLDialogElement>(null);
  const channelsTrigger = useRef<HTMLButtonElement>(null);
  const [tooltipsDismissed, setTooltipsDismissed] = useState(false);
  const closeDrawer = () => { if (drawerRef.current?.open) drawerRef.current.close(); };
  const blocked = state.switching || state.phase !== 'connected';
  const channels = (
    <>
      <p className="eyebrow">Your group</p>
      <h2>Group channels</h2>
      <ul className="channel-list">
        {state.rooms.map((room) => (
          <li key={room.id}>
            <button className="button channel-button"
              aria-current={room.id === state.roomId ? 'true' : undefined}
              aria-label={`${room.name}, ${room.online_count} online${room.id === state.roomId ? ', current channel' : ''}`}
              disabled={blocked || state.microphonePending || room.id === state.roomId}
              onClick={() => { closeDrawer(); void actions.switchRoom(room.id); }}>
              <span className="channel-name">{room.name}{room.id === state.roomId ? <small>Current</small> : null}</span>
              <span className="channel-count">{room.online_count} online</span>
            </button>
          </li>
        ))}
      </ul>
      {state.roomsPending ? <p className="screen-share-help" role="status">Loading channels...</p> : null}
      {state.roomsError ? <p className="form-error" role="alert">Channels could not load: {state.roomsError}</p> : null}
      <button className="button button-secondary" disabled={state.roomsPending || state.switching} onClick={() => void actions.refreshRooms()}>Refresh channels</button>
    </>
  );

  return (
    <section className="room-workspace" aria-labelledby="room-name">
      <aside className="channel-rail" aria-label="Group channels">{channels}</aside>
      <dialog ref={drawerRef} className="channel-drawer" aria-label="Group channels"
        onClose={() => channelsTrigger.current?.focus()}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); closeDrawer(); } }}>
        <button className="button button-secondary drawer-close" autoFocus onClick={closeDrawer}>Close channels</button>
        {channels}
      </dialog>
      <div className="room-main">
      <header className="room-header">
        <div className="card-heading">
          <button ref={channelsTrigger} className="button button-secondary channels-trigger" aria-label="Channels"
            aria-haspopup="dialog" onClick={() => drawerRef.current?.showModal()}><RoomIcon name="channels" /><span>Channels</span></button>
          <div>
            <p className="eyebrow">Current channel</p>
            <h1 id="room-name">{state.roomName}</h1>
          </div>
        </div>
        {state.switching ? <p className="connection-status status-warning" role="status">Switching channel...</p>
          : <ConnectionStatus phase={state.phase === 'reconnecting' ? 'reconnecting' : 'connected'} />}
      </header>

      {state.error ? <p className="form-error room-error" role="alert">{state.error}</p> : null}

      <section className="invite-section" aria-label="Share this room">
        <button className="button button-secondary" disabled={state.invitePending || state.switching || state.phase !== 'connected'} onClick={() => void actions.fetchInvite()}>
          {state.invitePending ? 'Getting invite...' : 'Share room'}
        </button>
        {state.inviteError ? <p className="form-error" role="alert">Invite could not be created: {state.inviteError}</p> : null}
        {state.inviteUrl ? <RoomInvite key={state.inviteUrl} url={state.inviteUrl} /> : null}
      </section>

      {state.needsAudioPermission ? (
        <aside className="audio-notice">
          <div>
            <strong>Audio is paused</strong>
            <p>Your browser needs one more tap to play the room.</p>
          </div>
          <button className="button button-secondary" onClick={() => void actions.enableAudio()}>
            Enable audio
          </button>
        </aside>
      ) : null}

      <div className="participant-section">
        <div className="section-label">
          <h2>In the room</h2>
          <span>{state.participants.length}</span>
        </div>
        {state.participants.length > 0 ? (
          <ul className="participant-list" aria-label="Participants">
            {state.participants.map((participant) => (
              <Participant key={participant.identity} participant={participant} />
            ))}
          </ul>
        ) : (
          <p className="empty-room">Waiting for participants…</p>
        )}
      </div>

      {state.cameras.length > 0 ? (
        <section className="camera-section" aria-labelledby="camera-heading">
          <div className="section-label"><h2 id="camera-heading">Cameras</h2></div>
          <div className="camera-grid">{state.cameras.map((camera) => <RoomVideo key={camera.id} screen={camera} camera
            speaking={state.participants.some((participant) => participant.identity === camera.participantIdentity && participant.isSpeaking)} />)}</div>
        </section>
      ) : null}

      {state.screens.length > 0 ? (
        <section className="screen-section" aria-labelledby="screen-heading">
          <div className="section-label"><h2 id="screen-heading">Shared screens</h2></div>
          {state.screens.map((screen) => <RoomVideo key={screen.id} screen={screen}
            speaking={state.participants.some((participant) => participant.identity === screen.participantIdentity && participant.isSpeaking)} />)}
        </section>
      ) : null}

      <p className="screen-share-help" id="screen-share-help">
        {state.screenShareSupported
          ? 'Screen audio is optional in the browser chooser, where supported. Room audio mute silences incoming voices and shared audio, not your microphone.'
          : 'Screen sharing is not supported in this browser. Use a supported browser over HTTPS or localhost. You can still view shared screens.'}
      </p>
      {!state.cameraSupported ? <p className="screen-share-help" id="camera-help">Camera capture is not supported in this browser. You can still watch other cameras.</p> : null}
      </div>
      <footer className="room-controls" aria-label="Room controls">
        <div className="local-status" aria-live="polite">
          <strong>{state.participants.find((participant) => participant.isLocal)?.displayName || 'You'}</strong>
          <span id="mic-status">{state.localMuted ? 'Mic off' : 'Mic on'}</span>
          <span id="audio-status">{state.incomingMuted ? 'Room audio off' : state.needsAudioPermission ? 'Room audio paused' : 'Room audio on'}</span>
        </div>
        <div className="control-buttons" onFocus={() => setTooltipsDismissed(false)}
          onMouseOver={() => setTooltipsDismissed(false)}
          onKeyDown={(event) => { if (event.key === 'Escape') setTooltipsDismissed(true); }}>
          <span className="control-wrap">
            <button className="button control-button" aria-label="Microphone" aria-pressed={!state.localMuted}
              aria-describedby="mic-status mic-tooltip" aria-busy={state.microphonePending}
              disabled={blocked || state.microphonePending} onClick={() => void actions.setMuted(!state.localMuted)}>
              <RoomIcon name="mic" off={state.localMuted} /><span>Mic</span>
            </button><span className="control-tooltip" id="mic-tooltip" role="tooltip" hidden={tooltipsDismissed}>{state.localMuted ? 'Unmute microphone' : 'Mute microphone'}</span>
          </span>
          <span className="control-wrap">
            <button className="button control-button" aria-label="Room audio" aria-pressed={!state.incomingMuted}
              aria-describedby="audio-status audio-tooltip" disabled={state.switching} onClick={() => void actions.setIncomingMuted(!state.incomingMuted)}>
              <RoomIcon name="audio" off={state.incomingMuted} /><span>Audio</span>
            </button><span className="control-tooltip" id="audio-tooltip" role="tooltip" hidden={tooltipsDismissed}>{state.incomingMuted ? 'Unmute room audio' : 'Mute room audio'}</span>
          </span>
          <span className="control-wrap">
            <button className="button control-button" aria-label="Camera" aria-pressed={state.localCamera}
              aria-busy={state.cameraPending} aria-describedby={state.cameraSupported ? 'camera-tooltip' : 'camera-tooltip camera-help'}
              disabled={blocked || (!state.cameraPending && !state.cameraSupported)}
              onClick={() => void actions.setCameraEnabled(state.cameraPending ? false : !state.localCamera)}>
              <RoomIcon name="camera" off={!state.localCamera} /><span>{state.cameraPending ? 'Cancel' : 'Camera'}</span>
            </button><span className="control-tooltip" id="camera-tooltip" role="tooltip" hidden={tooltipsDismissed}>{state.cameraPending ? 'Cancel camera request' : state.localCamera ? 'Turn off camera' : 'Turn on camera'}</span>
          </span>
          <span className="control-wrap">
            <button className="button control-button" aria-label="Screen sharing" aria-pressed={state.localSharing}
              aria-busy={state.screenSharePending} aria-describedby="screen-share-help screen-tooltip"
              disabled={blocked || state.screenSharePending || !state.screenShareSupported} onClick={() => void actions.setScreenSharing(!state.localSharing)}>
              <RoomIcon name="screen" /><span>Screen</span>
            </button><span className="control-tooltip" id="screen-tooltip" role="tooltip" hidden={tooltipsDismissed}>{state.localSharing ? 'Stop sharing' : 'Share screen'}</span>
          </span>
          <span className="control-wrap">
            <button className="button button-danger control-button" aria-label="Leave" aria-describedby="leave-tooltip" onClick={() => void actions.leave()}>
              <RoomIcon name="leave" /><span>Leave</span>
            </button><span className="control-tooltip" id="leave-tooltip" role="tooltip" hidden={tooltipsDismissed}>Leave the room</span>
          </span>
        </div>
      </footer>
    </section>
  );
}
