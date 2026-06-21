import { Component, ElementRef, OnInit, OnDestroy, ViewChild, AfterViewInit, HostListener, ChangeDetectorRef } from '@angular/core';
import { RouterOutlet } from "@angular/router";
import { CabinAudioService } from "./audio"; 
import { TestingButton } from "./testing-button/testing-button";
import { CabinComponent } from "./cabincomponent/cabincomponent";
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';

interface QuirkSwitch {
  id: string;
  label: string;
  active: boolean;
}

interface BluetoothDevice {
  name: string;
  mac: string;
  connected: boolean;
}

@Component({
  selector: "app-root",
  standalone: true,
  imports: [RouterOutlet, TestingButton, CabinComponent, CommonModule],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent implements OnInit, AfterViewInit, OnDestroy {
  currentTab: 'home' | 'connection' = 'home';

  @ViewChild('spectrogramCanvas', { static: false }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('canvasContainer', { static: false }) containerRef!: ElementRef<HTMLDivElement>;
  
  isShieldEngaged = false; 
  dominantHertz = 0;
  private currentBands: { frequency: number; gain_db: number }[] = [];
  
  // Cache for interpolating line rendering over time (prevents jitter)
  private smoothedGains: number[] = [];

  quirks: QuirkSwitch[] = [
    { id: 'loose-dash', label: 'Loose Dash', active: true },
    { id: 'low-gear', label: 'Low Gear Chiver', active: false },
  ];

  pairedDevices: BluetoothDevice[] = [
    { name: 'UNREALLX', mac: '41:50:AA:38:50:FE', connected: true },
    { name: 'Galaxy A54 5G', mac: 'CC:F8:26:35:69:C1', connected: false },
    { name: 'EW03 Plus', mac: 'AD:49:DB:F0:38:D7', connected: false },
    { name: 'pro 4', mac: 'F2:8E:61:B8:24:7A', connected: false },
    { name: 'JBL Xtreme 3', mac: '40:C1:F6:B5:02:34', connected: false },
    { name: 'A9 Pro(TDS)', mac: '41:42:CD:B1:D0:41', connected: false }
  ];

  private dspSubscription: Subscription | null = null;
  private animationFrameId!: number;

  constructor(private cabin: CabinAudioService, private cdr: ChangeDetectorRef) {}

  ngOnInit() {
    this.dspSubscription = this.cabin.dspFrame$.subscribe({
      next: (frame) => {
        this.dominantHertz = frame.dominant_hz;
        this.currentBands = frame.bands || [];
        
        // Gate state by whether physical bands are arriving
        this.isShieldEngaged = this.currentBands.length > 0;
        
        // Force cross-runtime thread synchronization update
        this.cdr.detectChanges();
      },
      error: (err) => console.error("Main View Audio Sub Error:", err),
    });
  }

  ngAfterViewInit() {
    this.resizeCanvasToContainer();
    this.initCanvasLoop(); 
  }

  ngOnDestroy() {
    if (this.dspSubscription) {
      this.dspSubscription.unsubscribe();
    }
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
  }

  @HostListener('window:resize')
  onWindowResize() {
    this.resizeCanvasToContainer();
  }

  private resizeCanvasToContainer() {
    if (this.canvasRef && this.containerRef) {
      const canvas = this.canvasRef.nativeElement;
      const container = this.containerRef.nativeElement;
      
      const width = container.clientWidth || container.getBoundingClientRect().width || 400;
      const height = container.clientHeight || container.getBoundingClientRect().height || 140;

      canvas.width = width;
      canvas.height = height;
    }
  }

  toggleQuirk(id: string) {
    this.quirks = this.quirks.map(q => q.id === id ? { ...q, active: !q.active } : q);
  }

  private initCanvasLoop() {
    const render = () => {
      this.animationFrameId = requestAnimationFrame(render);

      if (!this.canvasRef || this.currentTab !== 'home') return;

      const canvas = this.canvasRef.nativeElement;
      const ctx = canvas.getContext('2d'); 
      if (!ctx) return;

      // Anti-collapse structural check
      if (canvas.width === 0 || canvas.height === 0) {
        this.resizeCanvasToContainer();
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height); 
      
      // 1. BACKGROUND RADAR GRID
      ctx.strokeStyle = 'rgba(25, 135, 84, 0.12)'; 
      ctx.lineWidth = 1;
      for (let i = 0; i < canvas.width; i += 30) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, canvas.height); ctx.stroke(); 
      }
      for (let i = 0; i < canvas.height; i += 20) {
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(canvas.width, i); ctx.stroke(); 
      }

      // 2. TRUE FREQUENCY MAPPED OSCILLOSCOPE TRACE WITH DOMINANT RESONANCE
      if (this.isShieldEngaged && this.currentBands.length > 0) {
        const totalPoints = this.currentBands.length;

        if (this.smoothedGains.length !== totalPoints) {
          this.smoothedGains = new Array(totalPoints).fill(0);
        }

        // Identify min and max tracking frequency boundaries directly out of dataset frames
        const minFreq = this.currentBands[0].frequency;
        const maxFreq = this.currentBands[totalPoints - 1].frequency;
        const freqRange = maxFreq - minFreq || 1; 

        const points: {x: number, y: number}[] = [];
        
        // Use browser system time clock to generate continuous high-frequency oscillation frequencies
        const timeFactor = Date.now() * 0.05;

        for (let i = 0; i < totalPoints; i++) {
          const band = this.currentBands[i];
          
          // MAP X TARGET VIA PHYSICAL HERTZ METRICS
          const x = ((band.frequency - minFreq) / freqRange) * canvas.width;
          
          const rawGain = band.gain_db;
          let normalizedGain = 0;

          // Adaptively resolve amplitude structure boundaries
          if (rawGain < 0) {
            normalizedGain = Math.max(0, Math.min((rawGain + 60) / 60, 1.0));
          } else if (rawGain <= 1.0) {
            normalizedGain = Math.max(0, Math.min(rawGain * 5.0, 1.0)); // Lift small signals out of floor
          } else {
            normalizedGain = Math.max(0, Math.min(rawGain / 24, 1.0));
          }
          
          // RESONANCE LAYER: Inject dynamic vibrations around the active dominant peak frequency
          const deltaHz = Math.abs(band.frequency - this.dominantHertz);
          const proximityThreshold = 120; // HZ window size to receive the vibration ripple
          
          if (deltaHz < proximityThreshold && this.dominantHertz > 0) {
            const proximityFactor = 1.0 - (deltaHz / proximityThreshold);
            // Mix a high-frequency sine vibration pattern onto the target node
            const microOscillation = Math.sin(timeFactor + i) * 0.18 * proximityFactor;
            normalizedGain = Math.max(0, Math.min(normalizedGain + microOscillation, 1.0));
          }
          
          // Exponential Smoothing Factor (0.25 execution tracking velocity)
          this.smoothedGains[i] += (normalizedGain - this.smoothedGains[i]) * 0.25;
          
          const verticalPadding = 20;
          const usableHeight = canvas.height - (verticalPadding * 2);
          const y = canvas.height - verticalPadding - (this.smoothedGains[i] * usableHeight);
          
          points.push({ x, y });
        }

        // Sort data explicitly to guarantee left-to-right draw sequence
        points.sort((a, b) => a.x - b.x);

        // Underlay Matrix Faded Fill
        ctx.fillStyle = 'rgba(25, 135, 84, 0.06)';
        ctx.beginPath();
        ctx.moveTo(0, canvas.height);
        points.forEach(p => ctx.lineTo(p.x, p.y));
        ctx.lineTo(canvas.width, canvas.height);
        ctx.closePath();
        ctx.fill();

        // High Visibility Neon Scope Trace Core
        ctx.strokeStyle = '#198754';
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#198754';

        ctx.beginPath();
        points.forEach((p, idx) => {
          if (idx === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.stroke();
        
        ctx.shadowBlur = 0;

      } else {
        // High visibility standby trace alignment line
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