//! Rustコアの状態、プレビュー用スケッチWebViewの管理、ファイル監視、生存監視。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl};

use crate::{clock::Clock, compile, export, workspace, wv2};

/// wryの既定値(additional_browser_args を指定すると置き換わるので含める)と、フェーズ0で決めたスケッチ用の引数。
pub const SKETCH_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --disable-background-timer-throttling --enable-features=CanvasDrawElement";
pub const SB: &str = "http://sb.localhost";

#[derive(Clone, Copy, Debug, Default, Serialize, serde::Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Debug, Default)]
pub struct SketchState {
    pub last_hb: Option<Instant>,
    /// "loading" | "setup" | "ready" | "error"
    pub phase: String,
}

pub struct Core {
    pub app: AppHandle,
    pub ws: PathBuf,
    pub data: PathBuf,
    pub cache: compile::Cache,
    pub clock: Clock,
    pub work: Mutex<Option<String>>,
    pub preview_label: Mutex<String>,
    pub preview_rect: Mutex<Rect>,
    pub preview_hidden: AtomicBool,
    pub sketches: Mutex<HashMap<String, SketchState>>,
    pub seq: AtomicU64,
    pub rev: AtomicU64,
    pub logs: Mutex<Vec<Value>>,
    pub jobs: Mutex<HashMap<String, export::Job>>,
    pub player: Arc<crate::player::Player>,
    pub editor: crate::edit::Editor,
    pub live: crate::midi_live::LiveMidi,
    /// --render で起動したとき、書き出しが終わったら終了する
    pub exit_after_export: AtomicBool,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

pub fn core(app: &AppHandle) -> Arc<Core> {
    app.state::<Arc<Core>>().inner().clone()
}

impl Core {
    pub fn new(app: AppHandle) -> Self {
        let data = std::env::var("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(".")).join("sketchbench");
        Core {
            app,
            ws: workspace::workspace_dir(),
            data,
            cache: Default::default(),
            clock: Default::default(),
            work: Mutex::new(None),
            preview_label: Mutex::new(String::new()),
            preview_rect: Mutex::new(Rect { x: 0.0, y: 0.0, w: 640.0, h: 360.0 }),
            preview_hidden: AtomicBool::new(false),
            sketches: Default::default(),
            seq: AtomicU64::new(1),
            rev: AtomicU64::new(1),
            logs: Default::default(),
            jobs: Default::default(),
            player: crate::player::Player::start(),
            editor: Default::default(),
            live: Default::default(),
            exit_after_export: AtomicBool::new(false),
            watcher: Mutex::new(None),
        }
    }

    pub fn work_dir(&self) -> Result<PathBuf, String> {
        let w = self.work.lock().unwrap().clone().ok_or("作品が開かれていない")?;
        workspace::work_dir(&self.ws, &w).ok_or(format!("作品 {w} がない"))
    }

    pub fn next_id(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::SeqCst)
    }

    /// ログと診断。UIへも送る。
    pub fn log(&self, source: &str, level: &str, message: impl Into<String>, extra: Value) {
        let v = json!({ "source": source, "level": level, "message": message.into(), "extra": extra, "unixMs": crate::clock::unix_ms() });
        println!("[{level}] {source}: {}", v["message"].as_str().unwrap_or(""));
        let mut logs = self.logs.lock().unwrap();
        logs.push(v.clone());
        let n = logs.len();
        if n > 500 {
            logs.drain(..n - 500);
        }
        drop(logs);
        let _ = self.app.emit_to("ui", "sb:log", v);
    }

    pub fn broadcast_time(&self) {
        let msg = self.clock.msg();
        let label = self.preview_label.lock().unwrap().clone();
        let _ = self.app.emit_to("ui", "sb:time", msg);
        if !label.is_empty() {
            let _ = self.app.emit_to(label.as_str(), "sb:time", msg);
        }
    }

    /// 作品を開く: 時計を合わせ、ファイル監視を張り替え、プレビューを作り直す。
    pub fn open_work(self: &Arc<Self>, work: &str) -> Result<Value, String> {
        let dir = workspace::work_dir(&self.ws, work).ok_or(format!("作品 {work} がない"))?;
        let project = workspace::read_project(&dir)?;
        self.clock.play(false);
        self.clock.configure(project.fps, project.duration);
        self.clock.seek(0.0);
        *self.work.lock().unwrap() = Some(work.to_string());
        self.editor.clear();
        let _ = self.editor.normalize_ids(&dir);
        self.watch(dir.clone());
        self.rebuild_audio(dir.clone());
        self.recreate_preview("open")?;
        self.broadcast_time();
        Ok(json!({ "work": work, "project": project }))
    }

