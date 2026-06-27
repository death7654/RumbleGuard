import { Component, ElementRef, OnDestroy, OnInit, ViewChild } from "@angular/core";
import { CommonModule } from "@angular/common";
import { Subscription } from "rxjs";
import { invoke } from '@tauri-apps/api/core';
import { CabinAudioService } from "../audio";

@Component({
  selector: "app-cabincomponent",
  standalone: true,
  imports: [CommonModule],
  templateUrl: "./cabincomponent.html",
  styleUrl: "./cabincomponent.css",
})
export class CabinComponent implements OnInit, OnDestroy {
  @ViewChild("audioEl", { static: false }) audioRef!: ElementRef<HTMLAudioElement>;

  dominantHz = 0;
  noiseDb = -200;
  activeBands: any[] = [];
  isShieldActive = false;

  private sub: Subscription | null = null;
  private isConnected = false;

  constructor(private cabin: CabinAudioService) {}

  ngOnInit(): void {
    // Subscribe to real-time WebAudio/Rust event stream values
    this.sub = this.cabin.dspFrame$.subscribe({
      next: (frame) => {
        if (frame) {
          this.dominantHz = frame.dominant_hz;
          this.noiseDb = frame.noise_db;
          this.activeBands = frame.bands || [];
          
          if (this.isShieldActive && frame.bands) {
            this.cabin.updateLiveMultipliers(frame.bands);
          }
        }
      },
      error: (err) => console.error("DSP Frame Subscription Error:", err),
    });
  }

  onStart(): void {
    try {
      const audioElement = this.audioRef.nativeElement;

      // Only connect this element to the WebAudio framework instance once
      if (!this.isConnected) {
        this.cabin.connectAudioElement(audioElement);
        this.isConnected = true;
      }

      const nativeContext = (this.cabin as any).ctx as AudioContext;
      if (nativeContext && nativeContext.state === 'suspended') {
        nativeContext.resume().catch(() => {});
      }

      audioElement.play().catch((err) =>
        console.warn("Interactivity restriction blocked audio play:", err)
      );

      this.isShieldActive = true;
      
      // Wire up backend capturing rules safely
      this.cabin.startListening();
      invoke('start_recording').catch(err => console.error("Failed to start capturing:", err));
    } catch (e) {
      console.error("Initialization loop fail:", e);
    }
  }

  onStop(): void {
    this.isShieldActive = false;
    try {
      const audioElement = this.audioRef.nativeElement;
      audioElement.pause();
      audioElement.currentTime = 0;
    } catch (e) {}

    invoke('stop_recording').catch(() => {});
    
    this.dominantHz = 0;
    this.noiseDb = -200;
    this.activeBands.forEach(b => b.gain_db = 0);
  }

  ngOnDestroy(): void {
    if (this.sub) {
      this.sub.unsubscribe();
    }
    if (this.isShieldActive) {
      invoke('stop_recording').catch(() => {});
    }
  }
}