import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { Subject, Observable } from 'rxjs';

export interface EqBand {
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

  // Components subscribe to this to display live frequency data
  private dspFrameSubject = new Subject<DspFrame>();
  readonly dspFrame$: Observable<DspFrame> = this.dspFrameSubject.asObservable();

  ensureMicPermission(): boolean {
    return true;
  }

  connectAudioElement(el: HTMLAudioElement): void {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    const source = this.ctx.createMediaElementSource(el);
    this.eqNodes = Array.from({ length: 5 }, () => {
      const node = this.ctx!.createBiquadFilter();
      node.type = 'peaking';
      node.gain.value = 0;
      return node;
    });
    let prev: AudioNode = source;
    for (const node of this.eqNodes) {
      prev.connect(node);
      prev = node;
    }
    prev.connect(this.ctx.destination);
  }

  async startListening(): Promise<void> {
    if (this.unlisten) return;
    this.unlisten = await listen<DspFrame>('dsp-frame', (event) => {
      this.dspFrameSubject.next(event.payload); // broadcast to components
      this.applyEq(event.payload.bands);
    });
  }

  // 🎚️ FIX: Exposed public method for app.component.ts to dynamically update filter nodes
  public updateLiveMultipliers(bands: EqBand[]): void {
    this.applyEq(bands);
  }

  private applyEq(bands: EqBand[]): void {
    if (!this.ctx) return;
    bands.forEach((band, i) => {
      const node = this.eqNodes[i];
      if (!node) return;
      const t = this.ctx!.currentTime;
      node.frequency.setTargetAtTime(band.frequency, t, 0.1);
      node.gain.setTargetAtTime(band.gain_db, t, 0.1);
      node.Q.setTargetAtTime(band.q, t, 0.1);
    });
  }

  async startRecording(): Promise<void> { await invoke('start_recording'); }
  async stopRecording(): Promise<void> { await invoke('stop_recording'); }

  async destroy(): Promise<void> {
    await this.stopRecording();
    this.unlisten?.();
    this.unlisten = null;
    await this.ctx?.close();
    this.ctx = null;
    this.eqNodes = [];
  }
}