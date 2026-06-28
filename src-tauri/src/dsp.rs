use realfft::RealFftPlanner;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use ringbuf::traits::{Consumer, Observer};

// ─── FFT Configuration ────────────────────────────────────────────────────────
//
// Latency vs. accuracy trade-off:
//
//   FFT_SIZE controls frequency resolution: bin_hz = sample_rate / FFT_SIZE
//   At 48000 Hz:  2048 → 23.4 Hz/bin   4096 → 11.7 Hz/bin
//   Larger FFT = finer resolution but more samples to collect before analysis.
//
//   HOP_SIZE controls how often we analyse (update rate):
//   At 48000 Hz, HOP_SIZE 512 → analysis every ~10.7 ms  (92 Hz update rate)
//   75% overlap (HOP = FFT/4) gives 4 analyses per FFT window → smooth EMA tracking.
//
// We use FFT_SIZE=2048 with HOP_SIZE=512 (75% overlap):
//   - 23.4 Hz/bin is enough to resolve distinct cabin peaks (engine harmonics are ~50-100 Hz apart)
//   - 10.7 ms hop → EQ updates arrive ~92 times/sec, well within Web Audio's scheduling resolution
//   - Total pipeline latency ≈ HOP_SIZE/sample_rate = ~11 ms (vs 42 ms for FFT/2 hop at 4096)
//
// If you need finer frequency resolution (e.g. diesel engines with tight harmonics),
// increase FFT_SIZE to 4096 — accuracy improves but update rate halves to ~46 Hz.

pub const FFT_SIZE: usize = 2048;
pub const HOP_SIZE: usize = FFT_SIZE / 4; // 75% overlap → 512 samples @ 48kHz = ~10.7 ms

const CABIN_NOISE_MIN_HZ: f32 = 20.0;
const CABIN_NOISE_MAX_HZ: f32 = 500.0;

// ─── EMA time constant ────────────────────────────────────────────────────────
// 1.5 s gives a fast enough response to engine RPM changes (gear shifts ~0.5 s)
// while still averaging out transient noise bursts (bumps, speech, claps).
const EMA_TIME_CONSTANT_SECS: f32 = 1.5;

// ─── Calibration ──────────────────────────────────────────────────────────────
// 3 seconds of quiet baseline before live analysis begins.
// Short enough to feel responsive; long enough to capture idle engine floor.
const CALIBRATION_SECS: f32 = 3.0;

// ─── Adaptive floor ───────────────────────────────────────────────────────────
// Slowly lower the noise floor when the environment gets quieter (deceleration,
// highway cruise, engine off). FLOOR_DECAY_ALPHA = 0.001 → ~1000 hops to fully
// track down, i.e., about 10 seconds.
const FLOOR_DECAY_ALPHA: f32 = 0.001;

// ─── Masking parameters ───────────────────────────────────────────────────────
// Trigger: how many dB above the calibrated floor before we apply any EQ boost.
// 3 dB is half a perceived loudness step — anything less would boost on silence.
const MASKING_TRIGGER_DB: f32 = 3.0;
// Full: how far above the floor to reach maximum boost. 18 dB = very loud noise.
const MASKING_FULL_DB: f32 = 18.0;

// ─── Peak picking ─────────────────────────────────────────────────────────────
// Minimum gap between accepted peaks in FFT bins. 6 bins @ 23.4 Hz/bin = ~140 Hz
// separation. Prevents adjacent bins of the same spectral peak from all ranking
// as independent noise sources.
const MIN_PEAK_BIN_GAP: usize = 6;

// ─── Flux gate ────────────────────────────────────────────────────────────────
// Normalised spectral flux threshold. Values above this indicate a transient
// (pothole, speech, gear shift) — we skip the EMA update during those frames
// so transients don't corrupt the noise floor model.
// 0.25 was empirically good across engine noise + road noise test recordings.
const FLUX_GATE_RATIO: f32 = 0.25;

// ─── Emit rate ────────────────────────────────────────────────────────────────
// How often to send a dsp-frame event to the frontend.
// 0.08 s = ~12.5 Hz — fast enough for smooth UI updates, cheap enough for JS.
const EMIT_INTERVAL_SECS: f32 = 0.08;

// ─────────────────────────────────────────────────────────────────────────────

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
    pub calibrating: bool,
}

/// Hann window — multiplied onto each FFT frame to suppress spectral leakage.
/// Without this, energy from loud bins "bleeds" into adjacent bins, masking
/// quieter peaks that we need to detect for accurate EQ targeting.
fn hann_window(size: usize) -> Vec<f32> {
    (0..size)
        .map(|i| 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / (size - 1) as f32).cos()))
        .collect()
}

#[inline(always)]
fn magnitude_to_db(m: f32) -> f32 {
    20.0 * m.max(1e-10).log10()
}

