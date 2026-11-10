//! project.json の唯一の書き手。UIやMCPは「この値をこう変える」という操作を送り、ここで適用する。
//! 知らないキーを消さないよう、型に直さずJSONのまま扱う(キーの順序も保つ)。
//! 操作1回が取り消し1単位。

use std::path::Path;
use std::sync::Mutex;

use serde::Deserialize;
use serde_json::{json, Map, Value};

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Op {
    /// クリップを追加する(idはここで採番して返す)
    #[serde(rename_all = "camelCase")]
    AddClips { layer: String, track: String, clips: Vec<Value> },
    /// クリップの start・end を変え、value はフィールド単位で上書きする
    #[serde(rename_all = "camelCase")]
    UpdateClip { layer: String, track: String, id: String, start: Option<i64>, end: Option<i64>, value: Option<Map<String, Value>> },
    #[serde(rename_all = "camelCase")]
    DeleteClips { layer: String, track: String, ids: Vec<String> },
    /// クリップを at(フレーム)で2つに分ける
    #[serde(rename_all = "camelCase")]
    SplitClip { layer: String, track: String, id: String, at: i64 },
    /// マーカーを丸ごと置き換える
    SetMarkers { markers: Vec<Value> },
    /// BPMと拍0の位置(フレーム)
    #[serde(rename_all = "camelCase")]
    SetTempo { bpm: Option<f64>, beat_offset: Option<i64> },
    /// paramsの値(キーフレームはフェーズ4)
    #[serde(rename_all = "camelCase")]
    SetParam { layer: String, name: String, value: Value },
    /// イベント対応表とCC割り当てを丸ごと置き換える
    #[serde(rename_all = "camelCase")]
    SetEventMap { event_map: Value },
    #[serde(rename_all = "camelCase")]
    SetCcMap { cc_map: Value },
}

impl Op {
    pub fn label(&self) -> String {
        match self {
            Op::AddClips { clips, .. } => format!("クリップを{}個追加", clips.len()),
            Op::UpdateClip { .. } => "クリップを変更".into(),
            Op::DeleteClips { ids, .. } => format!("クリップを{}個削除", ids.len()),
            Op::SplitClip { .. } => "クリップを分割".into(),
            Op::SetMarkers { .. } => "マーカーを変更".into(),
            Op::SetTempo { .. } => "BPMを変更".into(),
            Op::SetParam { name, .. } => format!("{name} を変更"),
            Op::SetEventMap { .. } => "イベント対応表を変更".into(),
            Op::SetCcMap { .. } => "CC割り当てを変更".into(),
        }
    }
}

struct Step {
    label: String,
    before: String,
    after: String,
}

#[derive(Default)]
pub struct Editor {
    undo: Mutex<Vec<Step>>,
    redo: Mutex<Vec<Step>>,
    seq: Mutex<u64>,
}

fn read(dir: &Path) -> Result<(String, Value), String> {
    let s = std::fs::read_to_string(dir.join("project.json")).map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&s).map_err(|e| format!("project.json が正しいJSONではないので書き込みを止めた: {e}"))?;
    Ok((s, v))
}

fn write(dir: &Path, v: &Value) -> Result<String, String> {
    let mut s = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    s.push('\n');
    // 途中で落ちても壊れたファイルを残さないよう、一時ファイルから置き換える
    let tmp = dir.join("project.json.tmp");
    std::fs::write(&tmp, &s).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join("project.json")).map_err(|e| e.to_string())?;
    Ok(s)
}

fn layer_mut<'a>(v: &'a mut Value, id: &str) -> Result<&'a mut Map<String, Value>, String> {
    v["layers"]
        .as_array_mut()
        .and_then(|ls| ls.iter_mut().find(|l| l["id"] == id))
        .and_then(|l| l.as_object_mut())
        .ok_or(format!("レイヤー {id} がない"))
}

fn track_mut<'a>(v: &'a mut Value, layer: &str, track: &str) -> Result<&'a mut Map<String, Value>, String> {
    let l = layer_mut(v, layer)?;
    let tracks = l.entry("tracks").or_insert_with(|| json!({}));
    let t = tracks.as_object_mut().ok_or("tracks がオブジェクトではない")?.entry(track.to_string()).or_insert_with(|| json!({}));
    t.as_object_mut().ok_or(format!("tracks.{track} がオブジェクトではない"))
}

