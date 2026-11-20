//! project.json が参照する素材(音声・イベント対応表のMIDI・CC割り当ての録音)のリンク切れの検出と再リンク。
//! スケッチのコードが setup で読む素材は実行してみないと分からないので、そちらは読み込みの例外として出る。

use std::path::Path;

use serde_json::{json, Value};

use crate::workspace;

/// 参照している場所と相対パス
fn references(p: &Value) -> Vec<(String, String)> {
    let mut out = vec![];
    for (i, a) in p["audio"].as_array().into_iter().flatten().enumerate() {
        if let Some(s) = a["asset"].as_str() {
            out.push((format!("audio[{i}]"), s.to_string()));
        }
    }
    for (name, e) in p["eventMap"].as_object().into_iter().flatten() {
        if let Some(s) = e["midi"].as_str() {
            out.push((format!("eventMap.{name}"), s.to_string()));
        }
    }
    for (key, e) in p["ccMap"].as_object().into_iter().flatten() {
        if let Some(s) = e["source"].as_str() {
            out.push((format!("ccMap.{key}"), s.to_string()));
        }
    }
    out
}

/// 作品の assets/ のファイルの一覧(種類・大きさ・project.json で参照している場所)
pub fn list(dir: &Path) -> Value {
    let p: Value = std::fs::read_to_string(dir.join("project.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let refs = references(&p);
    let mut out: Vec<Value> = workspace::walk(&dir.join("assets"))
        .into_iter()
        .filter_map(|f| {
            let rel = f.strip_prefix(dir).ok()?.to_string_lossy().replace('\\', "/");
            let ext = rel.rsplit_once('.').map(|(_, e)| e.to_lowercase()).unwrap_or_default();
            let kind = match ext.as_str() {
                "wav" | "mp3" | "flac" | "ogg" | "m4a" | "aac" | "aif" | "aiff" => "audio",
                "mid" | "midi" => "midi",
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" => "image",
                "ttf" | "otf" | "woff" | "woff2" => "font",
                "mp4" | "mov" | "webm" | "mkv" => "video",
                "json" | "csv" | "txt" => "data",
                _ => "other",
            };
            let used: Vec<&String> = refs.iter().filter(|(_, r)| r.trim_start_matches("./") == rel).map(|(place, _)| place).collect();
            Some(json!({ "rel": rel, "kind": kind, "size": std::fs::metadata(&f).map(|m| m.len()).unwrap_or(0), "usedBy": used }))
        })
        .collect();
    out.sort_by(|a, b| a["rel"].as_str().cmp(&b["rel"].as_str()));
    json!(out)
}

/// 見つからない素材の一覧。作品フォルダの中に同じ名前のファイルがあれば候補に挙げる
pub fn missing(dir: &Path) -> Value {
    let Ok(text) = std::fs::read_to_string(dir.join("project.json")) else { return json!([]) };
    let Ok(p) = serde_json::from_str::<Value>(&text) else { return json!([]) };
    let files: Vec<String> = workspace::walk(dir)
        .into_iter()
        .filter_map(|f| f.strip_prefix(dir).ok().map(|r| r.to_string_lossy().replace('\\', "/")))
        .filter(|r| !r.starts_with(".cache/") && !r.starts_with("renders/") && !r.starts_with(".git/"))
        .collect();
    let mut out = vec![];
    for (place, rel) in references(&p) {
        let clean = rel.trim_start_matches("./");
        let exists = workspace::safe_rel(dir, clean).is_some_and(|f| f.is_file());
        if exists {
            continue;
        }
        let name = clean.rsplit('/').next().unwrap_or(clean).to_lowercase();
        let candidates: Vec<&String> = files.iter().filter(|f| f.rsplit('/').next().unwrap_or(f).to_lowercase() == name).collect();
        out.push(json!({ "place": place, "path": rel, "candidates": candidates }));
    }
    json!(out)
}

/// 作品の外のファイルを assets/ に写す(同じ名前で中身が違えば名前に番号を付ける)。戻り値は作品からの相対パス
pub fn import_file(dir: &Path, src: &Path) -> Result<String, String> {
    let assets = dir.join("assets");
    std::fs::create_dir_all(&assets).map_err(|e| e.to_string())?;
    let name = src.file_name().ok_or("ファイル名がない")?.to_string_lossy().to_string();
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (name.clone(), String::new()),
    };
    let data = std::fs::read(src).map_err(|e| format!("{}: {e}", src.display()))?;
    for n in 0..1000 {
        let file = if n == 0 { name.clone() } else { format!("{stem}_{n}{ext}") };
        let dst = assets.join(&file);
        match std::fs::read(&dst) {
            Ok(cur) if cur == data => return Ok(format!("assets/{file}")),
            Ok(_) => continue,
            Err(_) => {
                std::fs::write(&dst, &data).map_err(|e| e.to_string())?;
                return Ok(format!("assets/{file}"));
            }
        }
    }
    Err("assets/ に同じ名前のファイルが多すぎる".into())
}

/// project.json の中で from を参照している場所を to に書き換える(edit.rs の RelinkAsset から)
pub fn relink(v: &mut Value, from: &str, to: &str) -> usize {
    let mut n = 0;
    let mut fix = |s: &mut Value| {
        if s.as_str() == Some(from) {
            *s = json!(to);
            n += 1;
        }
    };
    for a in v["audio"].as_array_mut().into_iter().flatten() {
        fix(&mut a["asset"]);
    }
    for (_, e) in v["eventMap"].as_object_mut().into_iter().flatten() {
        if e.get("midi").is_some() {
            fix(&mut e["midi"]);
        }
    }
    for (_, e) in v["ccMap"].as_object_mut().into_iter().flatten() {
        if e.get("source").is_some() {
            fix(&mut e["source"]);
        }
    }
    n
}
