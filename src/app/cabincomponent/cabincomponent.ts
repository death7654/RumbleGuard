import { Component, ElementRef, OnDestroy, ViewChild } from '@angular/core';
import { CabinAudioService } from '../audio';

@Component({
  selector: 'app-cabincomponent',
  imports: [],
  templateUrl: './cabincomponent.html',
  styleUrl: './cabincomponent.css',
})

export class Cabincomponent implements OnDestroy {
  @ViewChild('audioEl') audioRef!: ElementRef<HTMLAudioElement>;

  constructor(private cabin: CabinAudioService) {}

  // Wire to a button tap — AudioContext requires a user gesture on Android
  async onStartTap(): Promise<void> {
    const granted = await this.cabin.ensureMicPermission();
    if (!granted) {
      // show UI telling user why you need the mic
      return;
    }

    this.cabin.connectAudioElement(this.audioRef.nativeElement);
    await this.cabin.startListening();   // subscribe to dsp-frame events
    await this.cabin.startRecording();   // tell Rust to open the mic
  }

  async onStopTap(): Promise<void> {
    await this.cabin.destroy();
  }

  ngOnDestroy(): void {
    this.cabin.destroy();
  }
}
