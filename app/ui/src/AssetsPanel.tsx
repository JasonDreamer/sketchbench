// アセットのエディタ。作品の assets/ の一覧(種類・大きさ・使っている場所)、ウィンドウへのドロップで assets/ に写す、
// 音声は解析の結果(BPM・ビートの数)を見て音声トラックに入れる・外す、MIDI はノートの範囲を見る、イベント対応表(eventMap)を編集する。
import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { ProjectLike } from "./timeline-model";

type Asset = { rel: string; kind: string; size: number; usedBy: string[] };
const SB = "http://sb.localhost";
const KIND: Record<string, string> = { audio: "音声", midi: "MIDI", image: "画像", font: "フォント", video: "動画", data: "データ", other: "その他" };

const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function AssetsPanel(props: { work: string; project: ProjectLike; edit: (op: Record<string, unknown>) => Promise<any>; status: (s: string) => void; fail: (e: unknown) => void }) {
  const [assets, { refetch }] = createResource(async () => (await invoke<{ assets: Asset[] }>("assets_list")).assets);
  const [info, setInfo] = createSignal<Record<string, string>>({});
  const [dropping, setDropping] = createSignal(false);

  /** 音声の解析(なければここで作られる)と、MIDIのノートの範囲を1行にまとめる */
  const describe = async (a: Asset) => {
    if (info()[a.rel]) return;
    setInfo((m) => ({ ...m, [a.rel]: "読んでいます…" }));
    try {
      if (a.kind === "audio") {
        const r = await (await fetch(`${SB}/work/${encodeURIComponent(props.work)}/analysis/${a.rel}`)).json();
        setInfo((m) => ({ ...m, [a.rel]: `${r.duration.toFixed(1)}秒 ・ BPM ${r.bpm ? r.bpm.toFixed(1) : "不明"} ・ ビート ${r.beats.length} ・ オンセット ${r.onsets.length}` }));
      } else if (a.kind === "midi") {
        const r = await (await fetch(`${SB}/work/${encodeURIComponent(props.work)}/midi/${a.rel}`)).json();
        const pitches = (r.notes ?? []).map((n: any) => n.pitch);
        const last = Math.max(0, ...(r.notes ?? []).map((n: any) => n.end));
        setInfo((m) => ({ ...m, [a.rel]: pitches.length ? `ノート ${pitches.length} ・ 音の高さ ${Math.min(...pitches)}〜${Math.max(...pitches)} ・ ${last.toFixed(1)}秒まで` : "ノートなし" }));
      } else setInfo((m) => ({ ...m, [a.rel]: "" }));
    } catch (e) {
      setInfo((m) => ({ ...m, [a.rel]: `読めない: ${e}` }));
    }
  };

  const audio = () => ((props.project as any).audio ?? []) as { asset: string; offset?: number; gain?: number }[];
  const inAudio = (rel: string) => audio().some((x) => x.asset === rel);
  const toggleAudio = (rel: string) =>
    props.edit({ op: "setAudio", audio: inAudio(rel) ? audio().filter((x) => x.asset !== rel) : [...audio(), { asset: rel, offset: 0 }] }).then(refetch);

  // イベント対応表: { 名前: { midi, note?, channel? } | { times } }
  const eventMap = () => ((props.project as any).eventMap ?? {}) as Record<string, any>;
  const setEvent = (name: string, v: any | null, rename?: string) => {
    const m = { ...eventMap() };
    delete m[name];
    if (v) m[rename ?? name] = v;
    return props.edit({ op: "setEventMap", eventMap: m }).then(refetch);
  };
  const addEvent = (midi?: string) => {
    let n = 1;
    while (eventMap()[`event${n}`]) n++;
    return setEvent(`event${n}`, midi ? { midi } : { times: [] });
  };

  onMount(async () => {
    // ファイルをウィンドウにドロップしたら assets/ に写す
    const un = await getCurrentWebview().onDragDropEvent(async (e) => {
      const p = e.payload as { type: string; paths?: string[] };
      if (p.type === "enter" || p.type === "over") setDropping(true);
      else if (p.type === "leave") setDropping(false);
      else if (p.type === "drop") {
        setDropping(false);
        if (!p.paths?.length) return;
        try {
          const r = await invoke<{ imported: string[] }>("assets_import", { paths: p.paths });
          props.status(`assets/ に写した: ${r.imported.join(", ")}`);
          refetch();
        } catch (err) {
          props.fail(err);
        }
      }
    });
    onCleanup(un);
  });

  return (
    <div class={`assets pane${dropping() ? " dropping" : ""}`}>
      <p class="hint">ファイルをウィンドウにドロップすると、作品の assets/ に写します。</p>
      <Show when={(assets() ?? []).length > 0} fallback={<p class="hint">素材はまだありません。</p>}>
        <ul class="asset-list">
          <For each={assets()}>
            {(a) => (
              <li>
                <div class="meta" onMouseEnter={() => describe(a)}>
                  <div><b>{a.rel.replace(/^assets\//, "")}</b> <span class="hint">{KIND[a.kind] ?? a.kind} ・ {size(a.size)}</span></div>
                  <div class="hint">{info()[a.rel] ?? ""}{a.usedBy.length ? ` ・ 使用: ${a.usedBy.join(", ")}` : ""}</div>
                </div>
                <Show when={a.kind === "audio"}>
                  <button onClick={() => toggleAudio(a.rel)}>{inAudio(a.rel) ? "音声トラックから外す" : "音声トラックに入れる"}</button>
                </Show>
                <Show when={a.kind === "midi"}>
                  <button onClick={() => addEvent(a.rel)} title="このMIDIのノートを名前つきのイベントにする">イベントに使う</button>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <h3>イベント対応表</h3>
      <p class="hint">スケッチは events.since("名前", t) などで引きます。ノートの番号を変えてもスケッチは書き換えずに済みます。</p>
      <table class="events">
        <tbody>
          <For each={Object.entries(eventMap())}>
            {([name, v]) => (
              <tr>
                <td><input value={name} aria-label="イベントの名前" onChange={(e) => e.currentTarget.value && e.currentTarget.value !== name && setEvent(name, v, e.currentTarget.value)} /></td>
                <Show when={typeof v.midi === "string"} fallback={
                  <td colSpan={3}><input value={(v.times ?? []).join(", ")} aria-label="時刻(秒、カンマ区切り)" placeholder="時刻(秒、カンマ区切り)"
                    onChange={(e) => setEvent(name, { times: e.currentTarget.value.split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x)) })} /></td>
                }>
                  <td>
                    <select aria-label="MIDIファイル" onChange={(e) => setEvent(name, { ...v, midi: e.currentTarget.value })}>
                      <For each={(assets() ?? []).filter((a) => a.kind === "midi")}>{(a) => <option value={a.rel} selected={a.rel === v.midi}>{a.rel.replace(/^assets\//, "")}</option>}</For>
                    </select>
                  </td>
                  <td><input type="number" min="0" max="127" value={v.note ?? ""} placeholder="ノート(全部)" aria-label="ノート番号"
                    onChange={(e) => setEvent(name, { ...v, note: e.currentTarget.value === "" ? undefined : Number(e.currentTarget.value) })} /></td>
                  <td><input type="number" min="0" max="15" value={v.channel ?? ""} placeholder="ch(全部)" aria-label="チャンネル"
                    onChange={(e) => setEvent(name, { ...v, channel: e.currentTarget.value === "" ? undefined : Number(e.currentTarget.value) })} /></td>
                </Show>
                <td><button onClick={() => setEvent(name, null)} aria-label={`${name} を消す`}>消す</button></td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <div class="actions" style={{ "justify-content": "flex-start" }}>
        <button onClick={() => addEvent()}>時刻で決めるイベントを足す</button>
      </div>
    </div>
  );
}
