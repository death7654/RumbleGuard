import { Component } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

@Component({
  selector: 'app-testing-button',
  imports: [],
  templateUrl: './testing-button.html',
  styleUrl: './testing-button.css',
})
export class TestingButton {
  outputsss = 'before'

test_backend() {
  console.log("Example");
  invoke<string>("testing").then((text) => {
      this.outputsss = text;
    });
}
}
