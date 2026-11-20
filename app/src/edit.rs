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
    /// スケッチを置いたレイヤーを末尾に足す(作品全体の長さ)
    AddLayer { sketch: String },
    /// レイヤー構成を丸ごと置き換える
    SetLayers { layers: Vec<Value> },
    /// キーフレームを1つ打つ(同じフレームにあれば置き換える)。対象は param か、クリップのフィールド
    #[serde(rename_all = "camelCase")]
    SetKey { target: KeyTarget, frame: i64, value: Value, ease: Option<Value> },
    /// キーフレームを1つ消す
    #[serde(rename_all = "camelCase")]
    DeleteKey { target: KeyTarget, frame: i64 },
    /// キーフレームを丸ごと置き換える(MCPの set_keyframes)。空にすると value だけが残る
    #[serde(rename_all = "camelCase")]
    SetKeys { target: KeyTarget, keys: Vec<Value> },
    /// 作品の大きさ・fps・尺を変える(省略したものはそのまま)
    #[serde(rename_all = "camelCase")]
    SetSettings { width: Option<u32>, height: Option<u32>, fps: Option<[u32; 2]>, duration: Option<u64> },
    /// 音声トラックの一覧を置き換える([{ asset, offset?, gain? }])
    #[serde(rename_all = "camelCase")]
    SetAudio { audio: Vec<Value> },
    /// project.json の中の素材の参照を from から to に付け替える(リンク切れの再リンク)
    #[serde(rename_all = "camelCase")]
    RelinkAsset { from: String, to: String },
    /// ループ範囲を決める(両方 null で外す)
    #[serde(rename_all = "camelCase")]
    SetLoop { start: Option<u64>, end: Option<u64> },
    /// レイヤーの設定を部分的に変える(値が null のキーは消す)。id と sketch は変えられない
    #[serde(rename_all = "camelCase")]
    UpdateLayer { layer: String, set: Map<String, Value> },
    /// レイヤーの重ね順を変える(to は layers の添字。0が一番下)
    #[serde(rename_all = "camelCase")]
    MoveLayer { layer: String, to: usize },
    /// レイヤーを消す
    #[serde(rename_all = "camelCase")]
    DeleteLayer { layer: String },
    /// クリップを差分で変える(MCPの set_clips)。1回が取り消し1単位
    SetClips { layer: String, track: String, add: Vec<Value>, update: Vec<Value>, delete: Vec<String>, replace: bool },
}

/// キーフレームを持てる場所: レイヤーの param か、クリップのフィールド(キーの frame はクリップ開始からの相対)
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyTarget {
    pub layer: String,
    pub param: Option<String>,
    pub track: Option<String>,
    pub clip: Option<String>,
    pub field: Option<String>,
    /// レイヤーの合成の値: "opacity"、"transform.position"、"transform.scale"、"transform.rotation"、"transform.anchor"
    pub property: Option<String>,
}

impl KeyTarget {
    fn describe(&self) -> String {
        match (&self.param, &self.track, &self.clip, &self.field) {
            (Some(p), ..) => format!("{}.{p}", self.layer),
            (None, Some(t), Some(c), Some(f)) => format!("{}.{t}[{c}].{f}", self.layer),
            _ => match &self.property {
                Some(p) => format!("{}.{p}", self.layer),
                None => self.layer.clone(),
            },
        }
    }
}

