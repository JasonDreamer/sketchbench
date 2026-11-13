// 書き出しの設定(レンダーキューに積む)と、キューの一覧。
// 解像度は複数選べ、選んだ数だけキューに積む(16:9 と 9:16 などを一度に書き出す)。
import { createSignal, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectLike } from "./timeline-model";

type Size = { key: string; label: string; w: number; h: number };
export type QueueItem = {
  id: string;
  state: "waiting" | "running" | "done" | "failed" | "canceled";
  options: { work: string; format: string; width?: number; height?: number; name?: string; from?: number; to?: number; depth?: number; motionBlur?: { samples: number } };
  job?: string;
  done: number;
  total: number;
  path?: string;
  error?: string;
  elapsed: number;
  loudness?: { before: { lufs: number; truePeakDb: number }; after: { lufs: number; truePeakDb: number }; gainDb: number };
};

const PRESETS: Omit<Size, "key">[] = [
  { label: "4K UHD", w: 3840, h: 2160 },
  { label: "フルHD", w: 1920, h: 1080 },
  { label: "縦 9:16", w: 1080, h: 1920 },
  { label: "正方形", w: 1080, h: 1080 },
];

export function ExportForm(props: { work: string; project: ProjectLike; close: () => void; added: (n: number) => void; fail: (e: unknown) => void }) {
  const [format, setFormat] = createSignal<"mp4" | "png">("mp4");
  const [loud, setLoud] = createSignal<{ lufs?: number; truePeakDb?: number; audio?: boolean } | null>(null);
  const p = () => props.project;
  const own = (): Size => ({ key: "own", label: "作品の設定", w: p().width ?? 1920, h: p().height ?? 1080 });
  const sizes = (): Size[] => [own(), ...PRESETS.filter((s) => s.w !== own().w || s.h !== own().h).map((s) => ({ ...s, key: `${s.w}x${s.h}` }))];
  invoke<any>("measure_loudness").then(setLoud, () => setLoud(null));

  const submit = async (ev: SubmitEvent) => {
    ev.preventDefault();
    const fd = new FormData(ev.currentTarget as HTMLFormElement);
    // 範囲
    let from: number | undefined, to: number | undefined;
    const range = String(fd.get("range"));
    if (range.startsWith("m:")) {
      const m = (p().markers ?? [])[Number(range.slice(2))];
      from = m.start;
      to = m.end ?? p().duration;
    } else if (range === "custom") {
      from = Number(fd.get("from"));
      to = Number(fd.get("to"));
    }
    // 大きさ(選んだ数だけ積む)
    const picked: { w: number; h: number; name?: string }[] = sizes().filter((s) => fd.get(`size-${s.key}`)).map((s) => ({ w: s.w, h: s.h, name: s.key === "own" ? undefined : s.key }));
    const cw = Number(fd.get("cw")), ch = Number(fd.get("ch"));
    if (cw > 0 && ch > 0) picked.push({ w: cw, h: ch, name: `${cw}x${ch}` });
    if (picked.length === 0) return props.fail("書き出す大きさを1つ以上選んでください");
    const samples = Number(fd.get("mb"));
    const motionBlur = samples > 1 ? { samples, shutter: Math.min(360, Math.max(1, Number(fd.get("shutter")) || 180)) / 360 } : undefined;
    const lufs = Number(fd.get("lufs"));
    const items = picked.map((s) => ({
      work: props.work,
      format: format(),
      from,
      to,
      width: s.w,
      height: s.h,
      name: picked.length > 1 ? s.name ?? `${s.w}x${s.h}` : s.name,
      motionBlur,
      ...(format() === "png" ? { depth: Number(fd.get("depth")), alpha: String(fd.get("alpha")) } : {}),
      ...(format() === "mp4" && lufs ? { loudness: { lufs, truePeak: -1 } } : {}),
    }));
    try {
      await invoke("queue_add", { items });
      props.added(items.length);
      props.close();
    } catch (e) {
      props.fail(e);
    }
  };

  return (
    <form class="export-form" onSubmit={submit}>
      <h3>書き出し</h3>
      <fieldset>
        <legend>形式</legend>
        <label><input type="radio" name="format" checked={format() === "mp4"} onChange={() => setFormat("mp4")} /> MP4(H.264、音声付き)</label>
        <label><input type="radio" name="format" checked={format() === "png"} onChange={() => setFormat("png")} /> 連番PNG(アルファ付き)</label>
      </fieldset>
      <label>範囲
        <select name="range">
          <option value="all">全体(0〜{p().duration} f)</option>
          <For each={p().markers ?? []}>{(m, i) => <option value={`m:${i()}`}>マーカー {m.name}({m.start}〜{m.end ?? p().duration} f)</option>}</For>
          <option value="custom">指定する</option>
        </select>
      </label>
      <div class="row">
        <label>開始 <input type="number" name="from" min="0" value="0" /></label>
        <label>終了 <input type="number" name="to" min="1" value={p().duration} /></label>
        <span class="hint">(「指定する」のとき)</span>
      </div>
      <fieldset>
        <legend>大きさ(複数選ぶと、その数だけキューに積む)</legend>
        <For each={sizes()}>
          {(s) => <label><input type="checkbox" name={`size-${s.key}`} checked={s.key === "own"} /> {s.label} {s.w}×{s.h}</label>}
        </For>
        <div class="row">
          <label>ほかの大きさ <input type="number" name="cw" min="16" placeholder="幅" /></label>
          <label>× <input type="number" name="ch" min="16" placeholder="高さ" /></label>
        </div>
      </fieldset>
      <Show when={format() === "png"}>
        <div class="row">
          <label>色深度
            <select name="depth"><option value="8">8bit</option><option value="16">16bit</option></select>
          </label>
          <label>アルファ
            <select name="alpha">
              <option value="straight">ストレート</option>
              <option value="premultiplied">プリマルチプライド</option>
              <option value="none">なし(黒の上に重ねる)</option>
            </select>
          </label>
        </div>
      </Show>
      <div class="row">
        <label>モーションブラー
          <select name="mb"><option value="1">なし</option><option value="4">4サンプル</option><option value="8">8サンプル</option><option value="16">16サンプル</option></select>
        </label>
        <label>シャッター角 <input type="number" name="shutter" min="1" max="360" value="180" /> 度</label>
      </div>
      <p class="hint">モーションブラーは mode: "pure" のスケッチだけにかかります。サンプル数の分だけ書き出しが遅くなります。</p>
      <Show when={format() === "mp4"}>
        <label>音量
          <select name="lufs">
            <option value="0">そのまま</option>
            <option value="-14">-14 LUFS(配信向け)</option>
            <option value="-16">-16 LUFS</option>
            <option value="-23">-23 LUFS(放送向け)</option>
          </select>
        </label>
        <p class="hint">
          <Show when={loud()} fallback="ミックスを測っています…">
            {(l) => (l().audio ? `今のミックス全体: ${l().lufs!.toFixed(1)} LUFS、トゥルーピーク ${l().truePeakDb!.toFixed(1)} dBTP。正規化ではトゥルーピークを -1 dBTP に抑えます。` : "この作品には音声がありません。")}
          </Show>
        </p>
      </Show>
      <div class="actions">
        <button type="button" onClick={props.close}>やめる</button>
        <button type="submit">キューに追加</button>
      </div>
    </form>
  );
}

