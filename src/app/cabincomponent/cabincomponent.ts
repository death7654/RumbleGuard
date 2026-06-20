import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
} from "@angular/core";
import { CommonModule } from "@angular/common"; // Fallback support if using standard directives
import { CabinAudioService } from "../audio";
import { Subscription } from "rxjs";

@Component({
  selector: "app-cabincomponent",
  standalone: true,
  imports: [CommonModule], // Included to make template parsing complete
  templateUrl: "./cabincomponent.html",
  styleUrl: "./cabincomponent.css",
})
export class CabinComponent implements OnInit, OnDestroy {
  @ViewChild("audioEl", { static: false })
  audioRef!: ElementRef<HTMLAudioElement>;

  dominantHz = 0;
  noiseDb = 0;
  activeBands: { frequency: number; gain_db: number }[] = [];

  private sub: Subscription | null = null;

  constructor(private cabin: CabinAudioService) {}

  ngOnInit(): void {
    // Subscribe to the Rust-backed DSP data broadcasted via Tauri events
    this.sub = this.cabin.dspFrame$.subscribe({
      next: (frame) => {
        this.dominantHz = frame.dominant_hz;
        this.noiseDb = frame.noise_db;
        this.activeBands = frame.bands;
      },
      error: (err) => console.error("DSP Frame Subscription Error:", err),
    });
  }
  onStart(): void {
    const audioElement = this.audioRef.nativeElement;
    this.cabin.connectAudioElement(audioElement);

    audioElement
      .play()
      .catch((err) =>
        console.warn("Interactivity restriction blocked audio play:", err),
      );
    this.cabin.ensureMicPermission();

    this.cabin.startListening();
    this.cabin.startRecording();
  }

  async onStop(): Promise<void> {
    if (this.audioRef?.nativeElement) {
      this.audioRef.nativeElement.pause();
    }
    await this.cabin.destroy();
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.cabin.destroy();
  }
}
