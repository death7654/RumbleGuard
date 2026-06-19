// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod dsp;
use dsp::run_dsp_loop;

use tauri::Emitter;
use cpal::traits::HostTrait;
use tauri::State;

#[tauri::command]
fn start_recording(
    app: tauri::AppHandle,          // Tauri injects this automatically
    state: State<'_, AudioState>,
) -> Result<(), String> {
    let mut stream_guard = state.stream.lock().unwrap();
    if stream_guard.is_some() {
        return Err("Already recording".into());
    }

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("No input device")?;

    let supported_config = device
        .default_input_config()
        .map_err(|e| e.to_string())?;

    let sample_rate = supported_config.sample_rate().0;

    let (tx, rx) = std::sync::mpsc::channel::<Vec<f32>>();
    *state.sample_tx.lock().unwrap() = Some(tx.clone());

    // Spawn the DSP loop — this is the thread that does FFT and emits events
    std::thread::spawn(move || {
        run_dsp_loop(rx, app, sample_rate);
    });

    let config = supported_config.into();
    let stream = device
        .build_input_stream(
            &config,
            move |data: &[f32], _| {
                // cpal's thread: keep this fast, just forward samples
                let _ = tx.send(data.to_vec());
            },
            |err| eprintln!("Stream error: {err}"),
            None,
        )
        .map_err(|e| e.to_string())?;

    stream.play().map_err(|e| e.to_string())?;
    *stream_guard = Some(stream);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        //.plugin(tauri_plugin_biometric::init())
        .plugin(tauri_plugin_websocket::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, testing, start_recording])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