/// Maximum EQ boost ceiling per frequency band.
/// Lower frequencies get higher ceiling: engine/road noise is strongest sub-200 Hz
/// and needs the most compensation; above 300 Hz we clamp tightly to avoid
/// artificially brightening the mix.
#[inline(always)]
fn freq_ceiling_db(hz: f32) -> f32 {
    if hz < 80.0       { 9.0 }
    else if hz < 160.0 { 7.0 }
    else if hz < 300.0 { 4.5 }
    else               { 2.0 }
}

/// Compute how many dB to boost the EQ at this frequency.
/// Uses a smooth curve from trigger to full rather than a hard step,
/// which prevents sudden EQ jumps that would be audible as clicks.
#[inline(always)]
fn masking_gain_db(current_db: f32, floor_db: f32, hz: f32) -> f32 {
    let excess = current_db - floor_db;
    if excess < MASKING_TRIGGER_DB { return 0.0; }
    let t = ((excess - MASKING_TRIGGER_DB) / (MASKING_FULL_DB - MASKING_TRIGGER_DB)).clamp(0.0, 1.0);
    // Ease-in-out cubic: smoother ramp than linear
    let smooth = t * t * (3.0 - 2.0 * t);
    smooth * freq_ceiling_db(hz)
}

/// Pick top N spectral peaks, enforcing a minimum bin gap between them.
/// Without the gap constraint, spectral smearing causes multiple adjacent bins
/// of one broad peak (e.g. 120 Hz engine fundamental) to all rank in the top 5,
/// leaving no room for the 240 Hz, 360 Hz harmonics that are the real targets.
fn pick_distinct_peaks(indexed: &[(usize, f32)], n: usize, min_gap: usize) -> Vec<(usize, f32)> {
    let mut sorted = indexed.to_vec();
    sorted.sort_unstable_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let mut peaks: Vec<(usize, f32)> = Vec::with_capacity(n);
    for cand in sorted {
        if !peaks.iter().any(|(b, _)| cand.0.abs_diff(*b) < min_gap) {
            peaks.push(cand);
            if peaks.len() >= n { break; }
        }
    }
    peaks
}

/// Normalised spectral flux: sum of absolute magnitude changes divided by
/// total energy. Device-independent unlike raw magnitude-based thresholds —
/// the same value means the same "amount of change" on any microphone gain.
#[inline]
fn normalised_flux(current: &[f32], previous: &[f32]) -> f32 {
    let flux: f32 = current.iter().zip(previous).map(|(a, b)| (a - b).abs()).sum();
    let energy: f32 = current.iter().sum::<f32>() / current.len().max(1) as f32;
    if energy < 1e-10 { 0.0 } else { flux / (energy * current.len() as f32) }
}

fn analyze(
    ema: &[f32],
    floor: &[f32],
    sample_rate: u32,
    calibrating: bool,
    strength: f32,
) -> DspFrame {
    let bin_hz = sample_rate as f32 / FFT_SIZE as f32;
    let min_bin = ((CABIN_NOISE_MIN_HZ / bin_hz) as usize).max(1);
    let max_bin = ((CABIN_NOISE_MAX_HZ / bin_hz) as usize).min(ema.len() - 1);

    if calibrating || min_bin >= max_bin {
        return DspFrame { bands: vec![], dominant_hz: 0.0, noise_db: -200.0, calibrating: true };
    }

    let indexed: Vec<(usize, f32)> = ema[min_bin..=max_bin]
        .iter().enumerate().map(|(i, &m)| (i + min_bin, m)).collect();

    let peaks = pick_distinct_peaks(&indexed, 5, MIN_PEAK_BIN_GAP);
    if peaks.is_empty() {
        return DspFrame { bands: vec![], dominant_hz: 0.0, noise_db: -200.0, calibrating: false };
    }

    let dominant_hz = peaks[0].0 as f32 * bin_hz;
    let noise_db = magnitude_to_db(peaks[0].1);

    let bands = peaks.iter().map(|(bin, mag)| {
        let hz = *bin as f32 * bin_hz;
        let gain = masking_gain_db(magnitude_to_db(*mag), magnitude_to_db(floor[*bin]), hz);

        // Q factor: wider (lower Q) for sub-bass where peaks are broad,
        // tighter (higher Q) above 160 Hz to avoid muddying the mix.
        let q = if hz < 80.0        { 1.0 }
                else if hz < 160.0  { 1.6 }
                else if hz < 300.0  { 2.2 }
                else                { 3.0 };

        EqBand { frequency: hz, gain_db: gain * strength, q }
    }).collect();

    DspFrame { bands, dominant_hz, noise_db, calibrating: false }
}

