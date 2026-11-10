//! 音声: デコード(Symphonia)、リサンプル(rubato)、解析(RMS・帯域・オンセット・ビート)、ミックス。
//! 解析は読み込み時に一度だけ行い、作品の .cache/audio/ に保存する。シークや書き出しで値がずれないよう、
//! スケッチは常にこの解析結果を時刻で引く。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Async, FixedAsync, Indexing, Resampler, SincInterpolationParameters, SincInterpolationType, WindowFunction};
use serde::{Deserialize, Serialize};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

use crate::workspace::{Project, AudioEntry};

/// 解析器の版。変えたらキャッシュを作り直す
const ANALYZER_VERSION: u32 = 1;
/// 解析値の時間解像度(1秒あたりの値の数)
pub const ANALYSIS_RATE: u32 = 100;

pub struct Pcm {
    pub sr: u32,
    pub channels: usize,
    /// インターリーブ
    pub samples: Vec<f32>,
}

pub fn decode(path: &Path) -> Result<Pcm, String> {
    let src = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(src), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let mut format = symphonia::default::get_probe()
        .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
        .map_err(|e| format!("{}: {e}", path.display()))?;
    let track = format.first_track_known_codec(TrackType::Audio).ok_or("音声トラックがない")?;
    let track_id = track.id;
    let params = track.codec_params.as_ref().and_then(|p| p.audio()).ok_or("音声のコーデック情報がない")?;
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(params, &AudioDecoderOptions::default())
        .map_err(|e| e.to_string())?;
    let (mut samples, mut scratch) = (Vec::new(), Vec::new());
    let (mut sr, mut channels) = (0u32, 0usize);
    while let Some(packet) = format.next_packet().map_err(|e| e.to_string())? {
        if packet.track_id != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(d) => {
                sr = d.spec().rate();
                channels = d.spec().channels().count();
                d.copy_to_vec_interleaved(&mut scratch);
                samples.extend_from_slice(&scratch);
            }
            Err(SymError::DecodeError(_)) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    if sr == 0 {
        return Err("音声を1つもデコードできない".into());
    }
    Ok(Pcm { sr, channels, samples })
}

/// 1チャンネルを別のサンプルレートへ。フィルターの遅延を差し引き、長さを入力の時間に合わせる。
fn resample_channel(input: &[f32], from: u32, to: u32) -> Result<Vec<f32>, String> {
    if from == to {
        return Ok(input.to_vec());
    }
    const CHUNK: usize = 1024;
    let ratio = to as f64 / from as f64;
    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };
    let mut r = Async::<f32>::new_sinc(ratio, 1.0, &params, CHUNK, 1, FixedAsync::Input).map_err(|e| e.to_string())?;
    let delay = r.output_delay();
    let want = (input.len() as f64 * ratio).round() as usize;
    let mut out = Vec::with_capacity(want + delay + CHUNK * 2);
    let mut buf = vec![0f32; r.output_frames_max()];
    let mut pos = 0;
    // 入力の末尾(1チャンクに満たない分)と、遅延分を押し出すための無音
    let mut tail = vec![0f32; CHUNK];
    while out.len() < want + delay {
        let (chunk, partial): (&[f32], Option<usize>) = if pos + CHUNK <= input.len() {
            (&input[pos..pos + CHUNK], None)
        } else if pos < input.len() {
            let n = input.len() - pos;
            tail.fill(0.0);
            tail[..n].copy_from_slice(&input[pos..]);
            (&tail[..], Some(n))
        } else {
            tail.fill(0.0);
            (&tail[..], Some(0))
        };
        pos += CHUNK;
        let inp = InterleavedSlice::new(chunk, 1, CHUNK).map_err(|e| format!("{e:?}"))?;
        let n_out = r.output_frames_next();
        let mut outp = InterleavedSlice::new_mut(&mut buf, 1, n_out).map_err(|e| format!("{e:?}"))?;
        let idx = partial.map(|n| Indexing { input_offset: 0, output_offset: 0, partial_len: Some(n), active_channels_mask: None });
        let (_, written) = r.process_into_buffer(&inp, &mut outp, idx.as_ref()).map_err(|e| e.to_string())?;
        out.extend_from_slice(&buf[..written]);
        if pos > input.len() + CHUNK * 64 {
            break;
        }
    }
    let end = (delay + want).min(out.len());
    Ok(out[delay.min(end)..end].to_vec())
}

