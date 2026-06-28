import { Injectable, OnDestroy } from '@angular/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { Subject, Observable } from 'rxjs';

export interface EqBand {
  frequency: number;
  gain_db: number;
  q: number;
}

export interface DspFrame {
  bands: EqBand[];
  dominant_hz: number;
  noise_db: number;
  calibrating: boolean;
}

/**
 * CabinAudioService
 *
 * Responsibilities:
 *  1. Own the single shared AudioContext for the app.
 *  2. Build and maintain a peaking-EQ filter chain driven by DSP frames from Rust.
 *  3. Optionally generate a low-level masking tone so noise suppression works
 *     even when no music is playing (important for demo / real-world use).
 *  4. Expose dspFrame$ so UI components can display live calibration data.
 */
@Injectable({ providedIn: 'root' })
export class CabinAudioService implements OnDestroy {

  // ─── Public state ────────────────────────────────────────────────────────────

  public ctx: AudioContext | null = null;
  readonly dspFrame$: Observable<DspFrame>;

  // ─── Private graph nodes ─────────────────────────────────────────────────────

  /** Chain of 5 peaking-EQ BiquadFilterNodes that shape the output audio. */
  private eqNodes: BiquadFilterNode[] = [];

  /** The shared gain node that all sources feed into before the EQ chain. */
  private masterGain: GainNode | null = null;

  /**
   * Masking tone: a soft brown-noise buffer looped continuously.
   * Activated when shield is engaged but no music source is connected,
   * so the EQ has something to shape into the cabin.
   */
  private maskingSource: AudioBufferSourceNode | null = null;
  private maskingGain: GainNode | null = null;
  private maskingActive = false;

  /** Tag set on <audio> elements to prevent double-wrapping. */
  private readonly LINKED_TAG = '__rumble_linked';

  private dspFrameSubject = new Subject<DspFrame>();
  private unlisten: UnlistenFn | null = null;

  constructor() {
    this.dspFrame$ = this.dspFrameSubject.asObservable();
  }

  // ─── Context bootstrap ───────────────────────────────────────────────────────

  /**
   * Lazily creates the AudioContext and the EQ + masking tone graph.
   * Must be called from a user-gesture handler so browsers allow it.
   */
  private ensureContext(): AudioContext {
    if (this.ctx) return this.ctx;

    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();

    // Build master gain (unity by default)
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 1.0;

    // Build 5 peaking-EQ filters chained in series
    this.eqNodes = Array.from({ length: 5 }, () => {
      const node = this.ctx!.createBiquadFilter();
      node.type = 'peaking';
      node.gain.value = 0;
      node.frequency.value = 100; // default; will be overwritten by DSP frames
      node.Q.value = 1.5;
      return node;
    });

    // Wire: masterGain → eq[0] → eq[1] → ... → eq[4] → destination
    let prev: AudioNode = this.masterGain;
    for (const node of this.eqNodes) {
      prev.connect(node);
      prev = node;
    }
    prev.connect(this.ctx.destination);

    // Build masking tone (brown noise, barely audible, only enabled on demand)
    this.buildMaskingTone();

    return this.ctx;
  }

  // ─── Source connection ───────────────────────────────────────────────────────

  /**
   * Connects an <audio> element into the Web Audio graph.
   * Safe to call multiple times — subsequent calls on the same element are no-ops.
   * Returns the AudioContext so callers can resume it on user gesture.
   */
  connectAudioElement(el: HTMLAudioElement): AudioContext {
    const ctx = this.ensureContext();

    if ((el as any)[this.LINKED_TAG]) return ctx;

    try {
      const source = ctx.createMediaElementSource(el);
      source.connect(this.masterGain!);
      (el as any)[this.LINKED_TAG] = true;
    } catch (err) {
      // InvalidStateError: element already attached to a different graph (rare)
      console.warn('RumbleGuard: could not attach audio element:', err);
    }

    return ctx;
  }

