//! 前回の状態(開いていた作品と再生ヘッドの位置)の保存と復元、異常終了の検知。
//! 作品の中身(project.json とスケッチ)は変更のたびにファイルへ書かれ履歴にも残るので、ここで覚えるのは「どこを見ていたか」だけ。
//! 起動時に印のファイルを置き、正常に終わったら消す。次の起動で印が残っていれば、前回は異常終了したと分かる。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::core::Core;

static CRASHED: AtomicBool = AtomicBool::new(false);

fn session_path(c: &Core) -> PathBuf {
    c.data.join("session.json")
}

fn marker(c: &Core) -> PathBuf {
    c.data.join("running")
}

/// 前回の状態({ work, frame })。なければ null
pub fn load(c: &Core) -> Value {
    std::fs::read_to_string(session_path(c)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null)
}

/// 前回は異常終了したか(起動時の印が残っていた)
pub fn crashed() -> bool {
    CRASHED.load(Ordering::SeqCst)
}

/// 起動時に呼ぶ。印を確かめてから置き、開いている作品と位置を数秒ごとに書く
pub fn start(c: Arc<Core>) {
    let m = marker(&c);
    CRASHED.store(m.exists(), Ordering::SeqCst);
    let _ = std::fs::create_dir_all(&c.data);
    let _ = std::fs::write(&m, std::process::id().to_string());
    std::thread::spawn(move || {
        let mut last = Value::Null;
        loop {
            std::thread::sleep(Duration::from_secs(3));
            let Some(work) = c.work.lock().unwrap().clone() else { continue };
            let t = c.clock.msg();
            let now = json!({ "work": work, "frame": t.frame.floor() as u64 });
            if now != last {
                let _ = std::fs::write(session_path(&c), now.to_string());
                last = now;
            }
        }
    });
}

/// 正常に終わるときに呼ぶ(印を消す)
pub fn clean_exit(c: &Core) {
    let _ = std::fs::remove_file(marker(c));
}
