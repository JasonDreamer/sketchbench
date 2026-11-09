//! マスタークロック。フェーズ1は音声がないので、Rust側の単調時計で再生位置を進める。
//! 時刻はフレーム番号(f64)と有理数のfpsで持つ。

use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeMsg {
    /// 送信時点のフレーム位置(小数を含む)
    pub frame: f64,
    pub playing: bool,
    pub fps: f64,
    pub duration: u64,
    /// 送信時点のUNIX時刻(ms)。受け手はこれと自分の時計の差で補間する
    pub unix_ms: f64,
}

struct State {
    playing: bool,
    anchor: Instant,
    anchor_frame: f64,
    fps: f64,
    duration: u64,
}

pub struct Clock {
    s: Mutex<State>,
}

pub fn unix_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

impl Default for Clock {
    fn default() -> Self {
        Clock { s: Mutex::new(State { playing: false, anchor: Instant::now(), anchor_frame: 0.0, fps: 30.0, duration: 300 }) }
    }
}

impl Clock {
    fn frame_of(s: &State) -> f64 {
        if !s.playing {
            return s.anchor_frame;
        }
        let f = s.anchor_frame + s.anchor.elapsed().as_secs_f64() * s.fps;
        if s.duration > 0 {
            f % s.duration as f64
        } else {
            f
        }
    }

    pub fn msg(&self) -> TimeMsg {
        let s = self.s.lock().unwrap();
        TimeMsg { frame: Self::frame_of(&s), playing: s.playing, fps: s.fps, duration: s.duration, unix_ms: unix_ms() }
    }

    pub fn configure(&self, fps: f64, duration: u64) {
        let mut s = self.s.lock().unwrap();
        let f = Self::frame_of(&s);
        s.fps = fps;
        s.duration = duration;
        s.anchor = Instant::now();
        s.anchor_frame = if duration > 0 { f.min(duration as f64 - 1.0).max(0.0) } else { f };
    }

    pub fn play(&self, playing: bool) {
        let mut s = self.s.lock().unwrap();
        let f = Self::frame_of(&s);
        s.anchor = Instant::now();
        s.anchor_frame = f;
        s.playing = playing;
    }

    pub fn seek(&self, frame: f64) {
        let mut s = self.s.lock().unwrap();
        s.anchor = Instant::now();
        let max = if s.duration > 0 { s.duration as f64 - 1.0 } else { f64::MAX };
        s.anchor_frame = frame.clamp(0.0, max);
    }
}
