//! WebView2のCOM APIを直接使う計測用ヘルパー。どれもメインスレッド(with_webviewの中)で呼ぶ。

use std::cell::RefCell;

use serde_json::{json, Value};
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::{
    CapturePreviewCompletedHandler, PermissionRequestedEventHandler, ProcessFailedEventHandler,
};
use windows::Win32::System::Com::StructuredStorage::{CreateStreamOnHGlobal, GetHGlobalFromStream};
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows_core::{Interface, HSTRING, PWSTR};

pub fn core(pw: &tauri::webview::PlatformWebview) -> windows_core::Result<ICoreWebView2> {
    unsafe { pw.controller().CoreWebView2() }
}

pub fn browser_pid(core: &ICoreWebView2) -> u32 {
    let mut p = 0u32;
    let _ = unsafe { core.BrowserProcessId(&mut p) };
    p
}

fn kind_name(k: COREWEBVIEW2_PROCESS_KIND) -> &'static str {
    match k {
        COREWEBVIEW2_PROCESS_KIND_BROWSER => "browser",
        COREWEBVIEW2_PROCESS_KIND_RENDERER => "renderer",
        COREWEBVIEW2_PROCESS_KIND_GPU => "gpu",
        COREWEBVIEW2_PROCESS_KIND_UTILITY => "utility",
        COREWEBVIEW2_PROCESS_KIND_SANDBOX_HELPER => "sandbox_helper",
        _ => "other",
    }
}

/// 環境(ブラウザプロセス単位)に属する全プロセスのPIDと種類。
pub fn process_infos(env: &ICoreWebView2Environment) -> windows_core::Result<Vec<(u32, &'static str)>> {
    let env8: ICoreWebView2Environment8 = env.cast()?;
    let coll = unsafe { env8.GetProcessInfos()? };
    let mut n = 0u32;
    unsafe { coll.Count(&mut n)? };
    let mut out = Vec::new();
    for i in 0..n {
        let info = unsafe { coll.GetValueAtIndex(i)? };
        let mut pid = 0i32;
        let mut kind = COREWEBVIEW2_PROCESS_KIND_BROWSER;
        unsafe {
            info.ProcessId(&mut pid)?;
            info.Kind(&mut kind)?;
        }
        out.push((pid as u32, kind_name(kind)));
    }
    Ok(out)
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

/// ProcessFailedイベントを購読する。cbはメインスレッドで呼ばれる。
pub fn on_process_failed(core: &ICoreWebView2, cb: impl Fn(Value) + 'static) -> windows_core::Result<()> {
    let handler = ProcessFailedEventHandler::create(Box::new(move |_wv, args| {
        let mut v = json!({});
        if let Some(args) = args {
            let mut k = COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED;
            unsafe { args.ProcessFailedKind(&mut k)? };
            v["kind"] = json!(failed_kind_name(k));
            if let Ok(a2) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON_UNEXPECTED;
                let mut code = 0i32;
                unsafe {
                    let _ = a2.Reason(&mut reason);
                    let _ = a2.ExitCode(&mut code);
                }
                v["reason"] = json!(reason.0);
                v["exitCode"] = json!(code);
            }
        }
        cb(v);
        Ok(())
    }));
    let mut token = 0i64;
    unsafe { core.add_ProcessFailed(&handler, &mut token) }
}

/// 権限要求を記録し、許可する(ローカル通信制限の確認用)。
pub fn on_permission(core: &ICoreWebView2, cb: impl Fn(Value) + 'static) -> windows_core::Result<()> {
    let handler = PermissionRequestedEventHandler::create(Box::new(move |_wv, args| {
        if let Some(args) = args {
            let mut kind = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
            let mut uri = PWSTR::null();
            unsafe {
                args.PermissionKind(&mut kind)?;
                args.Uri(&mut uri)?;
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
            }
            let uri = unsafe { uri.to_string().unwrap_or_default() };
            cb(json!({ "kind": kind.0, "uri": uri }));
        }
        Ok(())
    }));
    let mut token = 0i64;
    unsafe { core.add_PermissionRequested(&handler, &mut token) }
}

/// CapturePreviewでPNGを撮る。完了時にcb(PNGのバイト列)をメインスレッドで呼ぶ。
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
                        let n = GlobalSize(h);
                        let v = std::slice::from_raw_parts(p, n).to_vec();
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

thread_local! {
    /// 共有メモリのCOMオブジェクトはメインスレッドで保持する(解放するとマッピングが消える)。
    static SHARED: RefCell<Vec<ICoreWebView2SharedBuffer>> = const { RefCell::new(Vec::new()) };
}

/// 共有メモリを作ってスクリプトへ読み書き可で渡す。戻り値はRust側から見たアドレス。
pub fn post_shared_buffer(
    env: &ICoreWebView2Environment,
    core: &ICoreWebView2,
    size: u64,
    meta: &str,
) -> windows_core::Result<usize> {
    let env12: ICoreWebView2Environment12 = env.cast()?;
    let buf = unsafe { env12.CreateSharedBuffer(size)? };
    let mut p: *mut u8 = std::ptr::null_mut();
    unsafe { buf.Buffer(&mut p)? };
    let core17: ICoreWebView2_17 = core.cast()?;
    let meta = HSTRING::from(meta);
    unsafe {
        core17.PostSharedBufferToScript(&buf, COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_WRITE, &meta)?;
    }
    SHARED.with(|s| s.borrow_mut().push(buf));
    Ok(p as usize)
}

pub fn release_shared_buffers() {
    SHARED.with(|s| {
        for b in s.borrow_mut().drain(..) {
            let _ = unsafe { b.Close() };
        }
    });
}

pub fn terminate_pid(pid: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    unsafe {
        match OpenProcess(PROCESS_TERMINATE, false, pid) {
            Ok(h) => {
                let ok = TerminateProcess(h, 1).is_ok();
                let _ = CloseHandle(h);
                ok
            }
            Err(_) => false,
        }
    }
}
