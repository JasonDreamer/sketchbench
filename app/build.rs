// アプリのコマンドはマニフェストに載せ、ケイパビリティで許可したWebView(UI)からだけ呼べるようにする。
const COMMANDS: &[&str] = &[
    "get_state",
    "open_work",
    "create_work",
    "play",
    "seek",
    "set_preview_rect",
    "set_preview_hidden",
    "reload_preview",
    "start_export",
    "reveal",
];

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)))
        .expect("tauri build");
}
