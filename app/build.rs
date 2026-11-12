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
    "edit_project",
    "undo",
    "redo",
    "midi_connect",
    "midi_record",
    "preview_still",
    "set_ui_context",
    "list_history",
    "restore_history",
    "reveal",
];

fn main() {
    // UIはビルド時に埋め込まれるので、ui/dist が変わったら作り直す
    println!("cargo:rerun-if-changed=ui/dist");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)))
        .expect("tauri build");
}