/// 対象の値を { value, keys } の形にして返す(ただの値なら包む。なければ value に初期値を入れる)
fn keyed_mut<'a>(v: &'a mut Value, t: &KeyTarget, init: &Value) -> Result<&'a mut Map<String, Value>, String> {
    let slot: &mut Value = match (&t.param, &t.track, &t.clip, &t.field) {
        (Some(p), ..) => {
            let l = layer_mut(v, &t.layer)?;
            let params = l.entry("params").or_insert_with(|| json!({}));
            params.as_object_mut().ok_or("params がオブジェクトではない")?.entry(p.clone()).or_insert_with(|| init.clone())
        }
        (None, Some(tr), Some(c), Some(f)) => {
            let track = track_mut(v, &t.layer, tr)?;
            let clip = track.get_mut(c).and_then(|c| c.as_object_mut()).ok_or(format!("クリップ {c} がない"))?;
            let value = clip.entry("value").or_insert_with(|| json!({}));
            value.as_object_mut().ok_or("value がオブジェクトではない")?.entry(f.clone()).or_insert_with(|| init.clone())
        }
        (None, None, None, None) if t.property.is_some() => {
            let prop = t.property.as_deref().unwrap();
            if !LAYER_PROPS.contains(&prop) {
                return Err(format!("キーを打てるレイヤーの値は {} のどれか", LAYER_PROPS.join("、")));
            }
            let l = layer_mut(v, &t.layer)?;
            match prop.split_once('.') {
                Some((head, tail)) => {
                    let o = l.entry(head).or_insert_with(|| json!({}));
                    o.as_object_mut().ok_or(format!("{head} がオブジェクトではない"))?.entry(tail).or_insert_with(|| init.clone())
                }
                None => l.entry(prop).or_insert_with(|| init.clone()),
            }
        }
        _ => return Err("param か、track・clip・field の組か、property を指定する".into()),
    };
    let is_keyed = slot.as_object().is_some_and(|o| o.contains_key("value"));
    if !is_keyed {
        let raw = slot.take();
        *slot = json!({ "value": raw, "keys": [] });
    }
    let o = slot.as_object_mut().unwrap();
    if !o.get("keys").is_some_and(|k| k.is_array()) {
        o.insert("keys".into(), json!([]));
    }
    Ok(o)
}

/// キーフレームを打てるレイヤーの値
const LAYER_PROPS: [&str; 5] = ["opacity", "transform.position", "transform.scale", "transform.rotation", "transform.anchor"];

fn sort_keys(keys: &mut [Value]) {
    keys.sort_by_key(|k| k["frame"].as_i64().unwrap_or(0));
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
            Op::AddLayer { sketch } => format!("{sketch} のレイヤーを追加"),
            Op::SetKey { target, frame, .. } => format!("{} にキーを打つ(フレーム {frame})", target.describe()),
            Op::DeleteKey { target, frame } => format!("{} のキーを消す(フレーム {frame})", target.describe()),
            Op::SetKeys { target, keys } => format!("{} のキーを{}個に置き換え", target.describe(), keys.len()),
            Op::SetLayers { layers } => format!("レイヤー構成を{}個に置き換え", layers.len()),
            Op::UpdateLayer { layer, set } => format!("{layer} の{}を変更", set.keys().map(|k| k.as_str()).collect::<Vec<_>>().join("・")),
            Op::MoveLayer { layer, .. } => format!("{layer} の重ね順を変更"),
            Op::RelinkAsset { from, to } => format!("素材 {from} を {to} に付け替え"),
            Op::SetAudio { audio } => format!("音声トラックを{}本に", audio.len()),
            Op::SetSettings { .. } => "作品の設定を変更".into(),
            Op::SetLoop { start: None, end: None } => "ループ範囲を外す".into(),
            Op::SetLoop { .. } => "ループ範囲を変更".into(),
            Op::DeleteLayer { layer } => format!("{layer} を削除"),
            Op::SetClips { add, update, delete, replace, .. } => format!("クリップを変更(追加{} 変更{} 削除{}{})", add.len(), update.len(), delete.len(), if *replace { "、全置換" } else { "" }),
        }
    }
}

