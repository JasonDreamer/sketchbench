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

#[derive(Clone, Debug, Default, Deserialize, serde::Serialize)]
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
    /// format "frames": 描くフレームの一覧。結果はJPEGでメモリに返す(MCPの render_frames)
    #[serde(default)]
    pub frames: Option<Vec<u64>>,
    /// format "sheet": [from, to) から等間隔に何枚並べるか(MCPの render_contact_sheet)
    #[serde(default)]
    pub count: Option<u32>,
    /// frames・sheet の画像の長辺(既定1024)
    #[serde(default)]
    pub max_size: Option<u32>,
    /// 出力の大きさ。省略すると project.json の width・height(16:9 と 9:16 などを同じ作品から書き出す)
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    /// 連番PNGの色深度 8(既定)か 16
    #[serde(default)]
    pub depth: Option<u8>,
    /// 連番PNGのアルファ: "straight"(既定)・"premultiplied"・"none"(黒の上に重ねて不透明にする)
    #[serde(default)]
    pub alpha: Option<String>,
    /// モーションブラー。1フレームの中で samples 回描いて平均する。shutter は1フレームに対する開いている割合(0.5で180度)
    #[serde(default)]
    pub motion_blur: Option<MotionBlur>,
    /// 音声を目標のラウドネスに合わせる(MP4のみ)
    #[serde(default)]
    pub loudness: Option<LoudnessTarget>,
    /// ファイル名の末尾に付ける名前(複数仕様の書き出しで区別する。英数字・-・_)
    #[serde(default)]
    pub name: Option<String>,
    /// frames の画像の形式 "jpeg"(既定)か "png"(差分を取るときなど、劣化させたくないとき)
    #[serde(default)]
    pub image_format: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MotionBlur {
    pub samples: u32,
    #[serde(default = "half")]
    pub shutter: f64,
}

fn half() -> f64 {
    0.5
}

#[derive(Clone, Copy, Debug, Deserialize, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessTarget {
    /// 目標の統合ラウドネス(LUFS)。配信向けは -14 が多い
    pub lufs: f64,
    /// トゥルーピークの上限(dBTP)。既定 -1
    #[serde(default = "minus_one")]
    pub true_peak: f64,
}

fn minus_one() -> f64 {
    -1.0
}

/// 書き出しの結果。frames・sheet は画像(フレーム番号とJPEG)、mp4・png はファイルの場所
#[derive(Clone, Debug, Default)]
pub struct Outcome {
    pub ok: bool,
    pub error: Option<String>,
    pub path: Option<PathBuf>,
    pub images: Vec<(i64, Vec<u8>)>,
    pub elapsed: f64,
    /// 描いたWebViewのラベル(ログの出どころ)。そのジョブのエラーだけを返すのに使う
    pub label: String,
    /// 音声を正規化したときの前後の値
    pub loudness: Option<crate::audio::Normalized>,
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
    /// 連番PNGの色深度(8か16)
    pub depth: u8,
    pub total: u64,
    pub loudness_target: Option<LoudnessTarget>,
    pub loudness: Option<crate::audio::Normalized>,
    pub shared: Option<(usize, usize)>,
    pub pending: Arc<AtomicUsize>,
    pub started: Instant,
    /// frames・sheet で受け取った画像
    pub images: Vec<(i64, Vec<u8>)>,
    /// 終わったら結果を渡す相手(MCPのツールが待つ)
    pub waiters: Vec<tokio::sync::oneshot::Sender<Outcome>>,
}

