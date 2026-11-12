//! Sketchbench のRustコア。UI WebView、プレビュー用のスケッチWebView(別のWebView2環境)、
//! 書き出し用の非表示ウィンドウを管理する。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod clock;
mod compile;
mod core;
mod diagnostics;
mod edit;
mod export;
mod history;
mod mcp;
mod midi;
mod midi_live;
mod player;
mod schema;
mod scheme;
mod workspace;
mod wv2;

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, LogicalPosition, Manager, WebviewUrl};

use crate::core::{core, Core, Rect};

type CmdResult = Result<Value, String>;

#[tauri::command]
fn get_state(app: AppHandle) -> CmdResult {
    let c = core(&app);
    let work = c.work.lock().unwrap().clone();
    let project = work.as_ref().and_then(|w| workspace::work_dir(&c.ws, w)).and_then(|d| workspace::read_project(&d).ok());
    Ok(json!({
        "workspace": c.ws,
        "works": workspace::list_works(&c.ws),
        "templates": workspace::list_templates(&c.ws),
        "work": work,
        // 起動時に開く作品(--open <作品>)。UIは未指定なら一覧の先頭を開く
        "initialWork": std::env::args().skip_while(|a| a != "--open" && a != "--render").nth(1),
        "project": project,
        // スケッチが setup 成功時に送った宣言(params・tracks の型)。タイムラインとインスペクタが使う
        "declarations": work.as_ref().and_then(|w| workspace::work_dir(&c.ws, w)).map(|d| read_declarations(&d)).unwrap_or(Value::Null),
        "time": c.clock.msg(),
        "logs": *c.logs.lock().unwrap(),
    }))
}

/// UI WebView。開発ビルドで SB_DEBUG_PORT があれば、CDPで操作できるようリモートデバッグを開く
/// (動作確認で実際のマウスやキーを送らずに済むように)
fn ui_builder(c: &Core) -> WebviewBuilder<tauri::Wry> {
    let b = WebviewBuilder::new("ui", WebviewUrl::App("index.html".into())).data_directory(c.data.join("webview").join("ui")).auto_resize();
    match std::env::var("SB_DEBUG_PORT") {
        Ok(port) if cfg!(debug_assertions) => b.data_directory(c.data.join("webview").join("ui-debug")).additional_browser_args(&format!("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}")),
        _ => b,
    }
}

/// .cache/declarations/ の宣言を、スケッチのパス(sketches/main など)をキーにして返す
fn read_declarations(dir: &std::path::Path) -> Value {
    let mut m = serde_json::Map::new();
    if let Ok(rd) = std::fs::read_dir(dir.join(".cache").join("declarations")) {
        for e in rd.flatten() {
            let name = e.path().file_stem().map(|s| s.to_string_lossy().replace('_', "/")).unwrap_or_default();
            if let Ok(s) = std::fs::read_to_string(e.path()) {
                m.insert(name, serde_json::from_str::<Value>(&s).unwrap_or(Value::Null));
            }
        }
    }
    Value::Object(m)
}

#[tauri::command]
async fn open_work(app: AppHandle, work: String) -> CmdResult {
    core(&app).open_work(&work)
}

#[tauri::command]
async fn create_work(app: AppHandle, template: String, name: String) -> CmdResult {
    let c = core(&app);
    let w = workspace::create_work(&c.ws, &template, &name)?;
    c.open_work(&w)
}

#[tauri::command]
fn play(app: AppHandle, playing: bool) -> CmdResult {
    let c = core(&app);
    c.clock.play(playing);
    c.broadcast_time();
    Ok(Value::Null)
}

#[tauri::command]
fn seek(app: AppHandle, frame: f64, scrub: Option<bool>) -> CmdResult {
    let c = core(&app);
    c.clock.seek(frame);
    // 止まっているときのシークは短く音を鳴らして位置を耳で確かめられるようにする(スクラブ)
    if scrub.unwrap_or(false) && !c.clock.msg().playing {
        c.player.scrub(0.08);
    }
    c.broadcast_time();
    Ok(Value::Null)
}

#[tauri::command]
fn set_preview_rect(app: AppHandle, rect: Rect) -> CmdResult {
    core(&app).set_preview_rect(rect);
    Ok(Value::Null)
}

#[tauri::command]
fn set_preview_hidden(app: AppHandle, hidden: bool) -> CmdResult {
    core(&app).set_preview_hidden(hidden);
    Ok(Value::Null)
}

