mod dsp;
use dsp::run_dsp_loop;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use ringbuf::{SharedRb, storage::Heap, traits::*};
use std::path::{Path, PathBuf};
use tauri::http::Response;

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

    let rb = Arc::new(SharedRb::<Heap<f32>>::new(32768));
    let (mut producer, consumer) = rb.split();

    let strength_clone = Arc::clone(&state.shield_strength);
    
    std::thread::spawn(move || {
        run_dsp_loop(consumer, app, sample_rate, strength_clone);
    });

    let config = supported_config.into();
    let stream = match sample_format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config,
            move |data: &[f32], _| { 
                let _ = producer.push_slice(data);
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

#[derive(serde::Serialize)]
struct LocalAudioTrack {
    id: String,
    title: String,
    file_name: String,
    full_path: String,
    duration: String,
    r#type: String,
}

#[tauri::command]
fn get_local_music_tracks() -> Result<Vec<LocalAudioTrack>, String> {
    #[cfg(target_os = "android")]
    {
        let ctx = ndk_context::android_context();
        let vm = unsafe { jni::JavaVM::from_raw(ctx.vm() as *mut jni::sys::JavaVM) }.map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        
        let env_class = env.find_class("android/os/Environment").map_err(|e| e.to_string())?;
        let field_dir_music = env.get_static_field(&env_class, "DIRECTORY_MUSIC", "Ljava/lang/String;").map_err(|e| e.to_string())?;
        let dir_music_jstring = field_dir_music.l().map_err(|e| e.to_string())?;
        
        let storage_dir = env.call_static_method(
            &env_class,
            "getExternalStoragePublicDirectory",
            "(Ljava/lang/String;)Ljava/io/File;",
            &[jni::objects::JValue::from(&dir_music_jstring)],
        ).map_err(|e| e.to_string())?.l().map_err(|e| e.to_string())?;
        
        let path_jstring = env.call_method(&storage_dir, "getAbsolutePath", "()Ljava/lang/String;", &[]).map_err(|e| e.to_string())?.l().map_err(|e| e.to_string())?;
        let path_raw: String = env.get_string(&jni::objects::JString::from(path_jstring)).map_err(|e| e.to_string())?.into();
        
        let target_dir = Path::new(&path_raw);
        return scan_directory_for_audio(target_dir);
    }

    #[cfg(not(target_os = "android"))]
    {
        let user_dirs = target_dir_fallback();
        return scan_directory_for_audio(&user_dirs);
    }
}

#[tauri::command]
fn scan_custom_directory(dir_path: String) -> Result<Vec<LocalAudioTrack>, String> {
    let target_dir = Path::new(&dir_path);
    if !target_dir.exists() {
        return Err("The selected directory does not exist on this device.".to_string());
    }
    if !target_dir.is_dir() {
        return Err("The selected path is not a valid folder layout.".to_string());
    }
    scan_directory_for_audio(target_dir)
}

fn target_dir_fallback() -> PathBuf {
    #[allow(deprecated)]
    std::env::home_dir().unwrap_or_default().join("Music")
}

fn scan_directory_for_audio(path: &Path) -> Result<Vec<LocalAudioTrack>, String> {
    let mut tracks = Vec::new();
    if !path.exists() || !path.is_dir() {
        return Ok(tracks);
    }

    if let Ok(entries) = std::fs::read_dir(path) {
        let mut index = 1;
        for entry in entries.flatten() {
            let item_path = entry.path();
            if item_path.is_file() {
                if let Some(ext) = item_path.extension().and_then(|s| s.to_str()) {
                    let ext_lower = ext.to_lowercase();
                    if ext_lower == "mp3" || ext_lower == "wav" || ext_lower == "m4a" || ext_lower == "ogg" {
                        let file_name = item_path.file_name().and_then(|s| s.to_str()).unwrap_or("Unknown").to_string();
                        let title = item_path.file_stem().and_then(|s| s.to_str()).unwrap_or("Track").to_string();
                        
                        tracks.push(LocalAudioTrack {
                            id: format!("loc-{}", index),
                            title,
                            file_name,
                            full_path: item_path.to_string_lossy().to_string(),
                            duration: "Local File".to_string(),
                            r#type: ext_lower.to_uppercase(),
                        });
                        index += 1;
                    }
                }
            }
        }
    }
    Ok(tracks)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AudioState::new())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init()) 
        .register_uri_scheme_protocol("rumble-stream", |ctx, request| {
            let path_url = request.uri().path();
            let raw_path = percent_encoding::percent_decode(path_url.as_bytes()).decode_utf8_lossy().into_owned();
            let clean_path = raw_path.trim_start_matches('/');
            
            match std::fs::read(clean_path) {
                Ok(content) => {
                    let mime_type = if clean_path.ends_with(".wav") { "audio/wav" } else { "audio/mpeg" };
                    Response::builder()
                        .status(200)
                        .header("content-type", mime_type)
                        .header("access-control-allow-origin", "*")
                        .body(content)
                        .unwrap_or_else(|_| Response::builder().status(500).body(Vec::new()).unwrap())
                }
                Err(_) => Response::builder().status(404).body(Vec::new()).unwrap(),
            }
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            testing,
            start_recording,
            stop_recording,
            check_mic_permission,
            set_shield_strength,
            get_local_music_tracks,
            scan_custom_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}