import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type TimeMsg = { frame: number; playing: boolean; fps: number; duration: number; unixMs: number };
type Log = { source: string; level: string; message: string; unixMs: number };
type ExportMsg = { id: string; state: "running" | "done" | "failed"; done?: number; total?: number; path?: string; error?: string; elapsed?: number };

export function App() {
  const [works, setWorks] = createSignal<string[]>([]);
  const [templates, setTemplates] = createSignal<string[]>([]);
  const [work, setWork] = createSignal<string | null>(null);
  const [workspace, setWorkspace] = createSignal("");
  const [time, setTime] = createSignal<TimeMsg>({ frame: 0, playing: false, fps: 30, duration: 300, unixMs: Date.now() });
  const [now, setNow] = createSignal(0);
  const [logs, setLogs] = createSignal<Log[]>([]);
  const [exp, setExp] = createSignal<ExportMsg | null>(null);
  let previewEl!: HTMLDivElement;
  let seekCanvas!: HTMLCanvasElement;
  let consoleEl!: HTMLDivElement;
  let newDialog!: HTMLDialogElement;

  const refresh = async () => {
    const s: any = await invoke("get_state");
    setWorks(s.works);
    setTemplates(s.templates);
    setWork(s.work);
    setWorkspace(s.workspace);
    setTime(s.time);
    setLogs(s.logs);
  };

  const addLog = (l: Log) => {
    setLogs((v) => [...v.slice(-300), l]);
    queueMicrotask(() => (consoleEl.scrollTop = consoleEl.scrollHeight));
  };

  // 再生中は受け取った時刻とUNIX時刻の差で補間して表示する
  const currentFrame = () => {
    const t = time();
    now();
    let f = t.frame + (t.playing ? ((Date.now() - t.unixMs) / 1000) * t.fps : 0);
    if (t.duration > 0) f = ((f % t.duration) + t.duration) % t.duration;
    return Math.floor(f + 1e-6);
  };

  const reportRect = () => {
    const r = previewEl.getBoundingClientRect();
    invoke("set_preview_rect", { rect: { x: r.x, y: r.y, w: r.width, h: r.height } });
  };

  onMount(async () => {
    const un = await Promise.all([
      listen<TimeMsg>("sb:time", (e) => setTime(e.payload)),
      listen<Log>("sb:log", (e) => addLog(e.payload)),
      listen<ExportMsg>("sb:export", (e) => setExp(e.payload)),
    ]);
    onCleanup(() => un.forEach((f) => f()));
    const first: any = await invoke("get_state");
    await refresh();
    // 起動時は --open で指定した作品か、一覧の先頭を開く(前回のワークスペースの復元はフェーズ4)
    const initial = first.initialWork && works().includes(first.initialWork) ? first.initialWork : works()[0];
    if (!work() && initial) await open(initial);

    // 子WebViewはUIの上に重なる別のネイティブ領域なので、プレビュー領域の矩形をRustへ送って合わせる。
    // ウィンドウのリサイズ中は位置合わせが1〜2フレーム遅れて隙間が見えるため隠す(フェーズ0の結果)
    let resizeTimer = 0;
    let hidden = false;
    const ro = new ResizeObserver(() => {
      reportRect();
      if (!hidden) {
        hidden = true;
        invoke("set_preview_hidden", { hidden: true });
      }
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        hidden = false;
        reportRect();
        invoke("set_preview_hidden", { hidden: false });
      }, 150);
    });
    ro.observe(previewEl);
    reportRect();

    let raf = 0;
    const loop = () => {
      setNow(performance.now());
      drawSeek();
      raf = requestAnimationFrame(loop);
    };
    loop();
    onCleanup(() => cancelAnimationFrame(raf));

    // ショートカット。プレビュー(別のWebView)で押されたキーもRust経由でここに届く
    const shortcut = (k: { code: string; key: string; shift: boolean }) => {
      if (k.code === "Space") togglePlay();
      else if (k.key === "ArrowLeft" || k.key === "ArrowRight")
        invoke("seek", { frame: currentFrame() + (k.key === "ArrowLeft" ? -1 : 1) * (k.shift ? 10 : 1) });
      else if (k.key === "Home") invoke("seek", { frame: 0 });
      else return false;
      return true;
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, select, textarea, dialog")) return;
      if (shortcut({ code: e.code, key: e.key, shift: e.shiftKey })) e.preventDefault();
    };
    addEventListener("keydown", onKey);
    onCleanup(() => removeEventListener("keydown", onKey));
    const unKey = await listen<{ code: string; key: string; shift: boolean }>("sb:key", (e) => shortcut(e.payload));
    onCleanup(unKey);
  });

  const togglePlay = () => invoke("play", { playing: !time().playing });

  const drawSeek = () => {
    const c = seekCanvas;
    if (!c) return;
    const dpr = devicePixelRatio;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr)) c.width = Math.round(w * dpr);
    if (c.height !== Math.round(h * dpr)) c.height = Math.round(h * dpr);
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const t = time();
    const dur = Math.max(1, t.duration);
    // 1秒ごとの目盛り
    g.fillStyle = "#3a3d44";
    const secs = dur / t.fps;
    const step = secs > 120 ? 10 : secs > 30 ? 5 : 1;
    for (let s = 0; s <= secs; s += step) {
      const x = (s * t.fps / dur) * w;
      g.fillRect(Math.round(x), s % (step * 5) === 0 ? 6 : 14, 1, h);
    }
    const x = (currentFrame() / dur) * w;
    g.fillStyle = "#f2a541";
    g.fillRect(Math.round(x) - 1, 0, 2, h);
  };

  const seekAt = (e: PointerEvent) => {
    const r = seekCanvas.getBoundingClientRect();
    const f = Math.round(((e.clientX - r.left) / r.width) * time().duration);
    invoke("seek", { frame: f });
  };

  const open = async (w: string) => {
    try {
      await invoke("open_work", { work: w });
      await refresh();
      reportRect();
    } catch (e) {
      addLog({ source: "ui", level: "error", message: String(e), unixMs: Date.now() });
    }
  };

  const create = async (ev: SubmitEvent) => {
    ev.preventDefault();
    const fd = new FormData(ev.target as HTMLFormElement);
    try {
      await invoke("create_work", { template: fd.get("template"), name: fd.get("name") });
      newDialog.close();
      await refresh();
      reportRect();
    } catch (e) {
      addLog({ source: "ui", level: "error", message: String(e), unixMs: Date.now() });
    }
  };

  const startExport = async (format: "mp4" | "png") => {
    const w = work();
    if (!w) return;
    try {
      await invoke("start_export", { options: { work: w, format } });
      setExp({ id: "", state: "running", done: 0, total: time().duration });
    } catch (e) {
      addLog({ source: "ui", level: "error", message: String(e), unixMs: Date.now() });
    }
  };

  const fmtTime = (f: number) => {
    const s = f / time().fps;
    const m = Math.floor(s / 60);
    return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
  };

  return (
    <div class="app">
      <div class="bar">
        <select aria-label="作品" value={work() ?? ""} onChange={(e) => open(e.currentTarget.value)}>
          <Show when={!work()}><option value="">作品を選ぶ</option></Show>
          <For each={works()}>{(w) => <option value={w}>{w}</option>}</For>
        </select>
        <button onClick={() => newDialog.showModal()}>新規</button>
        <button onClick={togglePlay} disabled={!work()} aria-label={time().playing ? "一時停止" : "再生"}>
          {time().playing ? "一時停止" : "再生"}
        </button>
        <span class="time">
          <b>{currentFrame()}</b> / {time().duration} f ・ {fmtTime(currentFrame())} ・ {time().fps.toFixed(3).replace(/\.?0+$/, "")} fps
        </span>
        <span class="spacer" />
        <ExportState exp={exp()} />
        <button onClick={() => startExport("mp4")} disabled={!work() || exp()?.state === "running"}>MP4を書き出す</button>
        <button onClick={() => startExport("png")} disabled={!work() || exp()?.state === "running"}>連番PNGを書き出す</button>
      </div>
      <div class="preview" ref={previewEl}>
        <Show when={!work()}>
          <div class="empty">
            作品がありません。「新規」でテンプレートから作るか、<br />
            {workspace()}\works\ にフォルダを置いてください。
          </div>
        </Show>
      </div>
      <div class="seek" onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); seekAt(e); }}
        onPointerMove={(e) => { if (e.buttons & 1) seekAt(e); }}>
        <canvas ref={seekCanvas} aria-label="シークバー" />
      </div>
      <div class="console" ref={consoleEl} aria-live="polite">
        <Show when={logs().length === 0}><div class="row src">ログはまだありません。スケッチの変換エラーや実行時の例外はここに出ます。</div></Show>
        <For each={logs()}>
          {(l) => <div class={`row ${l.level}`}><span class="src">{l.source}</span>{l.message}</div>}
        </For>
      </div>
      <dialog ref={newDialog}>
        <form onSubmit={create}>
          <label>テンプレート
            <select name="template">
              <For each={templates()}>{(t) => <option value={t}>{t}</option>}</For>
            </select>
          </label>
          <label>作品名(英数字・-・_)
            <input name="name" required pattern="[A-Za-z0-9_\-]+" placeholder="my-sketch" />
          </label>
          <div style={{ display: "flex", gap: "8px", "justify-content": "flex-end" }}>
            <button type="button" onClick={() => newDialog.close()}>やめる</button>
            <button type="submit">作る</button>
          </div>
        </form>
      </dialog>
    </div>
  );
}

function ExportState(props: { exp: ExportMsg | null }) {
  return (
    <Show when={props.exp}>
      {(e) => (
        <span class="export-state">
          <Show when={e().state === "running"}>書き出し中 {e().done ?? 0} / {e().total ?? "?"}</Show>
          <Show when={e().state === "done"}>
            書き出し完了({(e().elapsed ?? 0).toFixed(1)}秒) <a onClick={() => invoke("reveal", { path: e().path })}>場所を開く</a>
          </Show>
          <Show when={e().state === "failed"}>書き出し失敗: {e().error}</Show>
        </span>
      )}
    </Show>
  );
}
