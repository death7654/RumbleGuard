import { Component, ElementRef, OnInit, OnDestroy, ViewChild } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { CommonModule } from '@angular/common';
import { appConfig } from "./app/app.config"; // Keeping the super secret brain settings safe!

// This is a recipe for a "Quirk Switch" (a special button that has a name and can be turned ON or OFF)
interface QuirkSwitch {
  id: string;
  label: string;
  active: boolean;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="min-h-screen bg-[#0B0F12] text-white font-sans flex items-center justify-center p-4">
      
      <div class="w-full max-w-md bg-[#13191E] border border-gray-800 rounded-3xl p-6 shadow-2xl flex flex-col gap-6">
        
        <div class="flex items-center justify-between border-b border-gray-800 pb-4">
          <button class="p-2 bg-[#1C242C] hover:bg-[#25303A] text-gray-400 hover:text-white rounded-xl transition-all">
            ⚙️ </button>
          <div class="text-center">
            <h1 class="text-xs uppercase tracking-widest text-gray-500 font-bold">Acoustic Shield</h1>
            <p class="text-[10px] text-gray-400 mt-0.5">DRIVE SYSTEM v2.4</p>
          </div>
          <div class="flex items-center gap-1.5 px-3 py-1 bg-[#1C242C] rounded-full text-[11px] font-semibold text-[#A3E635]">
            <span class="w-2 h-2 rounded-full bg-[#A3E635] animate-pulse"></span>
            READY
          </div>
        </div>

        <div class="relative bg-[#080B0D] border border-gray-900 rounded-2xl overflow-hidden">
          <div class="absolute top-3 left-4 flex items-center gap-2 text-[10px] font-bold tracking-wider text-gray-500 uppercase z-10">
            <span [ngClass]="{'text-[#A3E635]': isShieldEngaged}">📡</span> 
            Live Dual-Wave Spectrogram
          </div>
          <canvas #spectrogramCanvas width="400" height="140" class="w-full h-36 block bg-gradient-to-b from-transparent to-[#0d1217]"></canvas>
        </div>

        <button
          (click)="toggleShield()"
          [ngClass]="isShieldEngaged 
            ? 'bg-[#A3E635] text-[#0B0F12] border-[#A3E635] shadow-[0_0_25px_rgba(163,230,53,0.35)] font-black' 
            : 'bg-transparent text-gray-400 border-gray-800 hover:border-gray-700 hover:text-white'"
          class="w-full py-5 rounded-2xl font-bold tracking-wide transition-all duration-300 flex flex-col items-center justify-center gap-1 border uppercase text-sm"
        >
          <span [ngClass]="{'animate-bounce': isShieldEngaged}">🛡️</span>
          <span>{{ isShieldEngaged ? 'Shield Engaged' : 'Engage Shield' }}</span>
        </button>

        <div class="bg-[#1C242C] rounded-2xl p-4 border border-gray-800/50 flex flex-col gap-3">
          <div class="flex items-center justify-between">
            <div>
              <span class="text-[10px] text-gray-500 block uppercase font-bold tracking-wider">Media Controller</span>
              <span class="text-xs text-gray-300 font-medium">Active Noise Cancellation Profile</span>
            </div>
            <span class="text-gray-500 text-xs">🔊</span>
          </div>
          
          <div class="flex items-center gap-2 mt-1">
            <button 
              (click)="togglePlay()"
              [ngClass]="isPlaying ? 'bg-[#A3E635] text-[#0B0F12]' : 'bg-[#25303A] text-white hover:bg-[#2e3c49]'"
              class="p-2.5 rounded-xl transition-all"
            >
              <span>{{ isPlaying ? '⏸️' : '▶️' }}</span> </button>
            <button class="p-2.5 bg-[#25303A] text-gray-400 hover:text-white rounded-xl transition-all">
              ⏭️
            </button>
            <div class="h-1 bg-gray-800 flex-1 rounded-full overflow-hidden ml-2">
              <div 
                [ngClass]="isPlaying ? 'w-2/3 bg-[#A3E635]' : 'w-1/3 bg-gray-400'" 
                class="h-full rounded-full transition-all duration-500"
              ></div>
            </div>
          </div>
        </div>

        <div class="space-y-2">
          <div class="flex justify-between text-xs font-semibold px-1">
            <span class="text-gray-400 uppercase tracking-wider text-[11px]">Shield Strength</span>
            <span [ngClass]="isShieldEngaged ? 'text-[#A3E635] font-bold' : 'text-gray-400'">{{ shieldStrength }}%</span>
          </div>
          <div class="h-3 bg-[#0B0F12] border border-gray-800 rounded-full p-[2px]">
            <div 
              [style.width.%]="shieldStrength"
              [ngClass]="isShieldEngaged ? 'bg-[#A3E635] shadow-[0_0_8px_rgba(163,230,53,0.5)]' : 'bg-gray-600'"
              class="h-full rounded-full transition-all duration-500 ease-out"
            ></div>
          </div>
        </div>

