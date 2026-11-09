//! 書き出し。スケッチ用と同じ起動引数・別のWebView2環境の非表示ウィンドウで1フレームずつ描く。
//! MP4はWebView内のWebCodecs + Mediabunnyが作ったバイト列をそのまま書く。
//! 連番PNGは共有メモリで受け取ったRGBAをRust側でPNGにする。
//! 一時ファイル(.part)に書き、終わったら名前を変える。

use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::core::{Core, SKETCH_ARGS};
use crate::{workspace, wv2};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub work: String,
    /// "mp4" | "png"
    pub format: String,
    pub from: Option<u64>,
    pub to: Option<u64>,
    /// 連番PNGで描く順番。"forward"(既定)・"reverse"・"shuffle"。決定性の確認用
    #[serde(default)]
    pub order: Option<String>,
}

pub struct Job {
    pub id: String,
    pub label: String,
    pub format: String,
    pub part: PathBuf,
    pub out: PathBuf,
    pub file: Option<File>,
    pub width: u32,
    pub height: u32,
    pub total: u64,
    pub shared: Option<(usize, usize)>,
    pub pending: Arc<AtomicUsize>,
    pub started: Instant,
}

pub fn start(core: &Arc<Core>, opt: ExportOptions) -> Result<Value, String> {
    let dir = workspace::work_dir(&core.ws, &opt.work).ok_or("作品がない")?;
    let p = workspace::read_project(&dir)?;
    let from = opt.from.unwrap_or(0);
    let to = opt.to.unwrap_or(p.duration).min(p.duration);
    if to <= from {
        return Err("書き出し範囲が空".into());
    }
    let renders = dir.join("renders");
    std::fs::create_dir_all(&renders).map_err(|e| e.to_string())?;
    // 作品名_日時_内容ハッシュ(git導入まではコミットIDの代わり)
    let base = format!("{}_{}_{}", opt.work, workspace::local_stamp(), workspace::content_hash(&dir));
    let (out, part, file) = match opt.format.as_str() {
        "mp4" => {
            let out = renders.join(format!("{base}.mp4"));
            let part = renders.join(format!("{base}.mp4.part"));
            let f = File::create(&part).map_err(|e| e.to_string())?;
            (out, part, Some(f))
        }
        "png" => {
            let out = renders.join(&base);
            let part = renders.join(format!("{base}.part"));
            std::fs::create_dir_all(&part).map_err(|e| e.to_string())?;
            (out, part, None)
        }
        f => return Err(format!("未対応の形式 {f}")),
    };
    let id = format!("job{}", core.next_id());
    let label = format!("export-{id}");
    let order = opt.order.clone().unwrap_or_else(|| "forward".into());
    if opt.format == "mp4" && order != "forward" {
        return Err("MP4は順方向でしか書き出せない".into());
    }
    let extra = format!("&job={id}&format={}&from={from}&to={to}&order={order}", opt.format);
    let url = core.host_url(&label, &opt.work, "export", &extra);
    core.jobs.lock().unwrap().insert(
        id.clone(),
        Job {
            id: id.clone(),
            label: label.clone(),
            format: opt.format.clone(),
            part,
            out,
            file,
            width: p.width,
            height: p.height,
            total: to - from,
            shared: None,
            pending: Arc::new(AtomicUsize::new(0)),
            started: Instant::now(),
        },
    );
    // visible(false) のウィンドウはページからは表示中に見え、間引かれない(フェーズ0)。
    // プレビューと環境を共有すると遅くなる回があったので、データフォルダを分ける。
    WebviewWindowBuilder::new(&core.app, &label, WebviewUrl::External(url))
        .title(format!("export {id}"))
        .data_directory(core.data.join("webview").join("export"))
        .additional_browser_args(SKETCH_ARGS)
        .inner_size(640.0, 360.0)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    core.log("export", "info", format!("書き出し開始 {id} ({}、{} フレーム)", opt.format, to - from), json!({ "id": id }));
    Ok(json!({ "id": id }))
}

