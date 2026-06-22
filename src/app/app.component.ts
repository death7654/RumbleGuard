import { Component, ElementRef, OnInit, OnDestroy, ViewChild, AfterViewInit, HostListener, ChangeDetectorRef } from '@angular/core';
import { CabinAudioService, EqBand } from "./audio"; 
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';

@Component({
  selector: "app-root",
  standalone: true,
  imports: [CommonModule],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('spectrogramCanvas', { static: false }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('canvasContainer', { static: false }) containerRef!: ElementRef<HTMLDivElement>;
  @ViewChild('testAudioPlayer', { static: false }) audioPlayerRef!: ElementRef<HTMLAudioElement>;
  
  isShieldEngaged = false;
  isPlaying = false;
  dominantHertz = 0;
  
  private currentBands: EqBand[] = [];
  private smoothedGains: number[] = [];
  throttledBands: EqBand[] = [];

  private dspSubscription: Subscription | null = null;
  private animationFrameId!: number;
  private uiIntervalId: any = null;
  private audioObjectUrl: string | null = null; // Prevent memory leaks

  constructor(private cabin: CabinAudioService, private http: HttpClient, private cdr: ChangeDetectorRef) {
    const defaultFreqs = [60, 250, 1000, 4000, 16000];
    this.throttledBands = defaultFreqs.map(f => ({ frequency: f, gain_db: 0, q: 1 }));
  }

  ngOnInit() {
    this.dspSubscription = this.cabin.dspFrame$.subscribe({
      next: (frame) => {
        if (frame) {
          this.dominantHertz = frame.dominant_hz;
          this.currentBands = frame.bands || [];
        }
      },
      error: (err) => console.error("DSP Frame Pipe Exception:", err)
    });

    this.uiIntervalId = setInterval(() => {
      if (this.isShieldEngaged && this.currentBands.length > 0) {
        this.throttledBands = JSON.parse(JSON.stringify(this.currentBands));
        this.cdr.detectChanges(); 
      }
    }, 500);
  }

  ngAfterViewInit() {
    this.resizeCanvasToContainer();
    this.initCanvasLoop(); 
    
    // 🔥 Securely fetch the music file as a safe raw blob to bypass origin restrictions
    this.http.get('assets/hooligang.mp3', { responseType: 'blob' }).subscribe({
      next: (blob) => {
        this.audioObjectUrl = URL.createObjectURL(blob);
        const audio = this.audioPlayerRef.nativeElement;
        
        audio.src = this.audioObjectUrl;
        audio.load();
        
        // Wire up the safe asset directly to your filter graph
        this.cabin.connectAudioElement(audio);
      },
      error: (err) => console.error("Failed to load local music file resource safely:", err)
    });
  }

  ngOnDestroy() {
    if (this.dspSubscription) this.dspSubscription.unsubscribe();
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
    if (this.uiIntervalId) clearInterval(this.uiIntervalId);
    if (this.audioObjectUrl) URL.revokeObjectURL(this.audioObjectUrl); // Free system memory
    this.cabin.destroy();
  }

  @HostListener('window:resize')
  onWindowResize() {
    this.resizeCanvasToContainer();
  }

  togglePlayback() {
    const audio = this.audioPlayerRef.nativeElement;
    if (this.isPlaying) {
      audio.pause();
      this.isPlaying = false;
    } else {
      audio.play().catch(err => console.error("Media Unlock Error:", err));
      this.isPlaying = true;
    }
    this.cdr.detectChanges();
  }

  async toggleShield() {
    this.isShieldEngaged = !this.isShieldEngaged;
    
    if (this.isShieldEngaged) {
      try {
        await this.cabin.startListening();
        await this.cabin.startRecording();
      } catch (err) {
        console.error("Shield activation failure:", err);
        this.isShieldEngaged = false;
      }
    } else {
      try {
        await this.cabin.stopRecording();
      } catch (err) {}
      this.dominantHertz = 0;
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

      if (this.isShieldEngaged && this.currentBands.length > 0) {
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
          let normalizedGain = (band.gain_db + 30) / 45; 
          
          const deltaHz = Math.abs(band.frequency - this.dominantHertz);
          if (deltaHz < 150 && this.dominantHertz > 0) {
            const proximityFactor = 1.0 - (deltaHz / 150);
            normalizedGain += Math.sin(timeFactor + i) * 0.25 * proximityFactor;
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