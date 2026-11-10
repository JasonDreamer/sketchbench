//! 音声の再生(cpal)。再生中はこの再生位置がマスタークロックになる。
//! 出力の遅延はコールバックのタイムスタンプ(callback と playback の差)から求め、
//! 「いま耳に届いているサンプル位置」を返す。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

pub struct Player {
    pub sr: AtomicU64,
    /// 次にコールバックへ渡すサンプル位置(フレーム単位)
    pos: AtomicU64,
    playing: AtomicBool,
    buf: Mutex<Arc<Vec<f32>>>,
    /// 最後のコールバックの時刻と、その時点で書き始めた位置
    last: Mutex<Option<(Instant, u64)>>,
    latency_ns: AtomicU64,
    pub error: Mutex<Option<String>>,
}

impl Player {
    /// 既定の出力デバイスでストリームを開く。ストリームは専用スレッドが持ち続ける。
    pub fn start() -> Arc<Player> {
        let p = Arc::new(Player {
            sr: AtomicU64::new(48000),
            pos: AtomicU64::new(0),
            playing: AtomicBool::new(false),
            buf: Mutex::new(Arc::new(vec![])),
            last: Mutex::new(None),
            latency_ns: AtomicU64::new(0),
            error: Mutex::new(None),
        });
        let p2 = p.clone();
        std::thread::spawn(move || {
            if let Err(e) = run(p2.clone()) {
                *p2.error.lock().unwrap() = Some(e);
            }
        });
        p
    }

    pub fn sample_rate(&self) -> u32 {
        self.sr.load(Ordering::SeqCst) as u32
    }

    /// ミックス済みの音声(ステレオのインターリーブ、このプレイヤーのサンプルレート)を差し替える
    pub fn set_buffer(&self, b: Arc<Vec<f32>>) {
        *self.buf.lock().unwrap() = b;
    }

    pub fn has_audio(&self) -> bool {
        !self.buf.lock().unwrap().is_empty() && self.error.lock().unwrap().is_none()
    }

    pub fn play(&self, on: bool) {
        if on {
            *self.last.lock().unwrap() = None;
        } else {
            // 止めた位置は「耳に届いていた位置」にそろえる
            let s = self.position_secs();
            self.pos.store((s * self.sample_rate() as f64).max(0.0) as u64, Ordering::SeqCst);
        }
        self.playing.store(on, Ordering::SeqCst);
    }

    pub fn seek_secs(&self, s: f64) {
        self.pos.store((s.max(0.0) * self.sample_rate() as f64) as u64, Ordering::SeqCst);
        *self.last.lock().unwrap() = None;
    }

    pub fn latency(&self) -> Duration {
        Duration::from_nanos(self.latency_ns.load(Ordering::SeqCst))
    }

    /// 耳に届いている位置(秒)。再生中はコールバック時刻からの経過で補間する
    pub fn position_secs(&self) -> f64 {
        let sr = self.sample_rate() as f64;
        if !self.playing.load(Ordering::SeqCst) {
            return self.pos.load(Ordering::SeqCst) as f64 / sr;
        }
        match *self.last.lock().unwrap() {
            Some((t, start)) => {
                let since = t.elapsed().as_secs_f64() - self.latency().as_secs_f64();
                (start as f64 + since * sr).max(0.0) / sr
            }
            None => self.pos.load(Ordering::SeqCst) as f64 / sr,
        }
    }
}

fn run(p: Arc<Player>) -> Result<(), String> {
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or("音声の出力デバイスがない")?;
    let config = device.default_output_config().map_err(|e| e.to_string())?;
    if config.sample_format() != cpal::SampleFormat::F32 {
        return Err(format!("未対応の出力形式 {:?}(f32のみ)", config.sample_format()));
    }
    let config: cpal::StreamConfig = config.into();
    let channels = config.channels as usize;
    p.sr.store(config.sample_rate as u64, Ordering::SeqCst);
    let p2 = p.clone();
    let stream = device
        .build_output_stream(
            config,
            move |data: &mut [f32], info: &cpal::OutputCallbackInfo| {
                let ts = info.timestamp();
                if let Some(lat) = ts.playback.duration_since(ts.callback).checked_sub(Duration::ZERO) {
                    p2.latency_ns.store(lat.as_nanos() as u64, Ordering::SeqCst);
                }
                let frames = data.len() / channels;
                if !p2.playing.load(Ordering::SeqCst) {
                    data.fill(0.0);
                    return;
                }
                let start = p2.pos.fetch_add(frames as u64, Ordering::SeqCst);
                *p2.last.lock().unwrap() = Some((Instant::now(), start));
                let buf = p2.buf.lock().unwrap().clone();
                for i in 0..frames {
                    let s = (start as usize + i) * 2;
                    let (l, r) = if s + 1 < buf.len() { (buf[s], buf[s + 1]) } else { (0.0, 0.0) };
                    let o = &mut data[i * channels..(i + 1) * channels];
                    for (c, v) in o.iter_mut().enumerate() {
                        *v = if c % 2 == 0 { l } else { r };
                    }
                }
            },
            |e| eprintln!("音声出力: {e}"),
            None,
        )
        .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    // ストリームはこのスレッドが持ち続ける(Sendでないため)
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}
