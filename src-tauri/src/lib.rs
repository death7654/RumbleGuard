mod dsp;
use dsp::run_dsp_loop;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

// ── SendStream wrapper ────────────────────────────────────────────────────────
// cpal::Stream is !Send on Windows (WASAPI) due to NotSendSyncAcrossAllPlatforms.
// This is a blanket restriction: the stream never actually crosses thread
// boundaries in our code — it lives inside a Mutex for its entire lifetime.
// Wrapping it and asserting Send is sound under that invariant.
struct AudioStream(cpal::Stream);

// SAFETY: AudioStream is only accessed through a Mutex<Option<AudioStream>>.
// We never move it out of the mutex and hand it to another thread.
unsafe impl Send for AudioStream {}

// ── State ─────────────────────────────────────────────────────────────────────
pub struct AudioState {
    stream: std::sync::Mutex<Option<AudioStream>>,
    sample_tx: std::sync::Mutex<Option<std::sync::mpsc::Sender<Vec<f32>>>>,
}

impl AudioState {
    fn new() -> Self {
        Self {
            stream: std::sync::Mutex::new(None),
            sample_tx: std::sync::Mutex::new(None),
        }
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────
#[tauri::command]
fn start_recording(
    app: tauri::AppHandle,
    state: tauri::State<'_, AudioState>,
) -> Result<(), String> {
    let mut stream_guard = state.stream.lock().map_err(|e| e.to_string())?;

    if stream_guard.is_some() {
        return Err("Already recording".into());
    }

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("No input device available")?;

    let supported_config = device
        .default_input_config()
        .map_err(|e| e.to_string())?;

    let sample_rate = supported_config.sample_rate().0;

    let (tx, rx) = std::sync::mpsc::channel::<Vec<f32>>();
    *state.sample_tx.lock().map_err(|e| e.to_string())? = Some(tx.clone());

    std::thread::spawn(move || {
        run_dsp_loop(rx, app, sample_rate);
    });

    let config = supported_config.into();
    let stream = device
        .build_input_stream(
            &config,
            move |data: &[f32], _| {
                let _ = tx.send(data.to_vec());
            },
            |err| eprintln!("Stream error: {err}"),
            None,
        )
        .map_err(|e| e.to_string())?;

    stream.play().map_err(|e| e.to_string())?;

    // Wrap in AudioStream before storing — this is where we enter the unsafe contract
    *stream_guard = Some(AudioStream(stream));

    Ok(())
}

#[tauri::command]
fn stop_recording(state: tauri::State<'_, AudioState>) -> Result<(), String> {
    *state.stream.lock().map_err(|e| e.to_string())? = None; // drops stream, stops cpal
    *state.sample_tx.lock().map_err(|e| e.to_string())? = None; // closes channel, exits DSP loop
    Ok(())
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn testing() -> String {
    println!("Called from front");
    "Hello from rust".to_string()
}

#[tauri::command]
fn check_mic_permission() -> bool {
    true
}

// ── Entry point ───────────────────────────────────────────────────────────────
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AudioState::new()) // ← was missing; without this, State<AudioState> panics at runtime
        .plugin(tauri_plugin_websocket::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            testing,
            start_recording,
            stop_recording,
            check_mic_permission
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}