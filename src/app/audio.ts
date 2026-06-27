import { Injectable } from '@angular/core';
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
  public ctx: AudioContext | null = null;
  private eqNodes: BiquadFilterNode[] = [];
  private unlisten: UnlistenFn | null = null;

  private dspFrameSubject = new Subject<DspFrame>();
  readonly dspFrame$: Observable<DspFrame> = this.dspFrameSubject.asObservable();

  ensureMicPermission(): boolean {
    return true;
  }

  /**
   * Safe initialization engine:
   * Maps HTML elements into a unified shared audio destination matrix.
   * Returns the context instance immediately to allow synchronous unlock chaining.
   */
  connectAudioElement(el: HTMLAudioElement): AudioContext {
    try {
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      }

      // Safe initialization of filters once
      if (this.eqNodes.length === 0) {
        this.eqNodes = Array.from({ length: 5 }, () => {
          const node = this.ctx!.createBiquadFilter();
          node.type = 'peaking';
          node.gain.value = 0;
          return node;
        });
      }

      // Check if this specific element has already been wrapper-bound to prevent DOM exceptions
      if ((el as any).__webAudioLinked) {
        return this.ctx; 
      }

      const source = this.ctx.createMediaElementSource(el);
      let prev: AudioNode = source;
      for (const node of this.eqNodes) {
        prev.connect(node);
        prev = node;
      }
      prev.connect(this.ctx.destination);
      
      // Tag element to mark it successfully mapped
      (el as any).__webAudioLinked = true;
    } catch (err) {
      console.warn("WebAudio Node Graph Attachment bypass active:", err);
    }
    return this.ctx!;
  }

  async startListening(): Promise<void> {
    if (this.unlisten) return;
    this.unlisten = await listen<DspFrame>('dsp-frame', (event) => {
      this.dspFrameSubject.next(event.payload);
      this.applyEq(event.payload.bands);
    });
  }

  public updateLiveMultipliers(bands: EqBand[]): void {
    this.applyEq(bands);
  }

  private applyEq(bands: EqBand[]): void {
    if (!this.ctx || this.eqNodes.length === 0) return;
    bands.forEach((band, i) => {
      const node = this.eqNodes[i];
      if (!node) return;
      const t = this.ctx!.currentTime;
      node.frequency.setTargetAtTime(band.frequency, t, 0.1);
      node.gain.setTargetAtTime(band.gain_db, t, 0.1);
      node.Q.setTargetAtTime(band.q, t, 0.1);
    });
  }
}