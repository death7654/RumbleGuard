import { Component, ElementRef, OnInit, OnDestroy, ViewChild, AfterViewInit, HostListener, ChangeDetectorRef } from '@angular/core';
import { CabinAudioService } from "./audio"; 
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { invoke } from '@tauri-apps/api/core';

interface AudioTrack {
  id: string;
  title: string;
  fileName: string;
  duration: string;
  type: string;
}

@Component({
  selector: "app-root",
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
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
  
  // 🎚️ Shield Multiplier tracked on frontend & sent to Rust backend
  shieldStrength = 1.0; 

  private currentBands: any[] = [];
  private smoothedGains: number[] = [];
  throttledBands: any[] = [];

  trackList: AudioTrack[] = [
    { id: 't1', title: 'Hooligang Reference Bass Mix', fileName: 'hooligang.mp3', duration: '3:42', type: 'Cabin Profile' },
    { id: 't2', title: 'White Noise Isolation Sweep', fileName: 'whitenoise.mp3', duration: '5:00', type: 'Static Masking' },
    { id: 't3', title: 'Low Frequency Pink Noise Frame', fileName: 'pinknoise.mp3', duration: '4:15', type: 'Vibration Counter' }
  ];
  selectedTrack: AudioTrack = this.trackList[0];

  private dspSubscription: Subscription | null = null;
  private animationFrameId!: number;
  private uiIntervalId: any = null;
  private audioObjectUrl: string | null = null;

  constructor(private cabin: CabinAudioService, private cdr: ChangeDetectorRef) {
    const defaultFreqs = [60, 150, 240, 350, 480];
    this.throttledBands = defaultFreqs.map(f => ({ frequency: f, gain_db: 0, q: 1.5 }));
  }

  ngOnInit() {
    this.dspSubscription = this.cabin.dspFrame$.subscribe({
      next: (frame: any) => {
        if (frame) {
          this.dominantHertz = frame.dominant_hz;
          this.noiseDb = frame.noise_db;
          this.isCalibrating = !!frame.calibrating;
          this.currentBands = frame.bands || [];

          // Seamless synchronization to Web Audio API peaking engine filters layer
          if (this.isShieldEngaged && !this.isCalibrating) {
            this.cabin.updateLiveMultipliers(this.currentBands);
          }
        }
      },
      error: (err) => console.error("DSP Frame Subscription Error:", err)
    });

    // Throttled UI display loop interface matrices state maps updates
    this.uiIntervalId = setInterval(() => {
      if (this.isShieldEngaged && !this.isCalibrating && this.currentBands.length > 0) {
        this.throttledBands = JSON.parse(JSON.stringify(this.currentBands));
        this.cdr.detectChanges(); 
      }
    }, 400);
  }

  ngAfterViewInit() {
    this.resizeCanvasToContainer();
    this.initCanvasLoop(); 
    this.loadTrackAsset(this.selectedTrack);
  }

  ngOnDestroy() {
    if (this.dspSubscription) this.dspSubscription.unsubscribe();
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
    if (this.uiIntervalId) clearInterval(this.uiIntervalId);
    this.clearAudioObjectUrl();
  }

  @HostListener('window:resize')
  onWindowResize() {
    this.resizeCanvasToContainer();
  }

  // 🦀 CRITICAL BACKEND LINKAGE: Fires changes down to Rust loop
  onStrengthChange() {
    invoke('set_shield_strength', { strength: this.shieldStrength })
      .catch(err => console.error("Tauri IPC Invocation Error:", err));
  }

  async loadTrackAsset(track: AudioTrack) {
    try {
      this.clearAudioObjectUrl();
      const assetPath = `assets/${track.fileName}`;
      
      const response = await fetch(assetPath);
      const blob = await response.blob();
      
      this.audioObjectUrl = URL.createObjectURL(blob);
      const audio = this.audioPlayerRef.nativeElement;
      
      audio.src = this.audioObjectUrl;
      audio.load();
      
      this.cabin.connectAudioElement(audio);
      if (this.isPlaying) {
        audio.play().catch(() => this.isPlaying = false);
      }
    } catch (err) {
      console.error("Android Target Asset Loader Failure:", err);
    }
  }

  selectTrack(track: AudioTrack) {
    this.selectedTrack = track;
    this.loadTrackAsset(track);
    this.cdr.detectChanges();
  }

  private clearAudioObjectUrl() {
    if (this.audioObjectUrl) {
      URL.revokeObjectURL(this.audioObjectUrl);
      this.audioObjectUrl = null;
    }
  }

  togglePlayback() {
    const audio = this.audioPlayerRef.nativeElement;
    if (this.isPlaying) {
      audio.pause();
      this.isPlaying = false;
    } else {
      audio.play().catch(err => console.error("Audio Context Playback Lockout:", err));
      this.isPlaying = true;
    }
    this.cdr.detectChanges();
  }

  async toggleShield() {
    this.isShieldEngaged = !this.isShieldEngaged;
    
    if (this.isShieldEngaged) {
      try {
        await this.cabin.startListening();
        await invoke('start_recording');
      } catch (err) {
        console.error("Shield activation failure:", err);
        this.isShieldEngaged = false;
      }
    } else {
      try {
        await invoke('stop_recording');
      } catch (err) {}
      this.dominantHertz = 0;
      this.noiseDb = -200;
      this.isCalibrating = false;
      this.currentBands = [];
      this.throttledBands.forEach(b => b.gain_db = 0);
    }
    this.cdr.detectChanges();
  }

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

        const minFreq = this.currentBands[0].frequency;
        const maxFreq = this.currentBands[totalPoints - 1].frequency;
        const freqRange = maxFreq - minFreq || 1; 

        const points: {x: number, y: number}[] = [];
        const timeFactor = Date.now() * 0.05;

        for (let i = 0; i < totalPoints; i++) {
          const band = this.currentBands[i];
          const x = ((band.frequency - minFreq) / freqRange) * canvas.width;
          let normalizedGain = (band.gain_db) / 6.0; // Scaled to frequency_ceiling max
          
          const deltaHz = Math.abs(band.frequency - this.dominantHertz);
          if (deltaHz < 100 && this.dominantHertz > 0) {
            const proximityFactor = 1.0 - (deltaHz / 100);
            normalizedGain += Math.sin(timeFactor + i) * 0.15 * proximityFactor;
          }
          
          this.smoothedGains[i] += (normalizedGain - this.smoothedGains[i]) * 0.25;
          const usableHeight = canvas.height - 40;
          const y = canvas.height - 20 - (Math.max(0, Math.min(this.smoothedGains[i], 1.0)) * usableHeight);
          
          points.push({ x, y });
        }

        ctx.fillStyle = 'rgba(25, 135, 84, 0.06)';
        ctx.beginPath(); ctx.moveTo(0, canvas.height);
        points.forEach(p => ctx.lineTo(p.x, p.y));
        ctx.lineTo(canvas.width, canvas.height); ctx.closePath(); ctx.fill();

        ctx.strokeStyle = '#198754'; ctx.lineWidth = 3; ctx.lineJoin = 'round';
        ctx.shadowBlur = 10; ctx.shadowColor = '#198754';
        ctx.beginPath();
        points.forEach((p, idx) => idx === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
        ctx.stroke(); ctx.shadowBlur = 0;
      } else {
        ctx.strokeStyle = '#2c4c38'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, canvas.height / 2); ctx.lineTo(canvas.width, canvas.height / 2); ctx.stroke();
      }
    };
    render(); 
  }
}