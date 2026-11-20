import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Timeline, type Selection, type TimelineApi } from "./Timeline";
import type { ProjectLike } from "./timeline-model";
import { ParamPanel, type ParamApi } from "./ParamPanel";
import { ExportForm, QueueList, type QueueItem } from "./ExportUi";

type TimeMsg = { frame: number; playing: boolean; fps: number; duration: number; unixMs: number; audio?: boolean };
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
      invoke("set_preview_hidden", { hidden: false });
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
  let previewEl!: HTMLDivElement;
  let consoleEl!: HTMLDivElement;
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
  };

  const addLog = (l: Log) => {
    setLogs((v) => [...v.slice(-300), l]);
    queueMicrotask(() => (consoleEl.scrollTop = consoleEl.scrollHeight));
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
    if (t.duration > 0) f = ((f % t.duration) + t.duration) % t.duration;
    return Math.floor(f + 1e-6);
  };

  const reportRect = () => {
    const r = previewEl.getBoundingClientRect();
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
        coverPreview(true);
      }
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        hidden = false;
        reportRect();
        coverPreview(false);
      }, 150);
    });
    ro.observe(previewEl);
    reportRect();

    let raf = 0;
    const loop = () => {
      setNow(performance.now());
      raf = requestAnimationFrame(loop);
    };
    loop();
    onCleanup(() => cancelAnimationFrame(raf));

    // ショートカット。プレビュー(別のWebView)で押されたキーもRust経由でここに届く
    const shortcut = (k: KeyMsg) => {
      if (params?.key(k)) return true;
      if (timeline?.key(k)) return true;
      if (k.ctrl && (k.key === "z" || k.key === "Z")) {
        invoke(k.shift ? "redo" : "undo").then((r: any) => setStatus(`${k.shift ? "やり直し" : "取り消し"}: ${r.label}`), fail).then(refresh);
      } else if (k.ctrl && (k.key === "y" || k.key === "Y")) {
        invoke("redo").then((r: any) => setStatus(`やり直し: ${r.label}`), fail).then(refresh);
      } else if (k.code === "Space" || k.key === " ") togglePlay();
      else if (k.key === "ArrowLeft" || k.key === "ArrowRight") seek(currentFrame() + (k.key === "ArrowLeft" ? -1 : 1) * (k.shift ? 10 : 1), true);
      else if (k.key === "Home") seek(0);
      else return false;
      return true;
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, select, textarea, dialog")) return;
      if (shortcut({ code: e.code, key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey })) e.preventDefault();
    };
    addEventListener("keydown", onKey);
    onCleanup(() => removeEventListener("keydown", onKey));
    const unKey = await listen<KeyMsg>("sb:key", (e) => shortcut({ ...e.payload, ctrl: !!e.payload.ctrl }));
    onCleanup(unKey);
  });

  const open = async (w: string) => {
    try {
      await invoke("open_work", { work: w });
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

  const openHistory = async () => {
    try {
      const r: any = await invoke("list_history");
      setHistory(r.history);
    } catch (e) {
      fail(e);
      setHistory([]);
    }
    if (!historyDialog.open) openDialog(historyDialog);
  };

  const restore = async (commit: string) => {
    try {
      await invoke("restore_history", { commit });
      setStatus(`${commit} の状態に戻した(戻す前の状態も履歴に残っている)`);
      historyDialog.close();
      await refresh();
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
          <b>{currentFrame()}</b> / {time().duration} f ・ {fmtTime(currentFrame())} ・ {time().fps.toFixed(3).replace(/\.?0+$/, "")} fps
        </span>
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
      </div>
      <div class="preview" ref={previewEl}>
        <Show when={still()}>{(u) => <img class="still" src={u()} alt="" />}</Show>
        <Show when={!work()}>
          <div class="empty">
            作品がありません。「新規」でテンプレートから作るか、<br />
            {workspace()}\works\ にフォルダを置いてください。
          </div>
        </Show>
      </div>
      <div class="lower">
        <div class="timeline-wrap">
          <Show when={project() && work()} fallback={<div class="hint">作品を開くとタイムラインが出ます。</div>}>
            <Timeline
              work={work()!}
              project={project()!}
              decls={decls()}
              frame={currentFrame}
              playing={() => time().playing}
              cached={cached}
              selection={selection}
              select={setSelection}
              seek={(f, scrub) => seek(f, scrub)}
              edit={edit}
              status={setStatus}
              api={(a) => (timeline = a)}
            />
          </Show>
          <div class="status" aria-live="polite">{status() || "クリック: シーク / ダブルクリック: クリップやマーカーを追加 / ドラッグ: 移動・伸縮(Shiftで吸着なし) / S: 分割 / Delete: 削除 / Ctrl+Z: 取り消し / ホイール: 拡大縮小"}</div>
        </div>
        <div class="side">
          <Show when={project()}>
            {(p) => <ParamPanel project={p()} decls={decls()} frame={currentFrame} edit={edit} status={setStatus} api={(a) => (params = a)} />}
          </Show>
          <Inspector item={selectedClip()} edit={edit} />
        </div>
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
