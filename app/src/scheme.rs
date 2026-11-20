//! 専用URIスキーム sb(http://sb.localhost/)。スケッチWebViewとの通信のうち、
//! fetchで取るもの(ページ、ランタイム、ライブラリ、ビルド済みJS、アセット)と、
//! スケッチからのPOST(生存通知、ログ、書き出しデータ)を扱う。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use serde_json::{json, Value};
use tauri::http::{Request, Response};

use crate::core::{core, Core};
use crate::{export, workspace};

fn resp(status: u16, ctype: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", ctype)
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-store")
        .body(body)
        .unwrap()
}

fn json_resp(v: Value) -> Response<Vec<u8>> {
    resp(200, "application/json", serde_json::to_vec(&v).unwrap())
}

fn err(status: u16, msg: impl Into<String>) -> Response<Vec<u8>> {
    resp(status, "text/plain; charset=utf-8", msg.into().into_bytes())
}

fn query(req: &Request<Vec<u8>>, key: &str) -> Option<String> {
    req.uri().query()?.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then(|| percent_decode(v))
    })
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn ctype_of(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" | "ts" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "woff2" => "font/woff2",
        "fs" | "frag" | "glsl" | "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// 相対パスを親フォルダの中に限って結合する。
fn safe_join(base: &Path, rel: &str) -> Option<PathBuf> {
    if rel.split(['/', '\\']).any(|c| c == ".." || c.contains(':')) {
        return None;
    }
    Some(base.join(rel))
}

/// import map。依存はバンドルせず、同梱ライブラリを版を固定して配る。
fn import_map() -> Value {
    json!({ "imports": {
        "@sketchbench/runtime": "/runtime/index.js",
        "p5": "/vendor/p5.js",
        "mediabunny": "/vendor/mediabunny.js",
        "opentype.js": "/vendor/opentype.js",
    }})
}

fn host_html() -> String {
    format!(
        r#"<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><title>sketch</title>
<style>html,body{{margin:0;height:100%;background:#000;overflow:hidden}}#stage{{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}}#stage canvas{{max-width:100%;max-height:100%;object-fit:contain}}</style>
<script type="importmap">{}</script>
</head><body><div id="stage"></div>
<script type="module" src="/runtime/boot.js"></script>
</body></html>"#,
        import_map()
    )
}

pub fn handle(app: &tauri::AppHandle, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let c = core(app);
    let path = req.uri().path().to_string();
    if req.method() == "OPTIONS" {
        return resp(204, "text/plain", vec![]);
    }
    let repo = workspace::repo_dir();
    match path.as_str() {
        "/host.html" => resp(200, "text/html; charset=utf-8", host_html().into_bytes()),
        p if p.starts_with("/runtime/") => {
            // ランタイムはTSのまま置き、Oxcで変換して配る
            let rel = p.trim_start_matches("/runtime/").trim_end_matches(".js");
            let Some(f) = safe_join(&repo.join("packages/runtime/src"), &format!("{rel}.ts")) else { return err(403, "") };
            match c.cache.get(&f) {
                Ok(b) => resp(200, "text/javascript; charset=utf-8", b.js.into_bytes()),
                Err(d) => {
                    // ランタイムが読み込めないとスケッチWebViewは何も報告できないので、Rust側で知らせる
                    let msg = d.iter().map(|x| x.message.clone()).collect::<Vec<_>>().join("\n");
                    c.log("core", "error", format!("ランタイムを変換できない:\n{msg}"), Value::Null);
                    err(500, msg)
                }
            }
        }
        "/vendor/p5.js" => file(&repo.join("node_modules/p5/lib/p5.esm.min.js")),
        "/vendor/mediabunny.js" => file(&repo.join("node_modules/mediabunny/dist/bundles/mediabunny.min.mjs")),
        "/vendor/opentype.js" => file(&repo.join("node_modules/opentype.js/dist/opentype.min.mjs")),
        "/api/project" => api_project(&c, &query(&req, "work").unwrap_or_default()),
        p if p.starts_with("/work/") => work_file(&c, p, &req),
        "/hb" | "/state" | "/hello" => {
            let l = query(&req, "l").unwrap_or_default();
            let mut s = c.sketches.lock().unwrap();
            let e = s.entry(l.clone()).or_default();
            e.last_hb = Some(Instant::now());
            if let Some(ph) = query(&req, "phase") {
                e.phase = ph;
            }
            resp(200, "text/plain", vec![])
        }
        "/log" => {
            let l = query(&req, "l").unwrap_or_default();
            let v: Value = serde_json::from_slice(req.body()).unwrap_or(Value::Null);
            c.log(&l, v["level"].as_str().unwrap_or("info"), v["message"].as_str().unwrap_or(""), v["extra"].clone());
            resp(200, "text/plain", vec![])
        }
        // 描画時間(プレビューが2秒ごとに送る)。get_diagnostics が返す
        "/stats" => {
            let v: Value = serde_json::from_slice(req.body()).unwrap_or(Value::Null);
            *c.frame_stats.lock().unwrap() = v;
            resp(200, "text/plain", vec![])
        }
        // プレビュー上で囲んだ範囲(0〜1の矩形。null で解除)。get_ui_context が返す
        "/region" => {
            let v: Value = serde_json::from_slice(req.body()).unwrap_or(Value::Null);
            let mut ctx = c.ui_context.lock().unwrap();
            if !ctx.is_object() {
                *ctx = json!({});
            }
            ctx["region"] = v;
            resp(200, "text/plain", vec![])
        }
        // プレビューキャッシュの揃っている区間(プレビューが変わったときに送る)。UIのタイムラインに出す
        "/cache" => {
            let v: Value = serde_json::from_slice(req.body()).unwrap_or(Value::Null);
            let _ = tauri::Emitter::emit_to(&c.app, "ui", "sb:cache", v);
            resp(200, "text/plain", vec![])
        }
        "/key" => {
            let v: Value = serde_json::from_slice(req.body()).unwrap_or(Value::Null);
            let _ = tauri::Emitter::emit_to(&c.app, "ui", "sb:key", v);
            resp(200, "text/plain", vec![])
        }
        "/declare" => {
            // defineSketchの宣言を .cache/ に保存する(フェーズ3でJSON Schemaを作る元)
            let work = query(&req, "work").unwrap_or_default();
            let sketch = query(&req, "sketch").unwrap_or_default().replace(['/', '\\'], "_");
            if let Some(dir) = workspace::work_dir(&c.ws, &work) {
                let d = dir.join(".cache").join("declarations");
                let _ = std::fs::create_dir_all(&d);
                let _ = std::fs::write(d.join(format!("{sketch}.json")), req.body());
            }
            resp(200, "text/plain", vec![])
        }
        p if p.starts_with("/export/") => export_route(&c, p, &req),
        // 開発用: --verify の結果を表示して終了する
        "/verify/result" => {
            println!("[verify] {}", String::from_utf8_lossy(req.body()));
            let ok = serde_json::from_slice::<Value>(req.body()).ok().and_then(|v| v["ok"].as_bool()).unwrap_or(false);
            c.app.exit(if ok { 0 } else { 1 });
            resp(200, "text/plain", vec![])
        }
        _ => err(404, "not found"),
    }
}

fn file(p: &Path) -> Response<Vec<u8>> {
    match std::fs::read(p) {
        Ok(b) => resp(200, ctype_of(p), b),
        Err(_) => err(404, format!("{} がない", p.display())),
    }
}

fn api_project(c: &Arc<Core>, work: &str) -> Response<Vec<u8>> {
    let Some(dir) = workspace::work_dir(&c.ws, work) else { return err(404, "作品がない") };
    let p = match workspace::read_project(&dir) {
        Ok(p) => p,
        Err(e) => return json_resp(json!({ "ok": false, "error": e })),
    };
    let rev = c.rev.load(std::sync::atomic::Ordering::SeqCst);
    // スケッチのURLの版はコードと素材が変わったときだけ変える(params の変更でsetupをやり直さない)
    let ver = workspace::code_version(&dir);
    let layers: Vec<Value> = p
        .layers
        .iter()
        .map(|l| match workspace::sketch_entry(&dir, &l.sketch) {
            Some((_, "isf")) => json!({ "id": l.id, "sketch": l.sketch, "kind": "isf", "url": format!("/work/{work}/isf/{}?v={ver}", l.sketch), "params": l.params, "tracks": l.rest.get("tracks") }),
            Some(_) => json!({ "id": l.id, "sketch": l.sketch, "kind": "ts", "url": format!("/work/{work}/build/{}?v={ver}", l.sketch), "params": l.params, "tracks": l.rest.get("tracks") }),
            None => json!({ "id": l.id, "sketch": l.sketch, "kind": "missing", "params": l.params, "tracks": l.rest.get("tracks") }),
        })
        .collect();
    json_resp(json!({ "ok": true, "work": work, "project": p, "layers": layers, "rev": rev }))
}

/// /work/<作品>/build/<スケッチ> : sketch.ts を変換したJS(失敗時は診断のJSONで422)
/// /work/<作品>/isf/<スケッチ>   : shader.fs の本文とISFのメタデータ
/// /work/<作品>/files/<相対パス> : 作品フォルダ内のファイル(assetsなど)
fn work_file(c: &Arc<Core>, p: &str, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let rest = &p["/work/".len()..];
    let Some((work, rest)) = rest.split_once('/') else { return err(404, "") };
    let Some(dir) = workspace::work_dir(&c.ws, work) else { return err(404, "作品がない") };
    let Some((kind, rel)) = rest.split_once('/') else { return err(404, "") };
    match kind {
        "build" => match workspace::sketch_entry(&dir, rel) {
            Some((f, "ts")) => match c.cache.get(&f) {
                Ok(b) => resp(200, "text/javascript; charset=utf-8", b.js.into_bytes()),
                Err(d) => resp(422, "application/json", serde_json::to_vec(&json!({ "diagnostics": d })).unwrap()),
            },
            _ => err(404, "sketch.ts がない"),
        },
        "isf" => match workspace::sketch_entry(&dir, rel) {
            Some((f, "isf")) => {
                let src = std::fs::read_to_string(&f).unwrap_or_default();
                match isf::parse(&src) {
                    Ok(meta) => json_resp(json!({ "ok": true, "meta": meta, "source": src })),
                    Err(e) => resp(422, "application/json", serde_json::to_vec(&json!({ "diagnostics": [{ "file": f.display().to_string(), "message": format!("{e:?}") }] })).unwrap()),
                }
            }
            _ => err(404, "shader.fs がない"),
        },
        // /work/<作品>/analysis/<作品内の相対パス> : 音声の解析結果(キャッシュがなければ作る)
        "analysis" => match workspace::safe_rel(&dir, rel) {
            Some(f) => match crate::audio::analysis_cached(&dir, &f) {
                Ok(s) => resp(200, "application/json", s.into_bytes()),
                Err(e) => err(422, e),
            },
            None => err(403, ""),
        },
        // /work/<作品>/midi/<作品内の相対パス> : MIDIファイルを秒に直したノート・CC・テンポ
        "midi" => match workspace::safe_rel(&dir, rel) {
            Some(f) => match crate::midi::parse(&f) {
                Ok(m) => json_resp(serde_json::to_value(m).unwrap()),
                Err(e) => err(422, e),
            },
            None => err(403, ""),
        },
        // /work/<作品>/mixdown/<from>-<to>@<sr> : 作品の音声トラックのミックス(f32 LE、ステレオのインターリーブ)
        "mixdown" => {
            let parsed = rel.split_once('@').and_then(|(range, sr)| {
                let (a, b) = range.split_once('-')?;
                Some((a.parse::<u64>().ok()?, b.parse::<u64>().ok()?, sr.parse::<u32>().ok()?))
            });
            let Some((from, to, sr)) = parsed else { return err(400, "形式は <from>-<to>@<sr>") };
            let p = match workspace::read_project(&dir) {
                Ok(p) => p,
                Err(e) => return err(422, e),
            };
            let job = query(req, "job");
            let mixed = crate::audio::mixdown(&dir, &p, sr, from, to).and_then(|v| match &job {
                Some(id) => export::mix_for_job(c, id, v, sr),
                None => Ok(v),
            });
            match mixed {
                Ok(v) => resp(200, "application/octet-stream", v.iter().flat_map(|x| x.to_le_bytes()).collect()),
                Err(e) => err(422, e),
            }
        }
        "files" => match safe_join(&dir, rel) {
            Some(f) => file(&f),
            None => err(403, ""),
        },
        _ => err(404, ""),
    }
}

fn export_route(c: &Arc<Core>, p: &str, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let id = query(req, "job").unwrap_or_default();
    let r = match p {
        "/export/ready" => {
            let fmt = c.jobs.lock().unwrap().get(&id).map(|j| j.format.clone());
            match fmt.as_deref() {
                Some("png") => export::post_buffer(c, &id),
                Some(_) => Ok(()),
                None => Err("no job".into()),
            }
        }
        "/export/write" => export::write(c, &id, query(req, "pos").and_then(|s| s.parse().ok()).unwrap_or(0), req.body()),
        "/export/image" => export::image(c, &id, query(req, "i").and_then(|s| s.parse().ok()).unwrap_or(-1), req.body().to_vec()),
        "/export/frame" => export::frame(c, &id, query(req, "i").and_then(|s| s.parse().ok()).unwrap_or(0)),
        "/export/progress" => {
            export::progress(c, &id, query(req, "done").and_then(|s| s.parse().ok()).unwrap_or(0));
            Ok(())
        }
        "/export/done" | "/export/fail" => {
            let ok = p == "/export/done";
            let msg = String::from_utf8_lossy(req.body()).to_string();
            let c2 = c.clone();
            // 書き込み待ちとウィンドウを閉じる処理は応答の後で行う
            std::thread::spawn(move || export::finish(&c2, &id, ok, &msg));
            Ok(())
        }
        _ => Err("not found".into()),
    };
    match r {
        Ok(()) => resp(200, "text/plain", vec![]),
        Err(e) => err(500, e),
    }
}
