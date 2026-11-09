//! Sketchbench フェーズ0 技術検証アプリ。
//! UI WebView とスケッチ WebView(別のWebView2環境)を1つのウィンドウに置き、
//! 技術リスク表の9項目を計測して results/raw.jsonl に追記する。
//! `--auto` で全項目を順に実行して終了する。`--long` で非表示6分の間引き計測、
//! `--gpu-hang` でシェーダーの無限ループ試験を加える(画面が数秒止まることがある)。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod http;
mod screen;
mod wv2;

use std::collections::HashMap;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::http::{Request, Response};
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;

/// wryの既定値(--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection)。
/// additional_browser_args を指定すると置き換わるので、常にこれを含める。
const DEFAULT_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";
/// スケッチ用環境の起動引数(設計書の案)。
const SKETCH_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --disable-background-timer-throttling --enable-features=CanvasDrawElement";
/// タイマー間引きだけを止めた比較用。
const THROTTLE_ONLY_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-background-timer-throttling";

const SB: &str = "http://sb.localhost";

pub struct St {
    root: PathBuf,
    data: PathBuf,
    out: Mutex<std::fs::File>,
    waiters: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    hb: Mutex<HashMap<String, Instant>>,
    hello: Mutex<HashMap<String, Instant>>,
    events: Mutex<Vec<(Instant, String, Value)>>,
    shared: Mutex<Option<(usize, usize)>>,
    sink: Mutex<Vec<u8>>,
    still: Mutex<Vec<u8>>,
    bounds_log: Mutex<Vec<f64>>,
    seq: AtomicU64,
    pub http_port: Mutex<u16>,
    pub token: String,
    sketch_label: Mutex<String>,
    follow: Mutex<bool>,
}

impl St {
    fn rec(&self, item: &str, key: &str, value: Value) {
        let line = json!({ "item": item, "key": key, "value": value });
        println!("[{item}] {key}: {value}");
        let mut f = self.out.lock().unwrap();
        let _ = writeln!(f, "{line}");
        let _ = f.flush();
    }
    fn event(&self, label: &str, v: Value) {
        println!("[event] {label}: {v}");
        self.events.lock().unwrap().push((Instant::now(), label.to_string(), v));
    }
}

fn st(app: &AppHandle) -> Arc<St> {
    app.state::<Arc<St>>().inner().clone()
}

// ---------------------------------------------------------------- 専用URIスキーム

fn resp(status: u16, ctype: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", ctype)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Headers", "*")
        .header("Cache-Control", "no-store")
        .body(body)
        .unwrap()
}

fn query(req: &Request<Vec<u8>>, key: &str) -> Option<String> {
    req.uri().query()?.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then(|| v.to_string())
    })
}

/// 受信データの整合確認用。1MBごとの1バイトを足す。
fn sample_sum(b: &[u8]) -> u64 {
    b.iter().step_by(1 << 20).map(|&x| x as u64).sum()
}

fn handle_scheme(app: &AppHandle, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let s = st(app);
    let path = req.uri().path().to_string();
    if req.method() == "OPTIONS" {
        return resp(204, "text/plain", vec![]);
    }
    let body = req.body();
    match path.as_str() {
        p if p.starts_with("/s/") => {
            let rel = &p[3..];
            if rel.contains("..") {
                return resp(403, "text/plain", vec![]);
            }
            let f = s.root.join("sketch").join(rel);
            let ctype = match f.extension().and_then(|e| e.to_str()) {
                Some("html") => "text/html; charset=utf-8",
                Some("js") => "text/javascript; charset=utf-8",
                Some("png") => "image/png",
                Some("woff2") => "font/woff2",
                Some("ttf") => "font/ttf",
                _ => "application/octet-stream",
            };
            match std::fs::read(&f) {
                Ok(b) => resp(200, ctype, b),
                Err(_) => resp(404, "text/plain", vec![]),
            }
        }
        "/report" => {
            if let Ok(v) = serde_json::from_slice::<Value>(body) {
                s.rec(
                    v["item"].as_str().unwrap_or("?"),
                    v["key"].as_str().unwrap_or("?"),
                    v["value"].clone(),
                );
            }
            resp(200, "text/plain", vec![])
        }
        "/done" => {
            let id = query(&req, "id").unwrap_or_default();
            let v = serde_json::from_slice::<Value>(body).unwrap_or(Value::Null);
            if let Some(tx) = s.waiters.lock().unwrap().remove(&id) {
                let _ = tx.send(v);
            }
            resp(200, "text/plain", vec![])
        }
        "/hb" => {
            let l = query(&req, "l").unwrap_or_default();
            s.hb.lock().unwrap().insert(l, Instant::now());
            resp(200, "text/plain", vec![])
        }
        "/hello" => {
            let l = query(&req, "l").unwrap_or_default();
            println!("[hello] {l}");
            s.hello.lock().unwrap().insert(l, Instant::now());
            resp(200, "text/plain", vec![])
        }
        "/frame" => resp(200, "text/plain", format!("{} {}", body.len(), sample_sum(body)).into_bytes()),
        "/sbuf" => {
            // 共有メモリに書かれたフレームを、ffmpegへのパイプ書き込みを模してRust側のバッファへ写す
            let info = *s.shared.lock().unwrap();
            match info {
                Some((ptr, len)) => {
                    let src = unsafe { std::slice::from_raw_parts(ptr as *const u8, len) };
                    let mut sink = s.sink.lock().unwrap();
                    sink.resize(len, 0);
                    sink.copy_from_slice(src);
                    resp(200, "text/plain", format!("{} {}", len, sample_sum(&sink)).into_bytes())
                }
                None => resp(409, "text/plain", b"no shared buffer".to_vec()),
            }
        }
        "/save" => {
            let name = query(&req, "name").unwrap_or_else(|| "blob.bin".into());
            let name: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-' || *c == '_').collect();
            let _ = std::fs::write(s.root.join("results").join(name), body);
            resp(200, "text/plain", vec![])
        }
        "/rect" => {
            // UIのプレビュー領域が変わったら子WebViewを追従させる
            if *s.follow.lock().unwrap() {
                if let Ok(v) = serde_json::from_slice::<Value>(body) {
                    let label = s.sketch_label.lock().unwrap().clone();
                    if let Some(wv) = app.get_webview(&label) {
                        let t0 = Instant::now();
                        let _ = wv.set_bounds(tauri::Rect {
                            position: LogicalPosition::new(v["x"].as_f64().unwrap_or(0.0), v["y"].as_f64().unwrap_or(0.0)).into(),
                            size: LogicalSize::new(v["w"].as_f64().unwrap_or(100.0), v["h"].as_f64().unwrap_or(100.0)).into(),
                        });
                        s.bounds_log.lock().unwrap().push(t0.elapsed().as_secs_f64() * 1000.0);
                    }
                }
            }
            resp(200, "text/plain", vec![])
        }
        "/still.png" => resp(200, "image/png", s.still.lock().unwrap().clone()),
        "/sysfont" => {
            // foreignObjectのWebフォント試験用。許可した1ファイルだけを返す
            match query(&req, "name").as_deref() {
                Some("impact.ttf") => match std::fs::read(r"C:\Windows\Fonts\impact.ttf") {
                    Ok(b) => resp(200, "font/ttf", b),
                    Err(_) => resp(404, "text/plain", vec![]),
                },
                _ => resp(403, "text/plain", vec![]),
            }
        }
        "/run" => {
            let name = query(&req, "t").unwrap_or_default();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = run_one(&app, &name, false).await {
                    st(&app).rec("run", &name, json!(format!("error: {e}")));
                }
            });
            resp(200, "text/plain", vec![])
        }
        _ => resp(404, "text/plain", vec![]),
    }
}

