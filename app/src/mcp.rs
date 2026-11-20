//! MCPサーバー(rmcp)。名前付きパイプ \\.\pipe\sketchbench-mcp で待ち受け、`sb mcp` が標準入出力と中継する。
//! パイプは現在のユーザーだけが開けるようにし、接続の最初の1行でトークンを確かめる。
//! project.json を変えるツールは edit.rs の操作として送る(Rustコアが唯一の書き手)。

use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine as _;
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerConfig};
use rmcp::{tool, tool_handler, tool_router, ErrorData, ServerHandler, ServiceExt};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::core::Core;
use crate::export::{self, ExportOptions};
use crate::{diagnostics, edit, workspace};

pub const PIPE: &str = r"\\.\pipe\sketchbench-mcp";

const INSTRUCTIONS: &str = "Sketchbench: コードで映像を作るアプリ。作業フォルダの AGENTS.md に書き方がある。\
作品は works/<作品名>/ で、スケッチ(sketch.ts か shader.fs)はファイルを直接編集してよい(保存でプレビューに反映される)。\
project.json は直接書かず、set_* のツールで変える。変更したら get_diagnostics でエラーを、render_frames か render_contact_sheet で見た目を確かめてから完了を報告すること。";

/// ユーザー設定フォルダのトークン(なければ作る)。`sb mcp` が読んで最初の1行で送る
pub fn token() -> String {
    let path = token_path();
    if let Ok(t) = std::fs::read_to_string(&path) {
        let t = t.trim().to_string();
        if t.len() >= 32 {
            return t;
        }
    }
    let t = uuid::Uuid::new_v4().simple().to_string() + &uuid::Uuid::new_v4().simple().to_string();
    if let Some(p) = path.parent() {
        let _ = std::fs::create_dir_all(p);
    }
    let _ = std::fs::write(&path, &t);
    t
}

pub fn token_path() -> PathBuf {
    std::env::var("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(".")).join("sketchbench").join("mcp-token")
}

/// 現在のユーザーのSIDだけにすべての権限を与えるセキュリティ記述子(既定ではEveryoneに読み取りが付くため)
fn user_only_sddl() -> Result<String, String> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).map_err(|e| e.to_string())?;
        let mut len = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len);
        let mut buf = vec![0u8; len as usize];
        GetTokenInformation(token, TokenUser, Some(buf.as_mut_ptr() as _), len, &mut len).map_err(|e| e.to_string())?;
        let _ = CloseHandle(token);
        let tu = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut s = windows_core::PWSTR::null();
        ConvertSidToStringSidW(tu.User.Sid, &mut s).map_err(|e| e.to_string())?;
        let sid = s.to_string().map_err(|e| e.to_string())?;
        let _ = LocalFree(Some(HLOCAL(s.0 as _)));
        Ok(format!("D:P(A;;GA;;;{sid})"))
    }
}

