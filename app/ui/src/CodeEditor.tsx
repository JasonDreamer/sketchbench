// コードエディタ(CodeMirror 6)。開いている作品の sketches/ と lib/ のファイルを編集し、Ctrl+S で保存する(保存でホットリロード)。
// TypeScript は言語サーバー(TypeScript 7)で補完・型エラー・ホバーを出す。
// 保存していない変更は UI の localStorage に下書きとして残し、開き直したときに戻せる。
// 外(エージェントや外部エディタ)でファイルが書き換えられたら読み直し、変わった行に色を付ける。
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { basicSetup, EditorView } from "codemirror";
import { Compartment, EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, keymap, type DecorationSet } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import { lintGutter } from "@codemirror/lint";
import { lspClient, pullDiagnostics } from "./lsp";

type FileInfo = { rel: string; uri: string };

/** 変わった行の印(外で書き換えられたとき) */
const setChanged = StateEffect.define<number[]>();
const changedLines = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setChanged)) {
        const mark = Decoration.line({ class: "cm-changed-line" });
        return Decoration.set(e.value.filter((n) => n >= 1 && n <= tr.state.doc.lines).map((n) => mark.range(tr.state.doc.line(n).from)));
      }
    }
    // 打ち始めたら印を消す
    return tr.docChanged ? Decoration.none : deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** 新しい文書で、古い文書にない行(行番号、1から)。行単位の最長共通部分列で比べる */
function addedLines(before: string, after: string): number[] {
  const a = before.split("\n"), b = after.split("\n");
  if (a.length * b.length > 4_000_000) return [];
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: number[] = [];
  let i = 0, j = 0;
  while (j < m) {
    if (i < n && a[i] === b[j]) {
      i++;
      j++;
    } else if (i < n && dp[i + 1][j] >= dp[i][j + 1]) i++;
    else out.push(++j);
  }
  return out;
}