// ---------------------------------------------------------------- 実行の補助

type R<T> = Result<T, String>;

/// メインスレッドでWebView2のCOMを触り、結果を受け取る。
async fn on_wv<T: Send + 'static>(
    app: &AppHandle,
    label: &str,
    f: impl FnOnce(&tauri::webview::PlatformWebview) -> T + Send + 'static,
) -> R<T> {
    let wv = app.get_webview(label).ok_or(format!("no webview {label}"))?;
    let (tx, rx) = oneshot::channel();
    wv.with_webview(move |pw| {
        let _ = tx.send(f(&pw));
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())
}

/// WebView内で式を評価し、Promiseの結果を待つ。
async fn js(app: &AppHandle, label: &str, expr: &str, timeout: Duration) -> R<Value> {
    let s = st(app);
    let id = format!("q{}", s.seq.fetch_add(1, Ordering::SeqCst));
    let (tx, rx) = oneshot::channel();
    s.waiters.lock().unwrap().insert(id.clone(), tx);
    let wv = app.get_webview(label).ok_or(format!("no webview {label}"))?;
    wv.eval(format!("window.__run({id:?}, () => ({expr}))")).map_err(|e| e.to_string())?;
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(v)) => {
            if v["ok"].as_bool() == Some(true) {
                Ok(v["v"].clone())
            } else {
                Err(v["err"].as_str().unwrap_or("js error").to_string())
            }
        }
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => {
            s.waiters.lock().unwrap().remove(&id);
            Err(format!("timeout: {expr}"))
        }
    }
}

