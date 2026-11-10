//! MIDIファイル(.mid)を読み、ノート・CC・テンポ・拍子・マーカーを秒に変換する(midly)。

use std::path::Path;

use midly::{MetaMessage, MidiMessage, Smf, Timing, TrackEventKind};
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct Note {
    pub pitch: u8,
    /// 0〜1
    pub velocity: f32,
    pub channel: u8,
    pub track: usize,
    pub start: f64,
    pub end: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Cc {
    pub channel: u8,
    pub controller: u8,
    /// 0〜1
    pub value: f32,
    pub time: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiData {
    pub duration: f64,
    pub notes: Vec<Note>,
    pub cc: Vec<Cc>,
    /// [時刻, BPM]
    pub tempos: Vec<(f64, f64)>,
    /// [時刻, 分子, 分母]
    pub time_signatures: Vec<(f64, u8, u32)>,
    /// [時刻, 名前](マーカーとキューポイント)
    pub markers: Vec<(f64, String)>,
    pub track_names: Vec<String>,
}

pub fn parse(path: &Path) -> Result<MidiData, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let smf = Smf::parse(&bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    // 全トラックのイベントを絶対ティックに直す
    let mut events: Vec<(u64, usize, TrackEventKind)> = vec![];
    for (ti, track) in smf.tracks.iter().enumerate() {
        let mut tick = 0u64;
        for ev in track {
            tick += ev.delta.as_int() as u64;
            events.push((tick, ti, ev.kind));
        }
    }
    events.sort_by_key(|e| e.0);
    // ティック→秒(テンポの変化を順に積む)
    let (tpq, fixed_sec_per_tick) = match smf.header.timing {
        Timing::Metrical(t) => (t.as_int() as f64, None),
        Timing::Timecode(fps, sub) => (1.0, Some(1.0 / (fps.as_f32() as f64 * sub as f64))),
    };
    let mut us_per_q = 500_000f64;
    let (mut last_tick, mut last_sec) = (0u64, 0f64);
    let mut to_sec = |tick: u64, us: f64| -> f64 {
        let dt = (tick - last_tick) as f64;
        let s = last_sec + fixed_sec_per_tick.map(|k| dt * k).unwrap_or(dt * us / 1e6 / tpq);
        last_tick = tick;
        last_sec = s;
        s
    };
    let mut out = MidiData { duration: 0.0, notes: vec![], cc: vec![], tempos: vec![], time_signatures: vec![], markers: vec![], track_names: vec![String::new(); smf.tracks.len()] };
    // 発音中のノート: (track, channel, pitch) → (開始秒, ベロシティ)
    let mut open: std::collections::HashMap<(usize, u8, u8), Vec<(f64, f32)>> = Default::default();
    for (tick, ti, kind) in events {
        let t = to_sec(tick, us_per_q);
        out.duration = out.duration.max(t);
        match kind {
            TrackEventKind::Meta(MetaMessage::Tempo(v)) => {
                us_per_q = v.as_int() as f64;
                out.tempos.push((t, 60e6 / us_per_q));
            }
            TrackEventKind::Meta(MetaMessage::TimeSignature(num, den_pow, _, _)) => out.time_signatures.push((t, num, 1u32 << den_pow)),
            TrackEventKind::Meta(MetaMessage::Marker(s)) | TrackEventKind::Meta(MetaMessage::CuePoint(s)) => {
                out.markers.push((t, String::from_utf8_lossy(s).to_string()))
            }
            TrackEventKind::Meta(MetaMessage::TrackName(s)) => out.track_names[ti] = String::from_utf8_lossy(s).to_string(),
            TrackEventKind::Midi { channel, message } => {
                let ch = channel.as_int();
                match message {
                    MidiMessage::NoteOn { key, vel } if vel.as_int() > 0 => {
                        open.entry((ti, ch, key.as_int())).or_default().push((t, vel.as_int() as f32 / 127.0));
                    }
                    MidiMessage::NoteOn { key, .. } | MidiMessage::NoteOff { key, .. } => {
                        if let Some(v) = open.get_mut(&(ti, ch, key.as_int())) {
                            if !v.is_empty() {
                                let (start, velocity) = v.remove(0);
                                out.notes.push(Note { pitch: key.as_int(), velocity, channel: ch, track: ti, start, end: t });
                            }
                        }
                    }
                    MidiMessage::Controller { controller, value } => {
                        out.cc.push(Cc { channel: ch, controller: controller.as_int(), value: value.as_int() as f32 / 127.0, time: t })
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    // 閉じていないノートは最後のイベントで終える
    for ((ti, ch, pitch), v) in open {
        for (start, velocity) in v {
            out.notes.push(Note { pitch, velocity, channel: ch, track: ti, start, end: out.duration.max(start) });
        }
    }
    out.notes.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap().then(a.pitch.cmp(&b.pitch)));
    if out.tempos.is_empty() {
        out.tempos.push((0.0, 120.0));
    }
    Ok(out)
}