#[tauri::command]
async fn reload_preview(app: AppHandle) -> CmdResult {
    core(&app).recreate_preview("手動")?;
    Ok(Value::Null)
}

#[tauri::command]
async fn start_export(app: AppHandle, options: export::ExportOptions) -> CmdResult {
    export::start(&core(&app), options)
}

/// project.json を操作で書き換える(取り消し1単位)
#[tauri::command]
fn edit_project(app: AppHandle, op: edit::Op) -> CmdResult {
    let c = core(&app);
    let dir = c.work_dir()?;
    schema::check_op_allowed(&dir)?;
    let r = c.editor.apply(&dir, op)?;
    // UIでの人の操作は5秒止まったら1コミット
    if let Some(w) = c.work.lock().unwrap().clone() {
        history::touch(&c, &w, "Sketchbench (UI)");
    }
    Ok(r)
}

/// 人がアプリで指し示しているもの(選択中のクリップなど)。MCPの get_ui_context が返す
#[tauri::command]
fn set_ui_context(app: AppHandle, context: Value) -> CmdResult {
    let c = core(&app);
    let mut cur = c.ui_context.lock().unwrap();
    let mut v = if cur.is_object() { cur.clone() } else { json!({}) };
    for (k, x) in context.as_object().into_iter().flatten() {
        v[k] = x.clone();
    }
    *cur = v;
    Ok(Value::Null)
}

/// 作品の履歴(サムネイル付き)
#[tauri::command]
fn list_history(app: AppHandle) -> CmdResult {
    let c = core(&app);
    let w = c.work.lock().unwrap().clone().ok_or("作品が開かれていない")?;
    history::list(&c, &w, 100)
}

#[tauri::command]
async fn restore_history(app: AppHandle, commit: String) -> CmdResult {
    let c = core(&app);
    let w = c.work.lock().unwrap().clone().ok_or("作品が開かれていない")?;
    history::restore(&c, &w, &commit)
}

#[tauri::command]
fn undo(app: AppHandle) -> CmdResult {
    let c = core(&app);
    let dir = c.work_dir()?;
    Ok(json!({ "label": c.editor.undo(&dir)? }))
}

#[tauri::command]
fn redo(app: AppHandle) -> CmdResult {
    let c = core(&app);
    let dir = c.work_dir()?;
    Ok(json!({ "label": c.editor.redo(&dir)? }))
}

/// MIDI入力を開き直し、ポートと録音の状態を返す
#[tauri::command]
async fn midi_connect(app: AppHandle) -> CmdResult {
    let c = core(&app);
    let ports = c.live.connect_all(c.clone())?;
    Ok(json!({ "ports": ports, "recording": c.live.is_recording() }))
}

/// 録音の開始と終了。終了時は書いた .mid のパス(作品内の相対パス)を返す
#[tauri::command]
fn midi_record(app: AppHandle, on: bool) -> CmdResult {
    let c = core(&app);
    if on {
        c.live.start_recording();
        return Ok(json!({ "recording": true }));
    }
    let dir = c.work_dir()?;
    let file = c.live.stop_recording(&dir)?;
    if let Some(f) = &file {
        c.log("midi", "info", format!("MIDIを録音した: {f}"), Value::Null);
    }
    Ok(json!({ "recording": false, "file": file }))
}

/// プレビューの静止画(PNG)。子WebViewを隠す間、UIがこれを代わりに出す
#[tauri::command]
async fn preview_still(app: AppHandle) -> Result<tauri::ipc::Response, String> {
    let c = core(&app);
    let label = c.preview_label.lock().unwrap().clone();
    let wv = app.get_webview(&label).ok_or("プレビューがない")?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    wv.with_webview(move |pw| {
        let r = wv2::core(&pw).and_then(|core| wv2::capture_png(&core, move |r| { let _ = tx.send(r); }));
        if let Err(e) = r {
            eprintln!("capture: {e}");
        }
    })
    .map_err(|e| e.to_string())?;
    let png = tokio::time::timeout(std::time::Duration::from_secs(3), rx).await.map_err(|_| "静止画の取得が時間切れ")?.map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(png))
}

#[tauri::command]
fn reveal(path: String) -> CmdResult {
    std::process::Command::new("explorer").arg(format!("/select,{path}")).spawn().map_err(|e| e.to_string())?;
    Ok(Value::Null)
}