/// 書き出しを始め、終わるまで待つ(MCPと sb render から使う)
pub async fn run(core: &Arc<Core>, opt: ExportOptions) -> Outcome {
    let id = match start(core, opt) {
        Ok(v) => v["id"].as_str().unwrap_or_default().to_string(),
        Err(e) => return Outcome { ok: false, error: Some(e), ..Default::default() },
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    match core.jobs.lock().unwrap().get_mut(&id) {
        Some(j) => j.waiters.push(tx),
        None => return Outcome { ok: false, error: Some("書き出しが始まらなかった".into()), ..Default::default() },
    }
    rx.await.unwrap_or(Outcome { ok: false, error: Some("書き出しが途中で終わった".into()), ..Default::default() })
}

/// frames・sheet の画像を受け取る
pub fn image(core: &Arc<Core>, id: &str, index: i64, jpeg: Vec<u8>) -> Result<(), String> {
    let mut jobs = core.jobs.lock().unwrap();
    let j = jobs.get_mut(id).ok_or("no job")?;
    j.images.push((index, jpeg));
    Ok(())
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
    let mut base = format!("{}_{}_{}", opt.work, workspace::local_stamp(), workspace::content_hash(&dir));
    if let Some(n) = opt.name.as_deref().filter(|n| !n.is_empty()) {
        if !n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err("name は英数字・-・_ だけ".into());
        }
        base.push('_');
        base.push_str(n);
    }
    let (width, height) = (opt.width.unwrap_or(p.width), opt.height.unwrap_or(p.height));
    if !(16..=16384).contains(&width) || !(16..=16384).contains(&height) {
        return Err("width・height は16〜16384".into());
    }
    if opt.format == "mp4" && (width % 2 != 0 || height % 2 != 0) {
        return Err("MP4の width・height は偶数にする".into());
    }
    let depth = opt.depth.unwrap_or(8);
    if depth != 8 && depth != 16 {
        return Err("depth は 8 か 16".into());
    }
    if depth == 16 && opt.format != "png" {
        return Err("16bit は連番PNGだけ".into());
    }
    let alpha = opt.alpha.clone().unwrap_or_else(|| "straight".into());
    if !["straight", "premultiplied", "none"].contains(&alpha.as_str()) {
        return Err("alpha は straight・premultiplied・none のどれか".into());
    }
    if alpha != "straight" && opt.format != "png" {
        return Err("alpha を選べるのは連番PNGだけ(MP4はアルファを持たない)".into());
    }
    if let Some(m) = opt.motion_blur {
        if !(1..=64).contains(&m.samples) || !(m.shutter > 0.0 && m.shutter <= 1.0) {
            return Err("motionBlur は samples 1〜64、shutter 0より大きく1以下".into());
        }
    }
    if opt.loudness.is_some() && opt.format != "mp4" {
        return Err("loudness はMP4だけ(音声を持つ形式)".into());
    }
    // 同じ秒に同じ作品を書き出すと名前がぶつかるので、あれば番号を付ける(上書きしない)
    let taken = |b: &str| ["", ".mp4", ".part", ".mp4.part"].iter().any(|ext| renders.join(format!("{b}{ext}")).exists());
    if taken(&base) {
        let mut n = 2;
        while taken(&format!("{base}-{n}")) {
            n += 1;
        }
        base = format!("{base}-{n}");
    }
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
        // 画像はメモリで返すのでファイルは作らない
        "frames" | "sheet" => (PathBuf::new(), PathBuf::new(), None),
        f => return Err(format!("未対応の形式 {f}")),
    };
    let mut extra_q = String::new();
    if opt.format == "frames" {
        let fr = opt.frames.clone().unwrap_or_default();
        if fr.is_empty() || fr.len() > 64 {
            return Err("frames は1〜64個".into());
        }
        if let Some(bad) = fr.iter().find(|&&f| f >= p.duration) {
            return Err(format!("フレーム {bad} は尺({})の外", p.duration));
        }
        extra_q = format!("&frames={}", fr.iter().map(|f| f.to_string()).collect::<Vec<_>>().join(","));
    }
    if opt.format == "sheet" {
        extra_q = format!("&count={}", opt.count.unwrap_or(12).clamp(1, 64));
    }
    if opt.format == "frames" || opt.format == "sheet" {
        extra_q.push_str(&format!("&maxSize={}", opt.max_size.unwrap_or(1024).clamp(64, 4096)));
        if opt.image_format.as_deref() == Some("png") {
            extra_q.push_str("&img=png");
        }
    }
    let id = format!("job{}", core.next_id());
    let label = format!("export-{id}");
    core.last_render.lock().unwrap().insert(opt.work.clone(), label.clone());
    let order = opt.order.clone().unwrap_or_else(|| "forward".into());
    if opt.format == "mp4" && order != "forward" {
        return Err("MP4は順方向でしか書き出せない".into());
    }
    let mut extra = format!("&job={id}&format={}&from={from}&to={to}&order={order}&w={width}&h={height}&depth={depth}&alpha={alpha}{extra_q}", opt.format);
    if let Some(m) = opt.motion_blur.filter(|m| m.samples > 1) {
        extra.push_str(&format!("&mbs={}&mbsh={}", m.samples, m.shutter));
    }
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
            width,
            height,
            depth,
            total: to - from,
            loudness_target: opt.loudness,
            loudness: None,
            shared: None,
            pending: Arc::new(AtomicUsize::new(0)),
            started: Instant::now(),
            images: vec![],
            waiters: vec![],
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
        (j.label.clone(), j.width as usize * j.height as usize * if j.depth == 16 { 8 } else { 4 }, j.width, j.height)
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
    let (ptr, size, w, h, depth, path, pending) = {
        let jobs = core.jobs.lock().unwrap();
        let j = jobs.get(id).ok_or("no job")?;
        let (ptr, size) = j.shared.ok_or("no shared buffer")?;
        (ptr, size, j.width, j.height, j.depth, j.part.join(format!("frame_{index:06}.png")), j.pending.clone())
    };
    let mut rgba = unsafe { std::slice::from_raw_parts(ptr as *const u8, size) }.to_vec();
    pending.fetch_add(1, Ordering::SeqCst);
    std::thread::spawn(move || {
        // 16bit: ページはリトルエンディアンで書く。PNGはビッグエンディアン
        if depth == 16 {
            for px in rgba.chunks_exact_mut(2) {
                px.swap(0, 1);
            }
        }
        let _ = write_png(&path, w, h, depth, &rgba);
        pending.fetch_sub(1, Ordering::SeqCst);
    });
    Ok(())
}