export function QueueList(props: { items: QueueItem[]; progress: Record<string, number>; close: () => void; fail: (e: unknown) => void }) {
  const STATE = { waiting: "待機", running: "書き出し中", done: "完了", failed: "失敗", canceled: "中止" };
  const size = (it: QueueItem) => (it.options.width ? `${it.options.width}×${it.options.height}` : "作品の大きさ");
  const done = (it: QueueItem) => (it.state === "running" && it.job ? props.progress[it.job] ?? it.done : it.done);
  return (
    <div class="queue">
      <h3>レンダーキュー</h3>
      <Show when={props.items.length > 0} fallback={<p class="hint">キューは空です。「書き出し」から積むと、登録順に1つずつ書き出します。</p>}>
        <ul>
          <For each={props.items}>
            {(it) => (
              <li class={it.state}>
                <div class="meta">
                  <div>
                    <b>{it.options.work}</b> {it.options.format.toUpperCase()} {size(it)}
                    {it.options.name ? ` (${it.options.name})` : ""}
                    {it.options.depth === 16 ? " 16bit" : ""}
                    {it.options.motionBlur ? ` ブラー${it.options.motionBlur.samples}` : ""}
                  </div>
                  <div class="hint">
                    {STATE[it.state]}
                    <Show when={it.total > 0}> {done(it)} / {it.total} f</Show>
                    <Show when={it.elapsed > 0}> ・ {it.elapsed.toFixed(1)}秒</Show>
                    <Show when={it.loudness}>{(l) => ` ・ 音量 ${l().before.lufs.toFixed(1)} → ${l().after.lufs.toFixed(1)} LUFS(${l().after.truePeakDb.toFixed(1)} dBTP)`}</Show>
                    <Show when={it.error}> ・ {it.error}</Show>
                  </div>
                  <Show when={it.state === "running" && it.total > 0}>
                    <progress max={it.total} value={done(it)} />
                  </Show>
                </div>
                <Show when={it.state === "waiting" || it.state === "running"}>
                  <button onClick={() => invoke("queue_cancel", { id: it.id }).catch(props.fail)}>{it.state === "running" ? "止める" : "取り消す"}</button>
                </Show>
                <Show when={it.state === "done" && it.path}>
                  <button onClick={() => invoke("reveal", { path: it.path }).catch(props.fail)}>場所を開く</button>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <div class="actions">
        <button onClick={() => invoke("queue_clear").catch(props.fail)}>終わったものを消す</button>
        <button onClick={props.close}>閉じる</button>
      </div>
    </div>
  );
}
