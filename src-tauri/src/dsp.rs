use realfft::RealFftPlanner;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const FFT_SIZE: usize = 2048;
pub const HOP_SIZE: usize = FFT_SIZE / 2;

// Cabin noise lives in the low-frequency range.
// Voice fundamentals start around 80 Hz but formants extend to 3 kHz.
// Keeping the ceiling at 500 Hz excludes most voice energy while capturing
// engine harmonics and road rumble which dominate below 300 Hz.
const CABIN_NOISE_MIN_HZ: f32 = 20.0;
const CABIN_NOISE_MAX_HZ: f32 = 500.0;

// Number of FFT frames to average before emitting EQ params.
// Each frame is ~46ms at 44100 Hz / 2048 samples.
// 8 frames = ~370ms window. Engine noise is steady across this;
// voice is transient and averages down, suppressing false detections.
const SMOOTHING_FRAMES: usize = 8;

#[derive(Serialize, Clone)]
pub struct EqBand {
    pub frequency: f32, // Hz — center frequency to boost
    pub gain_db: f32,   // how much to boost (positive = louder)
    pub q: f32,         // bandwidth: higher Q = narrower band
}

#[derive(Serialize, Clone)]
pub struct DspFrame {
    pub bands: Vec<EqBand>,
    pub dominant_hz: f32, // loudest detected frequency in cabin noise range
    pub noise_db: f32,    // overall cabin noise level
}

/// Hann window — applied sample-by-sample before FFT.
/// Prevents spectral leakage at frame edges.
fn hann_window(size: usize) -> Vec<f32> {
    (0..size)
        .map(|i| {
            0.5 * (1.0
                - (2.0 * std::f32::consts::PI * i as f32 / (size - 1) as f32).cos())
        })
        .collect()
}

fn magnitude_to_db(magnitude: f32) -> f32 {
    20.0 * magnitude.max(1e-10_f32).log10()
}

fn masking_gain_db(noise_db: f32) -> f32 {
    // Map [-80 dB, -20 dB] → [0, 6 dB] of EQ boost.
    // -80 dB ≈ near silence / mic noise floor
    // -20 dB ≈ loud engine/road noise at the mic
    // Tune these two constants after testing on device in a real vehicle.
    let noise_floor: f32 = -80.0;
    let loud_cabin: f32 = -20.0;

    if noise_db <= noise_floor {
        return 0.0;
    }

    let normalized = (noise_db - noise_floor) / (loud_cabin - noise_floor);
    (normalized * 6.0).clamp(0.0, 6.0)
}

/// Analyze the averaged magnitude spectrum, restricted to the cabin noise
/// frequency band. Bins outside this range are ignored entirely — voice and
/// music frequencies never influence the EQ output.
fn analyze_cabin_spectrum(magnitudes: &[f32], sample_rate: u32) -> DspFrame {
    let bin_hz = sample_rate as f32 / FFT_SIZE as f32;

    // Convert Hz boundaries to bin indices, clamped to valid spectrum range
    let min_bin = ((CABIN_NOISE_MIN_HZ / bin_hz) as usize).max(1);
    let max_bin = ((CABIN_NOISE_MAX_HZ / bin_hz) as usize).min(magnitudes.len() - 1);

    // Build (bin_index, magnitude) pairs for the cabin noise window only
    let mut indexed: Vec<(usize, f32)> = magnitudes[min_bin..=max_bin]
        .iter()
        .enumerate()
        .map(|(i, &m)| (i + min_bin, m))
        .collect();

    // Sort by magnitude descending — loudest cabin noise bins first
    indexed.sort_unstable_by(|a, b| {
        b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal)
    });

    if indexed.is_empty() {
        return DspFrame {
            bands: vec![],
            dominant_hz: 0.0,
            noise_db: -200.0,
        };
    }

    let top = &indexed[..5.min(indexed.len())];

    let dominant_hz = top[0].0 as f32 * bin_hz;
    let noise_db = magnitude_to_db(top[0].1);

    let bands = top
        .iter()
        .map(|(bin, magnitude)| EqBand {
            frequency: *bin as f32 * bin_hz,
            gain_db: masking_gain_db(magnitude_to_db(*magnitude)),
            q: 2.0,
        })
        .collect();

    DspFrame { bands, dominant_hz, noise_db }
}

/// Runs on its own thread. Receives raw PCM chunks from the cpal callback,
/// accumulates them into frames, runs FFT, averages spectra across
/// SMOOTHING_FRAMES frames, then emits DspFrame events to Angular.
pub fn run_dsp_loop(
    sample_rx: std::sync::mpsc::Receiver<Vec<f32>>,
    app_handle: AppHandle,
    sample_rate: u32,
) {
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let window = hann_window(FFT_SIZE);

    let mut ring_buffer: Vec<f32> = Vec::with_capacity(FFT_SIZE * 2);

    // Spectral accumulator: sum magnitudes across SMOOTHING_FRAMES frames,
    // then divide. Voice energy is transient and averages down.
    // Engine harmonics are steady and remain proportionally dominant.
    let spectrum_len = FFT_SIZE / 2 + 1;
    let mut magnitude_accumulator: Vec<f32> = vec![0.0; spectrum_len];
    let mut frames_accumulated: usize = 0;

    while let Ok(chunk) = sample_rx.recv() {
        ring_buffer.extend_from_slice(&chunk);

        while ring_buffer.len() >= FFT_SIZE {
            // Apply Hann window element-wise
            let mut frame: Vec<f32> = ring_buffer[..FFT_SIZE]
                .iter()
                .zip(window.iter())
                .map(|(sample, w)| sample * w)
                .collect();

            let mut spectrum = fft.make_output_vec();

            if let Err(e) = fft.process(&mut frame, &mut spectrum) {
                eprintln!("FFT error: {e}");
                ring_buffer.drain(..HOP_SIZE);
                continue;
            }

            // Accumulate magnitudes across frames
            for (acc, c) in magnitude_accumulator.iter_mut().zip(spectrum.iter()) {
                *acc += c.norm();
            }
            frames_accumulated += 1;

            // Once we have enough frames, average and emit
            if frames_accumulated >= SMOOTHING_FRAMES {
                let averaged: Vec<f32> = magnitude_accumulator
                    .iter()
                    .map(|&v| v / SMOOTHING_FRAMES as f32)
                    .collect();

                let dsp_frame = analyze_cabin_spectrum(&averaged, sample_rate);
                app_handle.emit("dsp-frame", &dsp_frame).ok();

                magnitude_accumulator.fill(0.0);
                frames_accumulated = 0;
            }

            ring_buffer.drain(..HOP_SIZE);
        }
    }

    println!("DSP loop exiting");
}