/// パイプで待ち受ける(アプリの起動時に1回呼ぶ)
pub async fn serve(core: Arc<Core>) {
    use tokio::net::windows::named_pipe::ServerOptions;
    use windows::Win32::Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
    use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    let token = token();
    let sddl = match user_only_sddl() {
        Ok(s) => s,
        Err(e) => {
            core.log("mcp", "error", format!("MCPサーバーを開けない(ユーザーのSIDを取れない): {e}"), Value::Null);
            return;
        }
    };
    let mut first = true;
    loop {
        let server = unsafe {
            let mut sd = PSECURITY_DESCRIPTOR::default();
            let wide = windows_core::HSTRING::from(sddl.as_str());
            if let Err(e) = ConvertStringSecurityDescriptorToSecurityDescriptorW(&wide, SDDL_REVISION_1, &mut sd, None) {
                core.log("mcp", "error", format!("セキュリティ記述子を作れない: {e}"), Value::Null);
                return;
            }
            let mut sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: sd.0, bInheritHandle: false.into() };
            ServerOptions::new().first_pipe_instance(first).reject_remote_clients(true).create_with_security_attributes_raw(PIPE, &mut sa as *mut _ as *mut _)
        };
        let server = match server {
            Ok(s) => s,
            Err(e) => {
                core.log("mcp", "error", format!("MCPのパイプを作れない(別のSketchbenchが起動している?): {e}"), Value::Null);
                return;
            }
        };
        first = false;
        if server.connect().await.is_err() {
            continue;
        }
        let core = core.clone();
        let token = token.clone();
        tokio::spawn(async move {
            let (r, w) = tokio::io::split(server);
            let mut reader = BufReader::new(r);
            let mut line = String::new();
            if reader.read_line(&mut line).await.is_err() || line.trim() != format!("TOKEN {token}") {
                core.log("mcp", "warn", "トークンが合わない接続を切った", Value::Null);
                return;
            }
            core.log("mcp", "info", "エージェントが接続した", Value::Null);
            match Tools::new(core.clone()).serve((reader, w)).await {
                Ok(running) => {
                    let _ = running.waiting().await;
                }
                Err(e) => core.log("mcp", "error", format!("MCPの開始に失敗: {e}"), Value::Null),
            }
            core.log("mcp", "info", "エージェントが切断した", Value::Null);
        });
    }
}

// ---------------------------------------------------------------- ツールの引数

