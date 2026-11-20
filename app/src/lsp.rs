//! コードエディタ用の言語サーバー。同梱の TypeScript 7(tsc --lsp --stdio)を子プロセスで動かし、
//! UI の CodeMirror(@codemirror/lsp-client)とメッセージを中継する。
//! UI → サーバー: コマンド lsp_send(JSONの文字列)。サーバー → UI: イベント sb:lsp(JSONの文字列)。
//! 作業フォルダの tsconfig.json(works/**/*.ts と型の paths)を見るよう、作業フォルダで起動する。

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use tauri::Emitter;

use crate::core::Core;

#[derive(Default)]
pub struct Lsp {
    proc: Mutex<Option<(Child, ChildStdin)>>,
}

impl Lsp {
    /// 動いていなければ起動する
    pub fn ensure(&self, core: &Arc<Core>) -> Result<(), String> {
        let mut g = self.proc.lock().unwrap();
        if let Some((child, _)) = g.as_mut() {
            if child.try_wait().map_err(|e| e.to_string())?.is_none() {
                return Ok(());
            }
        }
        let tsc = crate::diagnostics::tsc_path().ok_or("tsc.exe がない(TypeScript 7 のネイティブ版)")?;
        let mut cmd = Command::new(tsc);
        cmd.args(["--lsp", "--stdio"]).current_dir(&core.ws).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd.spawn().map_err(|e| format!("言語サーバーを起動できない: {e}"))?;
        let stdin = child.stdin.take().ok_or("stdin がない")?;
        let stdout = child.stdout.take().ok_or("stdout がない")?;
        let app = core.app.clone();
        std::thread::spawn(move || read_loop(stdout, app));
        *g = Some((child, stdin));
        core.log("lsp", "info", "言語サーバー(TypeScript 7)を起動した", serde_json::Value::Null);
        Ok(())
    }

    pub fn send(&self, msg: &str) -> Result<(), String> {
        let mut g = self.proc.lock().unwrap();
        let (_, stdin) = g.as_mut().ok_or("言語サーバーが動いていない")?;
        write!(stdin, "Content-Length: {}\r\n\r\n{msg}", msg.len()).map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())
    }

    pub fn stop(&self) {
        if let Some((mut child, _)) = self.proc.lock().unwrap().take() {
            let _ = child.kill();
        }
    }
}

/// Content-Length で区切られたメッセージを読み、UIへ送る。終わったら sb:lsp-exit
fn read_loop(stdout: std::process::ChildStdout, app: tauri::AppHandle) {
    let mut r = BufReader::new(stdout);
    loop {
        let mut len = 0usize;
        loop {
            let mut line = String::new();
            match r.read_line(&mut line) {
                Ok(0) | Err(_) => {
                    let _ = app.emit_to("ui", "sb:lsp-exit", ());
                    return;
                }
                Ok(_) => {}
            }
            let line = line.trim_end();
            if line.is_empty() {
                break;
            }
            if let Some(v) = line.strip_prefix("Content-Length:") {
                len = v.trim().parse().unwrap_or(0);
            }
        }
        let mut body = vec![0u8; len];
        if r.read_exact(&mut body).is_err() {
            let _ = app.emit_to("ui", "sb:lsp-exit", ());
            return;
        }
        let _ = app.emit_to("ui", "sb:lsp", String::from_utf8_lossy(&body).to_string());
    }
}
