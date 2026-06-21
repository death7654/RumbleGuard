import { Component, ElementRef, OnInit, OnDestroy, ViewChild, AfterViewInit, HostListener } from '@angular/core';
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

  constructor(private cabin: CabinAudioService) {}

  ngOnInit() {
    this.dspSubscription = this.cabin.dspFrame$.subscribe({
      next: (frame) => {
        this.dominantHertz = frame.dominant_hz;
        this.currentBands = frame.bands || [];
        this.isShieldEngaged = frame.dominant_hz > 0;
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

  // 🔄 Listens to browser frame structural scaling instantly
  @HostListener('window:resize')
  onWindowResize() {
    this.resizeCanvasToContainer();
  }

  private resizeCanvasToContainer() {
    if (this.canvasRef && this.containerRef) {
      const canvas = this.canvasRef.nativeElement;
      const container = this.containerRef.nativeElement;
      
      // Sync internal layout resolution metrics to outer DOM bounds
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
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

      ctx.clearRect(0, 0, canvas.width, canvas.height); 
      
      // 1. GRID LAYER BACKGROUND
      ctx.strokeStyle = 'rgba(25, 135, 84, 0.04)'; 
      ctx.lineWidth = 1;
      for (let i = 0; i < canvas.width; i += 20) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, canvas.height); ctx.stroke(); 
      }
      for (let i = 0; i < canvas.height; i += 20) {
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(canvas.width, i); ctx.stroke(); 
      }

      // 2. LIVE FLUID SPECTROMETER RENDER
      if (this.isShieldEngaged && this.currentBands.length > 0) {
        const bufferLength = this.currentBands.length;
        const barWidth = canvas.width / bufferLength;
        let x = 0;

        ctx.fillStyle = '#198754';
        ctx.shadowBlur = 8;
        ctx.shadowColor = '#198754';

        for (let i = 0; i < bufferLength; i++) {
          const gain = this.currentBands[i].gain_db;
          const normalizedGain = Math.max(0, Math.min(gain / 24, 1.0));
          
          const barHeight = normalizedGain * canvas.height * 0.85;
          const y = canvas.height - barHeight - 10;

          ctx.fillRect(x, y, barWidth - 3, barHeight);
          x += barWidth;
        }
        ctx.shadowBlur = 0;
      } else {
        // Flatline trace
        ctx.strokeStyle = '#444444';
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