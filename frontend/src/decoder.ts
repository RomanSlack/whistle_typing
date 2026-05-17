/**
 * Whistle decoder — smoothed-hold.
 *
 * 1. The raw pitch is median-smoothed over the last N samples to kill
 *    one-frame wobbles.
 * 2. The smoothed zone has to stay the same for holdMs → emits a key.
 * 3. Once emitted, no re-emit until the smoothed zone *changes* (going
 *    silent counts), so you can hold a note long without it stuttering.
 * 4. A short silence between two articulated bursts of the same zone
 *    breaks the streak ⇒ double-letters work.
 * 5. Full-range sweeps (≥ gestureSpan zones in gestureWinMs) fire
 *    accept / backspace gestures.
 */

export interface DecoderOptions {
  fmin: number;
  fmax: number;
  zones: number;
  holdMs: number;
  smoothN: number;        // # of samples in median smoother
  silenceMs: number;
  gestureWinMs: number;
  gestureSpan: number;
  cooldownMs: number;
}

export const DEFAULT_OPTIONS: DecoderOptions = {
  fmin: 600,
  fmax: 2400,
  zones: 8,
  holdMs: 150,
  smoothN: 3,
  silenceMs: 1500,
  gestureWinMs: 240,
  gestureSpan: 7,
  cooldownMs: 60,
};

export type DecoderEvent =
  | { type: "key"; zone: number }
  | { type: "accept" }
  | { type: "backspace" }
  | { type: "commit" };

interface ZoneSample { t: number; zone: number | null; }

export class WhistleDecoder {
  opts: DecoderOptions;
  private gestureHistory: ZoneSample[] = [];
  private pitchBuf: number[] = [];
  private currentZone: number | null = null;
  private zoneSince = 0;
  private hasEmittedThisStreak = false;
  private silenceSince: number | null = null;
  private cooldownUntil = 0;
  private wordKeysActive = false;
  private onEvent: (e: DecoderEvent) => void;

  constructor(onEvent: (e: DecoderEvent) => void, opts: Partial<DecoderOptions> = {}) {
    this.onEvent = onEvent;
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }
  setOptions(opts: Partial<DecoderOptions>) {
    this.opts = { ...this.opts, ...opts };
  }
  noteWordReset() { this.wordKeysActive = false; this.silenceSince = null; }
  noteWordActive() { this.wordKeysActive = true; }

  freqToZone(freq: number): number {
    const { fmin, fmax, zones } = this.opts;
    if (freq <= fmin) return 0;
    if (freq >= fmax) return zones - 1;
    const r = (Math.log(freq) - Math.log(fmin)) / (Math.log(fmax) - Math.log(fmin));
    return Math.max(0, Math.min(zones - 1, Math.floor(r * zones)));
  }

  feed(sample: { t: number; freq: number | null; conf: number }) {
    const tMs = sample.t * 1000;
    const freq = sample.freq;

    // --- gesture history (raw zones) ---
    const rawZ = freq != null ? this.freqToZone(freq) : null;
    this.gestureHistory.push({ t: tMs, zone: rawZ });
    const gStart = tMs - this.opts.gestureWinMs;
    while (this.gestureHistory.length && this.gestureHistory[0].t < gStart) {
      this.gestureHistory.shift();
    }

    // --- pitch smoother ---
    if (freq != null) {
      this.pitchBuf.push(freq);
      while (this.pitchBuf.length > this.opts.smoothN) this.pitchBuf.shift();
    } else {
      this.pitchBuf = [];
    }

    // --- cooldown ---
    if (tMs < this.cooldownUntil) {
      if (freq == null) {
        if (this.silenceSince == null) this.silenceSince = tMs;
        this.currentZone = null;
        this.hasEmittedThisStreak = false;
      } else {
        this.silenceSince = null;
      }
      return;
    }

    // --- silence ---
    if (freq == null) {
      if (this.silenceSince == null) this.silenceSince = tMs;
      if (this.wordKeysActive && tMs - this.silenceSince >= this.opts.silenceMs) {
        this.emit(tMs, { type: "commit" });
        this.silenceSince = null;
      }
      this.currentZone = null;
      this.hasEmittedThisStreak = false;
      return;
    }
    this.silenceSince = null;

    // --- gestures (full-range, deliberate sweeps only) ---
    if (this.gestureHistory.length >= 3) {
      const allVoiced = this.gestureHistory.every(s => s.zone != null);
      if (allVoiced) {
        const first = this.gestureHistory[0].zone!;
        const last = this.gestureHistory[this.gestureHistory.length - 1].zone!;
        const span = last - first;
        if (span >= this.opts.gestureSpan) {
          this.emit(tMs, { type: "accept" });
          this.reset();
          return;
        }
        if (-span >= this.opts.gestureSpan) {
          this.emit(tMs, { type: "backspace" });
          this.reset();
          return;
        }
      }
    }

    // --- smoothed-zone hold ---
    const sorted = this.pitchBuf.slice().sort((a, b) => a - b);
    const smoothed = sorted[Math.floor(sorted.length / 2)];
    const z = this.freqToZone(smoothed);

    if (this.currentZone !== z) {
      this.currentZone = z;
      this.zoneSince = tMs;
      this.hasEmittedThisStreak = false;
    }

    if (!this.hasEmittedThisStreak && tMs - this.zoneSince >= this.opts.holdMs) {
      this.hasEmittedThisStreak = true;
      this.emit(tMs, { type: "key", zone: z });
    }
  }

  private reset() {
    this.gestureHistory = [];
    this.currentZone = null;
    this.hasEmittedThisStreak = false;
  }

  private emit(tMs: number, e: DecoderEvent) {
    this.cooldownUntil = tMs + this.opts.cooldownMs;
    this.onEvent(e);
  }
}