    fn watch(self: &Arc<Self>, dir: PathBuf) {
        use notify::{RecursiveMode, Watcher};
        let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
        let mut w = match notify::recommended_watcher(tx) {
            Ok(w) => w,
            Err(e) => {
                self.log("core", "error", format!("ファイル監視を開始できない: {e}"), Value::Null);
                return;
            }
        };
        let _ = w.watch(&dir, RecursiveMode::Recursive);
        *self.watcher.lock().unwrap() = Some(w);
        let me = self.clone();
        std::thread::spawn(move || {
            // 30ms以内に続いた変更は1回にまとめる
            while let Ok(first) = rx.recv() {
                let mut paths: Vec<PathBuf> = vec![];
                let mut push = |ev: notify::Result<notify::Event>| {
                    if let Ok(ev) = ev {
                        if matches!(ev.kind, notify::EventKind::Access(_)) {
                            return;
                        }
                        paths.extend(ev.paths);
                    }
                };
                push(first);
                while let Ok(ev) = rx.recv_timeout(Duration::from_millis(30)) {
                    push(ev);
                }
                let rel: Vec<String> = paths
                    .iter()
                    .filter_map(|p| p.strip_prefix(&dir).ok())
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .filter(|p| !p.starts_with(".cache") && !p.starts_with("renders") && !p.starts_with(".git"))
                    .collect();
                if rel.is_empty() {
                    continue;
                }
                let rev = me.rev.fetch_add(1, Ordering::SeqCst) + 1;
                if rel.iter().any(|p| p == "project.json") {
                    // 外から書かれたidのないクリップに採番する(書き戻しでもう一度ここに来る)
                    if me.editor.normalize_ids(&dir).unwrap_or(false) {
                        continue;
                    }
                    if let Ok(p) = workspace::read_project(&dir) {
                        me.clock.configure(p.fps, p.duration);
                    }
                }
                // 音声の割り当てや素材が変わったらミックスを作り直す
                if rel.iter().any(|p| p == "project.json" || p.starts_with("assets/")) {
                    me.rebuild_audio(dir.clone());
                }
                let payload = json!({ "rev": rev, "paths": rel, "unixMs": crate::clock::unix_ms() });
                let label = me.preview_label.lock().unwrap().clone();
                let _ = me.app.emit_to(label.as_str(), "sb:reload", payload.clone());
                let _ = me.app.emit_to("ui", "sb:reload", payload);
                me.broadcast_time();
            }
        });
    }

    pub fn host_url(&self, label: &str, work: &str, mode: &str, extra: &str) -> tauri::Url {
        format!("{SB}/host.html?l={label}&work={work}&mode={mode}{extra}").parse().unwrap()
    }

    /// プレビュー用の子WebViewを(作り直して)置く。UIとは別のWebView2環境。
    pub fn recreate_preview(self: &Arc<Self>, reason: &str) -> Result<(), String> {
        let work = self.work.lock().unwrap().clone().ok_or("作品が開かれていない")?;
        let win = self.app.get_window("main").ok_or("no main window")?;
        let old = std::mem::take(&mut *self.preview_label.lock().unwrap());
        if let Some(w) = self.app.get_webview(&old) {
            let _ = w.close();
        }
        let label = format!("preview-{}", self.next_id());
        let r = *self.preview_rect.lock().unwrap();
        let b = WebviewBuilder::new(&label, WebviewUrl::External(self.host_url(&label, &work, "preview", "")))
            .data_directory(self.data.join("webview").join("sketch"))
            .additional_browser_args(SKETCH_ARGS);
        // 作成した時刻を最初の生存通知とみなす(一度も届かない場合も監視できるように)
        self.sketches.lock().unwrap().insert(label.clone(), SketchState { last_hb: Some(Instant::now()), phase: "loading".into() });
        let wv = win
            .add_child(b, LogicalPosition::new(r.x, r.y), LogicalSize::new(r.w.max(1.0), r.h.max(1.0)))
            .map_err(|e| e.to_string())?;
        if self.preview_hidden.load(Ordering::SeqCst) {
            let _ = wv.hide();
        }
        *self.preview_label.lock().unwrap() = label.clone();
        let me = self.clone();
        let l2 = label.clone();
        let _ = wv.with_webview(move |pw| {
            if let Ok(c) = wv2::core(&pw) {
                let me2 = me.clone();
                let _ = wv2::on_process_failed(&c, move |kind| {
                    // ユーティリティプロセスなどは環境で共有していて、別のWebViewを閉じたときにも終わる。
                    // このWebViewの描画に関わるものだけで作り直す
                    if !matches!(kind, "render_exited" | "render_unresponsive" | "gpu_exited" | "browser_exited") {
                        return;
                    }
                    let me3 = me2.clone();
                    let l3 = l2.clone();
                    // イベントの中でWebViewを閉じないよう、別スレッドから作り直す
                    std::thread::spawn(move || me3.on_sketch_failed(&l3, &format!("ProcessFailed: {kind}")));
                });
            }
        });
        self.log("core", "info", format!("プレビューを作成 ({reason})"), json!({ "label": label }));
        Ok(())
    }

