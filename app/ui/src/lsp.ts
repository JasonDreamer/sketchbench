// 言語サーバー(Rustコアが動かす TypeScript 7 の tsc --lsp)とつなぐ。UIの中で1つだけ持つ。
// 送るのはコマンド lsp_send、受け取るのはイベント sb:lsp。サーバーが終わったら次に使うときに起動し直す。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LSPClient, LSPPlugin, languageServerExtensions, type Transport } from "@codemirror/lsp-client";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";

let client: Promise<LSPClient> | null = null;
const handlers = new Set<(m: string) => void>();
let listening = false;

export function lspClient(): Promise<LSPClient> {
  if (client) return client;
  client = (async () => {
    if (!listening) {
      listening = true;
      await listen<string>("sb:lsp", (e) => handlers.forEach((h) => h(e.payload)));
      await listen("sb:lsp-exit", () => (client = null));
    }
    const { rootUri } = await invoke<{ rootUri: string }>("lsp_start");
    const transport: Transport = {
      send(message) {
        invoke("lsp_send", { message }).catch(() => {});
      },
      subscribe: (h) => handlers.add(h),
      unsubscribe: (h) => handlers.delete(h),
    };
    // 型の確認は保存せずに打っている途中でも出すので、待ち時間は長めに取る
    return new LSPClient({ rootUri, extensions: languageServerExtensions(), timeout: 10000 }).connect(transport);
  })();
  client.catch(() => (client = null));
  return client;
}

/**
 * 型エラーの表示。TypeScript 7 の言語サーバーは診断を送ってこず(publishDiagnostics なし)、問い合わせ(textDocument/diagnostic)に答える形なので、
 * 打つのが止まってから問い合わせて、lint の表示に流す(@codemirror/lsp-client は送られてくる形にしか対応していない)
 */
export const pullDiagnostics = ViewPlugin.fromClass(
  class {
    timer = -1;
    seq = 0;
    constructor(readonly view: EditorView) {
      this.schedule(800);
    }
    update(u: ViewUpdate) {
      if (u.docChanged) this.schedule(600);
    }
    schedule(ms: number) {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.run(), ms);
    }
    async run() {
      const plugin = LSPPlugin.get(this.view);
      if (!plugin) return;
      plugin.client.sync();
      const n = ++this.seq;
      try {
        const r = await plugin.client.request<unknown, { kind: string; items?: LspDiagnostic[] }>("textDocument/diagnostic", { textDocument: { uri: plugin.uri } });
        if (n !== this.seq || !r || r.kind !== "full") return;
        const diags: Diagnostic[] = [];
        for (const it of r.items ?? []) {
          const sev = it.severity ?? 1;
          if (sev > 3) continue; // ヒント(使っていない変数など)は出さない
          diags.push({
            from: plugin.unsyncedChanges.mapPos(plugin.fromPosition(it.range.start, plugin.syncedDoc)),
            to: plugin.unsyncedChanges.mapPos(plugin.fromPosition(it.range.end, plugin.syncedDoc)),
            severity: sev === 1 ? "error" : sev === 2 ? "warning" : "info",
            message: it.message,
            source: it.code != null ? `TS${it.code}` : undefined,
          });
        }
        this.view.dispatch(setDiagnostics(this.view.state, diags));
      } catch {
        // 時間切れなどは次の変更で問い合わせ直す
      }
    }
    destroy() {
      clearTimeout(this.timer);
    }
  },
);

type LspDiagnostic = { range: { start: { line: number; character: number }; end: { line: number; character: number } }; severity?: number; message: string; code?: number | string };