struct Step {
    dir: std::path::PathBuf,
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
            Op::SetKey { target, frame, value, ease } => {
                let o = keyed_mut(&mut v, &target, &value)?;
                let keys = o.get_mut("keys").and_then(|k| k.as_array_mut()).unwrap();
                keys.retain(|k| k["frame"].as_i64() != Some(frame));
                let mut k = json!({ "frame": frame, "value": value });
                if let Some(e) = ease {
                    k["ease"] = e;
                }
                keys.push(k);
                sort_keys(keys);
            }
            Op::DeleteKey { target, frame } => {
                let o = keyed_mut(&mut v, &target, &Value::Null)?;
                // キーを消したときは、そのキーの値を value に残す(全部消えても値が飛ばないように)
                let keys = o.get_mut("keys").and_then(|k| k.as_array_mut()).unwrap();
                let removed = keys.iter().position(|k| k["frame"].as_i64() == Some(frame)).map(|i| keys.remove(i));
                let empty = keys.is_empty();
                if let (Some(r), true) = (removed, empty) {
                    o.insert("value".into(), r["value"].clone());
                }
            }
            Op::SetKeys { target, keys } => {
                for k in &keys {
                    if k["frame"].as_i64().is_none() || k.get("value").is_none() {
                        return Err("各キーに frame(整数)と value が要る".into());
                    }
                }
                let init = keys.first().map(|k| k["value"].clone()).unwrap_or(Value::Null);
                let o = keyed_mut(&mut v, &target, &init)?;
                let mut keys = keys;
                sort_keys(&mut keys);
                o.insert("keys".into(), json!(keys));
            }
            Op::AddLayer { sketch } => {
                let dur = v["duration"].as_i64().unwrap_or(300);
                let ls = v["layers"].as_array_mut().ok_or("layers がない")?;
                let mut n = ls.len() + 1;
                while ls.iter().any(|l| l["id"] == format!("L{n}")) {
                    n += 1;
                }
                let id = format!("L{n}");
                ls.push(json!({ "id": id, "sketch": sketch, "start": 0, "end": dur, "offset": 0, "speed": 1, "blend": "normal", "opacity": 1, "params": {} }));
                result = json!({ "layer": id });
            }
            Op::UpdateLayer { layer, set } => {
                let l = layer_mut(&mut v, &layer)?;
                for (k, val) in set {
                    if k == "id" || k == "sketch" {
                        return Err(format!("{k} は変えられない"));
                    }
                    if val.is_null() {
                        l.remove(&k);
                    } else {
                        l.insert(k, val);
                    }
                }
            }
            Op::SetSettings { width, height, fps, duration } => {
                if let Some(w) = width {
                    v["width"] = json!(w);
                }
                if let Some(h) = height {
                    v["height"] = json!(h);
                }
                if let Some(f) = fps {
                    if f[0] == 0 || f[1] == 0 {
                        return Err("fps は [分子, 分母] の正の整数".into());
                    }
                    v["fps"] = json!(f);
                }
                if let Some(d) = duration {
                    if d == 0 {
                        return Err("尺は1フレーム以上".into());
                    }
                    let old = v["duration"].as_u64().unwrap_or(d);
                    v["duration"] = json!(d);
                    // 尺いっぱいだったレイヤーは新しい尺まで伸ばし、尺を越えるものは詰める
                    for l in v["layers"].as_array_mut().into_iter().flatten() {
                        match l["end"].as_u64() {
                            Some(e) if e == old || e > d => l["end"] = json!(d),
                            _ => {}
                        }
                    }
                }
            }
            Op::SetAudio { audio } => {
                for a in &audio {
                    if a["asset"].as_str().is_none() {
                        return Err("各音声トラックに asset(作品からの相対パス)が要る".into());
                    }
                }
                v["audio"] = json!(audio);
            }
            Op::RelinkAsset { from, to } => {
                if crate::assets_check::relink(&mut v, &from, &to) == 0 {
                    return Err(format!("{from} を参照しているところがない"));
                }
            }
            Op::SetLoop { start, end } => {
                let dur = v["duration"].as_u64().unwrap_or(0);
                let cur = v.get("loop").cloned().unwrap_or(Value::Null);
                if start.is_none() && end.is_none() {
                    if let Some(o) = v.as_object_mut() {
                        o.remove("loop");
                    }
                } else {
                    // 片方だけ指定したら、もう片方は今の値(なければ先頭か尺の終わり)
                    let a = start.or(cur["start"].as_u64()).unwrap_or(0);
                    let b = end.or(cur["end"].as_u64()).unwrap_or(dur);
                    if a >= b || b > dur {
                        return Err(format!("ループ範囲は 0 ≦ 開始 < 終了 ≦ 尺({dur}) にする"));
                    }
                    v["loop"] = json!({ "start": a, "end": b });
                }
            }
            Op::MoveLayer { layer, to } => {
                let ls = v["layers"].as_array_mut().ok_or("layers がない")?;
                let i = ls.iter().position(|l| l["id"] == layer.as_str()).ok_or(format!("レイヤー {layer} がない"))?;
                let l = ls.remove(i);
                let to = to.min(ls.len());
                ls.insert(to, l);
            }
            Op::DeleteLayer { layer } => {
                let ls = v["layers"].as_array_mut().ok_or("layers がない")?;
                let n = ls.len();
                ls.retain(|l| l["id"] != layer.as_str());
                if ls.len() == n {
                    return Err(format!("レイヤー {layer} がない"));
                }
            }
            Op::SetLayers { layers } => {
                for l in &layers {
                    if l["id"].as_str().is_none() || l["sketch"].as_str().is_none() {
                        return Err("各レイヤーに id と sketch が要る".into());
                    }
                }
                v["layers"] = json!(layers);
            }
            Op::SetClips { layer, track, add, update, delete, replace } => {
                let mut ids = vec![];
                let fresh: Vec<(String, Value)> = add
                    .into_iter()
                    .map(|c| {
                        let id = self.new_id();
                        ids.push(id.clone());
                        let start = c["start"].as_i64().unwrap_or(0);
                        let end = c["end"].as_i64().unwrap_or(start + 1).max(start + 1);
                        (id, json!({ "start": start, "end": end, "value": c.get("value").cloned().unwrap_or(json!({})) }))
                    })
                    .collect();
                let t = track_mut(&mut v, &layer, &track)?;
                if replace {
                    t.clear();
                }
                for id in &delete {
                    t.shift_remove(id);
                }
                for u in update {
                    let id = u["id"].as_str().ok_or("update の各要素に id が要る")?.to_string();
                    let c = t.get_mut(&id).and_then(|c| c.as_object_mut()).ok_or(format!("クリップ {id} がない"))?;
                    for k in ["start", "end"] {
                        if let Some(x) = u.get(k).and_then(|x| x.as_i64()) {
                            c.insert(k.into(), json!(x));
                        }
                    }
                    if let Some(val) = u.get("value").and_then(|x| x.as_object()) {
                        let cur = c.entry("value").or_insert_with(|| json!({}));
                        if let Some(obj) = cur.as_object_mut() {
                            for (k, x) in val {
                                obj.insert(k.clone(), x.clone());
                            }
                        }
                    }
                }
                for (id, c) in fresh {
                    t.insert(id, c);
                }
                result = json!({ "added": ids });
            }
        }
        let after = write(dir, &v)?;
        self.undo.lock().unwrap().push(Step { dir: dir.to_path_buf(), label: label.clone(), before, after });
        self.redo.lock().unwrap().clear();
        result["label"] = json!(label);
        Ok(result)
    }

    /// 取り消し。ファイルが外から書き換わっていたら、その上には戻さない
    pub fn undo(&self, _dir: &Path) -> Result<String, String> {
        let step = self.undo.lock().unwrap().pop().ok_or("取り消せる操作がない")?;
        let dir = step.dir.clone();
        let (cur, _) = read(&dir)?;
        if cur != step.after {
            return Err("project.json が外で書き換わったので、この操作は取り消せない".into());
        }
        std::fs::write(dir.join("project.json"), &step.before).map_err(|e| e.to_string())?;
        let label = step.label.clone();
        self.redo.lock().unwrap().push(step);
        Ok(label)
    }

    pub fn redo(&self, _dir: &Path) -> Result<String, String> {
        let step = self.redo.lock().unwrap().pop().ok_or("やり直せる操作がない")?;
        let dir = step.dir.clone();
        let (cur, _) = read(&dir)?;
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