    /// スケッチWebViewが固まった・落ちたときの扱い。再生を止め、作り直す(自動では再生しない)。
    pub fn on_sketch_failed(self: &Arc<Self>, label: &str, why: &str) {
        if *self.preview_label.lock().unwrap() != label {
            return;
        }
        self.clock.play(false);
        self.log("core", "error", format!("スケッチWebViewを作り直す: {why}"), json!({ "label": label, "rev": self.rev.load(Ordering::SeqCst) }));
        if let Err(e) = self.recreate_preview(why) {
            self.log("core", "error", e, Value::Null);
        }
        self.broadcast_time();
    }

    pub fn set_preview_rect(&self, r: Rect) {
        *self.preview_rect.lock().unwrap() = r;
        let label = self.preview_label.lock().unwrap().clone();
        if let Some(w) = self.app.get_webview(&label) {
            let _ = w.set_bounds(tauri::Rect {
                position: LogicalPosition::new(r.x, r.y).into(),
                size: LogicalSize::new(r.w.max(1.0), r.h.max(1.0)).into(),
            });
        }
    }

    pub fn set_preview_hidden(&self, hidden: bool) {
        self.preview_hidden.store(hidden, Ordering::SeqCst);
        let label = self.preview_label.lock().unwrap().clone();
        if let Some(w) = self.app.get_webview(&label) {
            let _ = if hidden { w.hide() } else { w.show() };
        }
        // 隠している間は生存判定を止めるので、再表示時に起点を取り直す
        if !hidden {
            if let Some(s) = self.sketches.lock().unwrap().get_mut(&label) {
                s.last_hb = Some(Instant::now());
            }
        }
    }

    /// 生存監視: 生存通知が2秒(setup中は30秒)途切れたら作り直す。隠している間と最小化中は判定しない。
    pub fn start_watchdog(self: &Arc<Self>) {
        let me = self.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(250));
            if me.preview_hidden.load(Ordering::SeqCst) {
                continue;
            }
            let minimized = me.app.get_window("main").and_then(|w| w.is_minimized().ok()).unwrap_or(false);
            if minimized {
                continue;
            }
            let label = me.preview_label.lock().unwrap().clone();
            let st = me.sketches.lock().unwrap().get(&label).cloned();
            let Some(st) = st else { continue };
            let Some(last) = st.last_hb else { continue };
            let limit = if st.phase == "setup" || st.phase == "loading" { 30 } else { 2 };
            if last.elapsed() > Duration::from_secs(limit) {
                me.on_sketch_failed(&label, &format!("生存通知が{limit}秒途切れた"));
            }
        });
    }

    /// 作品の音声トラックを再生用にミックスし、解析のキャッシュも先に作っておく(別スレッド)
    pub fn rebuild_audio(self: &Arc<Self>, dir: PathBuf) {
        let me = self.clone();
        std::thread::spawn(move || {
            let Ok(p) = workspace::read_project(&dir) else { return };
            if p.audio.is_empty() {
                me.player.set_buffer(Arc::new(vec![]));
                me.clock.set_player(None);
                return;
            }
            let sr = me.player.sample_rate();
            match crate::audio::mixdown(&dir, &p, sr, 0, p.duration) {
                Ok(mix) => {
                    me.player.set_buffer(Arc::new(mix));
                    me.clock.set_player(Some(me.player.clone()));
                    let err = me.player.error.lock().unwrap().clone();
                    match err {
                        Some(e) => me.log("audio", "error", format!("音声を再生できない: {e}"), Value::Null),
                        None => me.log("audio", "info", format!("音声を読み込んだ({}トラック、{} Hz、出力の遅延 {:.1} ms)", p.audio.len(), sr, me.player.latency().as_secs_f64() * 1000.0), Value::Null),
                    }
                }
                Err(e) => me.log("audio", "error", format!("音声をミックスできない: {e}"), Value::Null),
            }
            me.broadcast_time();
            for a in &p.audio {
                if let Some(f) = workspace::safe_rel(&dir, &a.asset) {
                    let t0 = std::time::Instant::now();
                    match crate::audio::analysis_cached(&dir, &f) {
                        Ok(_) => me.log("audio", "info", format!("{} の解析を用意した({:.1}秒)", a.asset, t0.elapsed().as_secs_f64()), Value::Null),
                        Err(e) => me.log("audio", "error", format!("{} を解析できない: {e}", a.asset), Value::Null),
                    }
                }
            }
        });
    }

    pub fn start_clock_broadcast(self: &Arc<Self>) {
        let me = self.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(16));
            me.clock.wrap_audio();
            if me.clock.msg().playing {
                me.broadcast_time();
            }
        });
    }
}
