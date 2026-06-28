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

type AudioConsumer = ringbuf::wrap::CachingCons<Arc<ringbuf::SharedRb<ringbuf::storage::Heap<f32>>>>;

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
    env: jni::JNIEnv,
    activity: jni::objects::JObject,
) {
    let vm = env.get_java_vm().expect("failed to get JavaVM");
    // Promote to a global ref — local refs die when this JNI call returns.
    let global_activity = env
        .new_global_ref(&activity)
        .expect("failed to create global ref for activity");
    unsafe {
        ndk_context::initialize_android_context(
            vm.get_java_vm_pointer() as *mut std::ffi::c_void,
            global_activity.as_raw() as *mut std::ffi::c_void,
        );
    }
    // Prevent the GlobalRef destructor from deleting the ref we just stored.
    std::mem::forget(global_activity);
    println!("ndk-context initialized");
}
#[cfg(target_os = "android")]
fn get_audio_manager<'a>(
    env: &mut jni::JNIEnv<'a>,
    context: &jni::objects::JObject,   // <-- JObject, not GlobalRef
) -> Result<jni::objects::JObject<'a>, String> {
    let audio_service_str = env
        .get_static_field("android/content/Context", "AUDIO_SERVICE", "Ljava/lang/String;")
        .map_err(|e| e.to_string())?.l().map_err(|e| e.to_string())?;

    env.call_method(
        context,                         // <-- use directly
        "getSystemService",
        "(Ljava/lang/String;)Ljava/lang/Object;",
        &[jni::objects::JValue::from(&audio_service_str)],
    ).map_err(|e| e.to_string())?.l().map_err(|e| e.to_string())
}
#[cfg(target_os = "android")]
fn with_jni_context<F, R>(f: F) -> Result<R, String>
where
    F: FnOnce(&mut jni::JNIEnv, &jni::objects::JObject) -> Result<R, String>,
{
    let ctx = ndk_context::android_context();

    // ManuallyDrop prevents the jni crate from calling DestroyJavaVM on drop.
    // We don't own this VM — Android does.
    let vm = std::mem::ManuallyDrop::new(
        unsafe { jni::JavaVM::from_raw(ctx.vm() as *mut jni::sys::JavaVM) }
            .map_err(|e| e.to_string())?,
    );

    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;

    // ctx.context() is already a global ref (from the initNdkContext fix).
    let context = unsafe {
        jni::objects::JObject::from_raw(ctx.context() as jni::sys::jobject)
    };

    f(&mut env, &context)
}

#[cfg(target_os = "android")]
fn configure_android_audio_session() -> Result<(), String> {
    with_jni_context(|env, context_global| {
        let audio_manager_local = get_audio_manager(env, context_global)?;
        let audio_manager = env.new_global_ref(&audio_manager_local).map_err(|e| e.to_string())?;

        // MODE_IN_COMMUNICATION (3): only mode that keeps mic + speaker alive together
        env.call_method(audio_manager.as_obj(), "setMode", "(I)V",
            &[jni::objects::JValue::Int(3)]).map_err(|e| e.to_string())?;

        // Request audio focus so other apps can't steal and kill our capture
        let null_listener = jni::objects::JObject::null();
        env.call_method(
            audio_manager.as_obj(), "requestAudioFocus",
            "(Landroid/media/AudioManager$OnAudioFocusChangeListener;II)I",
            &[
                jni::objects::JValue::from(&null_listener),
                jni::objects::JValue::Int(3), // STREAM_MUSIC
                jni::objects::JValue::Int(1), // AUDIOFOCUS_GAIN
            ],
        ).map_err(|e| e.to_string())?;

        // Disable built-in processing that fights our DSP
        for param in &["noise_suppression=off", "agc_enable=false"] {
            let p = env.new_string(param).map_err(|e| e.to_string())?;
            env.call_method(audio_manager.as_obj(), "setParameters", "(Ljava/lang/String;)V",
                &[jni::objects::JValue::from(&p)]).map_err(|e| e.to_string())?;
        }

        println!("Android audio: MODE_IN_COMMUNICATION, NS=off, AGC=off");
        Ok(())
    })
}

#[cfg(target_os = "android")]
fn restore_android_audio_session() {
    let _ = with_jni_context(|env, context_global| {
        let audio_manager_local = get_audio_manager(env, context_global)?;
        let audio_manager = env.new_global_ref(&audio_manager_local).map_err(|e| e.to_string())?;
        env.call_method(audio_manager.as_obj(), "setMode", "(I)V",
            &[jni::objects::JValue::Int(0)]).map_err(|e| e.to_string())?; // MODE_NORMAL
        Ok(())
    });
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

    #[cfg(target_os = "android")]
    configure_android_audio_session()
        .unwrap_or_else(|e| eprintln!("Audio session config failed: {e}"));

    let host = cpal::default_host();
    let device = host.default_input_device().ok_or("No input device available")?;
    let supported_config = device.default_input_config().map_err(|e| e.to_string())?;
    let sample_rate = supported_config.sample_rate().0;
    let sample_format = supported_config.sample_format();

    let rb = Arc::new(SharedRb::<Heap<f32>>::new(dsp::FFT_SIZE * 16));
    let (mut producer, consumer) = rb.split();

    let strength_clone = Arc::clone(&state.shield_strength);

    std::thread::Builder::new()
        .name("rumble-dsp".into())
        .stack_size(512 * 1024)
        .spawn(move || {
            #[cfg(target_os = "android")]
            unsafe { libc::setpriority(libc::PRIO_PROCESS, 0, -10); }
            run_dsp_loop(consumer, app, sample_rate, strength_clone);
        })
        .map_err(|e| e.to_string())?;

    let config = cpal::StreamConfig {
        channels: 1,
        sample_rate: supported_config.sample_rate(),
        buffer_size: cpal::BufferSize::Fixed(dsp::HOP_SIZE as u32),
    };

    let stream = match sample_format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config,
            move |data: &[f32], _| { let _ = producer.push_slice(data); },
            |err| eprintln!("Stream error: {err}"),
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config,
            move |data: &[i16], _| {
                let mut buf = [0.0_f32; 512];
                for chunk in data.chunks(512) {
                    for (i, &s) in chunk.iter().enumerate() {
                        buf[i] = s as f32 / i16::MAX as f32;
                    }
                    let _ = producer.push_slice(&buf[..chunk.len()]);
                }
            },
            |err| eprintln!("Stream error: {err}"),
            None,
        ),
        _ => {
            let fallback: cpal::StreamConfig = supported_config.into();
            let s = device.build_input_stream(
                &fallback,
                move |data: &[f32], _| { let _ = producer.push_slice(data); },
                |err| eprintln!("Stream error: {err}"),
                None,
            ).map_err(|e| e.to_string())?;
            s.play().map_err(|e| e.to_string())?;
            *stream_guard = Some(AudioStream(s));
            return Ok(());
        }
    }.map_err(|e| e.to_string())?;

    stream.play().map_err(|e| e.to_string())?;
    *stream_guard = Some(AudioStream(stream));
    Ok(())
}

