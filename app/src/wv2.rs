//! WebView2のCOM APIを直接使う部分。どれもメインスレッド(with_webviewの中)で呼ぶ。

use std::cell::RefCell;
use std::collections::HashMap;

use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::{CapturePreviewCompletedHandler, ProcessFailedEventHandler};
use windows::Win32::System::Com::StructuredStorage::{CreateStreamOnHGlobal, GetHGlobalFromStream};
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows_core::{Interface, HSTRING};

pub fn core(pw: &tauri::webview::PlatformWebview) -> windows_core::Result<ICoreWebView2> {
    unsafe { pw.controller().CoreWebView2() }
}

fn failed_kind_name(k: COREWEBVIEW2_PROCESS_FAILED_KIND) -> &'static str {
    match k {
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => "browser_exited",
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => "render_exited",
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => "render_unresponsive",
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED => "frame_render_exited",
        COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED => "gpu_exited",
        COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED => "utility_exited",
        _ => "other",
    }
}

/// ProcessFailedイベントを購読する。cbには失敗の種類を渡す(メインスレッドで呼ばれる)。
pub fn on_process_failed(core: &ICoreWebView2, cb: impl Fn(&'static str) + 'static) -> windows_core::Result<()> {
    let handler = ProcessFailedEventHandler::create(Box::new(move |_wv, args| {
        let mut k = COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED;
        if let Some(args) = args {
            unsafe { args.ProcessFailedKind(&mut k)? };
        }
        cb(failed_kind_name(k));
        Ok(())
    }));
    let mut token = 0i64;
    unsafe { core.add_ProcessFailed(&handler, &mut token) }
}

thread_local! {
    /// 共有メモリのCOMオブジェクト。解放するとマッピングが消えるのでメインスレッドで保持する。
    static SHARED: RefCell<HashMap<String, ICoreWebView2SharedBuffer>> = RefCell::new(HashMap::new());
}

/// 共有メモリを作り、スクリプトへ読み書き可で渡す。戻り値はRust側から見たアドレス。
pub fn post_shared_buffer(
    env: &ICoreWebView2Environment,
    core: &ICoreWebView2,
    key: &str,
    size: u64,
    meta: &str,
) -> windows_core::Result<usize> {
    let env12: ICoreWebView2Environment12 = env.cast()?;
    let buf = unsafe { env12.CreateSharedBuffer(size)? };
    let mut p: *mut u8 = std::ptr::null_mut();
    unsafe { buf.Buffer(&mut p)? };
    let core17: ICoreWebView2_17 = core.cast()?;
    let meta = HSTRING::from(meta);
    unsafe { core17.PostSharedBufferToScript(&buf, COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_WRITE, &meta)? };
    SHARED.with(|s| s.borrow_mut().insert(key.to_string(), buf));
    Ok(p as usize)
}

pub fn release_shared_buffer(key: &str) {
    SHARED.with(|s| {
        if let Some(b) = s.borrow_mut().remove(key) {
            let _ = unsafe { b.Close() };
        }
    });
}

/// CapturePreviewでPNGを撮る(メニューやダイアログの間、子WebViewの代わりに出す静止画)。cbはメインスレッドで呼ばれる
pub fn capture_png(core: &ICoreWebView2, cb: impl FnOnce(Result<Vec<u8>, String>) + 'static) -> windows_core::Result<()> {
    let stream = unsafe { CreateStreamOnHGlobal(Default::default(), true)? };
    let s2 = stream.clone();
    let handler = CapturePreviewCompletedHandler::create(Box::new(move |hr| {
        let r = match hr {
            Err(e) => Err(format!("{e}")),
            Ok(()) => unsafe {
                match GetHGlobalFromStream(&s2) {
                    Err(e) => Err(format!("{e}")),
                    Ok(h) => {
                        let p = GlobalLock(h) as *const u8;
                        let v = std::slice::from_raw_parts(p, GlobalSize(h)).to_vec();
                        let _ = GlobalUnlock(h);
                        Ok(v)
                    }
                }
            },
        };
        cb(r);
        Ok(())
    }));
    unsafe { core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &handler) }
}
