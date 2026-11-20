import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Timeline, type Selection, type TimelineApi } from "./Timeline";
import { isNtsc, smpte, type ProjectLike, type TimeDisplay } from "./timeline-model";
import { SeamView } from "./SeamView";
import { Areas, type AreasApi } from "./Areas";
import { CodeEditor } from "./CodeEditor";
import { GraphEditor } from "./GraphEditor";
import { EDITOR_NAMES, loadWorkspaces, saveAsDefault, saveWorkspaces, type EditorTag, type WorkspaceSet } from "./workspaces";
import type { AreasLayout } from "sliced-areas";
import { ParamPanel, type ParamApi } from "./ParamPanel";
import { ExportForm, QueueList, type QueueItem } from "./ExportUi";

type TimeMsg = { frame: number; playing: boolean; fps: number; fpsRatio?: [number, number]; duration: number; unixMs: number; audio?: boolean; loopStart?: number; loopEnd?: number };
type Log = { source: string; level: string; message: string; unixMs: number };
type ExportMsg = { id: string; state: "running" | "done" | "failed"; done?: number; total?: number; path?: string; error?: string; elapsed?: number };
type KeyMsg = { code: string; key: string; shift: boolean; ctrl: boolean; alt?: boolean };

export function App() {
  const [works, setWorks] = createSignal<string[]>([]);
  const [templates, setTemplates] = createSignal<string[]>([]);
  const [work, setWork] = createSignal<string | null>(null);
  const [workspace, setWorkspace] = createSignal("");
  const [project, setProject] = createSignal<ProjectLike | null>(null);
  const [decls, setDecls] = createSignal<Record<string, any>>({});
  const [time, setTime] = createSignal<TimeMsg>({ frame: 0, playing: false, fps: 30, duration: 300, unixMs: Date.now() });
  const [now, setNow] = createSignal(0);
  const [logs, setLogs] = createSignal<Log[]>([]);
  const [exp, setExp] = createSignal<ExportMsg | null>(null);
  const [selection, setSelection] = createSignal<Selection | null>(null);
  const [status, setStatus] = createSignal("");
  const [midiPorts, setMidiPorts] = createSignal<string[] | null>(null);
  const [recording, setRecording] = createSignal(false);
  const [learn, setLearn] = createSignal<string | null>(null);
  let midiDialog!: HTMLDialogElement;
  let historyDialog!: HTMLDialogElement;
  const [history, setHistory] = createSignal<any[]>([]);
  const [still, setStill] = createSignal<string | null>(null);
  let covered = 0;
  /**
   * プレビューの子WebViewはUIより上に重なる別のネイティブ領域なので、メニューやダイアログを出す間は隠し、
   * 直前の画面の静止画をUI側に出す(設計書の「全体アーキテクチャ」)
   */
  const coverPreview = async (on: boolean) => {
    if (on) {
      if (++covered > 1) return;
      try {
        const buf = await invoke<ArrayBuffer>("preview_still");
        setStill(URL.createObjectURL(new Blob([buf], { type: "image/png" })));
      } catch {}
      if (covered > 0) invoke("set_preview_hidden", { hidden: true });
    } else {
      covered = Math.max(0, covered - 1);
      if (covered > 0) return;
      // プレビューのエリアがないワークスペースでは隠したまま
      invoke("set_preview_hidden", { hidden: !previewEl() });
      setStill((old) => {
        if (old) URL.revokeObjectURL(old);
        return null;
      });
    }
  };
  const openDialog = (d: HTMLDialogElement) => {
    coverPreview(true);
    d.showModal();
    d.addEventListener("close", () => coverPreview(false), { once: true });
  };
  let timeline: TimelineApi | null = null;
  let params: ParamApi | null = null;
  /** プレビューを出しているエリアの要素(プレビューの子WebViewは1つなので、最初に開いたエリアだけが持つ) */
  const [previewEl, setPreviewEl] = createSignal<HTMLDivElement | null>(null);
  let areas: AreasApi | null = null;
  /** ワークスペース(作品ごと)。layoutNow は切り替えたときだけ変える(ドラッグのたびに配置を入れ直さない) */
  const [wsSet, setWsSet] = createSignal<WorkspaceSet>(loadWorkspaces(null));
  const [layoutNow, setLayoutNow] = createSignal<AreasLayout>(wsSet().list[wsSet().active].layout);
  const switchWorkspace = (i: number) => {
    const ws = { ...wsSet(), active: i };
    setWsSet(ws);
    saveWorkspaces(work(), ws);
    setLayoutNow(ws.list[i].layout);
  };
  const changeLayout = (layout: AreasLayout) => {
    const ws = wsSet();
    const list = ws.list.map((w, i) => (i === ws.active ? { ...w, layout } : w));
    setWsSet({ ...ws, list });
    saveWorkspaces(work(), { ...ws, list });
  };
  const addWorkspace = () => {
    const ws = wsSet();
    const name = prompt("新しいワークスペースの名前(今の配置を写して作る)", `${ws.list[ws.active].name} 2`);
    if (!name) return;
    const list = [...ws.list, { name, layout: structuredClone(ws.list[ws.active].layout) }];
    setWsSet({ ...ws, list });
    switchWorkspace(list.length - 1);
  };
  const renameWorkspace = (i: number) => {
    const ws = wsSet();
    const name = prompt("ワークスペースの名前", ws.list[i].name);
    if (!name) return;
    const next = { ...ws, list: ws.list.map((w, k) => (k === i ? { ...w, name } : w)) };
    setWsSet(next);
    saveWorkspaces(work(), next);
  };
  const removeWorkspace = (i: number) => {
    const ws = wsSet();
    if (ws.list.length <= 1 || !confirm(`ワークスペース「${ws.list[i].name}」を消しますか`)) return;
    const list = ws.list.filter((_, k) => k !== i);
    const active = Math.min(ws.active > i ? ws.active - 1 : ws.active, list.length - 1);
    setWsSet({ active, list });
    saveWorkspaces(work(), { active, list });
    setLayoutNow(list[active].layout);
  };
  let newDialog!: HTMLDialogElement;
  let bulkDialog!: HTMLDialogElement;
  let layerDialog!: HTMLDialogElement;
  let exportDialog!: HTMLDialogElement;
  let queueDialog!: HTMLDialogElement;
  const [exportOpen, setExportOpen] = createSignal(false);
  const [queue, setQueue] = createSignal<QueueItem[]>([]);
  /** 書き出し中のジョブの進み具合(ジョブid → 描いたフレーム数) */
  /** プレビューキャッシュの揃っている区間 */
  const [cached, setCached] = createSignal<[number, number][]>([]);
  /** project.json が参照しているのに見つからない素材 */
  const [missing, setMissing] = createSignal<{ place: string; path: string; candidates: string[] }[]>([]);
  const [progress, setProgress] = createSignal<Record<string, number>>({});

  const refresh = async () => {
    const s: any = await invoke("get_state");
    setWorks(s.works);
    setTemplates(s.templates);
    setWork(s.work);
    setWorkspace(s.workspace);
    setTime(s.time);
    setLogs(s.logs);
    setProject(s.project);
    setDecls(s.declarations ?? {});
    setMissing(s.missingAssets ?? []);
  };

  const addLog = (l: Log) => {
    setLogs((v) => [...v.slice(-300), l]);
    queueMicrotask(() => document.querySelectorAll<HTMLElement>(".console").forEach((c) => (c.scrollTop = c.scrollHeight)));
  };
  const fail = (e: unknown) => addLog({ source: "ui", level: "error", message: String(e), unixMs: Date.now() });

  const edit = async (op: Record<string, unknown>) => {
    try {
      const r: any = await invoke("edit_project", { op });
      setStatus(r?.label ?? "");
      await refresh();
      return r;
    } catch (e) {
      fail(e);
    }
  };

  // 再生中は受け取った時刻とUNIX時刻の差で補間して表示する
  const currentFrame = () => {
    const t = time();
    now();
    let f = t.frame + (t.playing ? ((Date.now() - t.unixMs) / 1000) * t.fps : 0);
    // 再生中はループ範囲(なければ尺全体)で折り返す。Rustの時計と同じ規則
    if (t.playing && t.loopStart != null && t.loopEnd != null && t.loopEnd > t.loopStart && f >= t.loopEnd) f = t.loopStart + ((f - t.loopStart) % (t.loopEnd - t.loopStart));
    if (t.duration > 0) f = ((f % t.duration) + t.duration) % t.duration;
    return Math.floor(f + 1e-6);
  };

  /** 時刻の表示(クリックで フレーム → タイムコード →(NTSC系なら)ドロップしないタイムコード → 秒) */
  const [display, setDisplay] = createSignal<TimeDisplay>(((): TimeDisplay => {
    try {
      return (localStorage.getItem("timeDisplay") as TimeDisplay) || "frames";
    } catch {
      return "frames";
    }
  })());
  const fpsRatio = (): [number, number] => (project()?.fps as [number, number]) ?? time().fpsRatio ?? [30, 1];
  const nextDisplay = () => {
    const order: TimeDisplay[] = isNtsc(fpsRatio()) ? ["frames", "timecode", "timecodeNdf", "seconds"] : ["frames", "timecode", "seconds"];
    const n = order[(order.indexOf(display()) + 1) % order.length] ?? "frames";
    setDisplay(n);
    try {
      localStorage.setItem("timeDisplay", n);
    } catch {}
  };
  const showTime = (f: number) => {
    const d = display();
    if (d === "timecode") return smpte(f, fpsRatio(), true);
    if (d === "timecodeNdf") return smpte(f, fpsRatio(), false);
    if (d === "seconds") return fmtTime(f);
    return String(f);
  };
  const displayName = () => ({ frames: "フレーム", timecode: isNtsc(fpsRatio()) ? "タイムコード(ドロップフレーム)" : "タイムコード", timecodeNdf: "タイムコード(ノンドロップ)", seconds: "秒" })[display()];
  let seamDialog!: HTMLDialogElement;
  const [seamOpen, setSeamOpen] = createSignal(false);
  const openSeam = () => {
    setSeamOpen(true);
    openDialog(seamDialog);
    seamDialog.addEventListener("close", () => setSeamOpen(false), { once: true });
  };
  /** ループ範囲を打つ(B: 開始、N: 終了。AEの作業範囲と同じキー) */
  const setLoopAt = (which: "start" | "end") => {
    const f = currentFrame();
    const p = project();
    if (!p) return;
    const cur = (p as any).loop as { start: number; end: number } | undefined;
    let start = cur?.start ?? 0, end = cur?.end ?? p.duration;
    if (which === "start") start = f;
    else end = f + 1;
    if (end <= start) which === "start" ? (end = p.duration) : (start = 0);
    edit({ op: "setLoop", start, end });
  };

  const reportRect = () => {
    const el = previewEl();
    if (!el) return;
    const r = el.getBoundingClientRect();
    invoke("set_preview_rect", { rect: { x: r.x, y: r.y, w: r.width, h: r.height } });
  };

  const seek = (frame: number, scrub = false) => invoke("seek", { frame, scrub });
  const togglePlay = () => invoke("play", { playing: !time().playing });

  onMount(async () => {
    const un = await Promise.all([
      listen<TimeMsg>("sb:time", (e) => setTime(e.payload)),
      listen<Log>("sb:log", (e) => {
        addLog(e.payload);
        // スケッチを読み込み直すと宣言(tracks)が変わることがある
        if (/を読み込んだ/.test(e.payload.message)) refresh();
      }),
      listen<ExportMsg>("sb:export", (e) => {
        setExp(e.payload);
        if (e.payload.id && e.payload.done != null) setProgress((m) => ({ ...m, [e.payload.id]: e.payload.done! }));
      }),
      listen<{ items: QueueItem[] }>("sb:queue", (e) => setQueue(e.payload.items)),
      listen<{ ranges: [number, number][] }>("sb:cache", (e) => setCached(e.payload.ranges)),
      listen("sb:reload", () => refresh()),
      // CC割り当ての学習: 選んだparamに、次に動かしたコントローラーを割り当てる
      listen<{ type: string; channel: number; controller: number }>("sb:midi", (e) => {
        const target = learn();
        if (!target || e.payload.type !== "cc") return;
        setLearn(null);
        const [layer, param] = target.split(".");
        const sketch = project()?.layers.find((l) => l.id === layer)?.sketch ?? "";
        const d = decls()?.[sketch]?.params?.[param] ?? {};
        const cur = { ...((project() as any)?.ccMap ?? {}) };
        cur[target] = { cc: e.payload.controller, channel: e.payload.channel, min: d.min ?? 0, max: d.max ?? 1 };
        edit({ op: "setCcMap", ccMap: cur });
      }),
    ]);
    onCleanup(() => un.forEach((f) => f()));
    invoke<{ items: QueueItem[] }>("queue_list").then((q) => setQueue(q.items), () => {});
    const first: any = await invoke("get_state");
    await refresh();
    // 起動時は --open で指定した作品、なければ前回開いていた作品(と位置)、それもなければ一覧の先頭を開く
    const last = first.session?.work && works().includes(first.session.work) ? first.session.work : null;
    const initial = first.initialWork && works().includes(first.initialWork) ? first.initialWork : last ?? works()[0];
    if (!work() && initial) {
      await open(initial);
      if (initial === last && first.session.frame > 0) seek(first.session.frame);
    }
    if (first.crashed) setStatus("前回は正常に終了しませんでした。最後に開いていた作品を開いています。変更はその都度保存され、「履歴」からも戻せます。");


    let raf = 0;
    const loop = () => {
      setNow(performance.now());
      raf = requestAnimationFrame(loop);
    };
    loop();
    onCleanup(() => cancelAnimationFrame(raf));

    // ショートカット。プレビュー(別のWebView)で押されたキーもRust経由でここに届く
    const shortcut = (k: KeyMsg) => {
      // Ctrl+Space: カーソル下のエリアを最大化・復帰(Blenderと同じ)
      if (k.ctrl && (k.code === "Space" || k.key === " ")) {
        areas?.toggleMaximize();
        return true;
      }
      if (params?.key(k)) return true;
      if (timeline?.key(k)) return true;
      if (k.ctrl && (k.key === "z" || k.key === "Z")) {
        invoke(k.shift ? "redo" : "undo").then((r: any) => setStatus(`${k.shift ? "やり直し" : "取り消し"}: ${r.label}`), fail).then(refresh);
      } else if (k.ctrl && (k.key === "y" || k.key === "Y")) {
        invoke("redo").then((r: any) => setStatus(`やり直し: ${r.label}`), fail).then(refresh);
      } else if (k.code === "Space" || k.key === " ") togglePlay();
      else if (k.key === "ArrowLeft" || k.key === "ArrowRight") seek(currentFrame() + (k.key === "ArrowLeft" ? -1 : 1) * (k.shift ? 10 : 1), true);
      else if (k.key === "Home") seek(0);
      else if ((k.key === "b" || k.key === "B") && !k.ctrl) setLoopAt("start");
      else if ((k.key === "n" || k.key === "N") && !k.ctrl) setLoopAt("end");
      else return false;
      return true;
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, select, textarea, dialog, .cm-editor")) return;
      if (shortcut({ code: e.code, key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey })) e.preventDefault();
    };
    addEventListener("keydown", onKey);
    onCleanup(() => removeEventListener("keydown", onKey));
    const unKey = await listen<KeyMsg>("sb:key", (e) => shortcut({ ...e.payload, ctrl: !!e.payload.ctrl }));
    onCleanup(unKey);
  });

  // 子WebViewはUIの上に重なる別のネイティブ領域なので、プレビューのエリアの矩形をRustへ送って合わせる。
  // 大きさが変わっている間は位置合わせが1〜2フレーム遅れて隙間が見えるため隠す(フェーズ0の結果)。
  // プレビューのエリアがなければ隠す
  createEffect(() => {
    const el = previewEl();
    if (!el) {
      invoke("set_preview_hidden", { hidden: true }).catch(() => {});
      return;
    }
    if (covered === 0) invoke("set_preview_hidden", { hidden: false }).catch(() => {});
    let resizeTimer = 0;
    let hidden = false;
    const ro = new ResizeObserver(() => {
      reportRect();
      if (!hidden) {
        hidden = true;
        coverPreview(true);
      }
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        hidden = false;
        reportRect();
        coverPreview(false);
      }, 150);
    });
    ro.observe(el);
    reportRect();
    onCleanup(() => {
      ro.disconnect();
      clearTimeout(resizeTimer);
    });
  });

  const open = async (w: string) => {
    try {
      await invoke("open_work", { work: w });
      // 作品ごとのワークスペース
      const ws = loadWorkspaces(w);
      setWsSet(ws);
      setLayoutNow(ws.list[ws.active].layout);
      loadHistory();
      setCached([]);
      setSelection(null);
      await refresh();
      reportRect();
    } catch (e) {
      fail(e);
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
      fail(e);
    }
  };

  const openExport = () => {
    setExportOpen(true);
    openDialog(exportDialog);
    exportDialog.addEventListener("close", () => setExportOpen(false), { once: true });
  };
  const pending = () => queue().filter((q) => q.state === "waiting" || q.state === "running").length;

  const fmtTime = (f: number) => {
    const s = f / time().fps;
    const m = Math.floor(s / 60);
    return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
  };

  createEffect(() => {
    const s = selection();
    const p = project();
    const clip = s && p ? p.layers.find((l) => l.id === s.layer)?.tracks?.[s.track]?.[s.id] ?? null : null;
    invoke("set_ui_context", { context: { work: work(), selection: s ? { ...s, clip } : null } }).catch(() => {});
  });
  createEffect(() => {
    const t = time();
    if (!t.playing) invoke("set_ui_context", { context: { work: work(), frame: Math.floor(t.frame), seconds: t.frame / t.fps, playing: false } }).catch(() => {});
    else invoke("set_ui_context", { context: { playing: true } }).catch(() => {});
  });

  const loadHistory = async () => {
    try {
      const r: any = await invoke("list_history");
      setHistory(r.history);
    } catch (e) {
      setHistory([]);
    }
  };
  const openHistory = async () => {
    await loadHistory();
    if (!historyDialog.open) openDialog(historyDialog);
  };

  const restore = async (commit: string) => {
    try {
      await invoke("restore_history", { commit });
      setStatus(`${commit} の状態に戻した(戻す前の状態も履歴に残っている)`);
      if (historyDialog.open) historyDialog.close();
      await refresh();
      loadHistory();
    } catch (e) {
      fail(e);
    }
  };

  /** CCを割り当てられる数値のparams("レイヤー.名前") */
  const numericParams = createMemo(() => {
    const p = project();
    if (!p) return [] as string[];
    return p.layers.flatMap((l) => Object.entries<any>(decls()?.[l.sketch]?.params ?? {}).filter(([, d]) => d?.type === "float" || d?.type === "int").map(([n]) => `${l.id}.${n}`));
  });

  const openMidi = async () => {
    if (!midiDialog.open) openDialog(midiDialog);
    try {
      const r: any = await invoke("midi_connect");
      setMidiPorts(r.ports);
      setRecording(r.recording);
    } catch (e) {
      setMidiPorts([]);
      fail(e);
    }
  };

  const toggleRecord = async () => {
    try {
      const r: any = await invoke("midi_record", { on: !recording() });
      setRecording(r.recording);
      if (!r.recording && r.file) {
        // 録音ファイルをまだ持たないCC割り当てに結び付ける(書き出しはこの値を使う)
        const cur: Record<string, any> = { ...((project() as any)?.ccMap ?? {}) };
        let n = 0;
        for (const k of Object.keys(cur)) if (!cur[k].source) { cur[k] = { ...cur[k], source: r.file }; n++; }
        if (n) await edit({ op: "setCcMap", ccMap: cur });
        setStatus(`録音した: ${r.file}${n ? `(CC割り当て${n}件に結び付けた)` : ""}`);
      }
    } catch (e) {
      fail(e);
    }
  };

  /** クリップトラック(レイヤーと宣言の組)の一覧。一括入力の行き先に使う */
  const clipTracks = createMemo(() => {
    const p = project();
    if (!p) return [];
    return p.layers.flatMap((l) => Object.entries<any>(decls()?.[l.sketch]?.tracks ?? {}).map(([track, decl]) => ({ layer: l.id, track, decl })));
  });

  const selectedClip = createMemo(() => {
    const s = selection();
    const p = project();
    if (!s || !p) return null;
    const c = p.layers.find((l) => l.id === s.layer)?.tracks?.[s.track]?.[s.id];
    const decl = clipTracks().find((t) => t.layer === s.layer && t.track === s.track)?.decl;
    return c && decl ? { sel: s, clip: c, decl } : null;
  });

  // 一括入力: 改行区切りの各行を1クリップにする。長さを決めて並べるか、再生しながらKで区切る
  const bulk = async (ev: SubmitEvent) => {
    ev.preventDefault();
    const fd = new FormData(ev.target as HTMLFormElement);
    const [layer, track] = String(fd.get("target")).split("|");
    const t = clipTracks().find((x) => x.layer === layer && x.track === track);
    if (!t) return;
    const field = Object.keys(t.decl.fields).find((k) => t.decl.fields[k] === "text") ?? Object.keys(t.decl.fields)[0];
    const lines = String(fd.get("lines")).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    bulkDialog.close();
    if (fd.get("mode") === "tap") {
      timeline?.startTap(lines, layer, track, field);
      return;
    }
    const p = project()!;
    const per = p.bpm ? (60 / p.bpm) * (p.fps[0] / p.fps[1]) : p.fps[0] / p.fps[1];
    const len = Math.max(1, Math.round(per * Number(fd.get("length") || 1)));
    const start = currentFrame();
    const clips = lines.map((line, i) => ({ start: start + i * len, end: start + (i + 1) * len, value: { [field]: line } }));
    await edit({ op: "addClips", layer, track, clips });
  };

  const historyList = () => (
    <Show when={history().length > 0} fallback={<p class="hint">まだ履歴がありません。変更すると自動でコミットされます(MCPはツール呼び出しごと、直接の編集とUIの操作は5秒止まったら)。</p>}>
      <ul>
        <For each={history()}>
          {(h) => (
            <li>
              <Show when={h.thumb} fallback={<div class="thumb empty" />}>
                <img class="thumb" src={`http://sb.localhost${h.thumb}`} alt="" loading="lazy" />
              </Show>
              <div class="meta">
                <div>{h.message.replace(/^[^:]+: /, "")}</div>
                <div class="hint">{h.commit} ・ {h.author} ・ {new Date(h.date).toLocaleString()}</div>
              </div>
              <button onClick={() => restore(h.commit)}>この状態に戻す</button>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );

  /** エリアに置くエディタ(エリアの左上のメニューで選ぶ) */
  const editorFor = (tag: EditorTag) => {
    switch (tag) {
      case "preview":
        return <PreviewPane />;
      case "timeline":
        return (
          <div class="timeline-wrap">
            <Show when={project() && work()} fallback={<div class="hint">作品を開くとタイムラインが出ます。</div>}>
              <Timeline work={work()!} project={project()!} decls={decls()} frame={currentFrame} playing={() => time().playing} cached={cached}
                selection={selection} select={setSelection} seek={(f, scrub) => seek(f, scrub)} edit={edit} status={setStatus} api={(a) => (timeline = a)} />
            </Show>
          </div>
        );
      case "params":
        return (
          <div class="side">
            <Show when={project()}>
              {(p) => <ParamPanel project={p()} decls={decls()} frame={currentFrame} edit={edit} status={setStatus} api={(a) => (params = a)} />}
            </Show>
            <Inspector item={selectedClip()} edit={edit} />
          </div>
        );
      case "console":
        return (
          <div class="console" aria-live="polite">
            <Show when={logs().length === 0}><div class="row src">ログはまだありません。スケッチの変換エラーや実行時の例外はここに出ます。</div></Show>
            <For each={logs()}>{(l) => <div class={`row ${l.level}`}><span class="src">{l.source}</span>{l.message}</div>}</For>
          </div>
        );
      case "history":
        loadHistory();
        return <div class="history pane">{historyList()}</div>;
      case "export":
        return (
          <div class="pane">
            <div class="actions" style={{ "justify-content": "flex-start" }}>
              <button onClick={openExport} disabled={!work()}>書き出しの設定</button>
            </div>
            <QueueList items={queue()} progress={progress()} close={() => {}} fail={fail} />
          </div>
        );
      case "graph":
        return (
          <Show when={project()} fallback={<div class="hint">作品を開くとキーフレームのカーブが出ます。</div>}>
            {(p) => <GraphEditor project={p()} decls={decls()} frame={currentFrame} seek={(f) => seek(f, true)} edit={edit} status={setStatus} />}
          </Show>
        );
      case "code":
        return (
          <Show when={work()} keyed fallback={<div class="hint">作品を開くとコードを編集できます。</div>}>
            {(w) => <CodeEditor work={w} preferred={project()?.layers[0]?.sketch} status={setStatus} fail={fail} />}
          </Show>
        );
      default:
        return <div class="hint">{EDITOR_NAMES[tag]}は次の段階で入れます。</div>;
    }
  };

  /** プレビューのエリア。子WebViewは1つなので、2つ目からは案内だけ出す */
  function PreviewPane() {
    let el!: HTMLDivElement;
    const [mine, setMine] = createSignal(false);
    onMount(() => {
      if (!previewEl()) {
        setPreviewEl(el);
        setMine(true);
      }
    });
    onCleanup(() => {
      if (previewEl() === el) setPreviewEl(null);
    });
    return (
      <div class="preview" ref={el}>
        <Show when={mine()} fallback={<div class="empty">プレビューはほかのエリアに出ています(プレビューは1つだけ置けます)。</div>}>
          <Show when={still()}>{(u) => <img class="still" src={u()} alt="" />}</Show>
          <Show when={!work()}>
            <div class="empty">
              作品がありません。「新規」でテンプレートから作るか、<br />
              {workspace()}\works\ にフォルダを置いてください。
            </div>
          </Show>
        </Show>
      </div>
    );
  }

  return (
    <div class="app">
      <div class="bar">
        <select aria-label="作品" value={work() ?? ""} onChange={(e) => open(e.currentTarget.value)}>
          <Show when={!work()}><option value="">作品を選ぶ</option></Show>
          <For each={works()}>{(w) => <option value={w}>{w}</option>}</For>
        </select>
        <button onClick={() => openDialog(newDialog)}>新規</button>
        <button onClick={togglePlay} disabled={!work()} aria-label={time().playing ? "一時停止" : "再生"}>
          {time().playing ? "一時停止" : "再生"}
        </button>
        <span class="time">
          <button class="tc" onClick={nextDisplay} title={`表示: ${displayName()}(クリックで切り替え)`}>{showTime(currentFrame())}</button>
          {" "}/ {showTime(time().duration)} ・ {time().fps.toFixed(3).replace(/\.?0+$/, "")} fps
        </span>
        <Show when={(project() as any)?.loop}>
          {(l) => (
            <span class="loop-chip" title="ループ範囲(B で開始、N で終了を再生ヘッドに)">
              ループ {showTime(l().start)}〜{showTime(l().end)}
              <button onClick={openSeam} title="ループの最後と最初のフレームのつながりを見る">継ぎ目</button>
              <button onClick={() => edit({ op: "setLoop", start: null, end: null })} aria-label="ループ範囲を外す">✕</button>
            </span>
          )}
        </Show>
        <Show when={project()}>
          {(p) => (
            <label class="tempo">BPM
              <input type="number" min="1" max="400" step="0.01" value={p().bpm ?? ""} placeholder="なし" aria-label="BPM"
                onChange={(e) => edit({ op: "setTempo", bpm: e.currentTarget.value ? Number(e.currentTarget.value) : null, beatOffset: p().beatOffset ?? 0 })} />
              <button title="再生ヘッドの位置を拍0(小節の頭)にする" disabled={!p().bpm} onClick={() => edit({ op: "setTempo", bpm: p().bpm, beatOffset: currentFrame() })}>ここを1拍目に</button>
            </label>
          )}
        </Show>
        <button onClick={openHistory} disabled={!work()}>履歴</button>
        <button onClick={openMidi}>MIDI</button>
        <Show when={recording()}><span class="rec" title="MIDIを録音している(再生中の入力だけを記録)">● 録音中</span></Show>
        <button onClick={() => openDialog(layerDialog)} disabled={!work()} title="作品の中のスケッチを1つ選んでレイヤーにする(一番上に重なる)">レイヤー追加</button>
        <button onClick={() => openDialog(bulkDialog)} disabled={clipTracks().length === 0} title="改行区切りのテキストをクリップにする">一括入力</button>
        <span class="spacer" />
        <ExportState exp={exp()} />
        <button onClick={openExport} disabled={!work()}>書き出し</button>
        <button onClick={() => openDialog(queueDialog)} title="書き出しの順番待ちと結果">キュー{pending() ? `(${pending()})` : ""}</button>
        <Show when={missing().length > 0}>
          <div class="missing" role="alert">
            <For each={missing()}>
              {(m) => (
                <div>
                  見つからない素材: <b>{m.path}</b>({m.place})
                  <For each={m.candidates}>
                    {(c) => <button onClick={() => edit({ op: "relinkAsset", from: m.path, to: c })} title="作品の中の同じ名前のファイルに付け替える">{c} に付け替える</button>}
                  </For>
                  <button onClick={async () => {
                    try {
                      const r: any = await invoke("relink_pick", { from: m.path });
                      if (r?.to) await edit({ op: "relinkAsset", from: m.path, to: r.to });
                    } catch (e) {
                      fail(e);
                    }
                  }} title="選んだファイルを作品の assets/ に写して付け替える">ファイルを選ぶ</button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
      <div class="ws-tabs" role="tablist" aria-label="ワークスペース">
        <For each={wsSet().list}>
          {(w, i) => (
            <button role="tab" aria-selected={i() === wsSet().active} class={i() === wsSet().active ? "on" : ""}
              onClick={() => switchWorkspace(i())} onDblClick={() => renameWorkspace(i())}
              onContextMenu={(e) => { e.preventDefault(); removeWorkspace(i()); }}
              title="クリックで切り替え / ダブルクリックで名前を変える / 右クリックで消す">{w.name}</button>
          )}
        </For>
        <button onClick={addWorkspace} title="今の配置を写して新しいワークスペースを作る" aria-label="ワークスペースを足す">+</button>
        <span class="spacer" />
        <button onClick={() => { saveAsDefault(wsSet()); setStatus("今のワークスペースを、新しく開く作品の初期設定にした"); }} title="新しく開く作品の既定の配置にする">初期設定として保存</button>
      </div>
      <Areas layout={layoutNow} onChange={changeLayout} editor={editorFor} cover={coverPreview} api={(a) => (areas = a)} />
      <div class="status" aria-live="polite">{status() || "クリック: シーク / ダブルクリック: クリップやマーカーを追加 / ドラッグ: 移動・伸縮(Shiftで吸着なし) / S: 分割 / Delete: 削除 / B・N: ループの開始・終了 / Ctrl+Space: エリアの最大化 / Ctrl+Z: 取り消し / ホイール: 拡大縮小"}</div>
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
          <div class="actions">
            <button type="button" onClick={() => newDialog.close()}>やめる</button>
            <button type="submit">作る</button>
          </div>
        </form>
      </dialog>
      <dialog ref={midiDialog}>
        <div class="midi">
          <h3>MIDI入力</h3>
          <Show when={midiPorts()} fallback={<p class="hint">入力ポートを開いています…</p>}>
            {(ports) => (
              <Show when={ports().length > 0} fallback={<p class="hint">MIDI入力が見つかりません。機器をつないで「開き直す」を押してください。</p>}>
                <ul><For each={ports()}>{(n) => <li>{n}</li>}</For></ul>
              </Show>
            )}
          </Show>
          <div class="actions" style={{ "justify-content": "flex-start" }}>
            <button onClick={openMidi}>開き直す</button>
            <button onClick={toggleRecord} disabled={!work()}>{recording() ? "録音を止める" : "録音する"}</button>
          </div>
          <p class="hint">録音は再生中に届いた入力だけを作品の時刻と一緒に記録し、assets/recordings/ に .mid として保存します。</p>
          <h3>CC割り当て</h3>
          <Show when={numericParams().length > 0} fallback={<p class="hint">割り当てられる数値のparamsがありません。</p>}>
            <table>
              <tbody>
                <For each={numericParams()}>
                  {(k) => {
                    const m = () => (project() as any)?.ccMap?.[k];
                    return (
                      <tr>
                        <td>{k}</td>
                        <td>{m() ? `CC ${m().cc} ch ${m().channel ?? "*"}${m().source ? " ・ 録音あり" : ""}` : "なし"}</td>
                        <td><button onClick={() => setLearn(learn() === k ? null : k)}>{learn() === k ? "動かして…" : "学習"}</button></td>
                        <td><button disabled={!m()} onClick={() => { const cur = { ...((project() as any)?.ccMap ?? {}) }; delete cur[k]; edit({ op: "setCcMap", ccMap: cur }); }}>外す</button></td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </Show>
          <div class="actions"><button onClick={() => { setLearn(null); midiDialog.close(); }}>閉じる</button></div>
        </div>
      </dialog>
      <dialog ref={historyDialog}>
        <div class="history">
          <h3>履歴({work()})</h3>
          {historyList()}
          <div class="actions"><button onClick={() => historyDialog.close()}>閉じる</button></div>
        </div>
      </dialog>
      <dialog ref={exportDialog}>
        <Show when={exportOpen() && work() && project()}>
          <ExportForm work={work()!} project={project()!} close={() => exportDialog.close()} fail={fail}
            added={(n) => setStatus(`キューに${n}件積んだ。「キュー」で進み具合を見られます`)} />
        </Show>
      </dialog>
      <dialog ref={queueDialog}>
        <QueueList items={queue()} progress={progress()} close={() => queueDialog.close()} fail={fail} />
      </dialog>
      <dialog ref={seamDialog}>
        <Show when={seamOpen() && (project() as any)?.loop}>
          {(l) => <SeamView start={l().start} end={l().end} label={showTime} close={() => seamDialog.close()} />}
        </Show>
      </dialog>
      <dialog ref={layerDialog}>
        <form onSubmit={(ev) => { ev.preventDefault(); const fd = new FormData(ev.currentTarget); layerDialog.close(); edit({ op: "addLayer", sketch: String(fd.get("sketch")) }); }}>
          <label>スケッチ
            <select name="sketch">
              <For each={[...new Set([...(project()?.layers.map((l) => l.sketch) ?? []), ...Object.keys(decls())])]}>{(sk) => <option value={sk}>{sk}</option>}</For>
            </select>
          </label>
          <p class="hint">新しいスケッチはエージェント(MCPの add_sketch)か、works/{work()}/sketches/ にフォルダを置いて作ります。</p>
          <div class="actions">
            <button type="button" onClick={() => layerDialog.close()}>やめる</button>
            <button type="submit">追加</button>
          </div>
        </form>
      </dialog>
      <dialog ref={bulkDialog}>
        <form onSubmit={bulk}>
          <label>入れる先
            <select name="target">
              <For each={clipTracks()}>{(t) => <option value={`${t.layer}|${t.track}`}>{t.layer} {t.track}</option>}</For>
            </select>
          </label>
          <label>テキスト(1行が1クリップ)
            <textarea name="lines" rows="8" required placeholder="1行目&#10;2行目&#10;3行目" />
          </label>
          <fieldset>
            <label><input type="radio" name="mode" value="fixed" checked /> 再生ヘッドから並べる。長さ
              <input type="number" name="length" value="1" min="0.25" step="0.25" style={{ width: "5em" }} /> 拍(BPMがなければ秒)</label>
            <label><input type="radio" name="mode" value="tap" /> 再生しながら K キーで区切る(Escで確定)</label>
          </fieldset>
          <div class="actions">
            <button type="button" onClick={() => bulkDialog.close()}>やめる</button>
            <button type="submit">入れる</button>
          </div>
        </form>
      </dialog>
    </div>
  );
}

function Inspector(props: { item: { sel: Selection; clip: any; decl: any } | null; edit: (op: Record<string, unknown>) => Promise<any> }) {
  return (
    <div class="inspector">
      <Show when={props.item} fallback={<div class="hint">クリップを選ぶと、ここでフィールドを編集できます。</div>}>
        {(it) => {
          const set = (field: string, value: unknown) =>
            props.edit({ op: "updateClip", layer: it().sel.layer, track: it().sel.track, id: it().sel.id, value: { [field]: value } });
          return (
            <div class="fields">
              <div class="hint">{it().sel.layer} {it().sel.track} ・ {it().clip.start}〜{it().clip.end} f</div>
              <For each={Object.entries<string>(it().decl.fields)}>
                {([name, type]) => (
                  <label>{name}
                    {type === "color" ? (
                      <input type="color" value={String(it().clip.value?.[name] ?? "#ffffff")} onChange={(e) => set(name, e.currentTarget.value)} />
                    ) : type === "bool" ? (
                      <input type="checkbox" checked={!!it().clip.value?.[name]} onChange={(e) => set(name, e.currentTarget.checked)} />
                    ) : type === "float" || type === "int" ? (
                      <input type="number" step={type === "int" ? 1 : 0.01} value={Number(it().clip.value?.[name] ?? 0)} onChange={(e) => set(name, Number(e.currentTarget.value))} />
                    ) : (
                      <input type="text" value={String(it().clip.value?.[name] ?? "")} onChange={(e) => set(name, e.currentTarget.value)} />
                    )}
                  </label>
                )}
              </For>
            </div>
          );
        }}
      </Show>
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