#[tauri::command]
fn stop_recording(state: tauri::State<'_, AudioState>) -> Result<(), String> {
    *state.stream.lock().map_err(|e| e.to_string())? = None;
    *state.audio_consumer.lock().map_err(|e| e.to_string())? = None;
    #[cfg(target_os = "android")]
    restore_android_audio_session();
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
        return with_jni_context(|env, _context_global| {
            let env_class = env.find_class("android/os/Environment").map_err(|e| e.to_string())?;
            let dir_music = env
                .get_static_field(&env_class, "DIRECTORY_MUSIC", "Ljava/lang/String;")
                .map_err(|e| e.to_string())?.l().map_err(|e| e.to_string())?;

            let storage_dir = env
                .call_static_method(&env_class, "getExternalStoragePublicDirectory",
                    "(Ljava/lang/String;)Ljava/io/File;",
                    &[jni::objects::JValue::from(&dir_music)])
                .map_err(|e| e.to_string())?.l().map_err(|e| e.to_string())?;

            let path_str = env
                .call_method(&storage_dir, "getAbsolutePath", "()Ljava/lang/String;", &[])
                .map_err(|e| e.to_string())?.l().map_err(|e| e.to_string())?;
            let path: String = env
                .get_string(&jni::objects::JString::from(path_str))
                .map_err(|e| e.to_string())?.into();

            scan_directory_for_audio(Path::new(&path))
        });
    }

    #[cfg(not(target_os = "android"))]
    return scan_directory_for_audio(&target_dir_fallback());
}

#[tauri::command]
fn scan_custom_directory(dir_path: String) -> Result<Vec<LocalAudioTrack>, String> {
    let p = Path::new(&dir_path);
    if !p.exists() { return Err("Directory does not exist.".into()); }
    if !p.is_dir() { return Err("Path is not a directory.".into()); }
    scan_directory_for_audio(p)
}

fn target_dir_fallback() -> PathBuf {
    #[allow(deprecated)]
    std::env::home_dir().unwrap_or_default().join("Music")
}

fn scan_directory_for_audio(path: &Path) -> Result<Vec<LocalAudioTrack>, String> {
    let mut tracks = Vec::new();
    if !path.exists() || !path.is_dir() { return Ok(tracks); }
    if let Ok(entries) = std::fs::read_dir(path) {
        let mut index = 1;
        for entry in entries.flatten() {
            let item_path = entry.path();
            if item_path.is_file() {
                if let Some(ext) = item_path.extension().and_then(|s| s.to_str()) {
                    let ext_lower = ext.to_lowercase();
                    if matches!(ext_lower.as_str(), "mp3"|"wav"|"m4a"|"ogg"|"flac"|"aac") {
                        let file_name = item_path.file_name().and_then(|s| s.to_str()).unwrap_or("Unknown").to_string();
                        let title = item_path.file_stem().and_then(|s| s.to_str()).unwrap_or("Track").to_string();
                        tracks.push(LocalAudioTrack {
                            id: format!("loc-{}", index),
                            title, file_name,
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
        .register_uri_scheme_protocol("rumble-stream", |_ctx, request| {
            let path_url = request.uri().path();
            let raw_path = percent_encoding::percent_decode(path_url.as_bytes())
                .decode_utf8_lossy().into_owned();
            let clean_path = raw_path.trim_start_matches('/');
            match std::fs::read(clean_path) {
                Ok(content) => {
                    let mime = if clean_path.ends_with(".wav") { "audio/wav" }
                        else if clean_path.ends_with(".ogg") { "audio/ogg" }
                        else if clean_path.ends_with(".m4a") || clean_path.ends_with(".aac") { "audio/mp4" }
                        else { "audio/mpeg" };
                    Response::builder().status(200)
                        .header("content-type", mime)
                        .header("access-control-allow-origin", "*")
                        .body(content)
                        .unwrap_or_else(|_| Response::builder().status(500).body(Vec::new()).unwrap())
                }
                Err(_) => Response::builder().status(404).body(Vec::new()).unwrap(),
            }
        })
        .invoke_handler(tauri::generate_handler![
            greet, testing, start_recording, stop_recording,
            check_mic_permission, set_shield_strength,
            get_local_music_tracks, scan_custom_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}