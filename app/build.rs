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
    "queue_add",
    "queue_list",
    "queue_cancel",
    "queue_clear",
    "measure_loudness",
    "render_stills",
    "relink_pick",
    "assets_list",
    "assets_import",
    "lsp_start",
    "lsp_send",
    "code_files",
    "code_read",
    "code_write",
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
