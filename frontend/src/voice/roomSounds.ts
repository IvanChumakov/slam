export type RoomSound = 'join' | 'leave' | 'participantJoin' | 'participantLeave' | 'mute' | 'unmute' | 'audioOff' | 'audioOn';

const frequencies: Record<RoomSound, readonly number[]> = {
  join: [440, 660],
  leave: [660, 440],
  participantJoin: [520, 620],
  participantLeave: [620, 520],
  mute: [330, 260],
  unmute: [260, 330],
  audioOff: [390, 290],
  audioOn: [290, 390],
};

export function createRoomSounds() {
  let context: AudioContext | null = null;
  let enabled = true;
  let disposed = false;

  return {
    unlock() {
      if (!enabled || disposed || typeof AudioContext === 'undefined') return;
      try {
        context ??= new AudioContext();
        if (context.state === 'suspended') {
          // Notifications are optional: never queue stale signals behind autoplay restrictions.
          void context.resume().catch(() => undefined);
        }
      } catch {
        // Audio device/browser restrictions must not prevent joining or using the room.
      }
    },
    play(sound: RoomSound) {
      if (!enabled || disposed || context?.state !== 'running') return;
      try {
        const audio = context;
        frequencies[sound].forEach((frequency, index) => {
          const oscillator = audio.createOscillator();
          const gain = audio.createGain();
          const start = audio.currentTime + index * 0.09;
          oscillator.type = 'sine';
          oscillator.frequency.setValueAtTime(frequency, start);
          gain.gain.setValueAtTime(0, start);
          gain.gain.linearRampToValueAtTime(0.035, start + 0.012);
          gain.gain.linearRampToValueAtTime(0, start + 0.12);
          oscillator.connect(gain);
          gain.connect(audio.destination);
          oscillator.onended = () => {
            oscillator.disconnect();
            gain.disconnect();
          };
          oscillator.start(start);
          oscillator.stop(start + 0.13);
        });
      } catch {
        // A closed or unavailable output device affects only this notification.
      }
    },
    setEnabled(value: boolean) { enabled = value; },
    dispose() {
      disposed = true;
      if (context && context.state !== 'closed') void context.close().catch(() => undefined);
      context = null;
    },
  };
}
