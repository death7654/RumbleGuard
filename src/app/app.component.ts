import { Component, ElementRef, OnInit, OnDestroy, ViewChild, AfterViewInit, HostListener, ChangeDetectorRef } from '@angular/core';
import { CabinAudioService } from "./audio"; 
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { invoke } from '@tauri-apps/api/core';

/**
 * Structural definition for application audio tracks.
 * Accommodates both pre-compiled assets and dynamically generated local user selections.
 */
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
  // --- ViewChild DOM Pointers ---
  // Connects directly to the HTML5 Canvas instance for real-time spectrogram renderings
  @ViewChild('spectrogramCanvas', { static: false }) canvasRef!: ElementRef<HTMLCanvasElement>;
  // Handles parent bounding block rules to dynamically maintain responsive fluid layouts
  @ViewChild('canvasContainer', { static: false }) containerRef!: ElementRef<HTMLDivElement>;
  // Targets the core HTML5 Audio rendering element responsible for piping active audio data
  @ViewChild('testAudioPlayer', { static: false }) audioPlayerRef!: ElementRef<HTMLAudioElement>;
  
  // --- Core Reactive App State Properties ---
  currentTab: 'home' | 'music' = 'home';
  isShieldEngaged = false;     // Tracks whether ambient microphone filtering layers are listening
  isCalibrating = false;        // Dictates if backend DSP processes are establishing base noise levels
  isPlaying = false;            // Current audio playback toggle state tracking flag
  dominantHertz = 0;            // The current primary background frequency node calculated by Rust
  noiseDb = -200;               // Total measured environmental noise intensity measured in decibels
  
  //  Master calibration scaler transmitted across Tauri Inter-Process Communication (IPC)
  shieldStrength = 1.0; 

  // --- Analytical DSP Matrices Arrays ---
  private currentBands: any[] = [];    // Raw, high-frequency active equalizer filter bands from the service
  private smoothedGains: number[] = [];  // Historic mathematical arrays used to stabilize rendering jitters
  throttledBands: any[] = [];           // Human-readable, performance-throttled array mapped directly to UI loops

  // Hardcoded reference tracking profiles compiled in app assets directory
  trackList: AudioTrack[] = [
    { id: 't1', title: 'Hooligang Reference Bass Mix', fileName: 'hooligang.mp3', duration: '3:42', type: 'Cabin Profile' },
    { id: 't2', title: 'White Noise Isolation Sweep', fileName: 'whitenoise.mp3', duration: '5:00', type: 'Static Masking' },
    { id: 't3', title: 'Low Frequency Pink Noise Frame', fileName: 'pinknoise.mp3', duration: '4:15', type: 'Vibration Counter' }
  ];
  selectedTrack: AudioTrack = this.trackList[0];

  // --- Component Lifecycle Garbage-Collection Objects ---
  private dspSubscription: Subscription | null = null; // Stores continuous stream events emitted by Cabin service
  private animationFrameId!: number;                   // Tracks active requestAnimationFrame IDs to clear draw loops
  private uiIntervalId: any = null;                    // Interval holder managing throttled data updates
  private audioObjectUrl: string | null = null;        // Local hardware pointer address parsing active tracks

  constructor(private cabin: CabinAudioService, private cdr: ChangeDetectorRef) {
    // Establishes fallback frequencies to construct standard indicator structures before microphone initialization
    const defaultFreqs = [60, 150, 240, 350, 480];
    this.throttledBands = defaultFreqs.map(f => ({ frequency: f, gain_db: 0, q: 1.5 }));
  }

  /**
   * INITIALIZATION LIFECYCLE:
   * Sets up real-time audio analysis data pipelines.
   */
  ngOnInit() {
    // Subscribes to incoming audio analysis matrices parsed by the core Cabin audio engine
    this.dspSubscription = this.cabin.dspFrame$.subscribe({
      next: (frame: any) => {
        if (frame) {
          // Unpacks frequency characteristics from calculations processed on backend threads
          this.dominantHertz = frame.dominant_hz;
          this.noiseDb = frame.noise_db;
          this.isCalibrating = !!frame.calibrating;
          this.currentBands = frame.bands || [];

          // Feeds environmental noise offsets back into Web Audio API Peaking Filters
          if (this.isShieldEngaged && !this.isCalibrating) {
            this.cabin.updateLiveMultipliers(this.currentBands);
          }
        }
      },
      error: (err) => console.error("DSP Frame Subscription Error:", err)
    });

    // Throttled UI Display Loop: Captures high-frequency streams and updates the template
    // every 400ms to maintain application responsiveness and prevent browser strain.
    this.uiIntervalId = setInterval(() => {
      if (this.isShieldEngaged && !this.isCalibrating && this.currentBands.length > 0) {
        this.throttledBands = JSON.parse(JSON.stringify(this.currentBands));
        this.cdr.detectChanges(); // Manually requests DOM checks to maintain low latency updates
      }
    }, 400);
  }

  /**
   * DOM READY LIFECYCLE:
   * Fires once canvas and audio tags are mapped to the DOM.
   */
  ngAfterViewInit() {
    this.resizeCanvasToContainer(); // Corrects rendering scales matching initial layouts
    this.initCanvasLoop();          // Spawns recursive 60 FPS spectrogram graph loop
    this.loadTrackAsset(this.selectedTrack); // Pre-loads application initialization audio profile
  }

  /**
   * TEARDOWN LIFECYCLE:
   * Prevents system memory leaks when navigating away or destroying components.
   */
  ngOnDestroy() {
    if (this.dspSubscription) this.dspSubscription.unsubscribe(); // Closes reactive observable tracking
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId); // Terminates graphic loop cycles
    if (this.uiIntervalId) clearInterval(this.uiIntervalId); // Destroys UI throttling interval loops
    this.clearAudioObjectUrl(); // Discards active local media resource bindings from RAM
  }

  /**
   * Fluid layout watcher keeping HTML5 canvas grid pixels in alignment with window shifts
   */
  @HostListener('window:resize')
  onWindowResize() {
    this.resizeCanvasToContainer();
  }

  /**
   * TAURI RUST BACKEND SYNC:
   * Translates front-end filter parameters down across the Tauri IPC channel.
   * Fires whenever the user alters the shield configuration slider.
   */
  onStrengthChange() {
    invoke('set_shield_strength', { strength: this.shieldStrength })
      .catch(err => console.error("Tauri IPC Invocation Error:", err));
  }

  /**
   * Standard Local Asset Loader:
   * Fetches pre-compiled track assets inside the frontend build directory, convert them to raw Blobs,
   * and pipes the resulting stream link to the audio context.
   */
  async loadTrackAsset(track: AudioTrack) {
    try {
      this.clearAudioObjectUrl(); // Drops previous system pointers
      const assetPath = `assets/${track.fileName}`;
      
      const response = await fetch(assetPath);
      const blob = await response.blob();
      
      this.audioObjectUrl = URL.createObjectURL(blob);
      const audio = this.audioPlayerRef.nativeElement;
      
      audio.src = this.audioObjectUrl;
      audio.load();
      
      this.cabin.connectAudioElement(audio); // Ties audio channel into the analysis node pipeline
      if (this.isPlaying) {
        audio.play().catch(() => this.isPlaying = false);
      }
    } catch (err) {
      console.error("Android Target Asset Loader Failure:", err);
    }
  }

  /**
   * DYNAMIC MUSIC PICKER SYSTEM:
   * Processes local file uploads on the user's hardware.
   * Bypasses standard server networks by creating an encrypted, temporary local system resource path pointer.
   */
  async onLocalFileSelected(event: Event) {
    const target = event.target as HTMLInputElement;
    if (!target.files || target.files.length === 0) return;

    const file = target.files[0];
    this.clearAudioObjectUrl(); // Cleans up previous selections to keep RAM footprint low

    // Constructs a custom track metadata footprint mimicking your hardcoded structures
    const localTrack: AudioTrack = {
      id: `local-${Date.now()}`,
      title: file.name.replace(/\.[^/.]+$/, ""), // Cleans file suffix strings (e.g. '.mp3')
      fileName: file.name,
      duration: '--:--', // Dynamically updated by native element metadata configurations later
      type: 'Local File'
    };

    this.selectedTrack = localTrack;

    try {
      // Maps a direct hardware-to-browser stream memory pointer (blob url)
      this.audioObjectUrl = URL.createObjectURL(file);
      const audio = this.audioPlayerRef.nativeElement;

      audio.src = this.audioObjectUrl;
      audio.load(); // Forces HTML5 audio engine reload routines

      // Connects the imported track directly into your canvas rendering system 
      // and frequency adjustment filters without needing to edit the audio service.
      this.cabin.connectAudioElement(audio);
      
      if (this.isPlaying) {
        audio.play().catch(() => this.isPlaying = false);
      }

      this.cdr.detectChanges(); // Enforces fast UI redraws to reveal newly selected track properties
    } catch (err) {
      console.error("Local Audio Picker Processing System Failure:", err);
    }
  }

  /**
   * Iterates track parameters when standard pre-defined track selections get clicked
   */
  selectTrack(track: AudioTrack) {
    this.selectedTrack = track;
    this.loadTrackAsset(track);
    this.cdr.detectChanges();
  }

  /**
   * Memory Cleanup Routine:
   * Discards active system blob paths from RAM. Prevents audio data leaks from crashing the application.
   */
  private clearAudioObjectUrl() {
    if (this.audioObjectUrl) {
      URL.revokeObjectURL(this.audioObjectUrl);
      this.audioObjectUrl = null;
    }
  }

  /**
   * Handles user playback interactions (Play/Pause states)
   */
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

  /**
   * Activates/Deactivates Environmental Noise Isolation:
   * Integrates the Web Audio browser pipeline with the Rust Tauri recorder thread.
   */
  async toggleShield() {
    this.isShieldEngaged = !this.isShieldEngaged;
    
    if (this.isShieldEngaged) {
      try {
        await this.cabin.startListening(); // Activates frontend audio context listener nodes
        await invoke('start_recording');    // Triggers local OS recording drivers through Rust thread pools
      } catch (err) {
        console.error("Shield activation failure:", err);
        this.isShieldEngaged = false;
      }
    } else {
      try {
        await invoke('stop_recording'); // Safely parks Rust audio recording loop operations
      } catch (err) {}
      // Normalizes active tracker parameters back down to default baseline parameters
      this.dominantHertz = 0;
      this.noiseDb = -200;
      this.isCalibrating = false;
      this.currentBands = [];
      this.throttledBands.forEach(b => b.gain_db = 0);
    }
    this.cdr.detectChanges();
  }

  /**
   * Computes canvas display scaling matrices matching outer container elements
   */
  private resizeCanvasToContainer() {
    if (this.canvasRef && this.containerRef) {
      const canvas = this.canvasRef.nativeElement;
      const container = this.containerRef.nativeElement;
      canvas.width = container.clientWidth || 400;
      canvas.height = container.clientHeight || 140;
    }
  }

  /**
   * HIGH PERFORMANCE GRAPHICS SYSTEM:
   * Sets up a recursive drawing process rendering audio changes smoothly at a 60 FPS refresh rate.
   */
  private initCanvasLoop() {
    const render = () => {
      this.animationFrameId = requestAnimationFrame(render); // Registers subsequent display cycle updates
      if (!this.canvasRef) return;

      const canvas = this.canvasRef.nativeElement;
      const ctx = canvas.getContext('2d'); 
      if (!ctx) return;

      // Cleans previous graphic frames to handle fresh calculations
      ctx.clearRect(0, 0, canvas.width, canvas.height); 
      
      // --- Background Matrix Grid Rendering Block ---
      ctx.strokeStyle = 'rgba(25, 135, 84, 0.12)'; 
      ctx.lineWidth = 1;
      for (let i = 0; i < canvas.width; i += 30) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, canvas.height); ctx.stroke(); 
      }
      for (let i = 0; i < canvas.height; i += 20) {
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(canvas.width, i); ctx.stroke(); 
      }

      // --- Active Spectrogram Visualizer Logic ---
      if (this.isShieldEngaged && !this.isCalibrating && this.currentBands.length > 0) {
        const totalPoints = this.currentBands.length;
        // Initializes historic smoothing vectors matching active filter ranges
        if (this.smoothedGains.length !== totalPoints) {
          this.smoothedGains = new Array(totalPoints).fill(0);
        }

        const minFreq = this.currentBands[0].frequency;
        const maxFreq = this.currentBands[totalPoints - 1].frequency;
        const freqRange = maxFreq - minFreq || 1; 

        const points: {x: number, y: number}[] = [];
        const timeFactor = Date.now() * 0.05; // Drives continuous waving motions

        // Maps raw numerical frequency data directly to coordinate positions on the canvas grid
        for (let i = 0; i < totalPoints; i++) {
          const band = this.currentBands[i];
          const x = ((band.frequency - minFreq) / freqRange) * canvas.width;
          let normalizedGain = (band.gain_db) / 6.0; // Standardizes peak vector amplitudes
          
          // Amplifies wave movements if close to the primary background noise frequency
          const deltaHz = Math.abs(band.frequency - this.dominantHertz);
          if (deltaHz < 100 && this.dominantHertz > 0) {
            const proximityFactor = 1.0 - (deltaHz / 100);
            normalizedGain += Math.sin(timeFactor + i) * 0.15 * proximityFactor;
          }
          
          // Low-pass mathematical modifier preventing jagged vector spikes during rapid audio transitions
          this.smoothedGains[i] += (normalizedGain - this.smoothedGains[i]) * 0.25;
          const usableHeight = canvas.height - 40;
          const y = canvas.height - 20 - (Math.max(0, Math.min(this.smoothedGains[i], 1.0)) * usableHeight);
          
          points.push({ x, y });
        }

        // Fills the bottom area of the audio wave graph with a semi-transparent color tint
        ctx.fillStyle = 'rgba(25, 135, 84, 0.06)';
        ctx.beginPath(); ctx.moveTo(0, canvas.height);
        points.forEach(p => ctx.lineTo(p.x, p.y));
        ctx.lineTo(canvas.width, canvas.height); ctx.closePath(); ctx.fill();

        // Draws the main green outline path representing active equalizations
        ctx.strokeStyle = '#198754'; ctx.lineWidth = 3; ctx.lineJoin = 'round';
        ctx.shadowBlur = 10; ctx.shadowColor = '#198754'; // Generates glow path effects
        ctx.beginPath();
        points.forEach((p, idx) => idx === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
        ctx.stroke(); ctx.shadowBlur = 0; // Drops active display lighting parameters to preserve memory
      } else {
        // Fallback Flat Engine Baseline: Renders a static horizontal bar when monitoring tools are offline
        ctx.strokeStyle = '#2c4c38'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, canvas.height / 2); ctx.lineTo(canvas.width, canvas.height / 2); ctx.stroke();
      }
    };
    render(); 
  }
}