export function CodeEditor(props: { work: string; preferred?: string; status: (s: string) => void; fail: (e: unknown) => void }) {
  let host!: HTMLDivElement;
  let view: EditorView | null = null;
  const lang = new Compartment();
  const [files, setFiles] = createSignal<FileInfo[]>([]);
  const [current, setCurrent] = createSignal<string | null>(null);
  /** ディスクにある内容(保存済み) */
  let disk = "";
  const [dirty, setDirty] = createSignal(false);
  const [draft, setDraft] = createSignal<{ text: string; at: number } | null>(null);
  const [outside, setOutside] = createSignal<string | null>(null);
  const draftKey = (rel: string) => `draft:${props.work}/${rel}`;
  let draftTimer = 0;

  const text = () => view?.state.doc.toString() ?? "";

  const save = async () => {
    const rel = current();
    if (!rel || !view) return true;
    try {
      const t = text();
      await invoke("code_write", { rel, text: t });
      disk = t;
      setDirty(false);
      setOutside(null);
      try {
        localStorage.removeItem(draftKey(rel));
      } catch {}
      props.status(`${rel} を保存した(プレビューに反映される)`);
    } catch (e) {
      props.fail(e);
    }
    return true;
  };

  const language = async (f: FileInfo): Promise<Extension> => {
    if (!/\.(ts|js)$/.test(f.rel)) return [];
    const base = javascript({ typescript: f.rel.endsWith(".ts") });
    try {
      const client = await lspClient();
      return [base, client.plugin(f.uri, f.rel.endsWith(".ts") ? "typescript" : "javascript"), pullDiagnostics, lintGutter()];
    } catch (e) {
      props.status(`言語サーバーにつなげない(補完と型の表示なしで編集する): ${e}`);
      return base;
    }
  };

  const open = async (rel: string) => {
    if (dirty() && current() && !confirm(`${current()} の変更を保存していません。保存せずに開きますか(下書きは残ります)`)) return;
    try {
      const f = files().find((x) => x.rel === rel) ?? { rel, uri: "" };
      const r = await invoke<{ text: string; uri: string }>("code_read", { rel });
      disk = r.text;
      setCurrent(rel);
      setDirty(false);
      setOutside(null);
      const ext = await language({ ...f, uri: r.uri || f.uri });
      view?.destroy();
      view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: r.text,
          extensions: [
            basicSetup,
            oneDark,
            changedLines,
            lang.of(ext),
            keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (save(), true) }]),
            EditorView.updateListener.of((u) => {
              if (!u.docChanged) return;
              const d = text() !== disk;
              setDirty(d);
              clearTimeout(draftTimer);
              draftTimer = window.setTimeout(() => {
                try {
                  if (d) localStorage.setItem(draftKey(rel), JSON.stringify({ text: text(), at: Date.now() }));
                  else localStorage.removeItem(draftKey(rel));
                } catch {}
              }, 1000);
            }),
          ],
        }),
      });
      // 前回保存しなかった下書き
      try {
        const d = JSON.parse(localStorage.getItem(draftKey(rel)) ?? "null");
        setDraft(d && d.text !== disk ? d : null);
      } catch {
        setDraft(null);
      }
    } catch (e) {
      props.fail(e);
    }
  };

  const restoreDraft = () => {
    const d = draft();
    if (!d || !view) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: d.text } });
    setDraft(null);
  };
  const discardDraft = () => {
    const rel = current();
    if (rel)
      try {
        localStorage.removeItem(draftKey(rel));
      } catch {}
    setDraft(null);
  };

  /** 外で書き換えられた内容に入れ替え、変わった行に印を付ける */
  const reloadFromDisk = async () => {
    const rel = current();
    if (!rel || !view) return;
    const r = await invoke<{ text: string }>("code_read", { rel });
    const before = text();
    disk = r.text;
    // ファイル監視の通知は1回の書き込みで2つ来ることがある。同じ内容なら何もしない(付けた印を消さない)
    if (r.text === before) return;
    const lines = addedLines(before, r.text);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: r.text } });
    view.dispatch({ effects: setChanged.of(lines) });
    setDirty(false);
    setOutside(null);
    props.status(`${rel} が外で書き換えられたので読み直した${lines.length ? `(変わった行: ${lines.slice(0, 20).join(", ")}${lines.length > 20 ? " …" : ""})` : ""}`);
  };

  const loadFiles = async () => {
    try {
      const r = await invoke<{ files: FileInfo[] }>("code_files");
      setFiles(r.files);
      return r.files;
    } catch (e) {
      props.fail(e);
      return [];
    }
  };

  onMount(async () => {
    const list = await loadFiles();
    const first = list.find((f) => props.preferred && f.rel.startsWith(props.preferred)) ?? list[0];
    if (first) await open(first.rel);
    // ファイルの変更(Rustのファイル監視)。今開いているファイルなら読み直す
    const un = await listen<{ paths: string[] }>("sb:reload", async (e) => {
      const rel = current();
      if (e.payload.paths.some((p) => !files().some((f) => f.rel === p) && /^(sketches|lib)\//.test(p))) loadFiles();
      if (!rel || !e.payload.paths.includes(rel)) return;
      const r = await invoke<{ text: string }>("code_read", { rel }).catch(() => null);
      if (!r || r.text === disk) return; // 自分の保存
      if (!dirty()) await reloadFromDisk();
      else setOutside(r.text);
    });
    onCleanup(un);
  });
  onCleanup(() => {
    clearTimeout(draftTimer);
    view?.destroy();
  });

  // 作品を替えたらファイルの一覧から開き直す
  createEffect(
    on(
      () => props.work,
      async () => {
        const list = await loadFiles();
        if (list[0] && !list.some((f) => f.rel === current())) open(list[0].rel);
      },
      { defer: true },
    ),
  );

  return (
    <div class="code">
      <div class="code-bar">
        <select aria-label="開くファイル" onChange={(e) => open(e.currentTarget.value)}>
          <For each={files()}>{(f) => <option value={f.rel} selected={f.rel === current()}>{f.rel}</option>}</For>
        </select>
        <button onClick={save} disabled={!dirty()} title="保存してプレビューに反映する(Ctrl+S)">保存{dirty() ? "*" : ""}</button>
        <button onClick={() => {
          const f = files().find((x) => x.rel === current());
          if (f?.uri) invoke("reveal", { path: decodeURIComponent(f.uri.replace(/^file:\/\/\//, "")).replace(/\//g, "\\") }).catch(props.fail);
        }} title="エクスプローラーで場所を開く(VS Codeなどで編集しても保存で反映される)">場所を開く</button>
      </div>
      <Show when={draft()}>
        {(d) => (
          <div class="code-note">
            保存していない変更があります({new Date(d().at).toLocaleString()})。
            <button onClick={restoreDraft}>戻す</button>
            <button onClick={discardDraft}>捨てる</button>
          </div>
        )}
      </Show>
      <Show when={outside()}>
        <div class="code-note">
          このファイルが外で書き換えられました(保存していない変更があります)。
          <button onClick={reloadFromDisk}>読み直す(変更を捨てる)</button>
          <button onClick={() => setOutside(null)}>このまま</button>
        </div>
      </Show>
      <div class="code-host" ref={host} />
    </div>
  );
}
