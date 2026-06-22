mod dsp;
use dsp::run_dsp_loop;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

struct AudioStream(cpal::Stream);
unsafe impl Send for AudioStream {}

pub struct AudioState {
    stream: std::sync::Mutex<Option<AudioStream>>,
    sample_tx: std::sync::Mutex<Option<std::sync::mpsc::Sender<Vec<f32>>>>,
    pub shield_strength: Arc<AtomicU32>,
}

impl AudioState {
    fn new() -> Self {
        Self {
            stream: std::sync::Mutex::new(None),
            sample_tx: std::sync::Mutex::new(None),
            // Defaulting initialization parameters directly to 1.0 (100% full scale)
            shield_strength: Arc::new(AtomicU32::new(1.0_f32.to_bits())),
        }
    }
}

// Called from MainActivity.kt during onCreate — before any IPC can fire.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_com_audiobytes_rumbleguard_MainActivity_initNdkContext(
    mut env: jni::JNIEnv,
    activity: jni::objects::JObject,
) {
    let vm = env.get_java_vm().expect("failed to get JavaVM");
    unsafe {
        ndk_context::initialize_android_context(
            vm.get_java_vm_pointer() as *mut std::ffi::c_void,
            activity.as_raw() as *mut std::ffi::c_void,
        );
    }
    println!("ndk-context initialized for cpal");
}

#[tauri::command]
fn set_shield_strength(
    strength: f32, 
    state: tauri::State<'_, AudioState>
) -> Result<(), String> {
    state.shield_strength.store(strength.to_bits(), Ordering::Relaxed);
    Ok(())
}

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
    let device = host.default_input_device().ok_or("No input device available")?;
    let supported_config = device.default_input_config().map_err(|e| e.to_string())?;
    let sample_rate = supported_config.sample_rate().0;
    let sample_format = supported_config.sample_format();

    let (tx, rx) = std::sync::mpsc::channel::<Vec<f32>>();
    *state.sample_tx.lock().map_err(|e| e.to_string())? = Some(tx.clone());

    // Pass the atomic shield modifier down into our active thread execution loop
    let strength_clone = Arc::clone(&state.shield_strength);
    std::thread::spawn(move || run_dsp_loop(rx, app, sample_rate, strength_clone));

    let config = supported_config.into();
    let stream = match sample_format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config,
            move |data: &[f32], _| { let _ = tx.send(data.to_vec()); },
            |err| eprintln!("Stream error: {err}"),
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config,
            move |data: &[i16], _| {
                let f32_data: Vec<f32> = data.iter()
                    .map(|&s| s as f32 / i16::MAX as f32)
                    .collect();
                let _ = tx.send(f32_data);
            },
            |err| eprintln!("Stream error: {err}"),
            None,
        ),
        _ => return Err(format!("Unsupported audio format: {:?}", sample_format)),
    }.map_err(|e| e.to_string())?;

    stream.play().map_err(|e| e.to_string())?;
    *stream_guard = Some(AudioStream(stream));
    Ok(())
}

#[tauri::command]
fn stop_recording(state: tauri::State<'_, AudioState>) -> Result<(), String> {
    *state.stream.lock().map_err(|e| e.to_string())? = None;
    *state.sample_tx.lock().map_err(|e| e.to_string())? = None;
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
fn check_mic_permission() -> bool { true }

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AudioState::new())
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
            check_mic_permission,
            set_shield_strength 
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}