//! 作業フォルダ(works/ の親)と作品(works/<名前>/)。project.json を書くのはこのモジュールだけ。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn workspace_dir() -> PathBuf {
    if let Ok(p) = std::env::var("SB_WORKSPACE") {
        return PathBuf::from(p);
    }
    let home = std::env::var("USERPROFILE").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("."));
    home.join("Documents").join("Sketchbench")
}

/// アプリ同梱の資源(作業フォルダのひな形、ランタイム、ライブラリ)の場所。
/// 開発中はリポジトリを直接見る。
pub fn repo_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

pub fn template_dir() -> PathBuf {
    repo_dir().join("app").join("resources").join("workspace")
}

/// ひな形のファイルを作業フォルダへ写す。既にあるファイルは上書きしない。
/// types/ はアプリの版に合わせるため常に上書きする。
pub fn ensure_workspace(ws: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(ws.join("works"))?;
    copy_tree(&template_dir(), ws, &|rel| rel.starts_with("types"))?;
    // 型定義: ランタイムとp5
    let types = ws.join("types");
    std::fs::create_dir_all(&types)?;
    std::fs::copy(repo_dir().join("packages/runtime/types/index.d.ts"), types.join("sketchbench-runtime.d.ts"))?;
    let p5types = repo_dir().join("node_modules/p5/types");
    if p5types.exists() {
        copy_tree(&p5types, &types.join("p5"), &|_| true)?;
    }
    Ok(())
}

fn copy_tree(src: &Path, dst: &Path, overwrite: &dyn Fn(&Path) -> bool) -> std::io::Result<()> {
    for entry in walk(src) {
        let rel = entry.strip_prefix(src).unwrap();
        let to = dst.join(rel);
        if to.exists() && !overwrite(rel) {
            continue;
        }
        if let Some(p) = to.parent() {
            std::fs::create_dir_all(p)?;
        }
        std::fs::copy(&entry, &to)?;
    }
    Ok(())
}

pub fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Project {
    pub version: u32,
    pub width: u32,
    pub height: u32,
    /// 有理数のfps [分子, 分母]
    pub fps: [u32; 2],
    /// 尺(フレーム数)
    pub duration: u64,
    #[serde(default)]
    pub layers: Vec<Layer>,
    #[serde(default)]
    pub seed: u32,
    #[serde(flatten)]
    pub rest: serde_json::Map<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Layer {
    pub id: String,
    pub sketch: String,
    #[serde(default)]
    pub params: serde_json::Map<String, Value>,
    #[serde(flatten)]
    pub rest: serde_json::Map<String, Value>,
}

impl Project {
    pub fn fps_f64(&self) -> f64 {
        self.fps[0] as f64 / self.fps[1].max(1) as f64
    }
}

pub fn work_dir(ws: &Path, work: &str) -> Option<PathBuf> {
    if work.is_empty() || work.contains(['/', '\\']) || work.contains("..") {
        return None;
    }
    let d = ws.join("works").join(work);
    d.join("project.json").exists().then_some(d)
}

pub fn read_project(dir: &Path) -> Result<Project, String> {
    let s = std::fs::read_to_string(dir.join("project.json")).map_err(|e| e.to_string())?;
    serde_json::from_str(&s).map_err(|e| format!("project.json: {e}"))
}

pub fn list_works(ws: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(ws.join("works"))
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().join("project.json").exists())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

pub fn list_templates(ws: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(ws.join("templates"))
        .map(|rd| rd.flatten().filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().to_string()).collect())
        .unwrap_or_default();
    v.sort();
    v
}

/// テンプレートを複製して作品を作る。
pub fn create_work(ws: &Path, template: &str, name: &str) -> Result<String, String> {
    let valid = !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err("作品名は英数字・-・_ だけにする".into());
    }
    let src = ws.join("templates").join(template);
    if !src.join("project.json").exists() {
        return Err(format!("テンプレート {template} がない"));
    }
    let dst = ws.join("works").join(name);
    if dst.exists() {
        return Err(format!("{name} は既にある"));
    }
    copy_tree(&src, &dst, &|_| false).map_err(|e| e.to_string())?;
    Ok(name.to_string())
}

/// スケッチの実体ファイル(sketch.ts か shader.fs)。
pub fn sketch_entry(work_dir: &Path, sketch: &str) -> Option<(PathBuf, &'static str)> {
    let d = work_dir.join(sketch);
    if !d.starts_with(work_dir) {
        return None;
    }
    for (f, kind) in [("sketch.ts", "ts"), ("sketch.js", "ts"), ("shader.fs", "isf")] {
        if d.join(f).exists() {
            return Some((d.join(f), kind));
        }
    }
    None
}

/// 作品の内容ハッシュ(.cache と renders を除く全ファイル)。git導入までは書き出しファイル名に使う。
pub fn content_hash(work_dir: &Path) -> String {
    let mut h = blake3::Hasher::new();
    for f in walk(work_dir) {
        let rel = f.strip_prefix(work_dir).unwrap();
        let first = rel.components().next().map(|c| c.as_os_str().to_string_lossy().to_string()).unwrap_or_default();
        if first == ".cache" || first == "renders" {
            continue;
        }
        h.update(rel.to_string_lossy().replace('\\', "/").as_bytes());
        h.update(&[0]);
        if let Ok(b) = std::fs::read(&f) {
            h.update(&b);
        }
    }
    h.finalize().to_hex()[..8].to_string()
}

/// ローカル時刻の YYYYMMDD-HHMMSS。
pub fn local_stamp() -> String {
    let t = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    format!("{:04}{:02}{:02}-{:02}{:02}{:02}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond)
}
