use realfft::RealFftPlanner;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const FFT_SIZE: usize = 2048;
pub const HOP_SIZE: usize = FFT_SIZE / 2;

const CABIN_NOISE_MIN_HZ: f32 = 20.0;
const CABIN_NOISE_MAX_HZ: f32 = 500.0;

// How long to spend measuring the ambient floor before applying any masking.
// During this window the user should be in their normal quiet-car state
// (engine off, no music). The result becomes the zero-point for all gain decisions.
const CALIBRATION_SECS: f32 = 5.0;

// EMA time constant for the active noise profile (after calibration).
// 3 seconds: resistant to voice and short transients.
const EMA_TIME_CONSTANT_SECS: f32 = 3.0;

// Only trigger masking when noise exceeds the calibrated floor by this many dB.
// Prevents ambient room hiss from causing any EQ movement at all.
const MASKING_TRIGGER_DB: f32 = 6.0;

// At this many dB above floor → apply maximum gain for that frequency stage.
const MASKING_FULL_DB: f32 = 25.0;

// Spectral flux gate: freeze EMA updates during rapid spectral changes
// (voice, horn, door slam). Tune: lower = more frozen, higher = more permissive.
const FLUX_GATE_THRESHOLD: f32 = 50.0;

// Push EQ params to frontend at most once per this many seconds.
const EMIT_INTERVAL_SECS: f32 = 2.0;

#[derive(Serialize, Clone)]
pub struct EqBand {
    pub frequency: f32,
    pub gain_db: f32,
    pub q: f32,
}

#[derive(Serialize, Clone)]
pub struct DspFrame {
    pub bands: Vec<EqBand>,
    pub dominant_hz: f32,
    pub noise_db: f32,
    // True while still measuring the ambient floor.
    // Frontend should show "Calibrating..." during this phase.
    pub calibrating: bool,
}

fn hann_window(size: usize) -> Vec<f32> {
    (0..size)
        .map(|i| {
            0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / (size - 1) as f32).cos())
        })
        .collect()
}

fn magnitude_to_db(magnitude: f32) -> f32 {
    20.0 * magnitude.max(1e-10_f32).log10()
}

fn frequency_ceiling(freq_hz: f32) -> f32 {
    if freq_hz < 120.0 {
        6.0
    } else if freq_hz < 250.0 {
        4.0
    } else if freq_hz < 400.0 {
        2.0
    } else {
        0.8
    }
}

/// Compute masking gain relative to the calibrated floor.
/// Zero gain when noise is at or below floor. Scales up only when
/// something meaningfully louder than the calibrated ambient is detected.
///
/// excess_db = current_noise_db - floor_db
///   < MASKING_TRIGGER_DB  → 0.0 (ambient or quieter, leave it alone)
///   = MASKING_FULL_DB     → frequency_ceiling (maximum for this band)
fn masking_gain_db(current_db: f32, floor_db: f32, freq_hz: f32) -> f32 {
    let excess = current_db - floor_db;

    if excess < MASKING_TRIGGER_DB {
        return 0.0;
    }

    let normalized = ((excess - MASKING_TRIGGER_DB) / (MASKING_FULL_DB - MASKING_TRIGGER_DB))
        .clamp(0.0, 1.0);

    normalized * frequency_ceiling(freq_hz)
}

fn analyze_cabin_spectrum(
    ema_spectrum: &[f32],
    floor_spectrum: &[f32],
    sample_rate: u32,
    calibrating: bool,
) -> DspFrame {
    let bin_hz = sample_rate as f32 / FFT_SIZE as f32;
    let min_bin = ((CABIN_NOISE_MIN_HZ / bin_hz) as usize).max(1);
    let max_bin = ((CABIN_NOISE_MAX_HZ / bin_hz) as usize).min(ema_spectrum.len() - 1);

    if calibrating {
        // During calibration just report current levels, no EQ applied
        return DspFrame {
            bands: vec![],
            dominant_hz: 0.0,
            noise_db: -200.0,
            calibrating: true,
        };
    }

    let mut indexed: Vec<(usize, f32)> = ema_spectrum[min_bin..=max_bin]
        .iter()
        .enumerate()
        .map(|(i, &m)| (i + min_bin, m))
        .collect();

    indexed.sort_unstable_by(|a, b| {
        b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal)
    });

    if indexed.is_empty() {
        return DspFrame { bands: vec![], dominant_hz: 0.0, noise_db: -200.0, calibrating: false };
    }

    let top = &indexed[..5.min(indexed.len())];
    let dominant_hz = top[0].0 as f32 * bin_hz;
    let noise_db = magnitude_to_db(top[0].1);

    let bands = top
        .iter()
        .map(|(bin, magnitude)| {
            let freq = *bin as f32 * bin_hz;
            let current_db = magnitude_to_db(*magnitude);
            // Floor for this specific bin from the calibration snapshot
            let floor_db = magnitude_to_db(floor_spectrum[*bin]);
            EqBand {
                frequency: freq,
                gain_db: masking_gain_db(current_db, floor_db, freq),
                q: if freq < 120.0 { 1.5 } else { 2.5 },
            }
        })
        .collect();

    DspFrame { bands, dominant_hz, noise_db, calibrating: false }
}

