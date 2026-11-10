//! Sketchbench のRustコア。UI WebView、プレビュー用のスケッチWebView(別のWebView2環境)、
//! 書き出し用の非表示ウィンドウを管理する。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod clock;
mod compile;
mod core;
mod export;
mod player;
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
        "time": c.clock.msg(),
        "logs": *c.logs.lock().unwrap(),
    }))
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
fn seek(app: AppHandle, frame: f64) -> CmdResult {
    let c = core(&app);
    c.clock.seek(frame);
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

#[tauri::command]
fn reveal(path: String) -> CmdResult {
    std::process::Command::new("explorer").arg(format!("/select,{path}")).spawn().map_err(|e| e.to_string())?;
    Ok(Value::Null)
}

fn main() {
    tauri::Builder::default()
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
            reveal
        ])
        .setup(|app| {
            let c = Arc::new(Core::new(app.handle().clone()));
            if let Err(e) = workspace::ensure_workspace(&c.ws) {
                eprintln!("作業フォルダを用意できない: {e}");
            }
            app.manage(c.clone());
            let win = tauri::window::WindowBuilder::new(app, "main").title("Sketchbench").inner_size(1600.0, 960.0).build()?;
            let size = win.inner_size()?.to_logical::<f64>(win.scale_factor()?);
            win.add_child(
                WebviewBuilder::new("ui", WebviewUrl::App("index.html".into()))
                    .data_directory(c.data.join("webview").join("ui"))
                    .auto_resize(),
                LogicalPosition::new(0.0, 0.0),
                size,
            )?;
            c.start_watchdog();
            c.start_clock_broadcast();
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
                    let opt = export::ExportOptions { work, format, from: None, to: None, order };
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
