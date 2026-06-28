import {
  Component, ElementRef, OnInit, OnDestroy, ViewChild,
  AfterViewInit, HostListener, ChangeDetectorRef
} from '@angular/core';
import { CabinAudioService } from './audio';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { invoke } from '@tauri-apps/api/core';

interface AudioTrack {
  id: string;
  title: string;
  fileName: string;
  fullPath?: string;
  duration: string;
  type: string;
  isLocalDeviceFile?: boolean;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('spectrogramCanvas', { static: false }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('canvasContainer', { static: false }) containerRef!: ElementRef<HTMLDivElement>;
  @ViewChild('testAudioPlayer', { static: false }) audioPlayerRef!: ElementRef<HTMLAudioElement>;

  currentTab: 'home' | 'music' = 'home';
  isShieldEngaged = false;
  isCalibrating = false;
  isPlaying = false;
  dominantHertz = 0;
  noiseDb = -200;
  shieldStrength = 1.0;

  private currentBands: any[] = [];
  private smoothedGains: number[] = [];
  throttledBands: any[] = [];

  trackList: AudioTrack[] = [
    { id: 't1', title: 'Hooligang Reference Bass Mix', fileName: 'hooligang.mp3', duration: '3:42', type: 'Cabin Profile' },
    { id: 't2', title: 'White Noise Isolation Sweep', fileName: 'whitenoise.mp3', duration: '5:00', type: 'Static Masking' },
    { id: 't3', title: 'Low Frequency Pink Noise Frame', fileName: 'pinknoise.mp3', duration: '4:15', type: 'Vibration Counter' },
  ];

  deviceTrackList: AudioTrack[] = [];
  activeQueue: AudioTrack[] = [];
  currentTrackIndex = 0;
  selectedTrack: AudioTrack = this.trackList[0];

  isScanningHardware = false;

  private dspSubscription: Subscription | null = null;
  private animationFrameId!: number;
  private uiIntervalId: any = null;
  private audioObjectUrl: string | null = null;

  constructor(private cabin: CabinAudioService, private cdr: ChangeDetectorRef) {
    const defaultFreqs = [60, 150, 240, 350, 480];
    this.throttledBands = defaultFreqs.map(f => ({ frequency: f, gain_db: 0, q: 1.5 }));
    this.rebuildActiveQueue();
  }

  ngOnInit() {
    this.dspSubscription = this.cabin.dspFrame$.subscribe({
      next: (frame: any) => {
        if (!frame) return;
        this.dominantHertz = frame.dominant_hz;
        this.noiseDb = frame.noise_db;
        this.isCalibrating = !!frame.calibrating;
        this.currentBands = frame.bands || [];

        if (this.isShieldEngaged && !this.isCalibrating) {
          this.cabin.updateLiveMultipliers(this.currentBands);
        }
      },
      error: (err: any) => console.error('DSP Frame Subscription Error:', err),
    });

    // Throttle UI band display to 400 ms so Angular change detection stays cheap
    this.uiIntervalId = setInterval(() => {
      if (this.isShieldEngaged && !this.isCalibrating && this.currentBands.length > 0) {
        if (this.throttledBands.length !== this.currentBands.length) {
          this.throttledBands = this.currentBands.map(b => ({ ...b }));
        } else {
          for (let i = 0; i < this.currentBands.length; i++) {
            this.throttledBands[i].frequency = this.currentBands[i].frequency;
            this.throttledBands[i].gain_db = this.currentBands[i].gain_db;
            this.throttledBands[i].q = this.currentBands[i].q;
          }
        }
        this.cdr.detectChanges();
      }
    }, 400);

    this.scanDeviceHardwareTracks();
  }

  ngAfterViewInit() {
    this.resizeCanvasToContainer();
    this.initCanvasLoop();
    this.loadTrackAsset(this.selectedTrack);

    const audio = this.audioPlayerRef.nativeElement;
    audio.addEventListener('ended', () => this.onTrackEnded());
  }

  ngOnDestroy() {
    if (this.dspSubscription) this.dspSubscription.unsubscribe();
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
    if (this.uiIntervalId) clearInterval(this.uiIntervalId);
    this.clearAudioObjectUrl();
    // Stop Tauri event listener so it doesn't leak across hot reloads
    this.cabin.stopListening();
  }

  @HostListener('window:resize')
  onWindowResize() {
    this.resizeCanvasToContainer();
  }

  private rebuildActiveQueue() {
    this.activeQueue = [...this.deviceTrackList, ...this.trackList];
    const foundIndex = this.activeQueue.findIndex(t => t.id === this.selectedTrack.id);
    this.currentTrackIndex = foundIndex !== -1 ? foundIndex : 0;
  }

  onStrengthChange() {
    invoke('set_shield_strength', { strength: this.shieldStrength })
      .catch(err => console.error('set_shield_strength error:', err));
  }

  async scanDeviceHardwareTracks() {
    this.isScanningHardware = true;
    this.cdr.detectChanges();
    try {
      const tracks = await invoke<any[]>('get_local_music_tracks');
      this.deviceTrackList = tracks.map(t => ({
        id: t.id,
        title: t.title,
        fileName: t.file_name,
        fullPath: t.full_path,
        duration: t.duration,
        type: t.type,
        isLocalDeviceFile: true,
      }));
      this.rebuildActiveQueue();
    } catch (err) {
      console.error('Failed to scan local tracks:', err);
    } finally {
      this.isScanningHardware = false;
      this.cdr.detectChanges();
    }
  }

  async loadTrackAsset(track: AudioTrack) {
    try {
      this.clearAudioObjectUrl();
      const audio = this.audioPlayerRef.nativeElement;

      if (track.isLocalDeviceFile && track.fullPath) {
        audio.src = `rumble-stream://localhost/${encodeURIComponent(track.fullPath)}`;
      } else {
        const response = await fetch(`assets/${track.fileName}`);
        const blob = await response.blob();
        this.audioObjectUrl = URL.createObjectURL(blob);
        audio.src = this.audioObjectUrl;
      }

      audio.load();
      // connectAudioElement is idempotent — safe to call on every track change
      this.cabin.connectAudioElement(audio);

      if (this.isPlaying) {
        // Resume context first (required after autoplay policy blocks it)
        await this.cabin.resumeContext();
        audio.play().catch(() => (this.isPlaying = false));
      }
    } catch (err) {
      console.error('loadTrackAsset error:', err);
    }
  }

  nextTrack() {
    if (this.activeQueue.length === 0) return;
    this.currentTrackIndex = (this.currentTrackIndex + 1) % this.activeQueue.length;
    this.selectedTrack = this.activeQueue[this.currentTrackIndex];
    this.loadTrackAsset(this.selectedTrack);
    this.cdr.detectChanges();
  }

  prevTrack() {
    if (this.activeQueue.length === 0) return;
    this.currentTrackIndex =
      (this.currentTrackIndex - 1 + this.activeQueue.length) % this.activeQueue.length;
    this.selectedTrack = this.activeQueue[this.currentTrackIndex];
    this.loadTrackAsset(this.selectedTrack);
    this.cdr.detectChanges();
  }

  private onTrackEnded() {
    this.nextTrack();
  }

  async onLocalFileSelected(event: Event) {
    const target = event.target as HTMLInputElement;
    if (!target.files || target.files.length === 0) return;

    const file = target.files[0];
    this.clearAudioObjectUrl();

    const sandboxTrack: AudioTrack = {
      id: `sandbox-${Date.now()}`,
      title: file.name.replace(/\.[^/.]+$/, ''),
      fileName: file.name,
      duration: '--:--',
      type: 'Ad-hoc',
    };

    this.activeQueue.unshift(sandboxTrack);
    this.currentTrackIndex = 0;
    this.selectedTrack = sandboxTrack;

    try {
      this.audioObjectUrl = URL.createObjectURL(file);
      const audio = this.audioPlayerRef.nativeElement;
      audio.src = this.audioObjectUrl;
      audio.load();
      this.cabin.connectAudioElement(audio);

      if (this.isPlaying) {
        await this.cabin.resumeContext();
        audio.play().catch(() => (this.isPlaying = false));
      }
      this.cdr.detectChanges();
    } catch (err) {
      console.error('File picker error:', err);
    }
  }

  selectTrack(track: AudioTrack) {
    this.selectedTrack = track;
    const index = this.activeQueue.findIndex(t => t.id === track.id);
    if (index !== -1) this.currentTrackIndex = index;
    this.loadTrackAsset(track);
    this.cdr.detectChanges();
  }

  private clearAudioObjectUrl() {
    if (this.audioObjectUrl) {
      URL.revokeObjectURL(this.audioObjectUrl);
      this.audioObjectUrl = null;
    }
  }

  async togglePlayback() {
    const audio = this.audioPlayerRef.nativeElement;
    // Always resume context on user gesture — this is the earliest safe point
    await this.cabin.resumeContext();

    if (this.isPlaying) {
      audio.pause();
      this.isPlaying = false;
      // When music is paused, activate masking tone so EQ still has signal to shape
      if (this.isShieldEngaged) {
        this.cabin.enableMaskingTone();
      }
    } else {
      try {
        await audio.play();
        this.isPlaying = true;
        // Music is playing → use it as the EQ signal source, not the masking tone
        this.cabin.disableMaskingTone();
      } catch (err) {
        console.error('Playback error:', err);
      }
    }
    this.cdr.detectChanges();
  }

  async toggleShield() {
    this.isShieldEngaged = !this.isShieldEngaged;

    if (this.isShieldEngaged) {
      try {
        // Resume context before starting — user gesture is active here
        await this.cabin.resumeContext();
        await this.cabin.startListening();
        await invoke('start_recording');

        // If no music is playing, generate masking tone so EQ has audio to shape
        if (!this.isPlaying) {
          this.cabin.enableMaskingTone();
        }
      } catch (err) {
        console.error('Shield activation failure:', err);
        this.isShieldEngaged = false;
      }
    } else {
      try {
        await invoke('stop_recording');
        await this.cabin.stopListening();
      } catch (_) {}
      this.cabin.disableMaskingTone();
      this.cabin.resetEq();
      this.dominantHertz = 0;
      this.noiseDb = -200;
      this.isCalibrating = false;
      this.currentBands = [];
      this.throttledBands.forEach(b => (b.gain_db = 0));
    }
    this.cdr.detectChanges();
  }

  // ─── Canvas spectrogram ───────────────────────────────────────────────────────

  private resizeCanvasToContainer() {
    if (this.canvasRef && this.containerRef) {
      const canvas = this.canvasRef.nativeElement;
      const container = this.containerRef.nativeElement;
      canvas.width = container.clientWidth || 400;
      canvas.height = container.clientHeight || 140;
    }
  }

  private initCanvasLoop() {
    const render = () => {
      this.animationFrameId = requestAnimationFrame(render);
      if (!this.canvasRef) return;
      const canvas = this.canvasRef.nativeElement;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Grid
      ctx.strokeStyle = 'rgba(25, 135, 84, 0.12)';
      ctx.lineWidth = 1;
      for (let i = 0; i < canvas.width; i += 30) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, canvas.height); ctx.stroke();
      }
      for (let i = 0; i < canvas.height; i += 20) {
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(canvas.width, i); ctx.stroke();
      }

      if (this.isShieldEngaged && !this.isCalibrating && this.currentBands.length > 0) {
        const totalPoints = this.currentBands.length;
        if (this.smoothedGains.length !== totalPoints) {
          this.smoothedGains = new Array(totalPoints).fill(0);
        }

        const freqs = this.currentBands.map(b => b.frequency);
        const minFreq = Math.min(...freqs);
        const maxFreq = Math.max(...freqs);
        const freqRange = maxFreq - minFreq || 1;
        const timeFactor = Date.now() * 0.05;
        const points: { x: number; y: number }[] = [];

        for (let i = 0; i < totalPoints; i++) {
          const band = this.currentBands[i];
          const x = ((band.frequency - minFreq) / freqRange) * canvas.width;
          let normalizedGain = band.gain_db / 8.0; // scale to max ceiling (8 dB)

          const deltaHz = Math.abs(band.frequency - this.dominantHertz);
          if (deltaHz < 100 && this.dominantHertz > 0) {
            const proximity = 1.0 - deltaHz / 100;
            normalizedGain += Math.sin(timeFactor + i) * 0.15 * proximity;
          }

          this.smoothedGains[i] += (normalizedGain - this.smoothedGains[i]) * 0.25;
          const usableHeight = canvas.height - 40;
          const y = canvas.height - 20 - Math.max(0, Math.min(this.smoothedGains[i], 1)) * usableHeight;
          points.push({ x, y });
        }

        // Fill under curve
        ctx.fillStyle = 'rgba(25, 135, 84, 0.06)';
        ctx.beginPath();
        ctx.moveTo(0, canvas.height);
        points.forEach(p => ctx.lineTo(p.x, p.y));
        ctx.lineTo(canvas.width, canvas.height);
        ctx.closePath();
        ctx.fill();

        // Curve line
        ctx.strokeStyle = '#198754';
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#198754';
        ctx.beginPath();
        points.forEach((p, idx) => (idx === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.stroke();
        ctx.shadowBlur = 0;
      } else {
        // Idle flat line
        ctx.strokeStyle = '#2c4c38';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, canvas.height / 2);
        ctx.lineTo(canvas.width, canvas.height / 2);
        ctx.stroke();
      }
    };

    render();
  }
}