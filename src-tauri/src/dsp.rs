use realfft::RealFftPlanner;
use serde::Serialize;
use tauri::AppHandle;

pub const FFT_SIZE: usize = 2048;
pub const HOP_SIZE: usize = FFT_SIZE / 2;

#[derive(Serialize, Clone)]
pub struct EqBand {
    pub frequency: f32, // Hz — center frequency to boost
    pub gain_db: f32,   // how much to boost (positive = louder)
    pub q: f32,         // bandwidth: higher Q = narrower band
}

#[derive(Serialize, Clone)]
pub struct DspFrame {
    pub bands: Vec<EqBand>,
    pub dominant_hz: f32, // loudest detected frequency, for UI
    pub noise_db: f32,    // overall cabin noise level
}

/// Hann window — applied sample-by-sample before FFT.
/// Prevents spectral leakage at the frame edges.
fn hann_window(size: usize) -> Vec<f32> {
    (0..size)
        .map(|i| {
            0.5 * (1.0
                - (2.0 * std::f32::consts::PI * i as f32 / (size - 1) as f32).cos())
        })
        .collect()
}

fn magnitude_to_db(magnitude: f32) -> f32 {
    // Clamp to avoid log(0). 1e-10 is below any real signal.
    20.0 * magnitude.max(1e-10_f32).log10()
}

/// How much EQ boost to apply given the noise level at a frequency.
/// Simplified linear model: louder cabin noise = more masking boost, capped at 6dB.
/// You will tune this constant once you test on device.
fn masking_gain_db(noise_db: f32) -> f32 {
    (noise_db * 0.15).clamp(0.0, 6.0)
}

fn analyze_spectrum(magnitudes: &[f32], sample_rate: u32) -> DspFrame {
    // Each FFT bin corresponds to this many Hz
    let bin_hz = sample_rate as f32 / FFT_SIZE as f32;

    // Skip bin 0 (DC offset). Build (bin_index, magnitude) pairs.
    let mut indexed: Vec<(usize, f32)> = magnitudes[1..]
        .iter()
        .enumerate()
        .map(|(i, &m)| (i + 1, m))
        .collect();

    // Sort by magnitude descending — loudest bins first
    indexed.sort_unstable_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let top = &indexed[..5.min(indexed.len())];

    let dominant_hz = top[0].0 as f32 * bin_hz;
    let noise_db = magnitude_to_db(top[0].1);

    let bands = top
        .iter()
        .map(|(bin, magnitude)| {
            let freq = *bin as f32 * bin_hz;
            let db = magnitude_to_db(*magnitude);
            EqBand {
                frequency: freq,
                gain_db: masking_gain_db(db),
                q: 2.0, // moderate bandwidth; tune later
            }
        })
        .collect();

    DspFrame { bands, dominant_hz, noise_db }
}

/// Runs on its own thread. Receives raw PCM chunks from the cpal callback,
/// accumulates them into frames, runs FFT, emits DspFrame events to Angular.
pub fn run_dsp_loop(
    sample_rx: std::sync::mpsc::Receiver<Vec<f32>>,
    app_handle: AppHandle,
    sample_rate: u32,
) {
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let window = hann_window(FFT_SIZE);

    // Accumulate incoming chunks here until we have a full frame
    let mut ring_buffer: Vec<f32> = Vec::with_capacity(FFT_SIZE * 2);

    while let Ok(chunk) = sample_rx.recv() {
        ring_buffer.extend_from_slice(&chunk);

        // Process as many full frames as the buffer contains
        while ring_buffer.len() >= FFT_SIZE {
            // Apply Hann window element-wise to the frame
            let mut frame: Vec<f32> = ring_buffer[..FFT_SIZE]
                .iter()
                .zip(window.iter())
                .map(|(sample, w)| sample * w)
                .collect();

            // FFT output length is FFT_SIZE/2 + 1 for real-valued input
            let mut spectrum = fft.make_output_vec();

            // process() modifies `frame` in place as scratch space
            if let Err(e) = fft.process(&mut frame, &mut spectrum) {
                eprintln!("FFT error: {e}");
                break;
            }

            // Convert complex amplitudes to real magnitudes
            let magnitudes: Vec<f32> = spectrum.iter().map(|c| c.norm()).collect();

            let dsp_frame = analyze_spectrum(&magnitudes, sample_rate);

            // Fire-and-forget to Angular — Angular listens with listen('dsp-frame')
            app_handle.emit("dsp-frame", &dsp_frame).ok();

            // Slide the window forward by HOP_SIZE (50% overlap between frames)
            ring_buffer.drain(..HOP_SIZE);
        }
    }

    println!("DSP loop exiting");
}