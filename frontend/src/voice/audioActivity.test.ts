import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioActivityObserver } from './audioActivity';

function track(kind = 'audio', readyState = 'live') {
  const input = Object.assign(new EventTarget(), { kind, readyState, enabled: true, stop: vi.fn(), clone: vi.fn() });
  return input as unknown as MediaStreamTrack;
}

function mockAudio(state: AudioContextState = 'running') {
  const sources: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
  const analysers: { fftSize: number; smoothingTimeConstant: number; level: number; getFloatTimeDomainData: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
  const context = {
    state, destination: {}, onstatechange: null as (() => void) | null,
    resume: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined),
    createMediaStreamSource: vi.fn(() => {
      const source = { connect: vi.fn(), disconnect: vi.fn() };
      sources.push(source);
      return source;
    }),
    createAnalyser: vi.fn(() => {
      const analyser = { fftSize: 0, smoothingTimeConstant: 1, level: 0,
        getFloatTimeDomainData: vi.fn((data: Float32Array) => data.fill(analyser.level)), disconnect: vi.fn() };
      analysers.push(analyser);
      return analyser;
    }),
  };
  const constructor = vi.fn(function () { return context; });
  const stream = vi.fn(function (tracks: MediaStreamTrack[]) { return { tracks }; });
  vi.stubGlobal('AudioContext', constructor);
  vi.stubGlobal('MediaStream', stream);
  return { context, constructor, sources, analysers, stream };
}

