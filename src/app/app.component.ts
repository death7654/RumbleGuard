import { Component, ElementRef, OnInit, OnDestroy, ViewChild, AfterViewInit } from '@angular/core';
import { RouterOutlet } from "@angular/router";
import { invoke } from "@tauri-apps/api/core";
import { TestingButton } from "./testing-button/testing-button";
import { CabinComponent } from "./cabincomponent/cabincomponent";
import { CommonModule } from '@angular/common';

interface QuirkSwitch {
  id: string;
  label: string;
  active: boolean;
}

@Component({
  selector: "app-root",
  imports: [RouterOutlet, TestingButton, CabinComponent, CommonModule],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent implements OnInit, AfterViewInit, OnDestroy {
  greetingMessage = "";

  // Changed to { static: false } to safely grab structural template elements
  @ViewChild('spectrogramCanvas', { static: false }) canvasRef!: ElementRef<HTMLCanvasElement>;
  
  isShieldEngaged = false; 
  isPlaying = false;       
  shieldStrength = 85;     
  
  quirks: QuirkSwitch[] = [
    { id: 'loose-dash', label: 'Loose Dash', active: true },
    { id: 'low-gear', label: 'Low Gear Chiver', active: false },
  ];

  private animationFrameId!: number; 
  private phase = 0;                  

  ngOnInit() {
    // Keep your backend initialization logic here!
  }

  // "I'm fully rendered!" - This is the safest place to initialize DOM paint brushes like Canvas
  ngAfterViewInit() {
    this.initCanvasAnimation(); 
  }

  ngOnDestroy() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId); 
    }
  }

  greet(event: SubmitEvent, name: string): void {
    event.preventDefault();
    invoke<string>("greet", { name }).then((text) => {
      this.greetingMessage = text;
    });
  }

  toggleShield() {
    this.isShieldEngaged = !this.isShieldEngaged; 
  }

  togglePlay() {
    this.isPlaying = !this.isPlaying; 
  }

  toggleQuirk(id: string) {
    this.quirks = this.quirks.map(q => q.id === id ? { ...q, active: !q.active } : q);
  }

  private initCanvasAnimation() {
    // Fallback protection check in case the component renders without the canvas layout
    if (!this.canvasRef) return; 

    const canvas = this.canvasRef.nativeElement;
    const ctx = canvas.getContext('2d'); 
    if (!ctx) return;

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height); 
      
      // 1. DRAW THE GRID LINES
      ctx.strokeStyle = 'rgba(163, 230, 53, 0.05)'; 
      ctx.lineWidth = 1;
      for (let i = 0; i < canvas.width; i += 20) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, canvas.height); ctx.stroke(); 
      }
      for (let i = 0; i < canvas.height; i += 20) {
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(canvas.width, i); ctx.stroke(); 
      }

      // 2. DRAW MAIN LASER WAVE
      ctx.strokeStyle = this.isShieldEngaged ? '#A3E635' : '#4B5563';
      ctx.lineWidth = 2;
      ctx.shadowBlur = this.isShieldEngaged ? 10 : 0; 
      ctx.shadowColor = '#A3E635';
      
      ctx.beginPath();
      for (let x = 0; x < canvas.width; x++) {
        const amp = this.isShieldEngaged ? 25 : 5;
        const y = canvas.height / 2 + Math.sin(x * 0.02 + this.phase) * amp + Math.cos(x * 0.01 + this.phase * 0.5) * (amp * 0.3);
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // 3. DRAW SECONDARY LASER WAVE
      ctx.strokeStyle = this.isShieldEngaged ? 'rgba(163, 230, 53, 0.4)' : '#374151';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let x = 0; x < canvas.width; x++) {
        const amp = this.isShieldEngaged ? 15 : 2;
        const y = canvas.height / 2 + Math.sin(x * 0.03 - this.phase) * amp; 
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      ctx.shadowBlur = 0;
      this.phase += this.isShieldEngaged ? 0.08 : 0.01;
      this.animationFrameId = requestAnimationFrame(render);
    };

    render(); 
  }
}