  /** Resume a suspended AudioContext. Call from any user-gesture handler. */
  async resumeContext(): Promise<void> {
    if (this.ctx && this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  // ─── DSP event bridge ────────────────────────────────────────────────────────

  async startListening(): Promise<void> {
    if (this.unlisten) return; // already listening
    this.unlisten = await listen<DspFrame>('dsp-frame', (event) => {
      const frame = event.payload;
      this.dspFrameSubject.next(frame);
      if (!frame.calibrating) {
        this.applyEq(frame.bands);
      }
    });
  }

  async stopListening(): Promise<void> {
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
  }

  /** Called by components that want to push bands without waiting for an event. */
  public updateLiveMultipliers(bands: EqBand[]): void {
    this.applyEq(bands);
  }

  // ─── EQ application ──────────────────────────────────────────────────────────

  /**
   * Applies DSP-computed EQ bands to the BiquadFilter chain.
   *
   * Uses setTargetAtTime with a short time-constant (0.05 s) instead of
   * direct assignment to avoid audible parameter zipper noise when values
   * change rapidly between frames.
   */
  private applyEq(bands: EqBand[]): void {
    if (!this.ctx || this.eqNodes.length === 0) return;

    const t = this.ctx.currentTime;
    const TC = 0.05; // time constant in seconds (fast but smooth)

    bands.forEach((band, i) => {
      const node = this.eqNodes[i];
      if (!node) return;
      node.frequency.setTargetAtTime(band.frequency, t, TC);
      node.gain.setTargetAtTime(band.gain_db, t, TC);
      node.Q.setTargetAtTime(band.q, t, TC);
    });
  }

  /** Ramps all EQ gains back to 0 dB without a hard click. */
  public resetEq(): void {
    if (!this.ctx || this.eqNodes.length === 0) return;
    const t = this.ctx.currentTime;
    for (const node of this.eqNodes) {
      node.gain.setTargetAtTime(0, t, 0.1);
    }
  }

  // ─── Masking tone (brown noise) ───────────────────────────────────────────────

  /**
   * Generates a 4-second looping buffer of brown noise at −30 dBFS.
   * Brown noise has a −6 dB/octave slope that closely matches cabin noise,
   * making it a better masking signal than white or pink noise for this use case.
   */
  private buildMaskingTone(): void {
    if (!this.ctx) return;
    const sampleRate = this.ctx.sampleRate;
    const lengthSamples = sampleRate * 4; // 4-second loop
    const buffer = this.ctx.createBuffer(1, lengthSamples, sampleRate);
    const data = buffer.getChannelData(0);

    let lastOut = 0.0;
    for (let i = 0; i < lengthSamples; i++) {
      // Leaky integrator: white noise → brown noise
      const white = Math.random() * 2 - 1;
      lastOut = (lastOut + 0.02 * white) / 1.02;
      data[i] = lastOut * 3.5; // scale to reasonable amplitude
    }

    // Separate gain node so we can fade the masking tone independently
    this.maskingGain = this.ctx.createGain();
    this.maskingGain.gain.value = 0; // starts silent
    this.maskingGain.connect(this.masterGain!);

    // Create and immediately start the looping source
    this.maskingSource = this.ctx.createBufferSource();
    this.maskingSource.buffer = buffer;
    this.maskingSource.loop = true;
    this.maskingSource.connect(this.maskingGain);
    this.maskingSource.start();
  }

  /**
   * Fades the masking tone in at a very low level (−30 dBFS ≈ gain 0.032).
   * This gives the EQ filters something to shape even when no music is loaded.
   */
  enableMaskingTone(): void {
    if (!this.maskingGain || this.maskingActive) return;
    const t = this.ctx!.currentTime;
    this.maskingGain.gain.setTargetAtTime(0.032, t, 0.5);
    this.maskingActive = true;
  }

  disableMaskingTone(): void {
    if (!this.maskingGain || !this.maskingActive) return;
    const t = this.ctx!.currentTime;
    this.maskingGain.gain.setTargetAtTime(0, t, 0.3);
    this.maskingActive = false;
  }

  // ─── Teardown ────────────────────────────────────────────────────────────────

  async ngOnDestroy(): Promise<void> {
    await this.stopListening();
    this.maskingSource?.stop();
    this.maskingSource?.disconnect();
    this.maskingGain?.disconnect();
    for (const node of this.eqNodes) node.disconnect();
    this.masterGain?.disconnect();
    await this.ctx?.close();
    this.ctx = null;
  }
}