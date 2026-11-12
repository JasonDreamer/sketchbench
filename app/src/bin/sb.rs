//! sb: Sketchbench のCLI。
//!   sb mcp                       標準入出力のMCPサーバーとして動く(アプリの名前付きパイプへ中継する)
//!   sb render <作品> [--format mp4|png] [--from <フレーム>] [--to <フレーム>]
//! アプリが起動していなければ、ウィンドウを出さずに起動する(--background)。
//! 描画エンジンはアプリだけが持ち、CLIは依頼を送るだけ。

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};

const PIPE: &str = r"\\.\pipe\sketchbench-mcp";

fn token() -> Result<String, String> {
    let p = std::env::var("LOCALAPPDATA").map(PathBuf::from).map_err(|e| e.to_string())?.join("sketchbench").join("mcp-token");
    std::fs::read_to_string(&p).map(|s| s.trim().to_string()).map_err(|_| format!("{} がない(アプリを一度起動すると作られる)", p.display()))
}

/// アプリのパイプにつなぐ。なければアプリを --background で起動して待つ
async fn connect() -> Result<NamedPipeClient, String> {
    let mut launched = false;
    for _ in 0..150 {
        match ClientOptions::new().open(PIPE) {
            Ok(c) => return Ok(c),
            Err(e) if e.raw_os_error() == Some(231) => {} // ERROR_PIPE_BUSY: 空くまで待つ
            Err(_) if !launched => {
                let exe = std::env::current_exe().map_err(|e| e.to_string())?.with_file_name("sketchbench.exe");
                // 標準入出力はつながない(sb が終わったあとアプリの書き込みが失敗しないように)
                std::process::Command::new(&exe)
                    .arg("--background")
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn().map_err(|e| format!("{} を起動できない: {e}", exe.display()))?;
                launched = true;
            }
            Err(_) => {}
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err("Sketchbench に接続できない(30秒待った)".into())
}

async fn handshake(pipe: &mut NamedPipeClient) -> Result<(), String> {
    // トークンはアプリが起動時に作るので、接続できてから読む
    let t = token()?;
    pipe.write_all(format!("TOKEN {t}\n").as_bytes()).await.map_err(|e| e.to_string())
}

/// SB_DEBUG があれば、どこまで進んだかを標準エラーに出す
fn debug(msg: &str) {
    if std::env::var("SB_DEBUG").is_ok() {
        eprintln!("[sb] {msg}");
    }
}

async fn mcp() -> Result<(), String> {
    let mut pipe = connect().await?;
    debug("パイプにつないだ");
    handshake(&mut pipe).await?;
    debug("トークンを送った");
    let (mut pr, mut pw) = tokio::io::split(pipe);
    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let up = async {
        let n = tokio::io::copy(&mut stdin, &mut pw).await;
        debug(&format!("標準入力が閉じた: {n:?}"));
        let _ = pw.shutdown().await;
    };
    let down = async {
        let n = tokio::io::copy(&mut pr, &mut stdout).await;
        let _ = stdout.flush().await;
        debug(&format!("パイプが閉じた: {n:?}"));
    };
    // 標準入力が閉じたら書き込み側だけ閉じ、アプリからの応答は最後まで読む
    tokio::join!(up, down);
    Ok(())
}

/// MCPの tools/call を1回だけ行う小さなクライアント(1行1メッセージのJSON-RPC)
async fn call_tool(name: &str, args: Value) -> Result<Value, String> {
    let mut pipe = connect().await?;
    handshake(&mut pipe).await?;
    let (pr, mut pw) = tokio::io::split(pipe);
    let mut lines = BufReader::new(pr).lines();
    let send = |v: Value| format!("{}\n", v);
    pw.write_all(send(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "sb", "version": env!("CARGO_PKG_VERSION") } } })).as_bytes()).await.map_err(|e| e.to_string())?;
    let mut sent_call = false;
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        let v: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
        if v["id"] == 1 && !sent_call {
            if let Some(err) = v.get("error") {
                return Err(format!("initialize: {err}"));
            }
            pw.write_all(send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).as_bytes()).await.map_err(|e| e.to_string())?;
            pw.write_all(send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": name, "arguments": args } })).as_bytes()).await.map_err(|e| e.to_string())?;
            sent_call = true;
        } else if v["id"] == 2 {
            if let Some(err) = v.get("error") {
                return Err(err.to_string());
            }
            return Ok(v["result"].clone());
        }
    }
    Err("応答の前に接続が切れた".into())
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

const USAGE: &str = "使い方:\n  sb mcp\n  sb render <作品> [--format mp4|png] [--from <フレーム>] [--to <フレーム>]";

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let r = match args.first().map(String::as_str) {
        Some("mcp") => mcp().await,
        Some("render") => {
            let Some(work) = args.get(1).cloned() else {
                eprintln!("{USAGE}");
                std::process::exit(2);
            };
            let mut a = json!({ "work": work, "format": arg(&args, "--format").unwrap_or_else(|| "mp4".into()) });
            for k in ["from", "to"] {
                if let Some(v) = arg(&args, &format!("--{k}")).and_then(|s| s.parse::<u64>().ok()) {
                    a[k] = json!(v);
                }
            }
            match call_tool("export", a).await {
                Ok(res) => {
                    let text = res["content"][0]["text"].as_str().unwrap_or("").to_string();
                    if res["isError"] == true {
                        Err(text)
                    } else {
                        println!("{text}");
                        Ok(())
                    }
                }
                Err(e) => Err(e),
            }
        }
        _ => {
            eprintln!("{USAGE}");
            std::process::exit(2);
        }
    };
    if let Err(e) = r {
        eprintln!("sb: {e}");
        std::process::exit(1);
    }
}
