import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

interface EqBand {
  frequency: number;
  gain_db: number;
  q: number;
}

interface DspFrame {
  bands: EqBand[];
  dominant_hz: number;
  noise_db: number;
}

@Injectable({ providedIn: 'root' })
export class CabinAudioService {

  private ctx: AudioContext | null = null;
  private eqNodes: BiquadFilterNode[] = [];
  private unlisten: UnlistenFn | null = null;

  // ── Permissions ─────────────────────────────────────────────────────────────

  async ensureMicPermission(): Promise<boolean> {
    const { granted } = await invoke<{ granted: boolean }>('check_mic_permission');
    if (granted) return true;

    await invoke('request_mic_permission');

    // requestPermissions on Android is async — the Kotlin side resolves
    // before the user has actually tapped Allow/Deny. We wait, then recheck.
    await new Promise(r => setTimeout(r, 500));
    const recheck = await invoke<{ granted: boolean }>('check_mic_permission');
    return recheck.granted;
  }

  // ── Web Audio graph ──────────────────────────────────────────────────────────

  // Call this once with the <audio> element that plays the cabin audio/music.
  // Must be triggered by a user gesture (tap), otherwise AudioContext is blocked.
  connectAudioElement(el: HTMLAudioElement): void {
    if (this.ctx) return; // already connected

    this.ctx = new AudioContext();
    const source = this.ctx.createMediaElementSource(el);

    // 5 peaking EQ nodes — one per dominant frequency bin we receive from Rust.
    // "peaking" boosts or cuts a band around center frequency, leaving others alone.
    this.eqNodes = Array.from({ length: 5 }, () => {
      const node = this.ctx!.createBiquadFilter();
      node.type = 'peaking';
      node.gain.value = 0; // start flat
      return node;
    });

    // Chain: source → eq[0] → eq[1] → … → eq[4] → speakers
    let prev: AudioNode = source;
    for (const node of this.eqNodes) {
      prev.connect(node);
      prev = node;
    }
    prev.connect(this.ctx.destination);
  }

  // ── DSP event listener ───────────────────────────────────────────────────────

  async startListening(): Promise<void> {
    if (this.unlisten) return; // already listening

    this.unlisten = await listen<DspFrame>('dsp-frame', (event) => {
      this.applyEq(event.payload.bands);
    });
  }

  private applyEq(bands: EqBand[]): void {
    if (!this.ctx) return;

    bands.forEach((band, i) => {
      const node = this.eqNodes[i];
      if (!node) return;

      const t = this.ctx!.currentTime;

      // setTargetAtTime smooths parameter changes over ~0.1s.
      // Without this you get audible clicks on each DSP frame update.
      node.frequency.setTargetAtTime(band.frequency, t, 0.1);
      node.gain.setTargetAtTime(band.gain_db, t, 0.1);
      node.Q.setTargetAtTime(band.q, t, 0.1);
    });
  }

  // ── Recording commands ───────────────────────────────────────────────────────

  async startRecording(): Promise<void> {
    await invoke('start_recording');
  }

  async stopRecording(): Promise<void> {
    await invoke('stop_recording');
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────────

  async destroy(): Promise<void> {
    await this.stopRecording();
    this.unlisten?.();
    this.unlisten = null;
    await this.ctx?.close();
    this.ctx = null;
    this.eqNodes = [];
  }
}