/// 連番PNG用の共有メモリを作ってページへ渡す(ページが準備できたと知らせてから呼ぶ)。
pub fn post_buffer(core: &Arc<Core>, id: &str) -> Result<(), String> {
    let (label, size, w, h) = {
        let jobs = core.jobs.lock().unwrap();
        let j = jobs.get(id).ok_or("no job")?;
        (j.label.clone(), j.width as usize * j.height as usize * 4, j.width, j.height)
    };
    let wv = core.app.get_webview(&label).ok_or("no export webview")?;
    let (tx, rx) = std::sync::mpsc::channel();
    let key = id.to_string();
    wv.with_webview(move |pw| {
        let r = wv2::core(&pw).and_then(|c| {
            wv2::post_shared_buffer(&pw.environment(), &c, &key, size as u64, &format!(r#"{{"width":{w},"height":{h}}}"#))
        });
        let _ = tx.send(r.map_err(|e| e.to_string()));
    })
    .map_err(|e| e.to_string())?;
    let ptr = rx.recv_timeout(Duration::from_secs(10)).map_err(|e| e.to_string())??;
    if let Some(j) = core.jobs.lock().unwrap().get_mut(id) {
        j.shared = Some((ptr, size));
    }
    Ok(())
}

pub fn write(core: &Arc<Core>, id: &str, pos: u64, data: &[u8]) -> Result<(), String> {
    let mut jobs = core.jobs.lock().unwrap();
    let j = jobs.get_mut(id).ok_or("no job")?;
    let f = j.file.as_mut().ok_or("no file")?;
    f.seek(SeekFrom::Start(pos)).map_err(|e| e.to_string())?;
    f.write_all(data).map_err(|e| e.to_string())
}

/// 共有メモリのフレームを写してからPNGへの変換を別スレッドで行う。写し終えた時点で応答するので、
/// ページはすぐ次のフレームを書ける。
pub fn frame(core: &Arc<Core>, id: &str, index: u64) -> Result<(), String> {
    let (ptr, size, w, h, path, pending) = {
        let jobs = core.jobs.lock().unwrap();
        let j = jobs.get(id).ok_or("no job")?;
        let (ptr, size) = j.shared.ok_or("no shared buffer")?;
        (ptr, size, j.width, j.height, j.part.join(format!("frame_{index:06}.png")), j.pending.clone())
    };
    let rgba = unsafe { std::slice::from_raw_parts(ptr as *const u8, size) }.to_vec();
    pending.fetch_add(1, Ordering::SeqCst);
    std::thread::spawn(move || {
        let _ = write_png(&path, w, h, &rgba);
        pending.fetch_sub(1, Ordering::SeqCst);
    });
    Ok(())
}

fn write_png(path: &Path, w: u32, h: u32, rgba: &[u8]) -> Result<(), String> {
    let f = std::io::BufWriter::new(File::create(path).map_err(|e| e.to_string())?);
    let mut enc = png::Encoder::new(f, w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.set_compression(png::Compression::Fast);
    let mut wr = enc.write_header().map_err(|e| e.to_string())?;
    wr.write_image_data(rgba).map_err(|e| e.to_string())
}

pub fn progress(core: &Arc<Core>, id: &str, done: u64) {
    let jobs = core.jobs.lock().unwrap();
    if let Some(j) = jobs.get(id) {
        let el = j.started.elapsed().as_secs_f64();
        let _ = core.app.emit_to("ui", "sb:export", json!({ "id": id, "state": "running", "done": done, "total": j.total, "elapsed": el }));
    }
}

/// 成功・失敗のどちらでも、ウィンドウと共有メモリを片付ける。成功時だけ名前を変える。
pub fn finish(core: &Arc<Core>, id: &str, ok: bool, message: &str) {
    let Some(mut j) = core.jobs.lock().unwrap().remove(id) else { return };
    while j.pending.load(Ordering::SeqCst) > 0 {
        std::thread::sleep(Duration::from_millis(20));
    }
    if let Some(f) = j.file.take() {
        let _ = f.sync_all();
    }
    let result = if ok { std::fs::rename(&j.part, &j.out).map_err(|e| e.to_string()) } else { Err(message.to_string()) };
    if let Some(w) = core.app.get_webview(&j.label) {
        let key = j.id.clone();
        let _ = w.with_webview(move |_| wv2::release_shared_buffer(&key));
    }
    if let Some(w) = core.app.get_webview_window(&j.label) {
        let _ = w.close();
    }
    let el = j.started.elapsed().as_secs_f64();
    let exit_code = if result.is_ok() { 0 } else { 1 };
    match result {
        Ok(()) => {
            core.log("export", "info", format!("書き出し完了 {} ({:.1}秒)", j.out.display(), el), json!({ "id": id }));
            let _ = core.app.emit_to("ui", "sb:export", json!({ "id": id, "state": "done", "path": j.out, "elapsed": el, "total": j.total, "done": j.total }));
        }
        Err(e) => {
            // 失敗したら一時ファイルは残さない(連番は書けたところまで残す)
            if j.format == "mp4" {
                let _ = std::fs::remove_file(&j.part);
            }
            core.log("export", "error", format!("書き出し失敗 {id}: {e}"), json!({ "id": id }));
            let _ = core.app.emit_to("ui", "sb:export", json!({ "id": id, "state": "failed", "error": e }));
        }
    }
    if core.exit_after_export.load(Ordering::SeqCst) {
        core.app.exit(exit_code);
    }
}
