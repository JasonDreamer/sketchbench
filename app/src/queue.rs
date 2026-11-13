//! レンダーキュー。書き出しを登録順に1つずつ行う(同時に走らせると互いに遅くなるため)。
//! UIの「書き出し」とMCPの queue_add が積み、状態が変わるたびに sb:queue でUIへ一覧を送る。
//! アプリを閉じるとキューは消える(中断した位置からの再開は、連番が書けたところまで残ることで代える)。

use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::Emitter;

use crate::audio::Normalized;
use crate::core::Core;
use crate::export::{self, ExportOptions};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub options: ExportOptions,
    /// "waiting" | "running" | "done" | "failed" | "canceled"
    pub state: String,
    /// 書き出し中のジョブ(export::Job の id)
    pub job: Option<String>,
    pub done: u64,
    pub total: u64,
    pub path: Option<String>,
    pub error: Option<String>,
    pub elapsed: f64,
    pub loudness: Option<Normalized>,
}

fn emit(core: &Arc<Core>) {
    let _ = core.app.emit_to("ui", "sb:queue", list(core));
}

pub fn list(core: &Arc<Core>) -> Value {
    json!({ "items": *core.queue.lock().unwrap(), "running": core.queue_running.load(Ordering::SeqCst) })
}

/// 積んで、止まっていれば動かす。返り値は積んだ項目のid
pub fn add(core: &Arc<Core>, items: Vec<ExportOptions>) -> Result<Vec<String>, String> {
    if items.is_empty() {
        return Err("書き出しの指定が空".into());
    }
    for o in &items {
        if o.format != "mp4" && o.format != "png" {
            return Err(format!("キューに積めるのは mp4 と png(指定は {})", o.format));
        }
        crate::workspace::work_dir(&core.ws, &o.work).ok_or(format!("作品 {} がない", o.work))?;
    }
    let ids: Vec<String> = {
        let mut q = core.queue.lock().unwrap();
        items
            .into_iter()
            .map(|options| {
                let id = format!("q{}", core.next_id());
                q.push(Item { id: id.clone(), options, state: "waiting".into(), job: None, done: 0, total: 0, path: None, error: None, elapsed: 0.0, loudness: None });
                id
            })
            .collect()
    };
    emit(core);
    kick(core);
    Ok(ids)
}

fn kick(core: &Arc<Core>) {
    if core.queue_running.swap(true, Ordering::SeqCst) {
        return;
    }
    let core = core.clone();
    tauri::async_runtime::spawn(async move { run(core).await });
}

async fn run(core: Arc<Core>) {
    loop {
        let next = {
            let q = core.queue.lock().unwrap();
            q.iter().find(|i| i.state == "waiting").map(|i| (i.id.clone(), i.options.clone()))
        };
        let Some((qid, opt)) = next else {
            core.queue_running.store(false, Ordering::SeqCst);
            emit(&core);
            // 止めた直後に積まれていたら、もう一度動かす
            if core.queue.lock().unwrap().iter().any(|i| i.state == "waiting") {
                kick(&core);
            }
            return;
        };
        // 書き出した版を履歴から辿れるよう、先にコミットする(MCPの export と同じ)
        crate::history::commit_work(&core, &opt.work, "書き出し前の状態", "Sketchbench");
        let started = export::start(&core, opt);
        let job = match started {
            Ok(v) => v["id"].as_str().unwrap_or_default().to_string(),
            Err(e) => {
                update(&core, &qid, |i| {
                    i.state = "failed".into();
                    i.error = Some(e.clone());
                });
                continue;
            }
        };
        let (tx, rx) = tokio::sync::oneshot::channel();
        let total = {
            let mut jobs = core.jobs.lock().unwrap();
            match jobs.get_mut(&job) {
                Some(j) => {
                    j.waiters.push(tx);
                    j.total
                }
                None => 0,
            }
        };
        update(&core, &qid, |i| {
            i.state = "running".into();
            i.job = Some(job.clone());
            i.total = total;
        });
        let o = rx.await.unwrap_or_default();
        update(&core, &qid, |i| {
            i.elapsed = o.elapsed;
            i.loudness = o.loudness;
            if o.ok {
                i.state = "done".into();
                i.done = i.total;
                i.path = o.path.as_ref().map(|p| p.display().to_string());
            } else {
                let e = o.error.clone().unwrap_or_else(|| "書き出しが途中で終わった".into());
                i.state = if e == "中止した" { "canceled" } else { "failed" }.into();
                i.error = Some(e);
            }
        });
    }
}

fn update(core: &Arc<Core>, id: &str, f: impl FnOnce(&mut Item)) {
    if let Some(i) = core.queue.lock().unwrap().iter_mut().find(|i| i.id == id) {
        f(i);
    }
    emit(core);
}

/// 書き出しの進み具合(export::progress から)
pub fn on_progress(core: &Arc<Core>, job: &str, done: u64) {
    let mut q = core.queue.lock().unwrap();
    if let Some(i) = q.iter_mut().find(|i| i.job.as_deref() == Some(job) && i.state == "running") {
        i.done = done;
    }
}

/// 待っているものは取り消し、書き出し中のものは止める
pub fn cancel(core: &Arc<Core>, id: &str) -> Result<(), String> {
    let (state, job) = {
        let q = core.queue.lock().unwrap();
        let i = q.iter().find(|i| i.id == id).ok_or("キューにない")?;
        (i.state.clone(), i.job.clone())
    };
    match state.as_str() {
        "waiting" => update(core, id, |i| i.state = "canceled".into()),
        "running" => export::cancel(core, &job.unwrap_or_default()),
        _ => return Err("もう終わっている".into()),
    }
    Ok(())
}

/// 終わったもの(完了・失敗・中止)を一覧から消す
pub fn clear_finished(core: &Arc<Core>) {
    core.queue.lock().unwrap().retain(|i| i.state == "waiting" || i.state == "running");
    emit(core);
}
