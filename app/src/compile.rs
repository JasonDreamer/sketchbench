//! スケッチとランタイムのTypeScriptをOxcでJSに変換する。依存はバンドルせず、import mapで解決する。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use oxc::allocator::Allocator;
use oxc::codegen::{Codegen, CodegenOptions};
use oxc::parser::Parser;
use oxc::semantic::SemanticBuilder;
use oxc::span::SourceType;
use oxc::transformer::{TransformOptions, Transformer};
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct Diagnostic {
    pub file: String,
    pub message: String,
}

#[derive(Clone)]
pub struct Built {
    pub js: String,
}

/// ファイルの更新時刻をキーにした変換結果のキャッシュ。
#[derive(Default)]
pub struct Cache {
    entries: Mutex<HashMap<PathBuf, (SystemTime, Result<Built, Vec<Diagnostic>>)>>,
}

impl Cache {
    pub fn get(&self, path: &Path) -> Result<Built, Vec<Diagnostic>> {
        let mtime = std::fs::metadata(path).and_then(|m| m.modified()).ok();
        if let Some(mtime) = mtime {
            if let Some((t, r)) = self.entries.lock().unwrap().get(path) {
                if *t == mtime {
                    return r.clone();
                }
            }
        }
        let r = transform_file(path);
        if let Some(mtime) = mtime {
            self.entries.lock().unwrap().insert(path.to_path_buf(), (mtime, r.clone()));
        }
        r
    }
}

pub fn transform_file(path: &Path) -> Result<Built, Vec<Diagnostic>> {
    let file = path.display().to_string();
    let src = std::fs::read_to_string(path).map_err(|e| vec![Diagnostic { file: file.clone(), message: e.to_string() }])?;
    transform(&src, path)
}

pub fn transform(src: &str, path: &Path) -> Result<Built, Vec<Diagnostic>> {
    let file = path.display().to_string();
    // 「ファイル:行:列: メッセージ」と、該当行を1行だけ添える
    let diag = |errs: oxc::diagnostics::Diagnostics| -> Vec<Diagnostic> {
        errs.into_iter()
            .map(|e| {
                let mut msg = e.message.to_string();
                if let Some(l) = e.labels.iter().find(|l| l.primary()).or_else(|| e.labels.first()) {
                    let off = (l.offset() as usize).min(src.len());
                    let before = &src[..off];
                    let line = before.matches('\n').count() + 1;
                    let col = before.rsplit('\n').next().map(|s| s.chars().count()).unwrap_or(0) + 1;
                    let text = src.lines().nth(line - 1).unwrap_or("").trim_end();
                    msg = format!("{file}:{line}:{col}: {msg}\n    {text}");
                    if let Some(lbl) = l.label() {
                        msg.push_str(&format!("\n    ({lbl})"));
                    }
                }
                if let Some(h) = &e.help {
                    msg.push_str(&format!("\n    ヒント: {h}"));
                }
                Diagnostic { file: file.clone(), message: msg }
            })
            .collect()
    };
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path).unwrap_or_else(|_| SourceType::ts());
    let ret = Parser::new(&allocator, src, source_type).parse();
    if !ret.diagnostics.is_empty() {
        return Err(diag(ret.diagnostics));
    }
    let mut program = ret.program;
    let sem = SemanticBuilder::new().with_excess_capacity(2.0).build(&program);
    if !sem.diagnostics.is_empty() {
        return Err(diag(sem.diagnostics));
    }
    let scoping = sem.semantic.into_scoping();
    // 型を消すだけにし、構文の下位変換はしない(WebView2は最新のChromium)
    let options = TransformOptions::from_target("esnext").unwrap_or_default();
    let tr = Transformer::new(&allocator, path, &options).build_with_scoping(scoping, &mut program);
    if !tr.diagnostics.is_empty() {
        return Err(diag(tr.diagnostics));
    }
    let js = Codegen::new().with_options(CodegenOptions::default()).build(&program).code;
    Ok(Built { js })
}
