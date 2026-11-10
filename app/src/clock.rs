//! マスタークロック。時刻はフレーム番号(f64)と有理数のfpsで持つ。
//! 音声があるときは再生位置(cpal)が時刻を駆動し、ないときはRust側の単調時計で進める。

use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::player::Player;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeMsg {
    /// 送信時点のフレーム位置(小数を含む)
    pub frame: f64,
    pub playing: bool,
    pub fps: f64,
    /// 有理数のfps [分子, 分母]
    pub fps_ratio: [u32; 2],
    pub duration: u64,
    /// 送信時点のUNIX時刻(ms)。受け手はこれと自分の時計の差で補間する
    pub unix_ms: f64,
    /// 音声が時刻を駆動しているか
    pub audio: bool,
}

struct State {
    playing: bool,
    anchor: Instant,
    anchor_frame: f64,
    fps: [u32; 2],
    duration: u64,
}

pub struct Clock {
    s: Mutex<State>,
    player: Mutex<Option<Arc<Player>>>,
}

pub fn unix_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

impl Default for Clock {
    fn default() -> Self {
        Clock {
            s: Mutex::new(State { playing: false, anchor: Instant::now(), anchor_frame: 0.0, fps: [30, 1], duration: 300 }),
            player: Mutex::new(None),
        }
    }
}

fn fps_f(r: [u32; 2]) -> f64 {
    r[0] as f64 / r[1].max(1) as f64
}

impl Clock {
    pub fn set_player(&self, p: Option<Arc<Player>>) {
        *self.player.lock().unwrap() = p;
    }

    fn audio(&self) -> Option<Arc<Player>> {
        self.player.lock().unwrap().clone().filter(|p| p.has_audio())
    }

    fn frame_of(&self, s: &State) -> f64 {
        if !s.playing {
            return s.anchor_frame;
        }
        let f = match self.audio() {
            Some(p) => p.position_secs() * fps_f(s.fps),
            None => s.anchor_frame + s.anchor.elapsed().as_secs_f64() * fps_f(s.fps),
        };
        if s.duration > 0 {
            f % s.duration as f64
        } else {
            f
        }
    }

    pub fn msg(&self) -> TimeMsg {
        let s = self.s.lock().unwrap();
        TimeMsg {
            frame: self.frame_of(&s),
            playing: s.playing,
            fps: fps_f(s.fps),
            fps_ratio: s.fps,
            duration: s.duration,
            unix_ms: unix_ms(),
            audio: self.audio().is_some(),
        }
    }

    pub fn configure(&self, fps: [u32; 2], duration: u64) {
        let mut s = self.s.lock().unwrap();
        let f = self.frame_of(&s);
        s.fps = fps;
        s.duration = duration;
        s.anchor = Instant::now();
        s.anchor_frame = if duration > 0 { f.min(duration as f64 - 1.0).max(0.0) } else { f };
    }

    pub fn play(&self, playing: bool) {
        let mut s = self.s.lock().unwrap();
        let f = self.frame_of(&s);
        s.anchor = Instant::now();
        s.anchor_frame = f;
        s.playing = playing;
        if let Some(p) = self.player.lock().unwrap().as_ref() {
            p.seek_secs(f / fps_f(s.fps));
            p.play(playing);
        }
    }

    pub fn seek(&self, frame: f64) {
        let mut s = self.s.lock().unwrap();
        s.anchor = Instant::now();
        let max = if s.duration > 0 { s.duration as f64 - 1.0 } else { f64::MAX };
        s.anchor_frame = frame.clamp(0.0, max);
        if let Some(p) = self.player.lock().unwrap().as_ref() {
            p.seek_secs(s.anchor_frame / fps_f(s.fps));
        }
    }

    /// 音声が尺の終わりを越えたら先頭へ戻す(ループ再生)。時刻の配信ループから呼ぶ
    pub fn wrap_audio(&self) {
        let s = self.s.lock().unwrap();
        if !s.playing || s.duration == 0 {
            return;
        }
        if let Some(p) = self.audio() {
            if p.position_secs() * fps_f(s.fps) >= s.duration as f64 {
                p.seek_secs(0.0);
            }
        }
    }
}