async fn wait_hello(app: &AppHandle, label: &str, since: Instant, timeout: Duration) -> R<Duration> {
    let s = st(app);
    let t0 = Instant::now();
    loop {
        if let Some(t) = s.hello.lock().unwrap().get(label) {
            if *t >= since {
                return Ok(*t - since);
            }
        }
        if t0.elapsed() > timeout {
            return Err(format!("{label} did not load"));
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn sketch_url(page: &str, label: &str) -> tauri::Url {
    let s = format!("{SB}/s/{page}?l={label}");
    s.parse().unwrap()
}

fn data_dir(app: &AppHandle, name: &str) -> PathBuf {
    st(app).data.join(name)
}

/// プレビュー用の子WebViewをUIと別のWebView2環境で作る。
async fn create_sketch_child(app: &AppHandle, label: &str) -> R<Duration> {
    let win = app.get_window("main").ok_or("no main window")?;
    let rect = js(app, "ui", "UI.previewRect()", Duration::from_secs(5)).await?;
    let b = WebviewBuilder::new(label, WebviewUrl::External(sketch_url("tests.html", label)))
        .data_directory(data_dir(app, "sketch"))
        .additional_browser_args(SKETCH_ARGS);
    let t0 = Instant::now();
    win.add_child(
        b,
        LogicalPosition::new(rect["x"].as_f64().unwrap(), rect["y"].as_f64().unwrap()),
        LogicalSize::new(rect["w"].as_f64().unwrap(), rect["h"].as_f64().unwrap()),
    )
    .map_err(|e| e.to_string())?;
    *st(app).sketch_label.lock().unwrap() = label.to_string();
    let a2 = app.clone();
    let l2 = label.to_string();
    on_wv(app, label, move |pw| {
        let core = wv2::core(pw).unwrap();
        let a3 = a2.clone();
        let l3 = l2.clone();
        let _ = wv2::on_process_failed(&core, move |v| st(&a3).event(&format!("process_failed:{l3}"), v));
        let _ = wv2::on_permission(&core, move |v| st(&a2).event(&format!("permission:{l2}"), v));
    })
    .await?;
    let d = wait_hello(app, label, t0, Duration::from_secs(20)).await?;
    Ok(d)
}

fn ms(d: Duration) -> f64 {
    (d.as_secs_f64() * 1e5).round() / 100.0
}

fn stats(mut v: Vec<f64>) -> Value {
    if v.is_empty() {
        return Value::Null;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let r = |x: f64| (x * 100.0).round() / 100.0;
    json!({ "n": v.len(), "median": r(v[v.len() / 2]), "p95": r(v[(v.len() * 95 / 100).min(v.len() - 1)]), "max": r(v[v.len() - 1]) })
}

/// 環境に属するプロセスのワーキングセット合計(MB)。
async fn env_memory(app: &AppHandle, label: &str) -> R<Value> {
    let infos = on_wv(app, label, |pw| wv2::process_infos(&pw.environment()).map_err(|e| e.to_string())).await??;
    let pids: Vec<sysinfo::Pid> = infos.iter().map(|(p, _)| sysinfo::Pid::from_u32(*p)).collect();
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&pids), true);
    let mut by_kind: HashMap<&str, f64> = HashMap::new();
    let mut total = 0.0;
    for (pid, kind) in &infos {
        if let Some(p) = sys.process(sysinfo::Pid::from_u32(*pid)) {
            let mb = p.memory() as f64 / 1048576.0;
            *by_kind.entry(kind).or_default() += mb;
            total += mb;
        }
    }
    let by_kind: HashMap<&str, f64> = by_kind.into_iter().map(|(k, v)| (k, v.round())).collect();
    Ok(json!({ "totalMB": total.round(), "byKind": by_kind, "processes": infos.len() }))
}

// ---------------------------------------------------------------- 各項目

/// 2. UIとスケッチのプロセス分離
async fn t_process(app: &AppHandle) -> R<()> {
    let s = st(app);
    let it = "2-process";
    let sk = s.sketch_label.lock().unwrap().clone();
    let ui_pid = on_wv(app, "ui", |pw| wv2::browser_pid(&wv2::core(pw).unwrap())).await?;
    let sk_pid = on_wv(app, &sk, |pw| wv2::browser_pid(&wv2::core(pw).unwrap())).await?;
    let ui_p = on_wv(app, "ui", |pw| wv2::process_infos(&pw.environment()).map_err(|e| e.to_string())).await??;
    let sk_p = on_wv(app, &sk, |pw| wv2::process_infos(&pw.environment()).map_err(|e| e.to_string())).await??;
    let overlap: Vec<_> = ui_p.iter().filter(|a| sk_p.iter().any(|b| b.0 == a.0)).collect();
    s.rec(it, "browser_pid", json!({ "ui": ui_pid, "sketch": sk_pid, "separate": ui_pid != sk_pid }));
    s.rec(it, "process_infos", json!({ "ui": ui_p, "sketch": sk_p, "shared_pids": overlap }));

    // スケッチを5秒ビジーループさせ、その間のUIのrAF間隔を測る
    js(app, "ui", "UI.monStart('idle')", Duration::from_secs(2)).await?;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let idle = js(app, "ui", "UI.monStop('idle')", Duration::from_secs(2)).await?;
    js(app, "ui", "UI.monStart('busy')", Duration::from_secs(2)).await?;
    app.get_webview(&sk).unwrap().eval("setTimeout(() => { const e = performance.now() + 5000; while (performance.now() < e) {} }, 0)").ok();
    tokio::time::sleep(Duration::from_secs(6)).await;
    let busy = js(app, "ui", "UI.monStop('busy')", Duration::from_secs(2)).await?;
    s.rec(it, "ui_frame_gaps_during_sketch_busy_loop_5s", json!({ "idle": idle, "busy": busy }));
    Ok(())
}

/// 生存通知が途切れたら作り直す(無限ループ)
async fn t_hang_recover(app: &AppHandle) -> R<()> {
    let s = st(app);
    let it = "2-process";
    let sk = s.sketch_label.lock().unwrap().clone();
    // 生存通知が来ていることを確認
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let last = s.hb.lock().unwrap().get(&sk).copied();
    let hb_ok = last.map(|t| t.elapsed() < Duration::from_secs(1)).unwrap_or(false);
    js(app, "ui", "UI.monStart('hang')", Duration::from_secs(2)).await?;
    let t_hang = Instant::now();
    app.get_webview(&sk).unwrap().eval("setTimeout(() => { while (true) {} }, 0)").ok();
    // 監視: 2秒途切れたら検知
    let detected = loop {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let last = s.hb.lock().unwrap().get(&sk).copied().unwrap_or(t_hang);
        if last.elapsed() > Duration::from_secs(2) {
            break t_hang.elapsed();
        }
        if t_hang.elapsed() > Duration::from_secs(15) {
            return Err("heartbeat never stopped".into());
        }
    };
    // 作り直し
    let t_close = Instant::now();
    let w = app.get_webview(&sk).unwrap();
    let close_res = w.close().map_err(|e| e.to_string());
    let close_ms = ms(t_close.elapsed());
    let new_label = format!("sketch{}", s.seq.fetch_add(1, Ordering::SeqCst));
    let t_new = Instant::now();
    let load = create_sketch_child(app, &new_label).await?;
    let ui = js(app, "ui", "UI.monStop('hang')", Duration::from_secs(2)).await?;
    s.rec(it, "hang_recovery", json!({
        "heartbeat_before": hb_ok,
        "detect_ms_from_hang": ms(detected),
        "close_ms": close_ms, "close_result": format!("{close_res:?}"),
        "recreate_to_first_hello_ms": ms(t_new.elapsed()), "child_load_ms": ms(load),
        "ui_frame_gaps_during": ui,
    }));
    Ok(())
}

/// ProcessFailedの発火(レンダラーを強制終了)
async fn t_process_failed(app: &AppHandle) -> R<()> {
    let s = st(app);
    let it = "2-process";
    let sk = s.sketch_label.lock().unwrap().clone();
    let infos = on_wv(app, &sk, |pw| wv2::process_infos(&pw.environment()).map_err(|e| e.to_string())).await??;
    let renderers: Vec<u32> = infos.iter().filter(|(_, k)| *k == "renderer").map(|(p, _)| *p).collect();
    let n0 = s.events.lock().unwrap().len();
    let t0 = Instant::now();
    let killed: Vec<bool> = renderers.iter().map(|p| wv2::terminate_pid(*p)).collect();
    let mut got = None;
    while t0.elapsed() < Duration::from_secs(5) {
        tokio::time::sleep(Duration::from_millis(5)).await;
        let ev = s.events.lock().unwrap();
        if let Some((t, l, v)) = ev.iter().skip(n0).find(|(_, l, _)| l.starts_with("process_failed")) {
            got = Some((ms(*t - t0), l.clone(), v.clone()));
            break;
        }
    }
    s.rec(it, "process_failed_on_renderer_kill", json!({ "renderers": renderers, "killed": killed, "event": got }));
    let _ = app.get_webview(&sk).map(|w| w.close());
    let new_label = format!("sketch{}", s.seq.fetch_add(1, Ordering::SeqCst));
    let t1 = Instant::now();
    create_sketch_child(app, &new_label).await?;
    s.rec(it, "recreate_after_process_failed_ms", json!(ms(t1.elapsed())));
    Ok(())
}

/// 3. 非圧縮フレームの転送
async fn t_transfer(app: &AppHandle) -> R<()> {
    let s = st(app);
    let sk = s.sketch_label.lock().unwrap().clone();
    let size = 3840usize * 2160 * 4;
    let a2 = app.clone();
    let t0 = Instant::now();
    let ptr = on_wv(app, &sk, move |pw| {
        let core = wv2::core(pw).unwrap();
        wv2::post_shared_buffer(&pw.environment(), &core, size as u64, r#"{"kind":"frame","w":3840,"h":2160}"#)
            .map_err(|e| e.to_string())
    })
    .await?;
    let post_ms = ms(t0.elapsed());
    match ptr {
        Ok(p) => {
            *s.shared.lock().unwrap() = Some((p, size));
            s.rec("3-transfer", "shared_buffer_create_and_post_ms", json!(post_ms));
        }
        Err(e) => s.rec("3-transfer", "shared_buffer_error", json!(e)),
    }
    let _ = a2;
    let port = *s.http_port.lock().unwrap();
    let r = js(
        app,
        &sk,
        &format!("T.transfer({{ n: 15, port: {port}, token: {:?} }})", s.token),
        Duration::from_secs(180),
    )
    .await?;
    s.rec("3-transfer", "4k_rgba8_roundtrip", r);
    let ev: Vec<Value> = s.events.lock().unwrap().iter().filter(|(_, l, _)| l.starts_with("permission")).map(|(_, l, v)| json!({ "label": l, "v": v })).collect();
    s.rec("3-transfer", "permission_requests_seen", json!(ev));
    on_wv(app, &sk, |_| wv2::release_shared_buffers()).await?;
    *s.shared.lock().unwrap() = None;
    Ok(())
}

/// 4. HTMLレンダラー(CapturePreviewの速度を含む)
async fn t_html(app: &AppHandle) -> R<()> {
    let s = st(app);
    let it = "4-html";
    let sk = s.sketch_label.lock().unwrap().clone();
    for (env, label) in [("sketch(CanvasDrawElement指定)", sk.as_str()), ("ui(指定なし)", "ui")] {
        let r = js(app, label, "T.hic()", Duration::from_secs(20)).await;
        s.rec(it, &format!("html_in_canvas {env}"), r.unwrap_or_else(|e| json!(e)));
    }
    let r = js(app, &sk, "T.foreignObject()", Duration::from_secs(30)).await;
    s.rec(it, "foreign_object", r.unwrap_or_else(|e| json!(e)));
    let r = js(app, &sk, "T.cssClock()", Duration::from_secs(20)).await;
    s.rec(it, "css_under_virtual_clock", r.unwrap_or_else(|e| json!(e)));
    let mut times = vec![];
    let mut size = 0;
    for _ in 0..10 {
        let (d, n) = capture(app, &sk).await?;
        times.push(ms(d));
        size = n;
    }
    let dims = js(app, &sk, "({ w: innerWidth * devicePixelRatio, h: innerHeight * devicePixelRatio })", Duration::from_secs(2)).await?;
    s.rec(it, "capture_preview_png_ms", json!({ "stats": stats(times), "bytes": size, "pixels": dims }));

    // 1920x1080の非表示ウィンドウで、文字と図形の多いページを取り込む
    let label = format!("cap{}", s.seq.fetch_add(1, Ordering::SeqCst));
    let t0 = Instant::now();
    let w = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(sketch_url("tests.html", &label)))
        .data_directory(data_dir(app, "sketch"))
        .additional_browser_args(SKETCH_ARGS)
        .inner_size(1920.0, 1080.0)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    wait_hello(app, &label, t0, Duration::from_secs(20)).await?;
    js(app, &label, "T.busyPage()", Duration::from_secs(5)).await?;
    let mut times = vec![];
    let mut size = 0;
    for _ in 0..10 {
        let (d, n) = capture(app, &label).await?;
        times.push(ms(d));
        size = n;
    }
    let _ = std::fs::write(s.root.join("results").join("capture_1080p_hidden.png"), s.still.lock().unwrap().as_slice());
    let dims = js(app, &label, "({ w: innerWidth * devicePixelRatio, h: innerHeight * devicePixelRatio })", Duration::from_secs(2)).await?;
    s.rec(it, "capture_preview_png_ms_1080p_hidden_window", json!({ "stats": stats(times), "bytes": size, "pixels": dims }));
    w.close().ok();
    Ok(())
}

async fn capture(app: &AppHandle, label: &str) -> R<(Duration, usize)> {
    let (tx, rx) = oneshot::channel();
    let t0 = Instant::now();
    let a2 = app.clone();
    on_wv(app, label, move |pw| {
        let core = wv2::core(pw).unwrap();
        let r = wv2::capture_png(&core, move |r| {
            if let Ok(b) = &r {
                *st(&a2).still.lock().unwrap() = b.clone();
            }
            let _ = tx.send(r);
        });
        if let Err(e) = r {
            println!("capture error {e}");
        }
    })
    .await?;
    let png = tokio::time::timeout(Duration::from_secs(10), rx).await.map_err(|_| "capture timeout")?.map_err(|e| e.to_string())??;
    Ok((t0.elapsed(), png.len()))
}

/// 6. 子WebView(位置追従、表示切替、静止画への切り替え)
async fn t_child(app: &AppHandle) -> R<()> {
    let s = st(app);
    let it = "6-child";
    let sk = s.sketch_label.lock().unwrap().clone();
    let win = app.get_window("main").unwrap();
    let size0 = win.inner_size().map_err(|e| e.to_string())?;
    s.bounds_log.lock().unwrap().clear();
    // ウィンドウを30回リサイズし、UIのResizeObserver→/rect→set_boundsまでを記録
    js(app, "ui", "UI.rectLogStart()", Duration::from_secs(2)).await?;
    let mut resize_ms = vec![];
    for i in 0..30 {
        let w = size0.width as f64 - 200.0 + (i % 10) as f64 * 40.0;
        let t0 = Instant::now();
        win.set_size(tauri::PhysicalSize::new(w as u32, size0.height)).map_err(|e| e.to_string())?;
        resize_ms.push(ms(t0.elapsed()));
        tokio::time::sleep(Duration::from_millis(60)).await;
    }
    win.set_size(size0).ok();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let ui_side = js(app, "ui", "UI.rectLogStop()", Duration::from_secs(2)).await?;
    let sb = s.bounds_log.lock().unwrap().clone();
    s.rec(it, "follow_resize", json!({ "window_set_size_ms": stats(resize_ms), "child_set_bounds_ms": stats(sb), "ui_rect_post_roundtrip_ms": ui_side }));

    // ちらつきの判定: ドラッグ相当の速さ(約60Hz)でリサイズしながら画面を取り込み、
    // 子WebViewの下にあるプレビュー領域の背景色(#222222)が見えている画素を数える
    let mut flicker = |phase: &str, frames: usize, resize: bool| -> Value {
        let mut counts = vec![];
        let mut worst = (0usize, vec![], 0, 0);
        for i in 0..frames {
            if resize {
                let w = size0.width as i32 - 300 + ((i % 20) as i32 - 10).abs() * 30;
                let _ = win.set_size(tauri::PhysicalSize::new(w as u32, size0.height));
            }
            std::thread::sleep(Duration::from_millis(16));
            let pos = win.inner_position().unwrap();
            let sz = win.inner_size().unwrap();
            let (w, h) = (sz.width as i32, sz.height as i32);
            let px = screen::grab(pos.x, pos.y, w, h);
            let n = px.chunks_exact(4).filter(|p| p[0] == 0x22 && p[1] == 0x22 && p[2] == 0x22).count();
            if n >= worst.0 {
                worst = (n, px, w, h);
            }
            counts.push(n as f64);
        }
        let f: String = phase.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
        let _ = screen::save_bmp(&s.root.join("results").join(format!("flicker_{f}_worst.bmp")), worst.2, worst.3, &worst.1);
        let exposed = counts.iter().filter(|&&n| n > 0.0).count();
        json!({ "frames": frames, "framesWithExposedBackground": exposed, "exposedPixels": stats(counts) })
    };
    let rest = flicker("rest", 20, false);
    let drag = flicker("drag", 120, true);
    win.set_size(size0).ok();
    tokio::time::sleep(Duration::from_millis(300)).await;
    s.rec(it, "flicker_probe", json!({ "atRest": rest, "duringResize60Hz": drag }));

    // 非表示→表示の切り替え時間
    let wv = app.get_webview(&sk).unwrap();
    let mut hide = vec![];
    let mut show = vec![];
    for _ in 0..10 {
        let t0 = Instant::now();
        wv.hide().map_err(|e| e.to_string())?;
        hide.push(ms(t0.elapsed()));
        tokio::time::sleep(Duration::from_millis(50)).await;
        let t0 = Instant::now();
        wv.show().map_err(|e| e.to_string())?;
        show.push(ms(t0.elapsed()));
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    s.rec(it, "hide_show_call_ms", json!({ "hide": stats(hide), "show": stats(show) }));

    // 静止画への切り替え: CapturePreview → UIで表示 → 子WebViewを隠す
    let mut total = vec![];
    let mut ui_ms = vec![];
    for _ in 0..5 {
        let t0 = Instant::now();
        capture(app, &sk).await?;
        let r = js(app, "ui", "UI.showStill()", Duration::from_secs(5)).await?;
        wv.hide().ok();
        total.push(ms(t0.elapsed()));
        ui_ms.push(r.as_f64().unwrap_or(-1.0));
        tokio::time::sleep(Duration::from_millis(200)).await;
        wv.show().ok();
        js(app, "ui", "UI.hideStill()", Duration::from_secs(2)).await?;
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    s.rec(it, "swap_to_still_ms", json!({ "total": stats(total), "ui_fetch_decode": stats(ui_ms) }));
    // 子WebViewが隠れている間、そのページは非表示扱いになるか
    wv.hide().ok();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let vis = js(app, &sk, "({ visibility: document.visibilityState, hidden: document.hidden })", Duration::from_secs(3)).await;
    wv.show().ok();
    s.rec(it, "child_hidden_visibility_state", vis.unwrap_or_else(|e| json!(e)));
    Ok(())
}

/// 7. GPUの共有(メモリ増加、4Kテクスチャコピー、WebGLコンテキスト上限)
async fn t_gpu(app: &AppHandle) -> R<()> {
    let s = st(app);
    let it = "7-gpu";
    let sk = s.sketch_label.lock().unwrap().clone();
    for (k, e) in [
        ("texcopy_4k", "T.texCopy()"),
        ("readpixels_4k", "T.readPixels4k()"),
        ("webgl_contexts_main", "T.glContextsMain()"),
        ("webgl_contexts_worker", "T.glContextsWorker()"),
    ] {
        let r = js(app, &sk, e, Duration::from_secs(60)).await;
        s.rec(it, k, r.unwrap_or_else(|e| json!(e)));
    }
    Ok(())
}

/// 5. WebCodecs
async fn t_codecs(app: &AppHandle) -> R<()> {
    let s = st(app);
    let sk = s.sketch_label.lock().unwrap().clone();
    let r = js(app, &sk, "T.codecSupport()", Duration::from_secs(60)).await;
    s.rec("5-webcodecs", "is_config_supported", r.unwrap_or_else(|e| json!(e)));
    let r = js(app, &sk, "T.encodeSpeed()", Duration::from_secs(300)).await;
    s.rec("5-webcodecs", "encode_4k_speed", r.unwrap_or_else(|e| json!(e)));
    let r = js(app, &sk, "T.yuvCheck()", Duration::from_secs(60)).await;
    s.rec("5-webcodecs", "yuv_coefficients", r.unwrap_or_else(|e| json!(e)));
    Ok(())
}

/// 9. GPUの選択
async fn t_gpusel(app: &AppHandle) -> R<()> {
    let s = st(app);
    let sk = s.sketch_label.lock().unwrap().clone();
    for (env, label) in [("ui", "ui"), ("sketch", sk.as_str())] {
        let r = js(app, label, "T.env()", Duration::from_secs(20)).await;
        s.rec("9-gpusel", &format!("env {env}"), r.unwrap_or_else(|e| json!(e)));
    }
    Ok(())
}

/// 1. 非表示ウィンドウでの描画
async fn t_hidden(app: &AppHandle, long: bool) -> R<()> {
    let s = st(app);
    let it = "1-hidden";
    // (名前, 環境, 起動引数, 状態)
    let variants: &[(&str, &str, &str, &str)] = &[
        ("visible-ref", "sketch", SKETCH_ARGS, "visible"),
        ("hidden+flags", "sketch", SKETCH_ARGS, "hidden"),
        ("hidden+throttle-only", "thronly", THROTTLE_ONLY_ARGS, "hidden"),
        ("hidden+noflags", "noflags", DEFAULT_ARGS, "hidden"),
        ("minimized+flags", "sketch", SKETCH_ARGS, "minimized"),
        ("minimized+noflags", "noflags", DEFAULT_ARGS, "minimized"),
        ("covered+flags", "sketch", SKETCH_ARGS, "covered"),
        ("covered+throttle-only", "thronly", THROTTLE_ONLY_ARGS, "covered"),
        ("covered+noflags", "noflags", DEFAULT_ARGS, "covered"),
        ("offscreen+flags", "sketch", SKETCH_ARGS, "offscreen"),
        // 同じ起動引数で、プレビューの子WebViewと環境を共有しない場合
        ("hidden+flags(own-env)", "sketch2", SKETCH_ARGS, "hidden"),
        ("minimized+flags(own-env)", "sketch2", SKETCH_ARGS, "minimized"),
        ("covered+flags(own-env)", "sketch2", SKETCH_ARGS, "covered"),
    ];
    let main = app.get_window("main").unwrap();
    let mpos = main.outer_position().map_err(|e| e.to_string())?;
    for (name, env, args, mode) in variants {
        let label = format!("hid{}", s.seq.fetch_add(1, Ordering::SeqCst));
        let (x, y) = match *mode {
            "offscreen" => (-12000.0, -12000.0),
            _ => (mpos.x as f64 + 80.0, mpos.y as f64 + 80.0),
        };
        let t0 = Instant::now();
        let w = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(sketch_url("tests.html", &label)))
            .title(format!("phase0 {name}"))
            .data_directory(data_dir(app, env))
            .additional_browser_args(args)
            .inner_size(800.0, 500.0)
            .position(x, y)
            .visible(*mode != "hidden")
            .build()
            .map_err(|e| e.to_string())?;
        wait_hello(app, &label, t0, Duration::from_secs(20)).await?;
        match *mode {
            "minimized" => {
                w.minimize().ok();
            }
            "covered" => {
                main.set_always_on_top(true).ok();
                main.set_focus().ok();
            }
            _ => {}
        }
        // 隠蔽判定が効くまで少し待つ
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let r = js(app, &label, "T.render({ ms: 2500 })", Duration::from_secs(60)).await;
        let cap = capture(app, &label).await;
        if cap.is_ok() {
            let f: String = name.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
            let _ = std::fs::write(s.root.join("results").join(format!("capture_{f}.png")), s.still.lock().unwrap().as_slice());
        }
        let r = r.unwrap_or_else(|e| json!(e));
        s.rec(it, name, json!({ "render": r, "capture_preview": cap.map(|(d, n)| json!({ "ms": ms(d), "bytes": n })).unwrap_or_else(|e| json!(e)) }));
        if *mode == "covered" {
            main.set_always_on_top(false).ok();
        }
        w.close().ok();
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    if long {
        // 最小化のまま6.5分置いたときのタイマー間隔(Chromiumの強い間引きは5分後から)。
        // visible(false)のウィンドウはページ側でvisibleのままで間引かれないことを短時間試験で確認済み
        let mut labels = vec![];
        for (name, env, args) in [("minimized+flags", "sketch", SKETCH_ARGS), ("minimized+noflags", "noflags", DEFAULT_ARGS)] {
            let label = format!("long{}", s.seq.fetch_add(1, Ordering::SeqCst));
            let t0 = Instant::now();
            let w = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(sketch_url("tests.html", &label)))
                .data_directory(data_dir(app, env))
                .additional_browser_args(args)
                .inner_size(400.0, 300.0)
                .build()
                .map_err(|e| e.to_string())?;
            wait_hello(app, &label, t0, Duration::from_secs(20)).await?;
            w.minimize().ok();
            labels.push((name, label));
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
        let mut futs = vec![];
        for (name, label) in &labels {
            let app = app.clone();
            let label = label.clone();
            let name = name.to_string();
            futs.push(tauri::async_runtime::spawn(async move {
                (name, js(&app, &label, "T.timerGaps({ ms: 390000 })", Duration::from_secs(600)).await)
            }));
        }
        for f in futs {
            if let Ok((name, r)) = f.await {
                s.rec(it, &format!("long_hidden_6.5min {name}"), r.unwrap_or_else(|e| json!(e)));
            }
        }
        for (_, l) in labels {
            if let Some(w) = app.get_webview_window(&l) {
                w.close().ok();
            }
        }
    }
    Ok(())
}

/// 7. シェーダーの無限ループ(TDRの可能性あり。--gpu-hang のときだけ)
async fn t_gpu_hang(app: &AppHandle) -> R<()> {
    let s = st(app);
    let it = "7-gpu";
    let sk = s.sketch_label.lock().unwrap().clone();
    js(app, "ui", "UI.glWatchStart()", Duration::from_secs(5)).await?;
    js(app, "ui", "UI.monStart('gpuhang')", Duration::from_secs(2)).await?;
    let n0 = s.events.lock().unwrap().len();
    let t0 = Instant::now();
    let r = js(app, &sk, "T.gpuHang()", Duration::from_secs(40)).await;
    let sketch_ms = ms(t0.elapsed());
    tokio::time::sleep(Duration::from_secs(3)).await;
    let ui = js(app, "ui", "UI.monStop('gpuhang')", Duration::from_secs(10)).await;
    let gl = js(app, "ui", "UI.glWatchStop()", Duration::from_secs(10)).await;
    let ev: Vec<Value> = s.events.lock().unwrap().iter().skip(n0).map(|(t, l, v)| json!({ "ms": ms(*t - t0), "label": l, "v": v })).collect();
    s.rec(it, "shader_infinite_loop", json!({
        "sketch": r.unwrap_or_else(|e| json!(e)), "sketch_call_ms": sketch_ms,
        "ui_frames": ui.unwrap_or_else(|e| json!(e)), "ui_webgl": gl.unwrap_or_else(|e| json!(e)), "events": ev,
    }));
    Ok(())
}

async fn run_one(app: &AppHandle, name: &str, long: bool) -> R<()> {
    match name {
        "process" => t_process(app).await,
        "hang" => t_hang_recover(app).await,
        "pfail" => t_process_failed(app).await,
        "transfer" => t_transfer(app).await,
        "html" => t_html(app).await,
        "child" => t_child(app).await,
        "gpu" => t_gpu(app).await,
        "codecs" => t_codecs(app).await,
        "gpusel" => t_gpusel(app).await,
        "hidden" => t_hidden(app, long).await,
        "gpuhang" => t_gpu_hang(app).await,
        _ => Err(format!("unknown test {name}")),
    }
}

async fn startup(app: AppHandle, auto: bool, long: bool, gpu_hang: bool) {
    let s = st(&app);
    let t_ui = wait_hello(&app, "ui", Instant::now() - Duration::from_secs(60), Duration::from_secs(30)).await;
    if let Err(e) = t_ui {
        s.rec("setup", "ui", json!(e));
        return;
    }
    // スケッチ環境を作る前のUI環境だけのメモリ
    tokio::time::sleep(Duration::from_secs(2)).await;
    let mem_ui_only = env_memory(&app, "ui").await;
    let t0 = Instant::now();
    let r = create_sketch_child(&app, "sketch0").await;
    s.rec("6-child", "create_child_with_separate_env", json!({ "result": r.as_ref().map(|d| ms(*d)).map_err(|e| e.clone()), "total_ms": ms(t0.elapsed()) }));
    if r.is_err() {
        return;
    }
    *s.follow.lock().unwrap() = true;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let mem_ui = env_memory(&app, "ui").await;
    let mem_sk = env_memory(&app, "sketch0").await;
    js(&app, "sketch0", "T.spin({ ms: 3000 })", Duration::from_secs(10)).await.ok();
    let mem_sk_gl = env_memory(&app, "sketch0").await;
    s.rec("7-gpu", "memory_per_env", json!({
        "ui_env_before_sketch": mem_ui_only.unwrap_or_else(|e| json!(e)),
        "ui_env_after": mem_ui.unwrap_or_else(|e| json!(e)),
        "sketch_env_idle": mem_sk.unwrap_or_else(|e| json!(e)),
        "sketch_env_after_webgl_1080p": mem_sk_gl.unwrap_or_else(|e| json!(e)),
    }));
    if !auto {
        return;
    }
    let mut order = vec!["gpusel", "process", "gpu", "transfer", "codecs", "html", "child", "pfail", "hang", "hidden"];
    if gpu_hang {
        order.push("gpuhang");
    }
    // --only=html,child のように一部だけ流す
    if let Some(only) = std::env::args().find_map(|a| a.strip_prefix("--only=").map(str::to_string)) {
        let only: Vec<String> = only.split(',').map(str::to_string).collect();
        order.retain(|n| only.iter().any(|o| o == n));
    }
    for name in order {
        println!("==== {name}");
        if let Err(e) = run_one(&app, name, long).await {
            s.rec("run", name, json!(format!("error: {e}")));
        }
    }
    s.rec("run", "finished", json!(true));
    tokio::time::sleep(Duration::from_millis(500)).await;
    app.exit(0);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let auto = args.iter().any(|a| a == "--auto");
    let long = args.iter().any(|a| a == "--long");
    let gpu_hang = args.iter().any(|a| a == "--gpu-hang");
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    std::fs::create_dir_all(root.join("results")).unwrap();
    let data = std::env::var("LOCALAPPDATA").map(PathBuf::from).unwrap().join("sb-phase0");
    let out = std::fs::OpenOptions::new().create(true).append(true).open(root.join("results").join("raw.jsonl")).unwrap();
    let token = format!("{:032x}", {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        t ^ (std::process::id() as u128) << 64
    });
    let state = Arc::new(St {
        root,
        data,
        out: Mutex::new(out),
        waiters: Default::default(),
        hb: Default::default(),
        hello: Default::default(),
        events: Default::default(),
        shared: Default::default(),
        sink: Default::default(),
        still: Default::default(),
        bounds_log: Default::default(),
        seq: AtomicU64::new(1),
        http_port: Mutex::new(0),
        token,
        sketch_label: Mutex::new("sketch0".into()),
        follow: Mutex::new(false),
    });
    state.rec("run", "started", json!({ "args": args }));

    tauri::Builder::default()
        .manage(state.clone())
        .register_asynchronous_uri_scheme_protocol("sb", |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || responder.respond(handle_scheme(&app, req)));
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let s2 = state.clone();
            tauri::async_runtime::spawn(async move {
                match http::serve(s2.token.clone()).await {
                    Ok(port) => *s2.http_port.lock().unwrap() = port,
                    Err(e) => s2.rec("3-transfer", "http_server_error", json!(e)),
                }
            });
            let win = tauri::window::WindowBuilder::new(app, "main")
                .title("Sketchbench phase0")
                .inner_size(1600.0, 960.0)
                .build()?;
            let size = win.inner_size()?.to_logical::<f64>(win.scale_factor()?);
            win.add_child(
                WebviewBuilder::new("ui", WebviewUrl::App("index.html".into()))
                    .data_directory(state.data.join("ui"))
                    .auto_resize(),
                LogicalPosition::new(0.0, 0.0),
                size,
            )?;
            tauri::async_runtime::spawn(startup(handle, auto, long, gpu_hang));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
