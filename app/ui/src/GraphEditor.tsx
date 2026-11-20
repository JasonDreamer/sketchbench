// グラフエディタ。キーフレームのある数値(params の float・int・vec2 の各成分、レイヤーの不透明度・変形)を値のカーブで見せ、
// キーをドラッグして時刻と値を、キーから次のキーまでのイージングを(cubic-bezier のハンドルで)直す。
// 左の一覧で表示するカーブを選ぶ。色はカーブごとに決まった順で付け、一覧と曲線の端に名前を出す(色だけで見分けない)。
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { evaluate, PRESETS } from "../../../packages/runtime/src/keyframes";
import { keysOf, layerFrame, propOf, workFrame, type KeyLike, type LayerLike, type ProjectLike } from "./timeline-model";

/** カテゴリの色(dataviz の参照パレットの暗い背景用。背景 #191a1e で6つの検査を通した) */
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#0ca30c", "#9085e9", "#e66767"];
const EASE_NAMES: Record<string, string> = { linear: "直線", easeIn: "イーズイン", easeOut: "イーズアウト", easeInOut: "イーズインアウト", hold: "保持", custom: "カスタム(ハンドル)" };

/** 1本のカーブ(vec2 は成分ごとに分ける) */
type Channel = {
  id: string;
  label: string;
  layer: string;
  target: { param: string } | { property: string };
  /** 評価の型(float か vec2) */
  type: "float" | "int" | "vec2";
  comp: number | null;
  entry: unknown;
  keys: KeyLike[];
};

type KeySel = { ch: string; frame: number };

