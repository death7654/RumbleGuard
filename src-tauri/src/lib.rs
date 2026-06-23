mod dsp;
use dsp::run_dsp_loop;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use ringbuf::{SharedRb, storage::Heap, traits::*};

struct AudioStream(cpal::Stream);
unsafe impl Send for AudioStream {}

type AudioConsumer = ringbuf::wrap::CachingCons<std::sync::Arc<ringbuf::SharedRb<ringbuf::storage::Heap<f32>>>>;

pub struct AudioState {
    stream: std::sync::Mutex<Option<AudioStream>>,
    audio_consumer: std::sync::Mutex<Option<AudioConsumer>>,
    pub shield_strength: Arc<AtomicU32>,
}

impl AudioState {
    fn new() -> Self {
        Self {
            stream: std::sync::Mutex::new(None),
            audio_consumer: std::sync::Mutex::new(None),
            shield_strength: Arc::new(AtomicU32::new(1.0_f32.to_bits())),
        }
    }
}

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
fn set_shield_strength(strength: f32, state: tauri::State<'_, AudioState>) -> Result<(), String> {
    state.shield_strength.store(strength.to_bits(), Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn start_recording(app: tauri::AppHandle, state: tauri::State<'_, AudioState>) -> Result<(), String> {
    let mut stream_guard = state.stream.lock().map_err(|e| e.to_string())?;
    if stream_guard.is_some() {
        return Err("Already recording".into());
    }

    let host = cpal::default_host();
    let device = host.default_input_device().ok_or("No input device available")?;
    let supported_config = device.default_input_config().map_err(|e| e.to_string())?;
    let sample_rate = supported_config.sample_rate().0;
    let sample_format = supported_config.sample_format();

    // Allocate a large shared lock-free storage map to protect against scheduler hiccups
    let rb = Arc::new(SharedRb::<Heap<f32>>::new(32768));
    let (mut producer, consumer) = rb.split();

    let strength_clone = Arc::clone(&state.shield_strength);
    
    // Spawn your real-time processing worker
    std::thread::spawn(move || {
        run_dsp_loop(consumer, app, sample_rate, strength_clone);
    });

    let config = supported_config.into();
    let stream = match sample_format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config,
            move |data: &[f32], _| { 
                let _ = producer.push_slice(data); // Atomic memory push
            },
            |err| eprintln!("Stream error: {err}"),
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config,
            move |data: &[i16], _| {
                let mut stack_buf = [0.0_f32; 1024];
                for chunk in data.chunks(1024) {
                    for (i, &sample) in chunk.iter().enumerate() {
                        stack_buf[i] = sample as f32 / i16::MAX as f32;
                    }
                    let _ = producer.push_slice(&stack_buf[..chunk.len()]);
                }
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
    *state.audio_consumer.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

#[tauri::command] fn greet(name: &str) -> String { format!("Hello, {}!", name) }
#[tauri::command] fn testing() -> String { "Hello from rust".to_string() }
#[tauri::command] fn check_mic_permission() -> bool { true }

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AudioState::new())
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