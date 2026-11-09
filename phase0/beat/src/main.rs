//! 使い方: sb-phase0-beat <modelsディレクトリ> <goldenのjson> <音声ファイル> <出力json>
//! 1. Python版(beat_this)が出したgoldenと、Rust版の結果を±70msのF値で比べる
//! 2. 正解の分かっている合成クリック(120BPM、4拍子、1拍目を強調)で拍と小節頭を確かめる

use std::path::Path;
use std::time::Instant;

use beat_this::{BeatThis, RtenRuntime};
use serde_json::{json, Value};

const WINDOW: f64 = 0.070;

/// 各推定値を最も近い未使用の正解に1対1で割り当て、F値と時刻差を返す。
fn score(est: &[f32], reference: &[f64]) -> Value {
    let mut used = vec![false; reference.len()];
    let mut diffs = vec![];
    for &e in est {
        let e = e as f64;
        let mut best: Option<(usize, f64)> = None;
        for (i, &r) in reference.iter().enumerate() {
            let d = (e - r).abs();
            if !used[i] && d <= WINDOW && best.map_or(true, |(_, bd)| d < bd) {
                best = Some((i, d));
            }
        }
        if let Some((i, d)) = best {
            used[i] = true;
            diffs.push(d);
        }
    }
    let tp = diffs.len() as f64;
    let p = if est.is_empty() { 0.0 } else { tp / est.len() as f64 };
    let r = if reference.is_empty() { 0.0 } else { tp / reference.len() as f64 };
    let f = if p + r == 0.0 { 0.0 } else { 2.0 * p * r / (p + r) };
    let mean = if diffs.is_empty() { 0.0 } else { diffs.iter().sum::<f64>() / tp };
    let max = diffs.iter().cloned().fold(0.0, f64::max);
    json!({
        "f_measure": (f * 10000.0).round() / 10000.0,
        "matched": diffs.len(), "n_est": est.len(), "n_ref": reference.len(),
        "mean_diff_ms": (mean * 10000.0).round() / 10.0, "max_diff_ms": (max * 10000.0).round() / 10.0,
    })
}

fn floats(v: &Value) -> Vec<f64> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_f64()).collect()).unwrap_or_default()
}

/// 120BPM・4/4のクリック。1拍目は低い音で強く、他は高い音。
fn click_track(sr: u32, secs: f64, bpm: f64) -> (Vec<f32>, Vec<f64>, Vec<f64>) {
    let n = (sr as f64 * secs) as usize;
    let mut s = vec![0f32; n];
    let period = 60.0 / bpm;
    let (mut beats, mut downs) = (vec![], vec![]);
    let mut k = 0;
    let start = 0.5;
    loop {
        let t = start + k as f64 * period;
        if t > secs - 0.5 {
            break;
        }
        let down = k % 4 == 0;
        beats.push(t);
        if down {
            downs.push(t);
        }
        let (freq, amp, len) = if down { (110.0, 0.9, 0.12) } else { (1760.0, 0.5, 0.04) };
        let i0 = (t * sr as f64) as usize;
        for j in 0..(len * sr as f64) as usize {
            let tt = j as f64 / sr as f64;
            if let Some(x) = s.get_mut(i0 + j) {
                *x += (amp * (-tt * 40.0).exp() * (2.0 * std::f64::consts::PI * freq * tt).sin()) as f32;
            }
        }
        k += 1;
    }
    (s, beats, downs)
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let models = Path::new(&a[1]);
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(&a[2]).unwrap()).unwrap();
    let audio = Path::new(&a[3]);
    let mut out = json!({ "os": std::env::consts::OS, "arch": std::env::consts::ARCH, "backend": "rten (default)" });

    for (name, file) in [("full", "beat_this.onnx"), ("small", "beat_this_small.onnx")] {
        let t0 = Instant::now();
        let mut bt = BeatThis::new(&RtenRuntime, &models.join("mel_spectrogram.onnx"), &models.join(file)).expect("load models");
        let load_ms = t0.elapsed().as_millis();
        let t1 = Instant::now();
        let r = bt.analyze_file(audio).expect("analyze");
        let analyze_ms = t1.elapsed().as_millis();
        let mut entry = json!({ "model_load_ms": load_ms, "analyze_ms": analyze_ms, "bpm": beat_this::calculate_bpm(&r) });
        if name == "full" {
            entry["vs_python_golden"] = json!({
                "beats": score(&r.beats, &floats(&golden["beats"])),
                "downbeats": score(&r.downbeats, &floats(&golden["downbeats"])),
                "golden_provenance": golden["provenance"].clone(),
            });
        }
        // 合成クリック
        let (sig, beats, downs) = click_track(44100, 30.0, 120.0);
        let t2 = Instant::now();
        let c = bt.analyze_audio(&sig, 44100).expect("analyze click");
        entry["click_120bpm_30s"] = json!({
            "analyze_ms": t2.elapsed().as_millis(),
            "beats": score(&c.beats, &beats),
            "downbeats": score(&c.downbeats, &downs),
            "bpm": beat_this::calculate_bpm(&c),
        });
        out[name] = entry;
    }
    let s = serde_json::to_string_pretty(&out).unwrap();
    println!("{s}");
    std::fs::write(&a[4], s).unwrap();
}
