//! ライブMIDI入力(midir)。受けたメッセージはプレビュー用のスケッチWebViewとUIへイベントで流す。
//! 録音中は作品の時刻と一緒に記録し、止めたら作品の assets/recordings/ に .mid として書く。
//! スケッチが直接ライブ入力を読むことはしない(書き出しで結果が変わるため)。録音したファイルを使う。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use midir::{MidiInput, MidiInputConnection};
use midly::live::LiveEvent;
use midly::{Format, Header, MetaMessage, Smf, Timing, TrackEvent, TrackEventKind};
use serde_json::{json, Value};
use tauri::Emitter;

use crate::core::Core;

#[derive(Default)]
pub struct LiveMidi {
    conns: Mutex<Vec<MidiInputConnection<()>>>,
    pub ports: Mutex<Vec<String>>,
    recording: Mutex<Option<Vec<(f64, Vec<u8>)>>>,
    /// 最後に受けたCCの値(channel, controller) → 0〜1
    pub last_cc: Mutex<HashMap<(u8, u8), f32>>,
}

/// MIDIメッセージをJSONにする(UIとスケッチ向け)
fn describe(bytes: &[u8]) -> Option<Value> {
    let ev = LiveEvent::parse(bytes).ok()?;
    let LiveEvent::Midi { channel, message } = ev else { return None };
    let ch = channel.as_int();
    use midly::MidiMessage::*;
    Some(match message {
        NoteOn { key, vel } if vel.as_int() > 0 => json!({ "type": "noteOn", "channel": ch, "note": key.as_int(), "velocity": vel.as_int() as f32 / 127.0 }),
        NoteOn { key, .. } | NoteOff { key, .. } => json!({ "type": "noteOff", "channel": ch, "note": key.as_int() }),
        Controller { controller, value } => json!({ "type": "cc", "channel": ch, "controller": controller.as_int(), "value": value.as_int() as f32 / 127.0 }),
        _ => return None,
    })
}

impl LiveMidi {
    /// 入力ポートをすべて開き直す
    pub fn connect_all(&self, core: Arc<Core>) -> Result<Vec<String>, String> {
        self.conns.lock().unwrap().clear();
        let probe = MidiInput::new("sketchbench").map_err(|e| e.to_string())?;
        let ports = probe.ports();
        let mut names = vec![];
        for port in ports.iter() {
            let name = probe.port_name(port).unwrap_or_else(|_| "?".into());
            let input = MidiInput::new("sketchbench").map_err(|e| e.to_string())?;
            let c2 = core.clone();
            match input.connect(port, "sketchbench-in", move |_us, bytes, _| c2.live.on_message(&c2, bytes), ()) {
                Ok(conn) => {
                    self.conns.lock().unwrap().push(conn);
                    names.push(name);
                }
                Err(e) => core.log("midi", "warn", format!("{name} を開けない: {e}"), Value::Null),
            }
        }
        *self.ports.lock().unwrap() = names.clone();
        Ok(names)
    }

    fn on_message(&self, core: &Arc<Core>, bytes: &[u8]) {
        let Some(mut v) = describe(bytes) else { return };
        if v["type"] == "cc" {
            let key = (v["channel"].as_u64().unwrap_or(0) as u8, v["controller"].as_u64().unwrap_or(0) as u8);
            self.last_cc.lock().unwrap().insert(key, v["value"].as_f64().unwrap_or(0.0) as f32);
        }
        let t = core.clock.msg();
        let secs = t.frame / t.fps;
        v["time"] = json!(secs);
        if let Some(rec) = self.recording.lock().unwrap().as_mut() {
            if t.playing {
                rec.push((secs, bytes.to_vec()));
            }
        }
        let label = core.preview_label.lock().unwrap().clone();
        let _ = core.app.emit_to(label.as_str(), "sb:midi", v.clone());
        let _ = core.app.emit_to("ui", "sb:midi", v);
    }

    pub fn is_recording(&self) -> bool {
        self.recording.lock().unwrap().is_some()
    }

    pub fn start_recording(&self) {
        *self.recording.lock().unwrap() = Some(vec![]);
    }

    /// 録音を止めて .mid に書く。何も入っていなければ書かない
    pub fn stop_recording(&self, work_dir: &Path) -> Result<Option<String>, String> {
        let Some(mut events) = self.recording.lock().unwrap().take() else { return Ok(None) };
        if events.is_empty() {
            return Ok(None);
        }
        events.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        // 120BPM・4分音符960ティックに固定: 1秒 = 1920ティック。秒からそのまま戻せる
        const TPS: f64 = 1920.0;
        let mut track: Vec<TrackEvent> = vec![TrackEvent { delta: 0.into(), kind: TrackEventKind::Meta(MetaMessage::Tempo(500_000.into())) }];
        let mut last = 0u64;
        let parsed: Vec<(u64, LiveEvent)> = events.iter().filter_map(|(t, b)| LiveEvent::parse(b).ok().map(|e| ((t * TPS).round().max(0.0) as u64, e))).collect();
        for (tick, ev) in parsed {
            if let LiveEvent::Midi { channel, message } = ev {
                let d = tick.saturating_sub(last);
                last = tick.max(last);
                track.push(TrackEvent { delta: (d as u32).into(), kind: TrackEventKind::Midi { channel, message } });
            }
        }
        track.push(TrackEvent { delta: 0.into(), kind: TrackEventKind::Meta(MetaMessage::EndOfTrack) });
        let mut smf = Smf::new(Header::new(Format::SingleTrack, Timing::Metrical(960.into())));
        smf.tracks.push(track);
        let dir = work_dir.join("assets").join("recordings");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let name = format!("rec_{}.mid", crate::workspace::local_stamp());
        let path: PathBuf = dir.join(&name);
        smf.save(&path).map_err(|e| e.to_string())?;
        Ok(Some(format!("assets/recordings/{name}")))
    }
}
