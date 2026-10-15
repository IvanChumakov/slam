import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoomSounds, type RoomSound } from './roomSounds';

function mockAudio(state: AudioContextState = 'running') {
  const oscillators: { frequency: { setValueAtTime: ReturnType<typeof vi.fn> }; connect: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; onended?: () => void }[] = [];
  const gains: { gain: { setValueAtTime: ReturnType<typeof vi.fn>; linearRampToValueAtTime: ReturnType<typeof vi.fn> }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
  const context = { state, currentTime: 2, destination: {}, resume: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined),
    createOscillator: vi.fn(() => {
      const oscillator = { frequency: { setValueAtTime: vi.fn() }, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn() };
      oscillators.push(oscillator);
      return oscillator;
    }),
    createGain: vi.fn(() => {
      const gain = { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
      gains.push(gain);
      return gain;
    }),
  };
  const constructor = vi.fn(function () { return context; });
  vi.stubGlobal('AudioContext', constructor);
  return { context, constructor, oscillators, gains };
}

afterEach(() => vi.unstubAllGlobals());

describe('room sounds', () => {
  it('creates audio only on user unlock, schedules short quiet tones, and releases nodes', () => {
    const audio = mockAudio();
    const sounds = createRoomSounds();
    sounds.play('join');
    expect(audio.constructor).not.toHaveBeenCalled();
    sounds.unlock();
    sounds.play('join');
    expect(audio.constructor).toHaveBeenCalledOnce();
    expect(audio.oscillators).toHaveLength(2);
    for (const [index, oscillator] of audio.oscillators.entries()) {
      expect(oscillator.stop.mock.calls[0][0] - oscillator.start.mock.calls[0][0]).toBeLessThan(0.2);
      expect(audio.gains[index].gain.linearRampToValueAtTime.mock.calls[0][0]).toBeLessThanOrEqual(0.05);
      oscillator.onended?.();
      expect(oscillator.disconnect).toHaveBeenCalledOnce();
      expect(audio.gains[index].disconnect).toHaveBeenCalledOnce();
    }
    sounds.dispose();
    expect(audio.context.close).toHaveBeenCalledOnce();
  });

  it('has distinct signals and disables notifications independently from room audio', () => {
    const audio = mockAudio();
    const sounds = createRoomSounds();
    sounds.unlock();
    const signals: number[][] = [];
    const events: RoomSound[] = ['join', 'leave', 'participantJoin', 'participantLeave', 'mute', 'unmute', 'audioOff', 'audioOn'];
    for (const event of events) {
      const start = audio.oscillators.length;
      sounds.play(event);
      signals.push(audio.oscillators.slice(start).map((tone) => tone.frequency.setValueAtTime.mock.calls[0][0]));
    }
    expect(new Set(signals.map((signal) => signal.join(','))).size).toBe(events.length);
    const count = audio.oscillators.length;
    sounds.setEnabled(false);
    sounds.play('join');
    expect(audio.oscillators).toHaveLength(count);
    sounds.setEnabled(true);
    sounds.play('join');
    expect(audio.oscillators.length).toBeGreaterThan(count);
  });

  it('does not queue blocked audio and handles unavailable or rejected audio nonfatally', async () => {
    const audio = mockAudio('suspended');
    audio.context.resume.mockRejectedValue(new Error('blocked'));
    const sounds = createRoomSounds();
    sounds.unlock();
    sounds.play('join');
    await Promise.resolve();
    expect(audio.context.createOscillator).not.toHaveBeenCalled();
    audio.context.state = 'running';
    await Promise.resolve();
    expect(audio.context.createOscillator).not.toHaveBeenCalled();
    sounds.dispose();
    sounds.unlock();
    sounds.play('join');
    expect(audio.constructor).toHaveBeenCalledOnce();
    vi.stubGlobal('AudioContext', undefined);
    const unsupported = createRoomSounds();
    expect(() => { unsupported.unlock(); unsupported.play('join'); unsupported.dispose(); }).not.toThrow();
  });
});