fn main() {
    let background = std::env::args().any(|a| a == "--background");
    tauri::Builder::default()
        // 単一インスタンス: 2つ目の起動はウィンドウを前に出すだけ(sb mcp と sb render は既存のアプリに依頼する)
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if !args.iter().any(|a| a == "--background") {
                if let Some(w) = app.get_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
        }))
        .register_asynchronous_uri_scheme_protocol("sb", |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || {
                // 処理がパニックしても必ず応答を返す。返さないとWebView2側の接続が詰まり、生存通知まで止まる
                let path = req.uri().path().to_string();
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| scheme::handle(&app, req)));
                responder.respond(res.unwrap_or_else(|e| {
                    let msg = e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
                    core(&app).log("core", "error", format!("{path} の処理でパニック: {msg}"), Value::Null);
                    tauri::http::Response::builder().status(500).body(msg.into_bytes()).unwrap()
                }));
            });
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            open_work,
            create_work,
            play,
            seek,
            set_preview_rect,
            set_preview_hidden,
            reload_preview,
            start_export,
            edit_project,
            undo,
            redo,
            midi_connect,
            midi_record,
            preview_still,
            set_ui_context,
            list_history,
            restore_history,
            reveal
        ])
        .setup(move |app| {
            let c = Arc::new(Core::new(app.handle().clone()));
            if let Err(e) = workspace::ensure_workspace(&c.ws) {
                eprintln!("作業フォルダを用意できない: {e}");
            }
            app.manage(c.clone());
            // --background は sb mcp が未起動のアプリを立ち上げるとき。ウィンドウを出さずに動く
            let win = tauri::window::WindowBuilder::new(app, "main").title("Sketchbench").inner_size(1600.0, 960.0).visible(!background).build()?;
            let size = win.inner_size()?.to_logical::<f64>(win.scale_factor()?);
            win.add_child(
                ui_builder(&c),
                LogicalPosition::new(0.0, 0.0),
                size,
            )?;
            c.start_watchdog();
            c.start_clock_broadcast();
            if let Err(e) = history::ensure_repo(&c.ws) {
                c.log("history", "warn", format!("作業フォルダをgitリポジトリにできない: {e}"), Value::Null);
            }
            history::start_idle_committer(c.clone());
            c.watch_works_for_history();
            tauri::async_runtime::spawn(mcp::serve(c.clone()));
            // 確認用: --render <作品> [--format mp4|png] で書き出して終了する
            let args: Vec<String> = std::env::args().collect();
            // 確認用: --verify <作品> <作品内のMP4> で音と映像の同期を調べて終了する
            if let Some(i) = args.iter().position(|a| a == "--verify") {
                let work = args.get(i + 1).cloned().unwrap_or_default();
                let file = args.get(i + 2).cloned().unwrap_or_default();
                let c2 = c.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    let url = c2.host_url("verify", &work, "verify", &format!("&file={file}"));
                    let r = tauri::WebviewWindowBuilder::new(&c2.app, "verify", WebviewUrl::External(url))
                        .data_directory(c2.data.join("webview").join("export"))
                        .additional_browser_args(core::SKETCH_ARGS)
                        .visible(false)
                        .build();
                    if let Err(e) = r {
                        eprintln!("verify: {e}");
                        c2.app.exit(1);
                    }
                });
            }
            if let Some(i) = args.iter().position(|a| a == "--render") {
                let work = args.get(i + 1).cloned().unwrap_or_default();
                let format = args.iter().position(|a| a == "--format").and_then(|j| args.get(j + 1).cloned()).unwrap_or_else(|| "mp4".into());
                c.exit_after_export.store(true, std::sync::atomic::Ordering::SeqCst);
                let c2 = c.clone();
                std::thread::spawn(move || {
                    // UIのWebView2環境ができてから別環境を作る(同時だと ERROR_BUSY になることがある)
                    for _ in 0..100 {
                        if c2.work.lock().unwrap().is_some() {
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                    let order = args.iter().position(|a| a == "--order").and_then(|j| args.get(j + 1).cloned());
                    let opt = export::ExportOptions { work, format, from: None, to: None, order, frames: None, count: None, max_size: None };
                    if let Err(e) = export::start(&c2, opt) {
                        c2.log("export", "error", e, Value::Null);
                        c2.app.exit(1);
                    }
                });
            }
            // 最初の作品はUIの読み込み後にUIから開く。UIのWebView2環境の作成中に
            // 別環境の子WebViewを作ると ERROR_BUSY(0x800700AA)で失敗することがあった
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
