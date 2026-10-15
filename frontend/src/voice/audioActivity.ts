type Binding = {
  source?: MediaStreamAudioSourceNode;
  analyser?: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
  value: boolean | undefined;
  lastActive: number;
  ended: () => void;
};

export class AudioActivityObserver {
  private readonly bindings = new Map<MediaStreamTrack, Binding>();
  private context?: AudioContext;
  private contextFailed = false;
  private interval?: ReturnType<typeof setInterval>;
  private disposed = false;
  private readonly onChange: () => void;

  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  watch(track: MediaStreamTrack): void {
    if (this.disposed || track.kind !== 'audio' || track.readyState !== 'live') return;
    if (this.bindings.has(track)) {
      this.resume();
      return;
    }

    const binding: Binding = {
      samples: new Float32Array(512), value: undefined, lastActive: -Infinity,
      ended: () => this.unwatch(track),
    };
    // Keep failed bindings too: repeated SDK events must not rebuild a failed graph.
    this.bindings.set(track, binding);
    track.addEventListener('ended', binding.ended);
    try {
      if (!this.context && !this.contextFailed) {
        this.contextFailed = true;
        if (typeof AudioContext !== 'undefined') {
          this.context = new AudioContext();
          this.contextFailed = false;
        }
      }
      if (!this.context) return;
      this.context.onstatechange = () => {
        if (this.context?.state !== 'running') {
          for (const entry of this.bindings.values()) this.update(entry, undefined);
        }
      };
      binding.source = this.context.createMediaStreamSource(new MediaStream([track]));
      binding.analyser = this.context.createAnalyser();
      binding.analyser.fftSize = 512;
      binding.analyser.smoothingTimeConstant = 0;
      // Analysis only: never connect this graph to the audible destination.
      binding.source.connect(binding.analyser);
    } catch {
      this.disconnect(binding);
      return;
    }
    this.resume();
    this.sample(track, binding);
    if (binding.analyser && this.interval === undefined) {
      this.interval = setInterval(() => {
        for (const [input, entry] of this.bindings) {
          if (input.readyState !== 'live') this.unwatch(input);
          else this.sample(input, entry);
        }
        this.stopIdleInterval();
      }, 50);
    }
  }

  unwatch(track: MediaStreamTrack): void {
    const binding = this.bindings.get(track);
    if (!binding) return;
    this.bindings.delete(track);
    track.removeEventListener('ended', binding.ended);
    this.disconnect(binding);
    this.stopIdleInterval();
    if (!this.bindings.size && this.context) this.context.onstatechange = null;
    this.update(binding, undefined);
  }

  speaking(track: MediaStreamTrack): boolean | undefined {
    const binding = this.bindings.get(track);
    if (!binding) return undefined;
    if (!this.available(track, binding)) this.update(binding, undefined);
    return binding.value;
  }

  reset(): void {
    const changed = [...this.bindings.values()].some((binding) => binding.value !== undefined);
    for (const [track, binding] of this.bindings) {
      track.removeEventListener('ended', binding.ended);
      this.disconnect(binding);
    }
    this.bindings.clear();
    this.stopIdleInterval();
    const context = this.context;
    this.context = undefined;
    this.contextFailed = false;
    if (context) {
      context.onstatechange = null;
      try { void context.close().catch(() => {}); } catch { /* Already unavailable. */ }
    }
    if (changed) this.onChange();
  }

  dispose(): void {
    this.disposed = true;
    this.reset();
  }

  private available(track: MediaStreamTrack, binding: Binding): boolean {
    return !!binding.analyser && this.context?.state === 'running'
      && track.readyState === 'live' && track.enabled;
  }

  private resume(): void {
    if (this.context?.state !== 'suspended') return;
    // Only explicit watch calls may resume; polling never retries autoplay restrictions.
    try { void this.context.resume().catch(() => {}); } catch { /* Use SDK fallback. */ }
  }

  private sample(track: MediaStreamTrack, binding: Binding): void {
    if (!this.available(track, binding)) {
      this.update(binding, undefined);
      return;
    }
    let rms: number;
    try {
      binding.analyser!.getFloatTimeDomainData(binding.samples);
      let sum = 0;
      for (const value of binding.samples) sum += value * value;
      rms = Math.sqrt(sum / binding.samples.length);
      if (!Number.isFinite(rms)) throw new Error('Invalid audio samples');
    } catch {
      this.disconnect(binding);
      this.update(binding, undefined);
      return;
    }
    const now = performance.now();
    const threshold = binding.value === true ? 0.008 : 0.015;
    if (rms >= threshold) binding.lastActive = now;
    this.update(binding, rms >= threshold || now - binding.lastActive < 150);
  }

  private update(binding: Binding, value: boolean | undefined): void {
    if (value === undefined) binding.lastActive = -Infinity;
    if (binding.value === value) return;
    binding.value = value;
    this.onChange();
  }

  private disconnect(binding: Binding): void {
    try { binding.source?.disconnect(); } catch { /* Best-effort teardown. */ }
    try { binding.analyser?.disconnect(); } catch { /* Best-effort teardown. */ }
    binding.source = undefined;
    binding.analyser = undefined;
  }

  private stopIdleInterval(): void {
    if ([...this.bindings.values()].some((binding) => binding.analyser)) return;
    if (this.interval !== undefined) clearInterval(this.interval);
    this.interval = undefined;
  }
}