/// ステレオのインターリーブにして、指定のサンプルレートへ。
pub fn to_stereo(pcm: &Pcm, sr: u32) -> Result<Vec<f32>, String> {
    let ch = pcm.channels.max(1);
    let frames = pcm.samples.len() / ch;
    let pick = |c: usize| -> Vec<f32> { (0..frames).map(|i| pcm.samples[i * ch + c.min(ch - 1)]).collect() };
    let l = resample_channel(&pick(0), pcm.sr, sr)?;
    let r = if ch == 1 { l.clone() } else { resample_channel(&pick(1), pcm.sr, sr)? };
    let n = l.len().min(r.len());
    let mut out = Vec::with_capacity(n * 2);
    for i in 0..n {
        out.push(l[i]);
        out.push(r[i]);
    }
    Ok(out)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub version: u32,
    pub source: String,
    pub sample_rate: u32,
    pub channels: usize,
    /// 秒
    pub duration: f64,
    /// 値の時間解像度(1秒あたりの数)
    pub rate: u32,
    /// 0〜1に正規化したRMS
    pub rms: Vec<f32>,
    /// 0〜1に正規化した帯域エネルギー(low: 〜200Hz、mid: 200〜2000Hz、high: 2000Hz〜)
    pub low: Vec<f32>,
    pub mid: Vec<f32>,
    pub high: Vec<f32>,
    /// オンセットの時刻(秒)
    pub onsets: Vec<f32>,
    /// ビートと小節頭の時刻(秒)。Beat This!(beat-thisクレート)
    pub beats: Vec<f32>,
    pub downbeats: Vec<f32>,
    pub bpm: Option<f32>,
    /// ビート推定に使ったモデル。モデルがないときは null で beats は空
    pub beat_model: Option<String>,
    /// 波形表示用: 1/ rate 秒ごとの最小値と最大値
    pub wave_min: Vec<f32>,
    pub wave_max: Vec<f32>,
}

fn normalize(v: &mut [f32]) {
    // 外れ値に引っぱられないよう、99.5パーセンタイルを1にする
    let mut s: Vec<f32> = v.iter().copied().filter(|x| x.is_finite()).collect();
    if s.is_empty() {
        return;
    }
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let top = s[((s.len() - 1) as f32 * 0.995) as usize].max(1e-9);
    for x in v.iter_mut() {
        *x = (*x / top).clamp(0.0, 1.0);
    }
}

/// モデルの場所: %LOCALAPPDATA%\sketchbench\models(tools/fetch-models.sh で取得する)
pub fn models_dir() -> PathBuf {
    std::env::var("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(".")).join("sketchbench").join("models")
}

pub fn analyze(path: &Path) -> Result<Analysis, String> {
    let pcm = decode(path)?;
    let ch = pcm.channels.max(1);
    let mono: Vec<f32> = pcm.samples.chunks(ch).map(|f| f.iter().sum::<f32>() / ch as f32).collect();
    let sr = pcm.sr as usize;
    let hop = sr / ANALYSIS_RATE as usize;
    let win = 2048usize;
    let n = mono.len().div_ceil(hop);
    let mut planner = rustfft::FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(win);
    let hann: Vec<f32> = (0..win).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / win as f32).cos()).collect();
    let (mut rms, mut low, mut mid, mut high, mut flux) = (vec![0f32; n], vec![0f32; n], vec![0f32; n], vec![0f32; n], vec![0f32; n]);
    let (mut wmin, mut wmax) = (vec![0f32; n], vec![0f32; n]);
    let mut prev_mag = vec![0f32; win / 2];
    let bin_hz = sr as f32 / win as f32;
    let mut buf = vec![rustfft::num_complex::Complex32::new(0.0, 0.0); win];
    for i in 0..n {
        let center = i * hop;
        // RMSと波形は hop の区間、スペクトルは中心に合わせた窓
        let seg = &mono[center.min(mono.len())..(center + hop).min(mono.len())];
        if !seg.is_empty() {
            rms[i] = (seg.iter().map(|x| x * x).sum::<f32>() / seg.len() as f32).sqrt();
            wmin[i] = seg.iter().copied().fold(f32::MAX, f32::min);
            wmax[i] = seg.iter().copied().fold(f32::MIN, f32::max);
        }
        for (k, b) in buf.iter_mut().enumerate() {
            let j = center as isize + k as isize - (win / 2) as isize;
            let x = if j >= 0 && (j as usize) < mono.len() { mono[j as usize] } else { 0.0 };
            *b = rustfft::num_complex::Complex32::new(x * hann[k], 0.0);
        }
        fft.process(&mut buf);
        let mut f = 0f32;
        for k in 1..win / 2 {
            let m = buf[k].norm();
            let e = m * m;
            let hz = k as f32 * bin_hz;
            if hz < 200.0 {
                low[i] += e;
            } else if hz < 2000.0 {
                mid[i] += e;
            } else {
                high[i] += e;
            }
            f += (m - prev_mag[k]).max(0.0);
            prev_mag[k] = m;
        }
        flux[i] = f;
    }
    for v in [&mut low, &mut mid, &mut high] {
        for x in v.iter_mut() {
            *x = x.sqrt();
        }
    }
    // オンセット: スペクトルフラックスの局所最大で、周囲の平均より十分大きいもの
    let mut onsets = vec![];
    let w = 10usize;
    for i in 1..n.saturating_sub(1) {
        let lo = i.saturating_sub(w);
        let hi = (i + w).min(n - 1);
        let mean = flux[lo..=hi].iter().sum::<f32>() / (hi - lo + 1) as f32;
        let is_peak = flux[i] >= flux[i - 1] && flux[i] > flux[i + 1] && flux[i] == flux[lo..=hi].iter().copied().fold(0.0, f32::max);
        if is_peak && flux[i] > mean * 1.5 && flux[i] > 1e-3 {
            if onsets.last().is_none_or(|&t: &f32| i as f32 / ANALYSIS_RATE as f32 - t > 0.05) {
                onsets.push(i as f32 / ANALYSIS_RATE as f32);
            }
        }
    }
    for v in [&mut rms, &mut low, &mut mid, &mut high] {
        normalize(v);
    }
    // ビート: beat-this(rten)。フルモデルがなければ小モデル、どちらもなければ省く
    let md = models_dir();
    let mel = md.join("mel_spectrogram.onnx");
    let model = ["beat_this.onnx", "beat_this_small.onnx"].iter().map(|f| md.join(f)).find(|p| p.exists());
    let (mut beats, mut downbeats, mut bpm, mut beat_model) = (vec![], vec![], None, None);
    if let (true, Some(model)) = (mel.exists(), model) {
        match beat_this::BeatThis::new(&beat_this::RtenRuntime, &mel, &model).and_then(|mut bt| bt.analyze_audio(&mono, pcm.sr)) {
            Ok(a) => {
                bpm = beat_this::calculate_bpm(&a);
                beats = a.beats;
                downbeats = a.downbeats;
                beat_model = model.file_name().map(|s| s.to_string_lossy().to_string());
            }
            Err(e) => eprintln!("beat-this: {e}"),
        }
    }
    Ok(Analysis {
        version: ANALYZER_VERSION,
        source: path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
        sample_rate: pcm.sr,
        channels: pcm.channels,
        duration: mono.len() as f64 / pcm.sr as f64,
        rate: ANALYSIS_RATE,
        rms,
        low,
        mid,
        high,
        onsets,
        beats,
        downbeats,
        bpm,
        beat_model,
        wave_min: wmin,
        wave_max: wmax,
    })
}