        <div class="pt-2 border-t border-gray-800/60">
          <span class="text-[10px] text-gray-500 block uppercase font-bold tracking-wider mb-2.5 px-1 flex items-center gap-1">
            🎛️ Quirk Switches
          </span>
          <div class="grid grid-cols-2 gap-3">
            <button
              *ngFor="let quirk of quirks"
              (click)="toggleQuirk(quirk.id)"
              [ngClass]="quirk.active 
                ? 'border-[#A3E635]/40 bg-[#A3E635]/5 text-[#A3E635]' 
                : 'border-gray-800 bg-transparent text-gray-500 hover:border-gray-700 hover:text-gray-300'"
              class="py-3 px-4 rounded-xl border text-xs font-medium transition-all text-left flex justify-between items-center"
            >
              <span>{{ quirk.label }}</span>
              <span [ngClass]="quirk.active ? 'bg-[#A3E635]' : 'bg-transparent border border-gray-700'" class="w-1.5 h-1.5 rounded-full"></span>
            </button>
          </div>
        </div>

      </div>
    </div>
  `
})
export class AppComponent implements OnInit, OnDestroy {
  // Finding our canvas viewscreen so we can draw laser waves on it
  @ViewChild('spectrogramCanvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;
  
  // The Control Panel's Memory (State)
  isShieldEngaged = false; // Is the protective shield up? (Starts at No)
  isPlaying = false;       // Is the music playing? (Starts at No)
  shieldStrength = 85;     // Shield is at 85% health!
  
  // The inventory of extra quirk buttons
  quirks: QuirkSwitch[] = [
    { id: 'loose-dash', label: 'Loose Dash', active: true },
    { id: 'low-gear', label: 'Low Gear Chiver', active: false },
  ];

  private animationFrameId!: number; // This remembers the magic flipbook timer for animations
  private phase = 0;                  // Keeps track of how far the laser wave has wiggled

  // "Wake up!" - This runs immediately when our control panel is turned on
  ngOnInit() {
    this.initCanvasAnimation(); // Start drawing the wiggle lines!
  }

  // "Go to sleep" - Runs when the control panel is turned off completely
  ngOnDestroy() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId); // Stop the animation so it doesn't waste battery power
    }
  }

  // Flippers/Togglers: Flipping a switch upside down when clicked
  toggleShield() {
    this.isShieldEngaged = !this.isShieldEngaged; // If true becomes false, if false becomes true!
  }

  togglePlay() {
    this.isPlaying = !this.isPlaying; // Turns music on/off
  }

  toggleQuirk(id: string) {
    // Looks through the quirk buttons, finds the one you clicked, and flips its active light!
    this.quirks = this.quirks.map(q => q.id === id ? { ...q, active: !q.active } : q);
  }

  // THE ARTIST: This handles drawing the wavy lines on our viewscreen canvas
  private initCanvasAnimation() {
    const canvas = this.canvasRef.nativeElement;
    const ctx = canvas.getContext('2d'); // Grabbing our paintbrushes
    if (!ctx) return;

    // This loop runs super fast, like a cartoon flipbook!
    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height); // Erase the old drawing
      
      // 1. DRAW THE GRID LINES: Making it look like a radar blueprint graph
      ctx.strokeStyle = 'rgba(163, 230, 53, 0.05)'; // Very faint green paint
      ctx.lineWidth = 1;
      for (let i = 0; i < canvas.width; i += 20) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, canvas.height); ctx.stroke(); // Vertical lines
      }
      for (let i = 0; i < canvas.height; i += 20) {
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(canvas.width, i); ctx.stroke(); // Horizontal lines
      }

      // 2. DRAW MAIN LASER WAVE (The thick wave in the middle)
      // If shield is active, make it bright green and glow! Otherwise, dull gray.
      ctx.strokeStyle = this.isShieldEngaged ? '#A3E635' : '#4B5563';
      ctx.lineWidth = 2;
      ctx.shadowBlur = this.isShieldEngaged ? 10 : 0; // Glowing glow effect!
      ctx.shadowColor = '#A3E635';
      
      ctx.beginPath();
      for (let x = 0; x < canvas.width; x++) {
        // If shield is ON, make the waves super tall (amplitude = 25). If OFF, tiny ripples (amplitude = 5).
        const amp = this.isShieldEngaged ? 25 : 5;
        // Fancy math to calculate a pretty, curvy snake wiggle line
        const y = canvas.height / 2 + Math.sin(x * 0.02 + this.phase) * amp + Math.cos(x * 0.01 + this.phase * 0.5) * (amp * 0.3);
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // 3. DRAW SECONDARY LASER WAVE (A faint background wave moving backward)
      ctx.strokeStyle = this.isShieldEngaged ? 'rgba(163, 230, 53, 0.4)' : '#374151';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let x = 0; x < canvas.width; x++) {
        const amp = this.isShieldEngaged ? 15 : 2;
        const y = canvas.height / 2 + Math.sin(x * 0.03 - this.phase) * amp; // Notice the minus sign makes it slide backward!
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Clean up the glow paintbrush so it doesn't mess up anything else
      ctx.shadowBlur = 0;
      
      // Move the wave slightly forward so it looks animated next frame.
      // It zooms fast if the shield is active, and creeps slow if inactive!
      this.phase += this.isShieldEngaged ? 0.08 : 0.01;
      
      // Tell the browser: "Quickly do this whole drawing process again on the next heartbeat!"
      this.animationFrameId = requestAnimationFrame(render);
    };

    render(); // Fire up the drawing loop for the first time!
  }
}

// Spark up the engine! Boots up the application with our custom dashboard component.
bootstrapApplication(AppComponent, appConfig).catch((err) => console.error(err));