const observers: AudioActivityObserver[] = [];
function observer(onChange = vi.fn()) {
  const instance = new AudioActivityObserver(onChange);
  observers.push(instance);
  return instance;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  observers.splice(0).forEach((instance) => instance.dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('AudioActivityObserver', () => {
  it('lazily shares a context, immediately reads silence, and never routes or stops input', () => {
    const audio = mockAudio();
    const changed = vi.fn();
    const activity = observer(changed);
    const first = track();
    const second = track();
    expect(activity.speaking(first)).toBeUndefined();
    expect(audio.constructor).not.toHaveBeenCalled();
    activity.watch(first);
    activity.watch(first);
    activity.watch(second);
    expect(activity.speaking(first)).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(audio.constructor).toHaveBeenCalledOnce();
    expect(audio.stream.mock.calls).toEqual([[[first]], [[second]]]);
    expect(vi.getTimerCount()).toBe(1);
    audio.sources.forEach((source, index) => expect(source.connect).toHaveBeenCalledWith(audio.analysers[index]));
    audio.analysers.forEach((analyser) => {
      expect(analyser.fftSize).toBe(512);
      expect(analyser.smoothingTimeConstant).toBe(0);
    });
    vi.advanceTimersByTime(500);
    expect(changed).toHaveBeenCalledTimes(2);
    activity.dispose();
    expect(first.stop).not.toHaveBeenCalled();
    expect(first.clone).not.toHaveBeenCalled();
    expect(second.stop).not.toHaveBeenCalled();
    expect(audio.sources[0].connect).not.toHaveBeenCalledWith(audio.context.destination);
  });

  it('detects speech within 50ms, ignores noise, and holds silence for 150ms with hysteresis', () => {
    const audio = mockAudio();
    const changed = vi.fn();
    const activity = observer(changed);
    const input = track();
    activity.watch(input);
    audio.analysers[0].level = 0.01;
    vi.advanceTimersByTime(50);
    expect(activity.speaking(input)).toBe(false);
    audio.analysers[0].level = 0.02;
    vi.advanceTimersByTime(50);
    expect(activity.speaking(input)).toBe(true);
    audio.analysers[0].level = 0.01;
    vi.advanceTimersByTime(200);
    expect(activity.speaking(input)).toBe(true);
    audio.analysers[0].level = 0;
    vi.advanceTimersByTime(100);
    expect(activity.speaking(input)).toBe(true);
    vi.advanceTimersByTime(50);
    expect(activity.speaking(input)).toBe(false);
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it('returns fallback immediately for disabled or ended inputs and notifies only transitions', () => {
    mockAudio();
    const changed = vi.fn();
    const activity = observer(changed);
    const input = track();
    activity.watch(input);
    input.enabled = false;
    expect(activity.speaking(input)).toBeUndefined();
    vi.advanceTimersByTime(100);
    expect(changed).toHaveBeenCalledTimes(2);
    input.enabled = true;
    expect(activity.speaking(input)).toBeUndefined();
    vi.advanceTimersByTime(50);
    expect(activity.speaking(input)).toBe(false);
    Object.assign(input, { readyState: 'ended' });
    expect(activity.speaking(input)).toBeUndefined();
    input.dispatchEvent(new Event('ended'));
    expect(vi.getTimerCount()).toBe(0);
    expect(changed).toHaveBeenCalledTimes(4);
  });

  it('invalidates suspended readings and only retries resume on explicit watch', async () => {
    const audio = mockAudio();
    const changed = vi.fn();
    const activity = observer(changed);
    const input = track();
    activity.watch(input);
    audio.context.state = 'suspended';
    audio.context.onstatechange?.();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(activity.speaking(input)).toBeUndefined();
    audio.context.resume.mockRejectedValue(new Error('blocked'));
    activity.watch(input);
    await Promise.resolve();
    vi.advanceTimersByTime(1000);
    expect(audio.context.resume).toHaveBeenCalledOnce();
    expect(audio.context.createAnalyser).toHaveBeenCalledOnce();
    audio.context.state = 'running';
    expect(activity.speaking(input)).toBeUndefined();
    vi.advanceTimersByTime(50);
    expect(activity.speaking(input)).toBe(false);
  });

  it('resumes a suspended new context without using stale or queued readings', async () => {
    const audio = mockAudio('suspended');
    audio.context.resume.mockRejectedValue(new Error('blocked'));
    const activity = observer();
    const input = track();
    activity.watch(input);
    await Promise.resolve();
    vi.advanceTimersByTime(500);
    expect(activity.speaking(input)).toBeUndefined();
    expect(audio.analysers[0].getFloatTimeDomainData).not.toHaveBeenCalled();
    expect(audio.context.resume).toHaveBeenCalledOnce();
  });

  it('ignores non-audio and ended tracks, and tolerates unsupported or failing constructors', () => {
    const audio = mockAudio();
    const activity = observer();
    activity.watch(track('video'));
    activity.watch(track('audio', 'ended'));
    expect(audio.constructor).not.toHaveBeenCalled();
    vi.stubGlobal('AudioContext', undefined);
    const input = track();
    activity.watch(input);
    activity.watch(input);
    expect(activity.speaking(input)).toBeUndefined();
    vi.stubGlobal('AudioContext', vi.fn(function () { throw new Error('unavailable'); }));
    const failed = observer();
    expect(() => failed.watch(track())).not.toThrow();
  });

  it('does not interpret an initially disabled input as analysed silence', () => {
    const audio = mockAudio();
    const changed = vi.fn();
    const activity = observer(changed);
    const input = track();
    input.enabled = false;
    activity.watch(input);
    vi.advanceTimersByTime(100);
    expect(activity.speaking(input)).toBeUndefined();
    expect(changed).not.toHaveBeenCalled();
    expect(audio.analysers[0].getFloatTimeDomainData).not.toHaveBeenCalled();
    input.enabled = true;
    vi.advanceTimersByTime(50);
    expect(activity.speaking(input)).toBe(false);
    expect(changed).toHaveBeenCalledOnce();
  });

  it('reads the whole 512-sample waveform as RMS on the first sample', () => {
    const audio = mockAudio();
    const createAnalyser = audio.context.createAnalyser.getMockImplementation()!;
    audio.context.createAnalyser.mockImplementationOnce(() => {
      const analyser = createAnalyser();
      analyser.getFloatTimeDomainData.mockImplementation((data: Float32Array) => {
        expect(data).toHaveLength(512);
        data.forEach((_, index) => { data[index] = index % 2 ? -0.02 : 0.02; });
        return data;
      });
      return analyser;
    });
    const activity = observer();
    const input = track();
    activity.watch(input);
    expect(activity.speaking(input)).toBe(true);
  });

  it('isolates analyser construction and connection failures and cleans partial graphs', () => {
    const audio = mockAudio();
    const activity = observer();
    audio.context.createAnalyser.mockImplementationOnce(() => { throw new Error('analyser unavailable'); });
    const failed = track();
    activity.watch(failed);
    expect(activity.speaking(failed)).toBeUndefined();
    expect(audio.sources[0].disconnect).toHaveBeenCalledOnce();
    const createSource = audio.context.createMediaStreamSource.getMockImplementation()!;
    audio.context.createMediaStreamSource.mockImplementationOnce(() => {
      const source = createSource();
      source.connect.mockImplementation(() => { throw new Error('connection failed'); });
      return source;
    });
    activity.watch(track());
    expect(audio.sources[1].disconnect).toHaveBeenCalledOnce();
    expect(audio.analysers[0].disconnect).toHaveBeenCalledOnce();
    const good = track();
    activity.watch(good);
    expect(activity.speaking(good)).toBe(false);
  });

  it('removes ended listeners and catches ended tracks even without an event', () => {
    const audio = mockAudio();
    const activity = observer();
    const input = track();
    const remove = vi.spyOn(input, 'removeEventListener');
    activity.watch(input);
    Object.assign(input, { readyState: 'ended' });
    vi.advanceTimersByTime(50);
    expect(activity.speaking(input)).toBeUndefined();
    expect(remove).toHaveBeenCalledWith('ended', expect.any(Function));
    expect(audio.sources[0].disconnect).toHaveBeenCalledOnce();
    expect(audio.context.onstatechange).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('suppresses synchronous resume errors and rejected close without stale readings', async () => {
    const audio = mockAudio('suspended');
    audio.context.resume.mockImplementation(() => { throw new Error('blocked'); });
    audio.context.close.mockRejectedValue(new Error('close failed'));
    const activity = observer();
    const input = track();
    expect(() => activity.watch(input)).not.toThrow();
    expect(activity.speaking(input)).toBeUndefined();
    expect(() => activity.reset()).not.toThrow();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('isolates source and read failures and does not rebuild failed bindings', () => {
    const audio = mockAudio();
    audio.context.createMediaStreamSource.mockImplementationOnce(() => { throw new Error('source failed'); });
    const activity = observer();
    const failed = track();
    const good = track();
    activity.watch(failed);
    activity.watch(failed);
    activity.watch(good);
    expect(audio.context.createMediaStreamSource).toHaveBeenCalledTimes(2);
    expect(activity.speaking(failed)).toBeUndefined();
    expect(activity.speaking(good)).toBe(false);
    audio.analysers[0].getFloatTimeDomainData.mockImplementation(() => { throw new Error('read failed'); });
    vi.advanceTimersByTime(50);
    expect(activity.speaking(good)).toBeUndefined();
    activity.watch(good);
    expect(audio.context.createAnalyser).toHaveBeenCalledOnce();
    expect(audio.sources[0].disconnect).toHaveBeenCalledOnce();
    expect(audio.analysers[0].disconnect).toHaveBeenCalledOnce();
  });

  it('unwatches, resets and re-watches with a fresh context, but dispose is permanent', () => {
    const audio = mockAudio();
    const changed = vi.fn();
    const activity = observer(changed);
    const input = track();
    activity.watch(input);
    activity.unwatch(input);
    expect(activity.speaking(input)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(changed).toHaveBeenCalledTimes(2);
    activity.watch(input);
    activity.reset();
    expect(audio.context.close).toHaveBeenCalledOnce();
    expect(audio.context.onstatechange).toBeNull();
    expect(activity.speaking(input)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    activity.watch(input);
    expect(audio.constructor).toHaveBeenCalledTimes(2);
    expect(activity.speaking(input)).toBe(false);
    activity.dispose();
    activity.watch(input);
    activity.reset();
    activity.dispose();
    expect(audio.constructor).toHaveBeenCalledTimes(2);
    expect(audio.context.close).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    audio.sources.forEach((source) => expect(source.disconnect).toHaveBeenCalledOnce());
  });
});