#[derive(Deserialize, JsonSchema)]
pub struct WorkArg {
    /// 作品名(works/ 直下のフォルダ名)
    pub work: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct CreateWorkArg {
    /// テンプレート名(list_templates で一覧)
    pub template: String,
    /// 作品名(英数字・-・_)
    pub name: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct AddSketchArg {
    pub work: String,
    /// スケッチの元にするテンプレート名
    pub template: String,
    /// 新しいスケッチの名前(sketches/<name> になる)
    pub name: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct RenderFramesArg {
    pub work: String,
    /// 描くフレーム番号(times と どちらか)
    pub frames: Option<Vec<u64>>,
    /// 描く時刻(秒)
    pub times: Option<Vec<f64>>,
    /// 画像の長辺(既定1024)
    pub max_size: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
pub struct ContactSheetArg {
    pub work: String,
    /// 始まりの時刻(秒、既定0)
    pub from: Option<f64>,
    /// 終わりの時刻(秒、既定は尺の終わり)
    pub to: Option<f64>,
    /// 並べる枚数(既定12、最大64)
    pub n: Option<u32>,
    pub max_size: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
pub struct InspectAssetArg {
    pub work: String,
    /// 作品フォルダからの相対パス(例: assets/song.wav)
    pub path: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct SetParamsArg {
    pub work: String,
    /// レイヤーID(例: L1)
    pub layer: String,
    /// param名と値
    pub values: serde_json::Map<String, Value>,
}

#[derive(Deserialize, JsonSchema)]
pub struct SetKeyframesArg {
    pub work: String,
    pub layer: String,
    /// レイヤーの param 名(クリップのフィールドなら track・clip・field を指定)
    pub param: Option<String>,
    pub track: Option<String>,
    /// クリップのid
    pub clip: Option<String>,
    pub field: Option<String>,
    /// レイヤーの合成の値("opacity"・"transform.position"・"transform.scale"・"transform.rotation"・"transform.anchor")。frame はレイヤー時刻
    pub property: Option<String>,
    /// [{ frame, value, ease? }]。frame は param ならレイヤー時刻、クリップならクリップ開始からの相対フレーム。
    /// ease は次のキーまでの区間に効く: "linear"(既定)・"hold"・"easeIn"・"easeOut"・"easeInOut"・[x1, y1, x2, y2](cubic-bezier)。
    /// 数値・vec2・色は補間し、それ以外の型は次のキーまで値を保つ。空の配列でキーを外す
    pub keys: Vec<Value>,
}

#[derive(Deserialize, JsonSchema)]
pub struct SetLayersArg {
    pub work: String,
    /// レイヤーの配列(project.json の layers と同じ形)。知らないキーは保つ
    pub layers: Vec<Value>,
}

#[derive(Deserialize, JsonSchema)]
pub struct RelinkArg {
    pub work: String,
    /// 見つからない素材の、今の参照(get_diagnostics の missingAssets の path)
    pub from: String,
    /// 新しい場所。作品からの相対パスか、作品の外の絶対パス(作品の assets/ に写してから付け替える)
    pub to: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct SetLoopArg {
    pub work: String,
    /// ループ範囲の開始と終了(作品のフレーム、[start, end))。両方省略で外す
    pub start: Option<u64>,
    pub end: Option<u64>,
}

#[derive(Deserialize, JsonSchema)]
pub struct UpdateLayerArg {
    pub work: String,
    pub layer: String,
    /// 変えるキーと値(null で消す)。start・end(作品のフレーム)、offset(レイヤーのフレーム)、speed、
    /// opacity(0〜1)、blend("normal"・"add"・"multiply"・"screen"・"difference")、
    /// transform({ position: [x, y](出力のピクセル), scale: 数値か[x, y], rotation: 度(時計回り), anchor: [x, y](レイヤーのピクセル) })、
    /// matte({ layer, mode: "alpha"・"alphaInverted"・"luma"・"lumaInverted" })、resolution(0.1〜1)、visible
    pub set: serde_json::Map<String, Value>,
}

#[derive(Deserialize, JsonSchema)]
pub struct SetEventMapArg {
    pub work: String,
    /// { 名前: { midi, note?, channel?, track?, offset? } | { times: [秒] } }
    pub event_map: Value,
}

#[derive(Deserialize, JsonSchema)]
pub struct TracksArg {
    pub work: String,
    pub layer: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct SetClipsArg {
    pub work: String,
    pub layer: String,
    pub track: String,
    /// 追加するクリップ [{ start, end, value }](時刻はフレーム。idは返り値で受け取る)
    #[serde(default)]
    pub add: Vec<Value>,
    /// 変更するクリップ [{ id, start?, end?, value? }](value はフィールド単位で上書き)
    #[serde(default)]
    pub update: Vec<Value>,
    /// 削除するクリップのid
    #[serde(default)]
    pub delete: Vec<String>,
    /// true なら既存のクリップをすべて消してから add する
    #[serde(default)]
    pub replace: bool,
}

/// 書き出しの仕様
#[derive(Deserialize, JsonSchema, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportSpec {
    /// "mp4" か "png"(連番)
    pub format: String,
    /// 範囲(フレーム)。省略すると全体
    pub from: Option<u64>,
    pub to: Option<u64>,
    /// 出力の大きさ。省略すると作品の width・height。16:9 と 9:16 のように作品と違う比率も指定できる(スケッチは width・height を見て描く)
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// 連番PNGの色深度 8(既定)か 16
    pub depth: Option<u8>,
    /// 連番PNGのアルファ "straight"(既定)・"premultiplied"・"none"
    pub alpha: Option<String>,
    /// モーションブラー { samples: 1フレームに描く回数(2〜64), shutter: 開いている割合(0.5で180度) }。pure のスケッチだけに効く
    pub motion_blur: Option<export::MotionBlur>,
    /// 音声を { lufs: 目標(例 -14), truePeak: 上限 dBTP(既定 -1) } に合わせる(MP4のみ)
    pub loudness: Option<export::LoudnessTarget>,
    /// ファイル名の末尾に付ける名前(英数字・-・_)
    pub name: Option<String>,
}

impl ExportSpec {
    fn options(self, work: String) -> ExportOptions {
        ExportOptions {
            work,
            format: self.format,
            from: self.from,
            to: self.to,
            width: self.width,
            height: self.height,
            depth: self.depth,
            alpha: self.alpha,
            motion_blur: self.motion_blur,
            loudness: self.loudness,
            name: self.name,
            ..Default::default()
        }
    }
}

#[derive(Deserialize, JsonSchema)]
pub struct ExportArg {
    pub work: String,
    #[serde(flatten)]
    pub spec: ExportSpec,
}

#[derive(Deserialize, JsonSchema)]
pub struct QueueAddArg {
    pub work: String,
    /// 書き出しの仕様の配列。1つずつ順に書き出す(16:9 と 9:16 などをまとめて積める)
    pub jobs: Vec<ExportSpec>,
}

#[derive(Deserialize, JsonSchema)]
pub struct QueueIdArg {
    /// queue_add が返した id
    pub id: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct HistoryArg {
    pub work: String,
    /// コミットID(list_history で一覧)
    pub commit: String,
}

// ---------------------------------------------------------------- ツール

#[derive(Clone)]
pub struct Tools {
    core: Arc<Core>,
    tool_router: ToolRouter<Self>,
}

fn ok_json(v: Value) -> Result<CallToolResult, ErrorData> {
    // 整形しない(AIが読むトークンを減らす)
    Ok(CallToolResult::success(vec![ContentBlock::text(serde_json::to_string(&v).unwrap_or_default())]))
}

fn fail(msg: impl Into<String>) -> Result<CallToolResult, ErrorData> {
    Ok(CallToolResult::error(vec![ContentBlock::text(msg.into())]))
}

fn images(o: &export::Outcome, label: impl Fn(i64) -> String) -> Vec<ContentBlock> {
    let mut out = vec![];
    for (i, jpeg) in &o.images {
        out.push(ContentBlock::text(label(*i)));
        out.push(ContentBlock::image(base64::engine::general_purpose::STANDARD.encode(jpeg), "image/jpeg"));
    }
    out
}

#[tool_router(router = tool_router)]
impl Tools {
    pub fn new(core: Arc<Core>) -> Self {
        Tools { core, tool_router: Self::tool_router() }
    }

    fn dir(&self, work: &str) -> Result<PathBuf, String> {
        workspace::work_dir(&self.core.ws, work).ok_or(format!("作品 {work} がない(list_works で一覧)"))
    }

    /// 作業のあとで、変更をgitに1コミットとして残す(MCPのツール呼び出し単位)
    fn commit(&self, work: &str, message: &str) {
        let c = self.core.clone();
        let (work, message) = (work.to_string(), message.to_string());
        std::thread::spawn(move || crate::history::commit_work(&c, &work, &format!("MCP: {message}"), "AI (MCP)"));
    }

    fn apply(&self, work: &str, op: edit::Op) -> Result<Value, String> {
        let dir = self.dir(work)?;
        let label = op.label();
        crate::schema::check_op_allowed(&dir)?;
        let r = self.core.editor.apply(&dir, op)?;
        self.commit(work, &label);
        Ok(r)
    }

    #[tool(description = "作品の一覧", annotations(read_only_hint = true))]
    async fn list_works(&self) -> Result<CallToolResult, ErrorData> {
        ok_json(json!({ "workspace": self.core.ws, "works": workspace::list_works(&self.core.ws) }))
    }

    #[tool(description = "テンプレートの一覧", annotations(read_only_hint = true))]
    async fn list_templates(&self) -> Result<CallToolResult, ErrorData> {
        ok_json(json!({ "templates": workspace::list_templates(&self.core.ws) }))
    }

    #[tool(description = "作品の project.json の現在値と、各スケッチの宣言(params・tracks の型)、ファイルの場所を返す", annotations(read_only_hint = true))]
    async fn get_work(&self, Parameters(a): Parameters<WorkArg>) -> Result<CallToolResult, ErrorData> {
        let dir = match self.dir(&a.work) {
            Ok(d) => d,
            Err(e) => return fail(e),
        };
        let project: Value = std::fs::read_to_string(dir.join("project.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
        let files: Vec<String> = workspace::walk(&dir)
            .into_iter()
            .filter_map(|f| f.strip_prefix(&dir).ok().map(|p| p.to_string_lossy().replace('\\', "/")))
            .filter(|p| !p.starts_with(".cache") && !p.starts_with("renders") && !p.starts_with(".git"))
            .collect();
        ok_json(json!({ "work": a.work, "dir": dir, "project": project, "declarations": crate::read_declarations(&dir), "files": files }))
    }

    #[tool(description = "テンプレートから作品を作り、アプリで開く")]
    async fn create_work(&self, Parameters(a): Parameters<CreateWorkArg>) -> Result<CallToolResult, ErrorData> {
        match workspace::create_work(&self.core.ws, &a.template, &a.name) {
            Ok(w) => {
                let c = self.core.clone();
                let w2 = w.clone();
                // 子WebViewの作成はメインスレッドを待つので、別スレッドから開く
                let _ = tokio::task::spawn_blocking(move || c.open_work(&w2)).await;
                self.commit(&w, "作品を作成");
                ok_json(json!({ "work": w, "dir": self.dir(&w).ok() }))
            }
            Err(e) => fail(e),
        }
    }

    #[tool(description = "テンプレートのスケッチを作品に足し、レイヤーを1つ追加する")]
    async fn add_sketch(&self, Parameters(a): Parameters<AddSketchArg>) -> Result<CallToolResult, ErrorData> {
        let dir = match self.dir(&a.work) {
            Ok(d) => d,
            Err(e) => return fail(e),
        };
        match crate::workspace::add_sketch(&self.core.ws, &dir, &a.template, &a.name) {
            Ok(sketch) => match self.apply(&a.work, edit::Op::AddLayer { sketch: sketch.clone() }) {
                Ok(r) => ok_json(json!({ "sketch": sketch, "layer": r["layer"] })),
                Err(e) => fail(e),
            },
            Err(e) => fail(e),
        }
    }

    #[tool(description = "指定したフレーム(または秒)を描いてJPEGで返す。見た目を確かめる主な手段", annotations(read_only_hint = true))]
    async fn render_frames(&self, Parameters(a): Parameters<RenderFramesArg>) -> Result<CallToolResult, ErrorData> {
        let dir = match self.dir(&a.work) {
            Ok(d) => d,
            Err(e) => return fail(e),
        };
        let p = match workspace::read_project(&dir) {
            Ok(p) => p,
            Err(e) => return fail(e),
        };
        let fps = p.fps_f64();
        let mut frames = a.frames.unwrap_or_default();
        frames.extend(a.times.unwrap_or_default().into_iter().map(|t| (t * fps).floor().max(0.0) as u64));
        if frames.is_empty() {
            frames = vec![0, p.duration / 2, p.duration.saturating_sub(1)];
        }
        let o = export::run(&self.core, ExportOptions { work: a.work.clone(), format: "frames".into(), from: None, to: None, order: None, frames: Some(frames), count: None, max_size: a.max_size, ..Default::default() }).await;
        if !o.ok {
            return fail(format!("描けない: {}。get_diagnostics でエラーを確認", o.error.unwrap_or_default()));
        }
        let mut content = images(&o, |f| format!("frame {f} ({:.3}s)", f as f64 / fps));
        content.extend(self.runtime_errors(&o.label));
        Ok(CallToolResult::success(content))
    }

    #[tool(description = "区間からn枚を等間隔に描いて1枚に並べた画像を返す。動きの確認用", annotations(read_only_hint = true))]
    async fn render_contact_sheet(&self, Parameters(a): Parameters<ContactSheetArg>) -> Result<CallToolResult, ErrorData> {
        let dir = match self.dir(&a.work) {
            Ok(d) => d,
            Err(e) => return fail(e),
        };
        let p = match workspace::read_project(&dir) {
            Ok(p) => p,
            Err(e) => return fail(e),
        };
        let fps = p.fps_f64();
        let from = a.from.map(|t| (t * fps).floor() as u64).unwrap_or(0);
        let to = a.to.map(|t| (t * fps).ceil() as u64).unwrap_or(p.duration).min(p.duration);
        let o = export::run(&self.core, ExportOptions { work: a.work.clone(), format: "sheet".into(), from: Some(from), to: Some(to), order: None, frames: None, count: a.n, max_size: a.max_size, ..Default::default() }).await;
        if !o.ok {
            return fail(format!("描けない: {}。get_diagnostics でエラーを確認", o.error.unwrap_or_default()));
        }
        let mut content = images(&o, |_| format!("contact sheet: frames {from}..{to}(各コマの左上にフレーム番号と秒)"));
        content.extend(self.runtime_errors(&o.label));
        Ok(CallToolResult::success(content))
    }

    #[tool(description = "変換エラー、型エラー(TypeScript 7)、project.json の検証エラー、実行時の例外、描画時間を返す", annotations(read_only_hint = true))]
    async fn get_diagnostics(&self, Parameters(a): Parameters<WorkArg>) -> Result<CallToolResult, ErrorData> {
        let dir = match self.dir(&a.work) {
            Ok(d) => d,
            Err(e) => return fail(e),
        };
        let core = self.core.clone();
        let work = a.work.clone();
        let v = tokio::task::spawn_blocking(move || diagnostics::collect(&core, &work, &dir)).await.unwrap_or(Value::Null);
        ok_json(v)
    }

    #[tool(description = "素材の内容を文字で返す。音声はBPM・ビート・オンセットの数と先頭、MIDIはノートの範囲・テンポなど", annotations(read_only_hint = true))]
    async fn inspect_asset(&self, Parameters(a): Parameters<InspectAssetArg>) -> Result<CallToolResult, ErrorData> {
        let dir = match self.dir(&a.work) {
            Ok(d) => d,
            Err(e) => return fail(e),
        };
        let Some(path) = workspace::safe_rel(&dir, &a.path) else { return fail("作品フォルダの外は読めない") };
        let v = tokio::task::spawn_blocking(move || diagnostics::inspect_asset(&dir, &path)).await.unwrap_or_else(|e| Err(e.to_string()));
        match v {
            Ok(v) => ok_json(v),
            Err(e) => fail(e),
        }
    }

    #[tool(description = "レイヤーの params の値を変える(キーフレームはまだない)")]
    async fn set_params(&self, Parameters(a): Parameters<SetParamsArg>) -> Result<CallToolResult, ErrorData> {
        for (name, value) in a.values {
            if let Err(e) = self.apply(&a.work, edit::Op::SetParam { layer: a.layer.clone(), name, value }) {
                return fail(e);
            }
        }
        ok_json(json!({ "ok": true }))
    }

    #[tool(description = "params(またはクリップのフィールド)のキーフレームを置き換える")]
    async fn set_keyframes(&self, Parameters(a): Parameters<SetKeyframesArg>) -> Result<CallToolResult, ErrorData> {
        let target = edit::KeyTarget { layer: a.layer, param: a.param, track: a.track, clip: a.clip, field: a.field, property: a.property };
        match self.apply(&a.work, edit::Op::SetKeys { target, keys: a.keys }) {
            Ok(_) => ok_json(json!({ "ok": true })),
            Err(e) => fail(e),
        }
    }

    #[tool(description = "レイヤー構成と合成設定を丸ごと置き換える。消えたレイヤーのクリップや値も消える", annotations(destructive_hint = true))]
    async fn set_layers(&self, Parameters(a): Parameters<SetLayersArg>) -> Result<CallToolResult, ErrorData> {
        match self.apply(&a.work, edit::Op::SetLayers { layers: a.layers }) {
            Ok(_) => ok_json(json!({ "ok": true })),
            Err(e) => fail(e),
        }
    }

    #[tool(description = "レイヤー1つの設定(時間・不透明度・ブレンド・変形・マット・内部解像度)を部分的に変える")]
    async fn update_layer(&self, Parameters(a): Parameters<UpdateLayerArg>) -> Result<CallToolResult, ErrorData> {
        match self.apply(&a.work, edit::Op::UpdateLayer { layer: a.layer, set: a.set }) {
            Ok(_) => ok_json(json!({ "ok": true })),
            Err(e) => fail(e),
        }
    }

    #[tool(description = "リンク切れの素材(get_diagnostics の missingAssets)を別のファイルに付け替える")]
    async fn relink_asset(&self, Parameters(a): Parameters<RelinkArg>) -> Result<CallToolResult, ErrorData> {
        let dir = match self.dir(&a.work) {
            Ok(d) => d,
            Err(e) => return fail(e),
        };
        let p = std::path::Path::new(&a.to);
        let to = if p.is_absolute() {
            match crate::assets_check::import_file(&dir, p) {
                Ok(t) => t,
                Err(e) => return fail(e),
            }
        } else if crate::workspace::safe_rel(&dir, &a.to).is_some_and(|f| f.is_file()) {
            a.to.clone()
        } else {
            return fail(format!("{} が作品の中にない", a.to));
        };
        match self.apply(&a.work, edit::Op::RelinkAsset { from: a.from, to: to.clone() }) {
            Ok(_) => ok_json(json!({ "ok": true, "to": to })),
            Err(e) => fail(e),
        }
    }

    #[tool(description = "ループ範囲(プレビューの繰り返し再生と、書き出しの範囲に使える)を決める")]
    async fn set_loop(&self, Parameters(a): Parameters<SetLoopArg>) -> Result<CallToolResult, ErrorData> {
        match self.apply(&a.work, edit::Op::SetLoop { start: a.start, end: a.end }) {
            Ok(_) => ok_json(json!({ "ok": true })),
            Err(e) => fail(e),
        }
    }

    #[tool(description = "イベント対応表(eventMap)を置き換える")]
    async fn set_event_map(&self, Parameters(a): Parameters<SetEventMapArg>) -> Result<CallToolResult, ErrorData> {
        match self.apply(&a.work, edit::Op::SetEventMap { event_map: a.event_map }) {
            Ok(_) => ok_json(json!({ "ok": true })),
            Err(e) => fail(e),
        }
    }

    #[tool(description = "レイヤーのクリップトラックの値と、スケッチが宣言したフィールドの型を返す", annotations(read_only_hint = true))]
    async fn get_tracks(&self, Parameters(a): Parameters<TracksArg>) -> Result<CallToolResult, ErrorData> {
        let dir = match self.dir(&a.work) {
            Ok(d) => d,
            Err(e) => return fail(e),
        };
        let project: Value = std::fs::read_to_string(dir.join("project.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
        let layer = project["layers"].as_array().and_then(|ls| ls.iter().find(|l| l["id"] == a.layer.as_str())).cloned();
        let Some(layer) = layer else { return fail(format!("レイヤー {} がない", a.layer)) };
        let decl = crate::read_declarations(&dir)[layer["sketch"].as_str().unwrap_or("")]["tracks"].clone();
        ok_json(json!({ "fps": project["fps"], "declared": decl, "tracks": layer["tracks"] }))
    }

    #[tool(description = "クリップを差分で追加・変更・削除する(時刻はフレーム)。replace: true のときは全置換", annotations(destructive_hint = true))]
    async fn set_clips(&self, Parameters(a): Parameters<SetClipsArg>) -> Result<CallToolResult, ErrorData> {
        let op = edit::Op::SetClips { layer: a.layer, track: a.track, add: a.add, update: a.update, delete: a.delete, replace: a.replace };
        match self.apply(&a.work, op) {
            Ok(r) => ok_json(r),
            Err(e) => fail(e),
        }
    }

    #[tool(description = "書き出してファイルの場所を返す(mp4 は音声付き、png は連番)。書き出し前にgitへコミットする")]
    async fn export(&self, Parameters(a): Parameters<ExportArg>) -> Result<CallToolResult, ErrorData> {
        if a.spec.format != "mp4" && a.spec.format != "png" {
            return fail("format は mp4 か png");
        }
        crate::history::commit_work(&self.core, &a.work, "書き出し前の状態", "Sketchbench");
        let o = export::run(&self.core, a.spec.options(a.work)).await;
        if o.ok {
            ok_json(json!({ "path": o.path, "seconds": o.elapsed, "loudness": o.loudness }))
        } else {
            fail(o.error.unwrap_or_default())
        }
    }

    #[tool(description = "レンダーキューに書き出しを積む(すぐ返る)。進み具合と結果は queue_list で見る")]
    async fn queue_add(&self, Parameters(a): Parameters<QueueAddArg>) -> Result<CallToolResult, ErrorData> {
        let items = a.jobs.into_iter().map(|s| s.options(a.work.clone())).collect();
        match crate::queue::add(&self.core, items) {
            Ok(ids) => ok_json(json!({ "ids": ids })),
            Err(e) => fail(e),
        }
    }

    #[tool(description = "レンダーキューの一覧(状態、進んだフレーム数、ファイルの場所、音量の正規化の結果)", annotations(read_only_hint = true))]
    async fn queue_list(&self) -> Result<CallToolResult, ErrorData> {
        ok_json(crate::queue::list(&self.core))
    }

    #[tool(description = "レンダーキューの項目を取り消す(書き出し中なら止める)")]
    async fn queue_cancel(&self, Parameters(a): Parameters<QueueIdArg>) -> Result<CallToolResult, ErrorData> {
        match crate::queue::cancel(&self.core, &a.id) {
            Ok(()) => ok_json(json!({ "ok": true })),
            Err(e) => fail(e),
        }
    }

    #[tool(description = "作品の履歴(gitのコミット)を新しい順に返す", annotations(read_only_hint = true))]
    async fn list_history(&self, Parameters(a): Parameters<WorkArg>) -> Result<CallToolResult, ErrorData> {
        match crate::history::list(&self.core, &a.work, 50) {
            Ok(v) => ok_json(v),
            Err(e) => fail(e),
        }
    }

    #[tool(description = "作品を指定したコミットの状態に戻す(ほかの作品には影響しない)。いまの状態は先にコミットしておく", annotations(destructive_hint = true))]
    async fn restore_history(&self, Parameters(a): Parameters<HistoryArg>) -> Result<CallToolResult, ErrorData> {
        match crate::history::restore(&self.core, &a.work, &a.commit) {
            Ok(v) => ok_json(v),
            Err(e) => fail(e),
        }
    }

    #[tool(description = "人がアプリで指し示しているもの(開いている作品、フレーム、選択中のクリップ、プレビュー上で囲んだ範囲)と、その時点のプレビュー画像", annotations(read_only_hint = true))]
    async fn get_ui_context(&self) -> Result<CallToolResult, ErrorData> {
        let ctx = self.core.ui_context.lock().unwrap().clone();
        let mut content = vec![ContentBlock::text(serde_json::to_string_pretty(&ctx).unwrap_or_default())];
        if let Some(work) = ctx["work"].as_str() {
            let frame = ctx["frame"].as_u64().unwrap_or(0);
            let o = export::run(&self.core, ExportOptions { work: work.into(), format: "frames".into(), from: None, to: None, order: None, frames: Some(vec![frame]), count: None, max_size: Some(1024), ..Default::default() }).await;
            content.extend(images(&o, |f| format!("frame {f}")));
        }
        Ok(CallToolResult::success(content))
    }
}

impl Tools {
    /// その描画ジョブで出た実行時の例外
    fn runtime_errors(&self, label: &str) -> Vec<ContentBlock> {
        let logs = self.core.logs.lock().unwrap();
        let recent: Vec<&Value> = logs.iter().filter(|l| l["level"] == "error" && l["source"] == label).collect();
        if recent.is_empty() {
            vec![]
        } else {
            vec![ContentBlock::text(format!("描画中のエラー:\n{}", recent.iter().map(|l| l["message"].as_str().unwrap_or("")).collect::<Vec<_>>().join("\n")))]
        }
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for Tools {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("sketchbench", env!("CARGO_PKG_VERSION")))
            .with_instructions(INSTRUCTIONS)
    }
}