fn write_png(path: &Path, w: u32, h: u32, depth: u8, rgba: &[u8]) -> Result<(), String> {
    let f = std::io::BufWriter::new(File::create(path).map_err(|e| e.to_string())?);
    let mut enc = png::Encoder::new(f, w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(if depth == 16 { png::BitDepth::Sixteen } else { png::BitDepth::Eight });
    enc.set_compression(png::Compression::Fast);
    let mut wr = enc.write_header().map_err(|e| e.to_string())?;
    wr.write_image_data(rgba).map_err(|e| e.to_string())
}

/// 書き出しのミックスに、指定があればラウドネスの正規化をかける(書き出しのページが音声を取りに来たとき)
pub fn mix_for_job(core: &Arc<Core>, id: &str, mut pcm: Vec<f32>, sr: u32) -> Result<Vec<f32>, String> {
    let target = core.jobs.lock().unwrap().get(id).and_then(|j| j.loudness_target);
    let Some(t) = target else { return Ok(pcm) };
    let r = crate::audio::normalize_loudness(&mut pcm, sr, t.lufs, t.true_peak)?;
    core.log(
        "export",
        "info",
        format!("音量: {:.1} LUFS / {:.1} dBTP → {:.1} LUFS / {:.1} dBTP(ゲイン {:+.1} dB)", r.before.lufs, r.before.true_peak_db, r.after.lufs, r.after.true_peak_db, r.gain_db),
        json!({ "id": id }),
    );
    if let Some(j) = core.jobs.lock().unwrap().get_mut(id) {
        j.loudness = Some(r);
    }
    Ok(pcm)
}

/// 書き出しを中止する(一時ファイルは消す。連番は書けたところまで残す)
pub fn cancel(core: &Arc<Core>, id: &str) {
    finish(core, id, false, "中止した");
}

pub fn progress(core: &Arc<Core>, id: &str, done: u64) {
    crate::queue::on_progress(core, id, done);
    let jobs = core.jobs.lock().unwrap();
    if let Some(j) = jobs.get(id).filter(|j| j.format != "frames" && j.format != "sheet") {
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
    let in_memory = j.format == "frames" || j.format == "sheet";
    let result = if !ok {
        Err(message.to_string())
    } else if in_memory {
        Ok(())
    } else {
        std::fs::rename(&j.part, &j.out).map_err(|e| e.to_string())
    };
    if let Some(w) = core.app.get_webview(&j.label) {
        let key = j.id.clone();
        let _ = w.with_webview(move |_| wv2::release_shared_buffer(&key));
    }
    if let Some(w) = core.app.get_webview_window(&j.label) {
        let _ = w.close();
    }
    let el = j.started.elapsed().as_secs_f64();
    let exit_code = if result.is_ok() { 0 } else { 1 };
    let outcome = Outcome {
        ok: result.is_ok(),
        error: result.as_ref().err().cloned(),
        path: (!in_memory && result.is_ok()).then(|| j.out.clone()),
        images: std::mem::take(&mut j.images),
        elapsed: el,
        label: j.label.clone(),
        loudness: j.loudness,
    };
    for w in j.waiters.drain(..) {
        let _ = w.send(outcome.clone());
    }
    if in_memory {
        if core.exit_after_export.load(Ordering::SeqCst) {
            core.app.exit(exit_code);
        }
        return;
    }
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