/// 解析結果をキャッシュから返す。キーはファイルの内容ハッシュと解析器の版とモデル名。
pub fn analysis_cached(work_dir: &Path, asset: &Path) -> Result<String, String> {
    static LOCK: Mutex<()> = Mutex::new(());
    let _g = LOCK.lock().unwrap();
    let bytes = std::fs::read(asset).map_err(|e| format!("{}: {e}", asset.display()))?;
    let models: Vec<String> = ["beat_this.onnx", "beat_this_small.onnx"].iter().filter(|f| models_dir().join(f).exists()).map(|s| s.to_string()).collect();
    let key = blake3::hash(&[bytes.as_slice(), format!("v{ANALYZER_VERSION}{models:?}").as_bytes()].concat()).to_hex()[..16].to_string();
    let dir = work_dir.join(".cache").join("audio");
    let file = dir.join(format!("{key}.json"));
    if let Ok(s) = std::fs::read_to_string(&file) {
        return Ok(s);
    }
    let a = analyze(asset)?;
    let s = serde_json::to_string(&a).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(&file, &s).map_err(|e| e.to_string())?;
    Ok(s)
}

/// 作品の音声トラックをミックスする。範囲は作品のフレーム [from, to)。戻り値はステレオのインターリーブ。
pub fn mixdown(work_dir: &Path, p: &Project, sr: u32, from: u64, to: u64) -> Result<Vec<f32>, String> {
    let fps = p.fps_f64();
    let t0 = from as f64 / fps;
    let len = (((to - from) as f64 / fps) * sr as f64).round() as usize;
    let mut out = vec![0f32; len * 2];
    for a in &p.audio {
        let stereo = load_stereo(work_dir, a, sr)?;
        // offset は作品のフレーム。音声の先頭が作品時刻 offset/fps に来る
        let start = a.offset as f64 / fps;
        let gain = a.gain.unwrap_or(1.0);
        for i in 0..len {
            let src = ((t0 - start) * sr as f64).round() as i64 + i as i64;
            if src < 0 || (src as usize) * 2 + 1 >= stereo.len() {
                continue;
            }
            out[i * 2] += stereo[src as usize * 2] * gain;
            out[i * 2 + 1] += stereo[src as usize * 2 + 1] * gain;
        }
    }
    Ok(out)
}

/// ファイルとサンプルレートごとに、ステレオへ変換した音声をメモリに保持する。
pub fn load_stereo(work_dir: &Path, a: &AudioEntry, sr: u32) -> Result<std::sync::Arc<Vec<f32>>, String> {
    use std::collections::HashMap;
    use std::sync::Arc;
    static CACHE: Mutex<Option<HashMap<(PathBuf, u32, std::time::SystemTime), Arc<Vec<f32>>>>> = Mutex::new(None);
    let path = crate::workspace::safe_rel(work_dir, &a.asset).ok_or("音声のパスが作品の外を指している")?;
    let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).map_err(|e| format!("{}: {e}", path.display()))?;
    let key = (path.clone(), sr, mtime);
    if let Some(v) = CACHE.lock().unwrap().get_or_insert_with(HashMap::new).get(&key) {
        return Ok(v.clone());
    }
    let pcm = decode(&path)?;
    let v = Arc::new(to_stereo(&pcm, sr)?);
    CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(key, v.clone());
    Ok(v)
}
