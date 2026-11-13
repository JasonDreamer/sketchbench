//! 履歴(git)。作業フォルダ全体を1つのリポジトリにし、作品ごとにコミットする。
//! MCP経由の変更はツール呼び出しごと、ファイルの直接編集とUIでの操作は変更が5秒止まった時点で1コミット。
//! 巻き戻しは対象の作品フォルダだけに適用する。
//! git は今はシステムのものを使う(配布時は MinGit を同梱して別プロセスで実行する)。

use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::core::Core;

fn git(ws: &Path, args: &[&str]) -> Result<String, String> {
    // 外部のgit操作(Claude Codeなど)と重なったら、ロックが外れるまで待って再試行する
    for attempt in 0..20 {
        let lock = ws.join(".git").join("index.lock");
        if lock.exists() && attempt < 19 {
            std::thread::sleep(Duration::from_millis(250));
            continue;
        }
        let out = Command::new("git")
            .args(["-c", "core.quotepath=false", "-c", "user.name=Sketchbench", "-c", "user.email=sketchbench@localhost"])
            .args(args)
            .current_dir(ws)
            .output()
            .map_err(|e| format!("git を起動できない: {e}"))?;
        if out.status.success() {
            return Ok(String::from_utf8_lossy(&out.stdout).to_string());
        }
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        if err.contains("index.lock") {
            std::thread::sleep(Duration::from_millis(250));
            continue;
        }
        let out_text = String::from_utf8_lossy(&out.stdout);
        return Err(format!("git {} が失敗した(終了コード {:?}): {} {}", args.first().unwrap_or(&""), out.status.code(), err.trim(), out_text.chars().take(300).collect::<String>()));
    }
    Err("git のロックが外れない".into())
}

/// 作業フォルダをgitリポジトリにする(なければ)
pub fn ensure_repo(ws: &Path) -> Result<(), String> {
    if ws.join(".git").exists() {
        return Ok(());
    }
    git(ws, &["init", "-q", "-b", "main"])?;
    git(ws, &["add", "-A"])?;
    git(ws, &["commit", "-q", "-m", "作業フォルダを作成", "--allow-empty"])?;
    Ok(())
}

/// 作品の変更を1コミットにする。変更がなければ何もしない。作者でAIか外部編集かを分ける
pub fn commit_work(core: &Arc<Core>, work: &str, message: &str, author: &str) {
    let ws = core.ws.clone();
    let path = format!("works/{work}");
    let r = (|| -> Result<Option<String>, String> {
        ensure_repo(&ws)?;
        git(&ws, &["add", "-A", "--", &path])?;
        let staged = git(&ws, &["diff", "--cached", "--name-only", "--", &path])?;
        if staged.trim().is_empty() {
            return Ok(None);
        }
        let author_arg = format!("{author} <sketchbench@localhost>");
        git(&ws, &["commit", "-q", "--author", &author_arg, "-m", &format!("{work}: {message}"), "--", &path])?;
        Ok(Some(git(&ws, &["rev-parse", "--short", "HEAD"])?.trim().to_string()))
    })();
    match r {
        Ok(Some(id)) => {
            core.log("history", "info", format!("{work} をコミットした({id}、{author}: {message})"), json!({ "commit": id }));
            let _ = tauri::Emitter::emit_to(&core.app, "ui", "sb:history", json!({ "work": work, "commit": id }));
            thumbnail(core, work, &id);
        }
        Ok(None) => {}
        Err(e) => core.log("history", "warn", format!("コミットできない: {e}"), Value::Null),
    }
}

/// コミットのサムネイル(尺の中央のフレーム)を .cache/thumbs/<commit>.jpg に置く
fn thumbnail(core: &Arc<Core>, work: &str, commit: &str) {
    let core = core.clone();
    let (work, commit) = (work.to_string(), commit.to_string());
    tauri::async_runtime::spawn(async move {
        let Some(dir) = crate::workspace::work_dir(&core.ws, &work) else { return };
        let Ok(p) = crate::workspace::read_project(&dir) else { return };
        let o = crate::export::run(
            &core,
            crate::export::ExportOptions { work: work.clone(), format: "frames".into(), from: None, to: None, order: None, frames: Some(vec![p.duration / 2]), count: None, max_size: Some(320), ..Default::default() },
        )
        .await;
        if let Some((_, jpeg)) = o.images.first() {
            let d = dir.join(".cache").join("thumbs");
            let _ = std::fs::create_dir_all(&d);
            let _ = std::fs::write(d.join(format!("{commit}.jpg")), jpeg);
            let _ = tauri::Emitter::emit_to(&core.app, "ui", "sb:history", json!({ "work": work, "commit": commit, "thumb": true }));
        }
    });
}

/// 作品の履歴(新しい順)
pub fn list(core: &Arc<Core>, work: &str, n: usize) -> Result<Value, String> {
    let ws = &core.ws;
    ensure_repo(ws)?;
    let out = git(ws, &["log", &format!("-{n}"), "--format=%h%x1f%H%x1f%an%x1f%aI%x1f%s", "--", &format!("works/{work}")])?;
    let dir = crate::workspace::work_dir(ws, work);
    let items: Vec<Value> = out
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\x1f').collect();
            if f.len() < 5 {
                return None;
            }
            let thumb = dir.as_ref().map(|d| d.join(".cache").join("thumbs").join(format!("{}.jpg", f[0]))).filter(|p| p.exists());
            Some(json!({ "commit": f[0], "full": f[1], "author": f[2], "date": f[3], "message": f[4], "thumb": thumb.map(|_| format!("/work/{work}/files/.cache/thumbs/{}.jpg", f[0])) }))
        })
        .collect();
    Ok(json!({ "work": work, "history": items }))
}

/// 作品だけを指定したコミットの状態に戻す。戻す前の状態もコミットしておくので、戻したこと自体も取り消せる
pub fn restore(core: &Arc<Core>, work: &str, commit: &str) -> Result<Value, String> {
    if !commit.chars().all(|c| c.is_ascii_hexdigit()) || commit.len() < 4 {
        return Err("コミットIDの形が正しくない".into());
    }
    let ws = core.ws.clone();
    commit_work(core, work, "巻き戻す前の状態", "Sketchbench");
    let path = format!("works/{work}");
    git(&ws, &["restore", &format!("--source={commit}"), "--staged", "--worktree", "--", &path])?;
    commit_work(core, work, &format!("{commit} の状態に戻した"), "Sketchbench");
    core.editor.clear();
    Ok(json!({ "restored": commit }))
}

/// 直接編集とUIでの操作は、変更が5秒止まったら1コミットにする
pub fn start_idle_committer(core: Arc<Core>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let due: Vec<(String, String)> = {
            let mut p = core.pending_commit.lock().unwrap();
            let ready: Vec<String> = p.iter().filter(|(_, (_, t))| t.elapsed() >= Duration::from_secs(5)).map(|(w, _)| w.clone()).collect();
            ready.into_iter().filter_map(|w| p.remove(&w).map(|(a, _)| (w, a))).collect()
        };
        for (work, author) in due {
            commit_work(&core, &work, "変更", &author);
        }
    });
}

/// 変更があったことを記録する(5秒止まったらコミット)
pub fn touch(core: &Core, work: &str, author: &str) {
    // 先に記録した作者を残す(UIの操作のあとに来るファイル監視の通知で「外部編集」に上書きしない)
    let mut p = core.pending_commit.lock().unwrap();
    let e = p.entry(work.to_string()).or_insert((author.to_string(), Instant::now()));
    e.1 = Instant::now();
}
