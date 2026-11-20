//! get_diagnostics と inspect_asset の中身。AIが自分で直せるよう、場所と理由が分かる形で返す。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};

use crate::core::Core;
use crate::workspace;

/// 同梱のTypeScript 7(ネイティブ版)の tsc.exe。開発中はリポジトリの node_modules を使う
pub fn tsc_path() -> Option<PathBuf> {
    let p = workspace::repo_dir().join("node_modules/@typescript/typescript-win32-x64/lib/tsc.exe");
    p.exists().then_some(p)
}

/// 作業フォルダ全体を型チェックし、この作品のファイルの分だけ返す
pub fn typecheck(ws: &Path, work: &str) -> Value {
    let Some(tsc) = tsc_path() else { return json!({ "skipped": "tsc.exe がない" }) };
    let out = std::process::Command::new(tsc).arg("-p").arg(ws.join("tsconfig.json")).arg("--pretty").arg("false").current_dir(ws).output();
    let Ok(out) = out else { return json!({ "skipped": "tsc を起動できない" }) };
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let prefix = format!("works/{work}/");
    // 形式: works/x/sketches/main/sketch.ts(12,5): error TS2339: ...
    let errors: Vec<Value> = text
        .lines()
        .filter(|l| l.replace('\\', "/").starts_with(&prefix))
        .map(|l| json!(l.replace('\\', "/")))
        .collect();
    json!({ "errors": errors })
}

pub fn collect(core: &Arc<Core>, work: &str, dir: &Path) -> Value {
    let mut compile = vec![];
    let mut layers = vec![];
    if let Ok(p) = workspace::read_project(dir) {
        for l in &p.layers {
            match workspace::sketch_entry(dir, &l.sketch) {
                Some((f, "isf")) => {
                    let src = std::fs::read_to_string(&f).unwrap_or_default();
                    if let Err(e) = isf::parse(&src) {
                        compile.push(json!({ "file": f, "message": format!("ISFのJSONを読めない: {e:?}") }));
                    }
                }
                Some((f, _)) => {
                    if let Err(d) = core.cache.get(&f) {
                        compile.extend(d.into_iter().map(|x| json!({ "file": x.file, "message": x.message })));
                    }
                }
                None => compile.push(json!({ "layer": l.id, "message": format!("{} に sketch.ts も shader.fs もない", l.sketch) })),
            }
            layers.push(json!({ "id": l.id, "sketch": l.sketch }));
        }
    }
    // 実行時の例外: プレビューと書き出しのWebViewのログ(新しい順に最大20件)
    let logs = core.logs.lock().unwrap();
    let open = core.work.lock().unwrap().clone();
    let last_render = core.last_render.lock().unwrap().get(work).cloned();
    let since = *core.last_reload_ms.lock().unwrap();
    let runtime: Vec<Value> = logs
        .iter()
        .rev()
        .filter(|l| l["level"] == "error" || l["level"] == "warn")
        // この作品の最後の描画と、プレビュー(開いているとき)の最後の読み込み以降だけ
        .filter(|l| {
            let s = l["source"].as_str().unwrap_or("");
            Some(s) == last_render.as_deref() || (open.as_deref() == Some(work) && s.starts_with("preview-") && l["unixMs"].as_f64().unwrap_or(0.0) >= since)
        })
        .take(20)
        .map(|l| json!({ "level": l["level"], "source": l["source"], "message": l["message"] }))
        .collect();
    drop(logs);
    // 描画時間はプレビューで開いている作品のものだけ
    let stats = if open.as_deref() == Some(work) { core.frame_stats.lock().unwrap().clone() } else { json!("この作品はプレビューで開かれていない") };
    json!({
        "work": work,
        "layers": layers,
        "compile": compile,
        "types": typecheck(&core.ws, work),
        "projectJson": crate::schema::validate(dir),
        // project.json が参照しているのに見つからない素材(候補は作品フォルダ内の同じ名前のファイル)
        "missingAssets": crate::assets_check::missing(dir),
        "runtime": runtime,
        "frameTimeMs": stats,
        "note": "runtime はプレビュー(この作品を開いているとき)と直近の描画のログ。直したあとは render_frames で描き直して確かめる",
    })
}

pub fn inspect_asset(dir: &Path, path: &Path) -> Result<Value, String> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let size = std::fs::metadata(path).map(|m| m.len()).map_err(|e| format!("{}: {e}", path.display()))?;
    match ext.as_str() {
        "wav" | "mp3" | "flac" | "ogg" | "m4a" | "aac" => {
            let s = crate::audio::analysis_cached(dir, path)?;
            let a: Value = serde_json::from_str(&s).map_err(|e| e.to_string())?;
            let take = |k: &str, n: usize| a[k].as_array().map(|v| v.iter().take(n).cloned().collect::<Vec<_>>()).unwrap_or_default();
            let rms: Vec<f64> = a["rms"].as_array().map(|v| v.iter().filter_map(|x| x.as_f64()).collect()).unwrap_or_default();
            let mean = rms.iter().sum::<f64>() / rms.len().max(1) as f64;
            Ok(json!({
                "kind": "audio", "bytes": size,
                "duration": a["duration"], "sampleRate": a["sampleRate"], "channels": a["channels"],
                "bpm": a["bpm"], "beatModel": a["beatModel"],
                "beats": a["beats"].as_array().map(|v| v.len()), "firstBeats": take("beats", 16),
                "downbeats": a["downbeats"].as_array().map(|v| v.len()), "firstDownbeats": take("downbeats", 8),
                "onsets": a["onsets"].as_array().map(|v| v.len()), "firstOnsets": take("onsets", 16),
                "rmsMean": (mean * 1000.0).round() / 1000.0,
                "hint": "スケッチでは assets.audio() で rms・band・beat・pulse・onset を時刻で引ける",
            }))
        }
        "mid" | "midi" => {
            let m = crate::midi::parse(path)?;
            let mut channels = std::collections::BTreeMap::<u8, usize>::new();
            let mut ccs = std::collections::BTreeSet::<u8>::new();
            for n in &m.notes {
                *channels.entry(n.channel).or_default() += 1;
            }
            for c in &m.cc {
                ccs.insert(c.controller);
            }
            let pitches: Vec<u8> = m.notes.iter().map(|n| n.pitch).collect();
            let mut used: Vec<u8> = pitches.clone();
            used.sort();
            used.dedup();
            Ok(json!({
                "kind": "midi", "bytes": size, "duration": m.duration,
                "notes": m.notes.len(), "pitchRange": [pitches.iter().min(), pitches.iter().max()], "pitchesUsed": used,
                "notesPerChannel": channels, "ccControllers": ccs,
                "tempos": m.tempos, "timeSignatures": m.time_signatures, "markers": m.markers, "trackNames": m.track_names,
                "firstNotes": m.notes.iter().take(16).map(|n| json!([n.start, n.pitch, n.velocity, n.channel])).collect::<Vec<_>>(),
                "hint": "スケッチでは assets.midi() か、project.json の eventMap で名前を付けて events.since() で引ける",
            }))
        }
        "json" | "csv" | "txt" | "srt" => {
            let s = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
            Ok(json!({ "kind": ext, "bytes": size, "head": s.chars().take(2000).collect::<String>() }))
        }
        _ => Ok(json!({ "kind": ext, "bytes": size })),
    }
}