fn spectral_flux(current: &[f32], previous: &[f32]) -> f32 {
    current
        .iter()
        .zip(previous.iter())
        .map(|(a, b)| (a - b).abs())
        .sum()
}

pub fn run_dsp_loop(
    sample_rx: std::sync::mpsc::Receiver<Vec<f32>>,
    app_handle: AppHandle,
    sample_rate: u32,
) {
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let window = hann_window(FFT_SIZE);
    let mut ring_buffer: Vec<f32> = Vec::with_capacity(FFT_SIZE * 2);

    let hop_secs = HOP_SIZE as f32 / sample_rate as f32;
    let alpha = 1.0_f32 - (-hop_secs / EMA_TIME_CONSTANT_SECS).exp();

    let spectrum_len = FFT_SIZE / 2 + 1;
    let mut ema_spectrum: Vec<f32> = vec![0.0; spectrum_len];
    let mut prev_magnitudes: Vec<f32> = vec![0.0; spectrum_len];
    // Calibrated ambient floor — set at the end of the calibration phase
    let mut floor_spectrum: Vec<f32> = vec![0.0; spectrum_len];

    // Calibration: accumulate frames for CALIBRATION_SECS, then snapshot
    let calibration_frames = (CALIBRATION_SECS / hop_secs).round() as usize;
    let mut frames_elapsed: usize = 0;
    let mut calibrating = true;

    let emit_every = (EMIT_INTERVAL_SECS / hop_secs).round() as usize;
    let mut frames_since_emit: usize = 0;
    let mut initialized = false;

    while let Ok(chunk) = sample_rx.recv() {
        ring_buffer.extend_from_slice(&chunk);

        while ring_buffer.len() >= FFT_SIZE {
            let mut frame: Vec<f32> = ring_buffer[..FFT_SIZE]
                .iter()
                .zip(window.iter())
                .map(|(s, w)| s * w)
                .collect();

            let mut spectrum = fft.make_output_vec();

            if let Err(e) = fft.process(&mut frame, &mut spectrum) {
                eprintln!("FFT error: {e}");
                ring_buffer.drain(..HOP_SIZE);
                continue;
            }

            let magnitudes: Vec<f32> = spectrum.iter().map(|c| c.norm()).collect();

            if !initialized {
                ema_spectrum.copy_from_slice(&magnitudes);
                prev_magnitudes.copy_from_slice(&magnitudes);
                initialized = true;
            } else {
                let flux = spectral_flux(&magnitudes, &prev_magnitudes);

                // During calibration: always update EMA to learn the ambient floor.
                // After calibration: gate on flux to ignore transients.
                if calibrating || flux < FLUX_GATE_THRESHOLD {
                    for (ema, &mag) in ema_spectrum.iter_mut().zip(magnitudes.iter()) {
                        *ema = alpha * mag + (1.0 - alpha) * *ema;
                    }
                }

                prev_magnitudes.copy_from_slice(&magnitudes);
            }

            frames_elapsed += 1;

            // Snapshot the floor at the end of calibration
            if calibrating && frames_elapsed >= calibration_frames {
                floor_spectrum.copy_from_slice(&ema_spectrum);
                calibrating = false;
                eprintln!(
                    "Calibration complete. Ambient floor captured ({calibration_frames} frames)."
                );
            }

            frames_since_emit += 1;
            if frames_since_emit >= emit_every {
                let dsp_frame =
                    analyze_cabin_spectrum(&ema_spectrum, &floor_spectrum, sample_rate, calibrating);
                app_handle.emit("dsp-frame", &dsp_frame).ok();
                frames_since_emit = 0;
            }

            ring_buffer.drain(..HOP_SIZE);
        }
    }

    println!("DSP loop exiting");
}