export function GraphEditor(props: {
  project: ProjectLike;
  decls: Record<string, any>;
  frame: () => number;
  seek: (f: number) => void;
  edit: (op: Record<string, unknown>) => Promise<any>;
  status: (s: string) => void;
}) {
  let canvas!: HTMLCanvasElement;
  const [shown, setShown] = createSignal<Set<string>>(new Set());
  const [sel, setSel] = createSignal<KeySel | null>(null);
  /** ドラッグ中の仮の値(離したら操作として送る) */
  const [ghost, setGhost] = createSignal<{ ch: string; from: number; frame: number; value: number } | null>(null);
  const [ghostEase, setGhostEase] = createSignal<{ ch: string; frame: number; ease: number[] } | null>(null);
  let drag: { kind: "key"; ch: Channel; from: number } | { kind: "handle"; ch: Channel; frame: number; which: 1 | 2 } | { kind: "seek" } | null = null;

  const layerOf = (id: string): LayerLike | undefined => props.project.layers.find((l) => l.id === id);

  /** キーのある数値のカーブの一覧(並びは作品の順で固定。色はこの並びで決める) */
  const channels = createMemo<Channel[]>(() => {
    const out: Channel[] = [];
    for (const l of props.project.layers) {
      const add = (name: string, target: Channel["target"], entry: unknown, type: string) => {
        const keys = keysOf(entry);
        if (!keys.length) return;
        const raw = (entry as any).value;
        if (type === "vec2" || Array.isArray(raw)) {
          ["x", "y"].forEach((c, i) => out.push({ id: `${l.id}.${name}.${c}`, label: `${l.id}.${name}.${c}`, layer: l.id, target, type: "vec2", comp: i, entry, keys }));
        } else if (type === "float" || type === "int" || typeof raw === "number") {
          out.push({ id: `${l.id}.${name}`, label: `${l.id}.${name}`, layer: l.id, target, type: type === "int" ? "int" : "float", comp: null, entry, keys });
        }
      };
      for (const [name, entry] of Object.entries(l.params ?? {})) add(name, { param: name }, entry, props.decls?.[l.sketch]?.params?.[name]?.type ?? "float");
      for (const prop of ["opacity", "transform.rotation", "transform.scale", "transform.position", "transform.anchor"]) {
        add(prop, { property: prop }, propOf(l, prop), prop === "transform.position" || prop === "transform.anchor" ? "vec2" : "float");
      }
    }
    return out;
  });
  const colorOf = (id: string) => SERIES[Math.max(0, channels().findIndex((c) => c.id === id)) % SERIES.length];
  /** 何も選んでいなければ全部出す */
  const visible = () => {
    const s = shown();
    const list = channels();
    return s.size ? list.filter((c) => s.has(c.id)) : list;
  };
  const toggle = (id: string) =>
    setShown((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const num = (v: unknown, comp: number | null) => Number(comp == null ? v : Array.isArray(v) ? v[comp] : v);
  /** そのカーブの、作品のフレーム f での値(ドラッグ中は仮の値で) */
  const valueAt = (c: Channel, f: number) => {
    const l = layerOf(c.layer)!;
    return num(evaluate(c.type === "vec2" ? "vec2" : "float", entryWithGhost(c), layerFrame(l, f)), c.comp);
  };
  const entryWithGhost = (c: Channel) => {
    const g = ghost(), ge = ghostEase();
    if ((!g || g.ch !== c.id) && (!ge || ge.ch !== c.id)) return c.entry;
    return { ...(c.entry as object), keys: keysWithGhost(c) };
  };
  const keysWithGhost = (c: Channel): KeyLike[] => {
    const g = ghost(), ge = ghostEase();
    let keys = c.keys;
    if (g && g.ch === c.id) keys = keys.filter((k) => k.frame === g.from || k.frame !== g.frame).map((k) => (k.frame === g.from ? { ...k, frame: g.frame, value: withComp(k.value, c.comp, g.value) } : k));
    if (ge && ge.ch === c.id) keys = keys.map((k) => (k.frame === ge.frame ? { ...k, ease: ge.ease } : k));
    return [...keys].sort((a, b) => a.frame - b.frame);
  };
  const withComp = (v: unknown, comp: number | null, x: number): unknown => {
    if (comp == null) return x;
    const a = Array.isArray(v) ? [...v] : [0, 0];
    a[comp] = x;
    return a;
  };

  // 表示の範囲: 横は作品全体、縦は見えているカーブの最小〜最大に余白
  const PAD = { l: 52, r: 16, t: 12, b: 22 };
  /** ドラッグ中は縦の範囲を止める(動かした値で範囲が変わると、つかんだ点がずれていく) */
  let frozen: { lo: number; hi: number } | null = null;
  const view = () => {
    const w = canvas?.clientWidth ?? 600, h = canvas?.clientHeight ?? 300;
    if (frozen) return { w, h, lo: frozen.lo, hi: frozen.hi, dur: props.project.duration };
    let lo = Infinity, hi = -Infinity;
    const step = Math.max(1, Math.floor(props.project.duration / 200));
    for (const c of visible()) {
      for (let f = 0; f <= props.project.duration; f += step) {
        const v = valueAt(c, f);
        if (Number.isFinite(v)) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
      for (const k of keysWithGhost(c)) {
        const v = num(k.value, c.comp);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    if (!Number.isFinite(lo)) (lo = 0), (hi = 1);
    if (hi - lo < 1e-6) (lo -= 0.5), (hi += 0.5);
    const m = (hi - lo) * 0.08;
    return { w, h, lo: lo - m, hi: hi + m, dur: props.project.duration };
  };
  const xOf = (v: ReturnType<typeof view>, f: number) => PAD.l + (f / Math.max(1, v.dur)) * (v.w - PAD.l - PAD.r);
  const fOf = (v: ReturnType<typeof view>, x: number) => ((x - PAD.l) / (v.w - PAD.l - PAD.r)) * v.dur;
  const yOf = (v: ReturnType<typeof view>, val: number) => PAD.t + (1 - (val - v.lo) / (v.hi - v.lo)) * (v.h - PAD.t - PAD.b);
  const valOf = (v: ReturnType<typeof view>, y: number) => v.lo + (1 - (y - PAD.t) / (v.h - PAD.t - PAD.b)) * (v.hi - v.lo);

  /** 選んだキーのイージングを cubic-bezier で(名前つきは対応する値に、保持は null) */
  const bezierOf = (k: KeyLike): number[] | null => {
    if (Array.isArray(k.ease)) return k.ease as number[];
    if (k.ease === "hold") return null;
    return PRESETS[String(k.ease)] ?? [0, 0, 1, 1];
  };

  /** 選んだキーと次のキーの、画面での区間とハンドルの位置 */
  const segment = (v: ReturnType<typeof view>, c: Channel, frame: number) => {
    const keys = keysWithGhost(c);
    const i = keys.findIndex((k) => k.frame === frame);
    if (i < 0 || i + 1 >= keys.length) return null;
    const l = layerOf(c.layer)!;
    const a = keys[i], b = keys[i + 1];
    const x0 = xOf(v, workFrame(l, a.frame)), x3 = xOf(v, workFrame(l, b.frame));
    const y0 = yOf(v, num(a.value, c.comp)), y3raw = yOf(v, num(b.value, c.comp));
    // 値が変わらない区間はハンドルの上下が見えないので、仮に40pxの箱で扱う
    const dy = Math.abs(y3raw - y0) < 8 ? -40 : y3raw - y0;
    const bz = ghostEase()?.ch === c.id && ghostEase()?.frame === frame ? ghostEase()!.ease : bezierOf(a);
    if (!bz) return { x0, y0, x3, dy, bz: null, h1: null, h2: null };
    return { x0, y0, x3, dy, bz, h1: { x: x0 + bz[0] * (x3 - x0), y: y0 + bz[1] * dy }, h2: { x: x0 + bz[2] * (x3 - x0), y: y0 + bz[3] * dy } };
  };

  const draw = () => {
    if (!canvas) return;
    const v = view();
    const dpr = devicePixelRatio;
    if (canvas.width !== Math.round(v.w * dpr)) canvas.width = Math.round(v.w * dpr);
    if (canvas.height !== Math.round(v.h * dpr)) canvas.height = Math.round(v.h * dpr);
    const g = canvas.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#191a1e";
    g.fillRect(0, 0, v.w, v.h);
    g.font = "11px 'Segoe UI', 'Yu Gothic UI', sans-serif";
    // 目盛り(控えめに)
    g.strokeStyle = "#2c2e33";
    g.fillStyle = "#8b8f98";
    g.lineWidth = 1;
    g.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const val = v.lo + ((v.hi - v.lo) * i) / 4;
      const y = Math.round(yOf(v, val)) + 0.5;
      g.beginPath();
      g.moveTo(PAD.l, y);
      g.lineTo(v.w - PAD.r, y);
      g.stroke();
      g.textAlign = "right";
      g.fillText(Math.abs(val) >= 100 ? val.toFixed(0) : val.toFixed(2), PAD.l - 6, y);
    }
    const fps = props.project.fps[0] / props.project.fps[1];
    g.textAlign = "center";
    g.textBaseline = "alphabetic";
    const secStep = [1, 2, 5, 10, 30, 60].find((s) => (s * fps * (v.w - PAD.l - PAD.r)) / v.dur > 60) ?? 120;
    for (let s = 0; s * fps <= v.dur; s += secStep) g.fillText(`${s}s`, xOf(v, s * fps), v.h - 6);
    // カーブ
    for (const c of visible()) {
      const col = colorOf(c.id);
      g.strokeStyle = col;
      g.lineWidth = 2;
      g.beginPath();
      for (let x = PAD.l; x <= v.w - PAD.r; x += 2) {
        const y = yOf(v, valueAt(c, fOf(v, x)));
        if (x === PAD.l) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
      // 名前(右端)。文字は文字の色で、色の印を横に
      const ly = yOf(v, valueAt(c, v.dur));
      g.fillStyle = col;
      g.fillRect(v.w - PAD.r - 4, ly - 4, 8, 8);
      // キー
      const l = layerOf(c.layer)!;
      for (const k of keysWithGhost(c)) {
        const x = xOf(v, workFrame(l, k.frame)), y = yOf(v, num(k.value, c.comp));
        const on = sel()?.ch === c.id && sel()!.frame === k.frame;
        g.fillStyle = on ? "#d8dade" : col;
        g.strokeStyle = "#191a1e";
        g.lineWidth = 2;
        g.beginPath();
        g.arc(x, y, on ? 6 : 5, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }
    }
    // 選んだキーのイージングのハンドル
    const s = sel();
    const c = s && channels().find((x) => x.id === s.ch);
    if (s && c) {
      const seg = segment(v, c, s.frame);
      if (seg?.h1 && seg.h2) {
        g.strokeStyle = "#8b8f98";
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(seg.x0, seg.y0);
        g.lineTo(seg.h1.x, seg.h1.y);
        g.moveTo(seg.x3, seg.y0 + seg.dy);
        g.lineTo(seg.h2.x, seg.h2.y);
        g.stroke();
        g.fillStyle = "#d8dade";
        for (const h of [seg.h1, seg.h2]) g.fillRect(h.x - 4, h.y - 4, 8, 8);
      }
    }
    // 再生ヘッド
    g.fillStyle = "#f2a541";
    g.fillRect(Math.round(xOf(v, props.frame())) - 1, PAD.t, 2, v.h - PAD.t - PAD.b);
  };

  const local = (e: PointerEvent | MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const hitKey = (x: number, y: number) => {
    const v = view();
    for (const c of [...visible()].reverse()) {
      const l = layerOf(c.layer)!;
      for (const k of c.keys) if (Math.hypot(xOf(v, workFrame(l, k.frame)) - x, yOf(v, num(k.value, c.comp)) - y) < 8) return { c, k };
    }
    return null;
  };

  const onDown = (e: PointerEvent) => {
    canvas.setPointerCapture(e.pointerId);
    const { x, y } = local(e);
    const v = view();
    frozen = { lo: v.lo, hi: v.hi };
    // キーを先に見る(ハンドルがキーに重なっているときは Alt を押してハンドルを掴む)
    const hit = hitKey(x, y);
    if (hit && !e.altKey) {
      setSel({ ch: hit.c.id, frame: hit.k.frame });
      drag = { kind: "key", ch: hit.c, from: hit.k.frame };
      return;
    }
    // 選んだキーのハンドル
    const s = sel();
    const sc = s && channels().find((c) => c.id === s.ch);
    if (s && sc) {
      const seg = segment(v, sc, s.frame);
      for (const [h, which] of [[seg?.h1, 1], [seg?.h2, 2]] as const) {
        if (h && Math.abs(h.x - x) < 7 && Math.abs(h.y - y) < 7) {
          drag = { kind: "handle", ch: sc, frame: s.frame, which };
          return;
        }
      }
    }
    if (hit) {
      setSel({ ch: hit.c.id, frame: hit.k.frame });
      drag = { kind: "key", ch: hit.c, from: hit.k.frame };
      return;
    }
    setSel(null);
    drag = { kind: "seek" };
    props.seek(Math.max(0, Math.min(props.project.duration - 1, Math.round(fOf(v, x)))));
  };

  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    const { x, y } = local(e);
    const v = view();
    if (drag.kind === "seek") props.seek(Math.max(0, Math.min(props.project.duration - 1, Math.round(fOf(v, x)))));
    else if (drag.kind === "key") {
      const l = layerOf(drag.ch.layer)!;
      // Shift で値だけ(時刻を動かさない)
      const frame = e.shiftKey ? drag.from : Math.round(layerFrame(l, Math.max(0, fOf(v, x))));
      let value = valOf(v, y);
      value = drag.ch.type === "int" ? Math.round(value) : Math.round(value * 1000) / 1000;
      setGhost({ ch: drag.ch.id, from: drag.from, frame, value });
    } else if (drag.kind === "handle") {
      const seg = segment(v, drag.ch, drag.frame);
      if (!seg || !seg.bz) return;
      const bx = Math.min(1, Math.max(0, (x - seg.x0) / Math.max(1, seg.x3 - seg.x0)));
      const by = (y - seg.y0) / seg.dy;
      const ease = [...seg.bz];
      if (drag.which === 1) (ease[0] = bx), (ease[1] = by);
      else (ease[2] = bx), (ease[3] = by);
      setGhostEase({ ch: drag.ch.id, frame: drag.frame, ease: ease.map((n) => Math.round(n * 1000) / 1000) });
    }
  };

  const target = (c: Channel) => ({ layer: c.layer, ...c.target });

  const onUp = async () => {
    const d = drag;
    drag = null;
    frozen = null;
    const g = ghost(), ge = ghostEase();
    if (d?.kind === "key" && g) {
      const keys = keysWithGhost(d.ch);
      setGhost(null);
      await props.edit({ op: "setKeys", target: target(d.ch), keys });
      setSel({ ch: d.ch.id, frame: g.frame });
    } else if (d?.kind === "key") {
      const l = layerOf(d.ch.layer)!;
      props.seek(Math.max(0, Math.round(workFrame(l, d.from))));
    }
    if (d?.kind === "handle" && ge) {
      const keys = keysWithGhost(d.ch);
      setGhostEase(null);
      await props.edit({ op: "setKeys", target: target(d.ch), keys });
    }
    setGhost(null);
    setGhostEase(null);
  };

  /** ダブルクリックでカーブの上にキーを足す(その時刻の値で) */
  const onDbl = async (e: MouseEvent) => {
    const { x, y } = local(e);
    const v = view();
    let best: { c: Channel; d: number } | null = null;
    for (const c of visible()) {
      const d = Math.abs(yOf(v, valueAt(c, fOf(v, x))) - y);
      if (d < 10 && (!best || d < best.d)) best = { c, d };
    }
    if (!best) return;
    const c = best.c;
    const l = layerOf(c.layer)!;
    const lf = Math.round(layerFrame(l, fOf(v, x)));
    const value = evaluate(c.type === "vec2" ? "vec2" : "float", c.entry, lf);
    await props.edit({ op: "setKey", target: target(c), frame: lf, value });
    setSel({ ch: c.id, frame: lf });
  };

  const selectedKey = () => {
    const s = sel();
    const c = s && channels().find((x) => x.id === s.ch);
    const k = c?.keys.find((x) => x.frame === s!.frame);
    return c && k ? { c, k } : null;
  };
  const easeName = (k: KeyLike) => (Array.isArray(k.ease) ? "custom" : typeof k.ease === "string" ? k.ease : "linear");
  const setEase = (name: string) => {
    const s = selectedKey();
    if (!s) return;
    // 直線と保持からカスタムにするときは、ハンドルがキーに重ならない CSS の ease と同じ値から始める
    const b = bezierOf(s.k);
    const ease = name === "custom" ? (!b || (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 1) ? [0.25, 0.1, 0.25, 1] : b) : name;
    const keys = s.c.keys.map((k) => (k.frame === s.k.frame ? { ...k, ease } : k));
    props.edit({ op: "setKeys", target: target(s.c), keys });
  };

  onMount(() => {
    let raf = 0;
    const loop = () => {
      draw();
      raf = requestAnimationFrame(loop);
    };
    loop();
    onCleanup(() => cancelAnimationFrame(raf));
    const onKey = (e: KeyboardEvent) => {
      if (!canvas.matches(":hover") || !(e.key === "Delete" || e.key === "Backspace")) return;
      const s = selectedKey();
      if (!s) return;
      e.preventDefault();
      e.stopPropagation();
      props.edit({ op: "deleteKey", target: target(s.c), frame: s.k.frame });
      setSel(null);
    };
    addEventListener("keydown", onKey, true);
    onCleanup(() => removeEventListener("keydown", onKey, true));
  });

  return (
    <div class="graph">
      <div class="graph-list" role="list" aria-label="カーブ">
        <Show when={channels().length > 0} fallback={<p class="hint">キーフレームのある数値がまだありません。パラメータパネルで I キーを押すとキーを打てます。</p>}>
          <For each={channels()}>
            {(c) => (
              <label role="listitem" class={shown().size && !shown().has(c.id) ? "off" : ""}>
                <input type="checkbox" checked={!shown().size || shown().has(c.id)} onChange={() => toggle(c.id)} />
                <span class="swatch" style={{ background: colorOf(c.id) }} />
                {c.label}
              </label>
            )}
          </For>
        </Show>
      </div>
      <div class="graph-main">
        <div class="graph-bar">
          <Show when={selectedKey()} fallback={<span class="hint">キーをクリックで選ぶ / ドラッグで時刻と値(Shiftで値だけ) / ダブルクリックでキーを足す / Delete で消す / Alt+ドラッグでキーに重なったハンドル</span>}>
            {(s) => (
              <>
                <span>{s().c.label} ・ フレーム {s().k.frame} ・ 値 {num(s().k.value, s().c.comp).toFixed(3)}</span>
                <label>次のキーまで
                  <select value={easeName(s().k)} onChange={(e) => setEase(e.currentTarget.value)}>
                    <For each={Object.entries(EASE_NAMES)}>{([k, n]) => <option value={k} selected={k === easeName(s().k)}>{n}</option>}</For>
                  </select>
                </label>
                <Show when={Array.isArray(s().k.ease)}>
                  <span class="hint">[{(s().k.ease as number[]).map((n) => n.toFixed(2)).join(", ")}] ハンドルをドラッグで調整</span>
                </Show>
              </>
            )}
          </Show>
        </div>
        <canvas ref={canvas} class="graph-canvas" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onDblClick={onDbl} aria-label="キーフレームのグラフ" />
      </div>
    </div>
  );
}