pub fn run_dsp_loop<C: Consumer<Item = f32>>(
    mut consumer: C,
    app_handle: AppHandle,
    sample_rate: u32,
    shield_strength: Arc<AtomicU32>,
) {
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let window = hann_window(FFT_SIZE);

    let hop_secs = HOP_SIZE as f32 / sample_rate as f32;
    // EMA smoothing factor — derived from the time constant and hop size.
    // alpha close to 1 = fast response; alpha close to 0 = heavy smoothing.
    let alpha = 1.0_f32 - (-hop_secs / EMA_TIME_CONSTANT_SECS).exp();

    let spectrum_len = FFT_SIZE / 2 + 1;
    let mut ema_spectrum = vec![0.0_f32; spectrum_len];
    let mut prev_magnitudes = vec![0.0_f32; spectrum_len];
    let mut floor_spectrum = vec![0.0_f32; spectrum_len];
    let mut magnitudes = vec![0.0_f32; spectrum_len];

    // Pre-allocate FFT scratch buffers to avoid per-frame heap allocation
    let mut fft_input = vec![0.0_f32; FFT_SIZE];
    let mut fft_output = fft.make_output_vec();

    // Sliding history window: holds exactly one FFT_SIZE of audio
    let mut history = vec![0.0_f32; FFT_SIZE];

    let calibration_frames = (CALIBRATION_SECS / hop_secs).round() as usize;
    let emit_every = (EMIT_INTERVAL_SECS / hop_secs).round().max(1.0) as usize;
    let mut frames_elapsed: usize = 0;
    let mut frames_since_emit: usize = 0;
    let mut calibrating = true;
    let mut initialized = false;

    // Block until we have a full FFT window of samples before starting.
    // Use a short sleep to avoid burning CPU while waiting for the first fill.
    while consumer.occupied_len() < FFT_SIZE {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    consumer.pop_slice(&mut history);

    loop {
        // ── 1. Apply Hann window ──────────────────────────────────────────────
        for i in 0..FFT_SIZE {
            fft_input[i] = history[i] * window[i];
        }

        // ── 2. FFT ────────────────────────────────────────────────────────────
        if fft.process(&mut fft_input, &mut fft_output).is_ok() {

            // ── 3. Magnitude spectrum ─────────────────────────────────────────
            for (mag, c) in magnitudes.iter_mut().zip(fft_output.iter()) {
                *mag = c.norm();
            }

            if !initialized {
                // Seed EMA with the very first frame so calibration starts immediately
                ema_spectrum.copy_from_slice(&magnitudes);
                prev_magnitudes.copy_from_slice(&magnitudes);
                initialized = true;
            } else {
                // ── 4. Flux gate ──────────────────────────────────────────────
                // Only update the EMA during stable audio. Transient frames
                // (bumps, speech, claps) have high flux and would corrupt the
                // long-term noise floor model if included.
                let flux = normalised_flux(&magnitudes, &prev_magnitudes);
                if calibrating || flux < FLUX_GATE_RATIO {
                    for (e, &m) in ema_spectrum.iter_mut().zip(magnitudes.iter()) {
                        *e = alpha * m + (1.0 - alpha) * *e;
                    }
                }
                prev_magnitudes.copy_from_slice(&magnitudes);
            }

            frames_elapsed += 1;

            // ── 5. End calibration ────────────────────────────────────────────
            if calibrating && frames_elapsed >= calibration_frames {
                floor_spectrum.copy_from_slice(&ema_spectrum);
                calibrating = false;
                println!("RumbleGuard: calibration complete ({} frames)", frames_elapsed);
            }

            // ── 6. Adaptive floor tracking ────────────────────────────────────
            // After calibration, slowly lower the floor when the environment
            // gets quieter (reducing speed, idle stop). We never raise the floor
            // automatically — that would mask real noise increases.
            if !calibrating {
                for (f, &e) in floor_spectrum.iter_mut().zip(ema_spectrum.iter()) {
                    if e < *f {
                        *f = FLOOR_DECAY_ALPHA * e + (1.0 - FLOOR_DECAY_ALPHA) * *f;
                    }
                }
            }

            // ── 7. Emit to frontend ───────────────────────────────────────────
            frames_since_emit += 1;
            if frames_since_emit >= emit_every {
                let strength = f32::from_bits(shield_strength.load(Ordering::Relaxed));
                let frame = analyze(&ema_spectrum, &floor_spectrum, sample_rate, calibrating, strength);
                let _ = app_handle.emit("dsp-frame", &frame);
                frames_since_emit = 0;
            }
        }

        // ── 8. Slide history window forward by one hop ────────────────────────
        // copy_within is a single memmove — no allocation, minimal latency.
        history.copy_within(HOP_SIZE..FFT_SIZE, 0);

        // ── 9. Wait for next hop of samples ───────────────────────────────────
        // Use a tighter sleep (1 ms) to minimise wait latency while still
        // yielding the thread so cpal can fill the ring buffer.
        while consumer.occupied_len() < HOP_SIZE {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        consumer.pop_slice(&mut history[FFT_SIZE - HOP_SIZE..]);
    }
}