impl Editor {
    /// 作成順に並ぶ不変のid(作成時刻のミリ秒と通し番号を36進で)
    fn new_id(&self) -> String {
        let mut seq = self.seq.lock().unwrap();
        *seq += 1;
        let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0) as u64;
        format!("c_{}{:0>2}", base36(ms), base36(*seq % 1296))
    }

    pub fn apply(&self, dir: &Path, op: Op) -> Result<Value, String> {
        let (before, mut v) = read(dir)?;
        let label = op.label();
        let mut result = json!({});
        match op {
            Op::AddClips { layer, track, clips } => {
                let mut ids = vec![];
                let mut fresh = vec![];
                for c in clips {
                    let id = self.new_id();
                    let start = c["start"].as_i64().ok_or("start(フレーム)がない")?;
                    let end = c["end"].as_i64().unwrap_or(start + 1).max(start + 1);
                    fresh.push((id.clone(), json!({ "start": start, "end": end, "value": c.get("value").cloned().unwrap_or(json!({})) })));
                    ids.push(id);
                }
                let t = track_mut(&mut v, &layer, &track)?;
                for (id, c) in fresh {
                    t.insert(id, c);
                }
                result = json!({ "ids": ids });
            }
            Op::UpdateClip { layer, track, id, start, end, value } => {
                let t = track_mut(&mut v, &layer, &track)?;
                let c = t.get_mut(&id).and_then(|c| c.as_object_mut()).ok_or(format!("クリップ {id} がない"))?;
                if let Some(s) = start {
                    c.insert("start".into(), json!(s));
                }
                if let Some(e) = end {
                    c.insert("end".into(), json!(e));
                }
                let (s, e) = (c["start"].as_i64().unwrap_or(0), c["end"].as_i64().unwrap_or(0));
                if e <= s {
                    c.insert("end".into(), json!(s + 1));
                }
                if let Some(val) = value {
                    let cur = c.entry("value").or_insert_with(|| json!({}));
                    if let Some(obj) = cur.as_object_mut() {
                        for (k, x) in val {
                            obj.insert(k, x);
                        }
                    }
                }
            }
            Op::DeleteClips { layer, track, ids } => {
                let t = track_mut(&mut v, &layer, &track)?;
                for id in ids {
                    t.shift_remove(&id);
                }
            }
            Op::SplitClip { layer, track, id, at } => {
                let new_id = self.new_id();
                let t = track_mut(&mut v, &layer, &track)?;
                let c = t.get_mut(&id).and_then(|c| c.as_object_mut()).ok_or(format!("クリップ {id} がない"))?;
                let (s, e) = (c["start"].as_i64().unwrap_or(0), c["end"].as_i64().unwrap_or(0));
                if at <= s || at >= e {
                    return Err("分割位置がクリップの外".into());
                }
                c.insert("end".into(), json!(at));
                let value = c.get("value").cloned().unwrap_or(json!({}));
                t.insert(new_id.clone(), json!({ "start": at, "end": e, "value": value }));
                result = json!({ "id": new_id });
            }
            Op::SetMarkers { markers } => v["markers"] = json!(markers),
            Op::SetTempo { bpm, beat_offset } => {
                let o = v.as_object_mut().ok_or("project.json がオブジェクトではない")?;
                match bpm {
                    Some(b) => o.insert("bpm".into(), json!(b)),
                    None => o.shift_remove("bpm"),
                };
                if let Some(b) = beat_offset {
                    o.insert("beatOffset".into(), json!(b));
                }
            }
            Op::SetParam { layer, name, value } => {
                let l = layer_mut(&mut v, &layer)?;
                let params = l.entry("params").or_insert_with(|| json!({}));
                params[name] = json!({ "value": value, "keys": [] });
            }
            Op::SetEventMap { event_map } => v["eventMap"] = event_map,
            Op::SetCcMap { cc_map } => v["ccMap"] = cc_map,
        }
        let after = write(dir, &v)?;
        self.undo.lock().unwrap().push(Step { label: label.clone(), before, after });
        self.redo.lock().unwrap().clear();
        result["label"] = json!(label);
        Ok(result)
    }

    /// 取り消し。ファイルが外から書き換わっていたら、その上には戻さない
    pub fn undo(&self, dir: &Path) -> Result<String, String> {
        let step = self.undo.lock().unwrap().pop().ok_or("取り消せる操作がない")?;
        let (cur, _) = read(dir)?;
        if cur != step.after {
            return Err("project.json が外で書き換わったので、この操作は取り消せない".into());
        }
        std::fs::write(dir.join("project.json"), &step.before).map_err(|e| e.to_string())?;
        let label = step.label.clone();
        self.redo.lock().unwrap().push(step);
        Ok(label)
    }

    pub fn redo(&self, dir: &Path) -> Result<String, String> {
        let step = self.redo.lock().unwrap().pop().ok_or("やり直せる操作がない")?;
        let (cur, _) = read(dir)?;
        if cur != step.before {
            return Err("project.json が外で書き換わったので、やり直せない".into());
        }
        std::fs::write(dir.join("project.json"), &step.after).map_err(|e| e.to_string())?;
        let label = step.label.clone();
        self.undo.lock().unwrap().push(step);
        Ok(label)
    }

    pub fn clear(&self) {
        self.undo.lock().unwrap().clear();
        self.redo.lock().unwrap().clear();
    }

    /// 外から書かれた project.json で、id のないクリップ(配列で書かれたトラック)に採番して書き戻す。
    /// 書き戻したら true
    pub fn normalize_ids(&self, dir: &Path) -> Result<bool, String> {
        let (_, mut v) = read(dir)?;
        let mut changed = false;
        if let Some(ls) = v["layers"].as_array_mut() {
            for l in ls {
                let Some(tracks) = l.get_mut("tracks").and_then(|t| t.as_object_mut()) else { continue };
                for (_, t) in tracks.iter_mut() {
                    if let Some(arr) = t.as_array().cloned() {
                        let mut m = Map::new();
                        for c in arr {
                            m.insert(self.new_id(), c);
                        }
                        *t = Value::Object(m);
                        changed = true;
                    }
                }
            }
        }
        if changed {
            write(dir, &v)?;
        }
        Ok(changed)
    }
}

fn base36(mut n: u64) -> String {
    const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut s = vec![];
    while n > 0 {
        s.push(D[(n % 36) as usize]);
        n /= 36;
    }
    s.reverse();
    String::from_utf8(s).unwrap()
}
