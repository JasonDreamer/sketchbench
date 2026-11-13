import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { EASES, fpsOf, frameOf, keysOf, layerFrame, propOf, rowsOf, snapFrame, workFrame, xOf, type Clip, type LayerLike, type ProjectLike, type Row, type View } from "./timeline-model";

const SB = "http://sb.localhost";

export interface Selection {
  layer: string;
  track: string;
  id: string;
}

export interface TimelineApi {
  /** キー操作。処理したら true */
  key(k: { key: string; code: string; shift: boolean; ctrl: boolean }): boolean;
  /** 再生中の区切り打ちを始める(texts を順にクリップの値にする) */
  startTap(texts: string[], layer: string, track: string, field: string): void;
}

type Props = {
  work: string;
  project: ProjectLike;
  decls: Record<string, any>;
  frame: () => number;
  playing: () => boolean;
  selection: () => Selection | null;
  select: (s: Selection | null) => void;
  seek: (frame: number, scrub: boolean) => void;
  edit: (op: Record<string, unknown>) => Promise<any>;
  status: (msg: string) => void;
  api: (a: TimelineApi) => void;
};

type Drag =
  | { kind: "seek" }
  | { kind: "clip"; mode: "move" | "left" | "right"; sel: Selection; grab: number; start: number; end: number; moved: boolean }
  | { kind: "marker"; index: number; grab: number; start: number; moved: boolean }
  | { kind: "pan"; x: number; start: number }
  | { kind: "key"; sel: KeySel; fromWork: number; grab: number; moved: boolean }
  | { kind: "layer"; mode: "move" | "left" | "right"; layer: string; grab: number; start: number; end: number; moved: boolean };

/** 選んだキーフレーム。param か合成の値(prop)の、レイヤーのフレーム */
type KeySel = { layer: string; param?: string; prop?: string; frame: number };
const sameRow = (a: { layer: string; param?: string; prop?: string }, b: { layer: string; param?: string; prop?: string }) =>
  a.layer === b.layer && a.param === b.param && a.prop === b.prop;
const keyTarget = (k: KeySel) => (k.param ? { layer: k.layer, param: k.param } : { layer: k.layer, property: k.prop });

const COLORS = { bg: "#1e1f23", row: "#191a1e", line: "#2c2e33", text: "#8b8f98", textStrong: "#d8dade", clip: "#3b4252", clipSel: "#5a6478", accent: "#f2a541", beat: "#33363d", bar: "#4a4e57", wave: "#6f7d91", marker: "#c9a0dc", event: "#7fb3a1" };

/** キーフレームの印(ひし形) */
function diamond(g: CanvasRenderingContext2D, x: number, y: number, r: number) {
  g.beginPath();
  g.moveTo(x, y - r);
  g.lineTo(x + r, y);
  g.lineTo(x, y + r);
  g.lineTo(x - r, y);
  g.closePath();
  g.fill();
}

export function Timeline(props: Props) {
  let canvas!: HTMLCanvasElement;
  const [view, setView] = createSignal<View>({ start: 0, pxPerFrame: 2, gutter: 120 });
  const [analyses, setAnalyses] = createSignal<Record<string, any>>({});
  const [events, setEvents] = createSignal<Record<string, number[]>>({});
  /** ドラッグ中のクリップの仮の位置(離したときに操作として送る) */
  const [ghost, setGhost] = createSignal<{ sel: Selection; start: number; end: number } | null>(null);
  const [ghostMarker, setGhostMarker] = createSignal<{ index: number; start: number } | null>(null);
  const [keySel, setKeySel] = createSignal<KeySel | null>(null);
  /** ドラッグ中のキーの仮の位置 */
  const [ghostKey, setGhostKey] = createSignal<number | null>(null);
  /** ドラッグ中のレイヤーの仮の区間 */
  const [ghostLayer, setGhostLayer] = createSignal<{ layer: string; start: number; end: number } | null>(null);
  const layerById = (id: string): LayerLike | undefined => p().layers.find((l) => l.id === id);
  const spanOf = (l: LayerLike) => ({ start: l.start ?? 0, end: l.end ?? p().duration });
  const keysFor = (k: { layer: string; param?: string; prop?: string }) => {
    const l = layerById(k.layer);
    if (!l) return [];
    return keysOf(k.param ? l.params?.[k.param] : propOf(l, k.prop!));
  };
  let drag: Drag | null = null;
  let tap: { texts: string[]; layer: string; track: string; field: string; times: number[] } | null = null;

  const p = () => props.project;
  const rows = () => rowsOf(p(), props.decls);
  const fps = () => fpsOf(p());

  // 音声の解析と、イベント対応表のMIDIを読み込む
  createEffect(async () => {
    const proj = p();
    const out: Record<string, any> = {};
    for (const a of proj.audio ?? []) {
      try {
        const r = await fetch(`${SB}/work/${encodeURIComponent(props.work)}/analysis/${a.asset}`);
        if (r.ok) out[a.asset] = await r.json();
      } catch {}
    }
    setAnalyses(out);
    const ev: Record<string, number[]> = {};
    for (const [name, src] of Object.entries<any>(proj.eventMap ?? {})) {
      if (Array.isArray(src?.times)) ev[name] = src.times;
      else if (typeof src?.midi === "string") {
        try {
          const m = await (await fetch(`${SB}/work/${encodeURIComponent(props.work)}/midi/${src.midi}`)).json();
          const notes = src.note == null ? null : Array.isArray(src.note) ? src.note : [src.note];
          ev[name] = m.notes.filter((n: any) => (!notes || notes.includes(n.pitch)) && (src.channel == null || n.channel === src.channel)).map((n: any) => n.start + Number(src.offset ?? 0));
        } catch {}
      }
    }
    setEvents(ev);
  });

  const audioBeats = () => {
    const a = Object.values(analyses())[0];
    if (!a) return [] as number[];
    const off = (p().audio?.[0]?.offset ?? 0) / fps();
    return (a.beats as number[]).map((b) => b + off);
  };

  const clipsOf = (layer: string, track: string): [string, Clip][] => {
    const l = p().layers.find((x) => x.id === layer);
    return Object.entries(l?.tracks?.[track] ?? {});
  };

  const rowAt = (y: number): { row: Row; top: number } | null => {
    let top = 0;
    for (const r of rows()) {
      if (y >= top && y < top + r.h) return { row: r, top };
      top += r.h;
    }
    return null;
  };

  const fitAll = () => {
    const w = canvas.clientWidth - view().gutter - 10;
    setView((v) => ({ ...v, start: 0, pxPerFrame: Math.max(0.05, w / Math.max(1, p().duration)) }));
  };

  const draw = () => {
    if (!canvas) return;
    const dpr = devicePixelRatio;
    const w = canvas.clientWidth;
    const h = rows().reduce((s, r) => s + r.h, 0) + 6;
    canvas.style.height = `${h}px`;
    if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
    const g = canvas.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = COLORS.bg;
    g.fillRect(0, 0, w, h);
    const v = view();
    const proj = p();
    const F = fps();
    const visFrom = Math.max(0, v.start), visTo = Math.min(proj.duration, frameOf(v, w));
    g.font = "11px 'Segoe UI', 'Yu Gothic UI', sans-serif";
    g.textBaseline = "middle";

    const gridTop = rows()[0].h;

    let top = 0;
    for (const r of rows()) {
      g.fillStyle = COLORS.row;
      if (r.kind !== "ruler") g.fillRect(v.gutter, top + 1, w - v.gutter, r.h - 2);
      g.fillStyle = COLORS.text;
      const label = r.kind === "ruler" ? "" : r.kind === "markers" ? "マーカー" : r.kind === "audio" ? r.asset.replace(/^assets\//, "") : r.kind === "events" ? `イベント ${r.name}` : r.kind === "keys" ? `  ${r.layer}.${r.param ?? r.prop}` : r.kind === "layer" ? `${r.layer}  ${layerById(r.layer)?.sketch.replace(/^sketches\//, "") ?? ""}` : `${r.layer} ${r.track}`;
      g.fillText(label, 6, top + r.h / 2, v.gutter - 10);
      if (r.kind === "ruler") {
        const secs = 1 / (v.pxPerFrame * F); // 1pxあたりの秒
        const step = [0.1, 0.5, 1, 2, 5, 10, 30, 60].find((s) => s / secs > 60) ?? 120;
        for (let s = Math.ceil(visFrom / F / step) * step; s * F <= visTo; s += step) {
          const x = Math.round(xOf(v, s * F)) + 0.5;
          g.fillStyle = COLORS.line;
          g.fillRect(x, top + 12, 1, r.h - 12);
          g.fillStyle = COLORS.text;
          g.fillText(step < 1 ? s.toFixed(1) : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`, x + 3, top + 7);
        }
      } else if (r.kind === "markers") {
        const ms = (proj.markers ?? []).map((m, i) => (ghostMarker()?.index === i ? { ...m, start: ghostMarker()!.start } : m));
        for (const m of ms) {
          const x = xOf(v, m.start);
          g.fillStyle = COLORS.marker;
          g.beginPath();
          g.moveTo(x, top + 2);
          g.lineTo(x + 6, top + 2);
          g.lineTo(x, top + r.h - 2);
          g.fill();
          g.fillText(m.name, x + 8, top + r.h / 2);
        }
      } else if (r.kind === "audio") {
        const a = analyses()[r.asset];
        if (a) {
          const mid = top + r.h / 2;
          g.fillStyle = COLORS.wave;
          const rate = a.rate as number;
          for (let x = v.gutter; x < w; x++) {
            const t = frameOf(v, x) / F - r.offset / F;
            const i = Math.floor(t * rate);
            const i2 = Math.max(i + 1, Math.floor((frameOf(v, x + 1) / F - r.offset / F) * rate));
            if (i < 0 || i >= a.waveMax.length) continue;
            let lo = 0, hi = 0;
            for (let j = i; j < Math.min(i2, a.waveMax.length); j++) {
              lo = Math.min(lo, a.waveMin[j]);
              hi = Math.max(hi, a.waveMax[j]);
            }
            g.fillRect(x, mid - hi * (r.h / 2 - 2), 1, Math.max(1, (hi - lo) * (r.h / 2 - 2)));
          }
          // 推定したビート
          g.fillStyle = COLORS.textStrong;
          for (const b of a.beats as number[]) {
            const x = xOf(v, (b * F) + r.offset);
            if (x >= v.gutter && x <= w) g.fillRect(Math.round(x), top + 2, 1, 5);
          }
        } else {
          g.fillStyle = COLORS.text;
          g.fillText("解析中…", v.gutter + 6, top + r.h / 2);
        }
      } else if (r.kind === "events") {
        g.fillStyle = COLORS.event;
        for (const t of events()[r.name] ?? []) {
          const x = xOf(v, t * F);
          if (x >= v.gutter && x <= w) g.fillRect(Math.round(x), top + 3, 2, r.h - 6);
        }
      } else if (r.kind === "clips") {
        const sel = props.selection();
        const field = Object.keys(r.decl.fields).find((k) => r.decl.fields[k] === "text") ?? Object.keys(r.decl.fields)[0];
        for (const [id, c0] of clipsOf(r.layer, r.track)) {
          const gh = ghost();
          const c = gh && gh.sel.id === id && gh.sel.track === r.track && gh.sel.layer === r.layer ? { ...c0, start: gh.start, end: gh.end } : c0;
          const x0 = xOf(v, c.start), x1 = xOf(v, c.end);
          if (x1 < v.gutter || x0 > w) continue;
          const isSel = sel?.id === id && sel.track === r.track && sel.layer === r.layer;
          g.fillStyle = isSel ? COLORS.clipSel : COLORS.clip;
          g.fillRect(Math.max(v.gutter, x0), top + 3, Math.max(2, x1 - Math.max(v.gutter, x0) - 1), r.h - 6);
          if (r.decl.tail) {
            g.fillStyle = COLORS.line;
            g.fillRect(x1, top + r.h / 2, r.decl.tail * F * v.pxPerFrame, 2);
          }
          g.fillStyle = COLORS.textStrong;
          const txt = field ? String(c.value?.[field] ?? "") : "";
          g.save();
          g.beginPath();
          g.rect(x0, top, x1 - x0, r.h);
          g.clip();
          g.fillText(txt, Math.max(v.gutter, x0) + 4, top + r.h / 2);
          // クリップ内フィールドのキー(クリップ開始からの相対フレーム)を下端に小さく
          g.fillStyle = COLORS.textStrong;
          for (const fv of Object.values(c.value ?? {})) for (const k of keysOf(fv)) diamond(g, xOf(v, c.start + k.frame), top + r.h - 6, 3);
          g.restore();
        }
      } else if (r.kind === "keys") {
        const ks = keySel();
        const mid = top + r.h / 2;
        const dk = drag?.kind === "key" ? drag : null;
        const l = layerById(r.layer)!;
        const frames = r.keys.map((k) => (dk && sameRow(dk.sel, r) && k.frame === dk.sel.frame && ghostKey() != null ? ghostKey()! : workFrame(l, k.frame)));
        // キーの間: 保持(hold)は点線、それ以外は実線
        for (let i = 0; i + 1 < r.keys.length; i++) {
          const a = xOf(v, frames[i]), b = xOf(v, frames[i + 1]);
          g.fillStyle = COLORS.line;
          if (r.keys[i].ease === "hold") for (let x = a; x < b; x += 4) g.fillRect(x, mid, 2, 1);
          else g.fillRect(a, mid, b - a, 1);
        }
        r.keys.forEach((k, i) => {
          const on = ks && sameRow(ks, r) && ks.frame === k.frame;
          g.fillStyle = on ? COLORS.accent : COLORS.textStrong;
          diamond(g, xOf(v, frames[i]), mid, on ? 5 : 4);
        });
      } else if (r.kind === "layer") {
        const l = layerById(r.layer);
        if (l) {
          const gl = ghostLayer();
          const { start, end } = gl && gl.layer === r.layer ? gl : spanOf(l);
          const x0 = Math.max(v.gutter, xOf(v, start)), x1 = xOf(v, end);
          g.fillStyle = l.visible === false ? COLORS.line : COLORS.bar;
          if (x1 > x0) g.fillRect(x0, top + 4, x1 - x0, r.h - 8);
          // マットに使われているレイヤーは帯に印
          if (p().layers.some((o) => o.matte?.layer === l.id)) {
            g.fillStyle = COLORS.textStrong;
            g.fillText("マット", x0 + 4, top + r.h / 2);
          }
        }
      }
      g.fillStyle = COLORS.line;
      g.fillRect(0, top + r.h - 1, w, 1);
      top += r.h;
    }
    // 拍・小節のグリッド(BPMがあれば)。段の背景の上に半透明で重ねる
    if (proj.bpm) {
      const per = (60 / proj.bpm) * F;
      const off = proj.beatOffset ?? 0;
      const k0 = Math.ceil((visFrom - off) / per);
      if (per * v.pxPerFrame > 4) {
        for (let k = k0; off + k * per <= visTo; k++) {
          const x = Math.round(xOf(v, off + k * per)) + 0.5;
          g.fillStyle = k % 4 === 0 ? "rgba(150,156,170,0.35)" : "rgba(150,156,170,0.14)";
          g.fillRect(x, gridTop, 1, h - gridTop);
        }
      }
    }
    // 尺の終わり
    const xe = xOf(v, proj.duration);
    if (xe < w) {
      g.fillStyle = "rgba(0,0,0,0.35)";
      g.fillRect(xe, 0, w - xe, h);
    }
    // 区切り打ちの途中経過
    if (tap) {
      g.fillStyle = COLORS.accent;
      for (const t of tap.times) g.fillRect(Math.round(xOf(v, t)), 0, 1, h);
    }
    // 再生ヘッド
    const xp = Math.round(xOf(v, props.frame())) + 0.5;
    g.fillStyle = COLORS.accent;
    g.fillRect(xp - 1, 0, 2, h);
    g.fillStyle = COLORS.bg;
    g.fillRect(0, 0, v.gutter, gridTop);
  };

  const hitClip = (x: number, y: number) => {
    const hit = rowAt(y);
    if (!hit || hit.row.kind !== "clips") return null;
    const r = hit.row;
    const f = frameOf(view(), x);
    const edge = 6 / view().pxPerFrame;
    for (const [id, c] of clipsOf(r.layer, r.track).reverse()) {
      if (f >= c.start - edge && f <= c.end + edge) {
        const mode: "move" | "left" | "right" = Math.abs(f - c.start) < edge ? "left" : Math.abs(f - c.end) < edge ? "right" : "move";
        if (mode === "move" && (f < c.start || f > c.end)) continue;
        return { sel: { layer: r.layer, track: r.track, id }, clip: c, mode, row: r };
      }
    }
    return { sel: null, clip: null, mode: null, row: r };
  };

  const local = (e: PointerEvent | MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: PointerEvent) => {
    canvas.setPointerCapture(e.pointerId);
    const { x, y } = local(e);
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      drag = { kind: "pan", x, start: view().start };
      return;
    }
    if (x < view().gutter) return;
    const hit = rowAt(y);
    const f = frameOf(view(), x);
    if (hit?.row.kind === "markers") {
      const ms = p().markers ?? [];
      const i = ms.findIndex((m) => Math.abs(xOf(view(), m.start) - x) < 8);
      if (i >= 0) {
        drag = { kind: "marker", index: i, grab: f, start: ms[i].start, moved: false };
        return;
      }
    }
    if (hit?.row.kind === "keys") {
      const r = hit.row;
      const l = layerById(r.layer)!;
      const k = r.keys.find((k) => Math.abs(xOf(view(), workFrame(l, k.frame)) - x) < 6);
      if (k) {
        props.select(null);
        const sel = { layer: r.layer, param: r.param, prop: r.prop, frame: k.frame };
        setKeySel(sel);
        drag = { kind: "key", sel, fromWork: workFrame(l, k.frame), grab: f, moved: false };
        return;
      }
    }
    if (hit?.row.kind === "layer") {
      const l = layerById(hit.row.layer);
      if (l) {
        const { start, end } = spanOf(l);
        const edge = 6 / view().pxPerFrame;
        if (f >= start - edge && f <= end + edge) {
          const mode = Math.abs(f - start) < edge ? "left" : Math.abs(f - end) < edge ? "right" : "move";
          drag = { kind: "layer", mode, layer: l.id, grab: f, start, end, moved: false };
          return;
        }
      }
    }
    setKeySel(null);
    const c = hitClip(x, y);
    if (c?.sel && c.clip && c.mode) {
      props.select(c.sel);
      drag = { kind: "clip", mode: c.mode, sel: c.sel, grab: f, start: c.clip.start, end: c.clip.end, moved: false };
      return;
    }
    if (c && !c.sel) props.select(null);
    drag = { kind: "seek" };
    props.seek(Math.max(0, Math.min(p().duration - 1, Math.round(f))), true);
  };

  const onMove = (e: PointerEvent) => {
    const { x, y } = local(e);
    if (!drag) {
      const c = hitClip(x, y);
      canvas.style.cursor = c?.mode === "left" || c?.mode === "right" ? "ew-resize" : c?.mode === "move" ? "grab" : "default";
      return;
    }
    const f = frameOf(view(), x);
    if (drag.kind === "seek") props.seek(Math.max(0, Math.min(p().duration - 1, Math.round(f))), true);
    else if (drag.kind === "pan") setView((v) => ({ ...v, start: Math.max(0, drag && drag.kind === "pan" ? drag.start - (x - drag.x) / v.pxPerFrame : v.start) }));
    else if (drag.kind === "key") {
      drag.moved = true;
      setGhostKey(snapFrame(p(), audioBeats(), drag.fromWork + (f - drag.grab), view().pxPerFrame, !e.shiftKey));
    } else if (drag.kind === "layer") {
      drag.moved = true;
      const d = f - drag.grab;
      const sn = (fr: number) => snapFrame(p(), audioBeats(), fr, view().pxPerFrame, !e.shiftKey);
      let { start, end } = drag;
      if (drag.mode === "move") {
        const ns = Math.max(0, sn(start + d));
        end = ns + (end - start);
        start = ns;
      } else if (drag.mode === "left") start = Math.max(0, Math.min(end - 1, sn(start + d)));
      else end = Math.max(start + 1, sn(end + d));
      setGhostLayer({ layer: drag.layer, start, end });
    } else if (drag.kind === "marker") {
      drag.moved = true;
      setGhostMarker({ index: drag.index, start: snapFrame(p(), audioBeats(), drag.start + (f - drag.grab), view().pxPerFrame, !e.shiftKey) });
    } else if (drag.kind === "clip") {
      drag.moved = true;
      const d = f - drag.grab;
      const sn = (fr: number) => snapFrame(p(), audioBeats(), fr, view().pxPerFrame, !e.shiftKey);
      let { start, end } = drag;
      if (drag.mode === "move") {
        const ns = sn(start + d);
        end = ns + (end - start);
        start = ns;
      } else if (drag.mode === "left") start = Math.min(end - 1, sn(start + d));
      else end = Math.max(start + 1, sn(end + d));
      setGhost({ sel: drag.sel, start: Math.max(0, start), end });
    }
  };

  const onUp = async () => {
    const d = drag;
    drag = null;
    if (d?.kind === "clip" && d.moved && ghost()) {
      const g = ghost()!;
      await props.edit({ op: "updateClip", layer: g.sel.layer, track: g.sel.track, id: g.sel.id, start: Math.round(g.start), end: Math.round(g.end) });
    }
    if (d?.kind === "marker" && d.moved && ghostMarker()) {
      const ms = (p().markers ?? []).map((m, i) => (i === d.index ? { ...m, start: Math.round(ghostMarker()!.start) } : m));
      await props.edit({ op: "setMarkers", markers: ms });
    }
    if (d?.kind === "key") {
      const l = layerById(d.sel.layer)!;
      const g = ghostKey();
      const to = g == null ? d.sel.frame : Math.round(layerFrame(l, g));
      if (d.moved && to !== d.sel.frame) {
        // 同じフレームに別のキーがあれば置き換える。1回の操作(取り消し1単位)で送る
        const keys = keysFor(d.sel).filter((k) => k.frame !== to).map((k) => (k.frame === d.sel.frame ? { ...k, frame: to } : k));
        await props.edit({ op: "setKeys", target: keyTarget(d.sel), keys });
        setKeySel({ ...d.sel, frame: to });
      } else if (!d.moved) props.seek(Math.max(0, Math.round(d.fromWork)), false);
    }
    if (d?.kind === "layer" && d.moved && ghostLayer()) {
      const gl = ghostLayer()!;
      const l = layerById(d.layer)!;
      const set: Record<string, unknown> = { start: Math.round(gl.start), end: Math.round(gl.end) };
      // 左端を詰めたときは中身をその場に残す(AEと同じ)。動かしたときは中身ごと動く
      if (d.mode === "left") set.offset = (l.offset ?? 0) + (gl.start - d.start) * (l.speed || 1);
      await props.edit({ op: "updateLayer", layer: d.layer, set });
    }
    setGhostLayer(null);
    setGhostKey(null);
    setGhost(null);
    setGhostMarker(null);
  };

  const onDbl = async (e: MouseEvent) => {
    const { x, y } = local(e);
    const hit = rowAt(y);
    if (!hit || x < view().gutter) return;
    const f = snapFrame(p(), audioBeats(), frameOf(view(), x), view().pxPerFrame, !e.shiftKey);
    if (hit.row.kind === "markers") {
      const name = prompt("マーカーの名前", `m${(p().markers ?? []).length + 1}`);
      if (name) await props.edit({ op: "setMarkers", markers: [...(p().markers ?? []), { name, start: f }] });
    } else if (hit.row.kind === "clips" && !hitClip(x, y)?.sel) {
      // 1拍(BPMがなければ1秒)の長さで追加
      const len = Math.round(p().bpm ? (60 / p().bpm!) * fps() : fps());
      const r = hit.row;
      const value: Record<string, unknown> = {};
      for (const [k, t] of Object.entries(r.decl.fields)) value[k] = t === "text" ? "" : t === "color" ? "#ffffff" : t === "bool" ? false : t === "float" || t === "int" ? 0 : "";
      const res = await props.edit({ op: "addClips", layer: r.layer, track: r.track, clips: [{ start: f, end: f + len, value }] });
      if (res?.ids?.[0]) props.select({ layer: r.layer, track: r.track, id: res.ids[0] });
    }
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const { x } = local(e);
    setView((v) => {
      if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.shiftKey) {
        // 拡大縮小(カーソル位置を中心に)
        const f = frameOf(v, x);
        const ppf = Math.max(0.02, Math.min(40, v.pxPerFrame * Math.exp(-e.deltaY * 0.0015)));
        return { ...v, pxPerFrame: ppf, start: Math.max(0, f - (x - v.gutter) / ppf) };
      }
      return { ...v, start: Math.max(0, v.start + (e.deltaX || e.deltaY) / v.pxPerFrame) };
    });
  };

  onMount(() => {
    fitAll();
    let raf = 0;
    const loop = () => {
      draw();
      raf = requestAnimationFrame(loop);
    };
    loop();
    onCleanup(() => cancelAnimationFrame(raf));
    canvas.addEventListener("wheel", onWheel, { passive: false });
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
    onCleanup(() => ro.disconnect());
  });

  const finishTap = async () => {
    const t = tap;
    tap = null;
    if (!t || t.times.length < 2) {
      props.status("区切り打ちを終えた(クリップは2回以上打つと作られる)");
      return;
    }
    const clips = [];
    for (let i = 0; i + 1 < t.times.length && i < t.texts.length; i++) clips.push({ start: t.times[i], end: t.times[i + 1], value: { [t.field]: t.texts[i] } });
    await props.edit({ op: "addClips", layer: t.layer, track: t.track, clips });
    props.status(`区切り打ちから${clips.length}個のクリップを作った(1回で取り消せる)`);
  };

  props.api({
    key(k) {
      const sel = props.selection();
      if (k.key === "Escape" && tap) {
        finishTap();
        return true;
      }
      if ((k.key === "k" || k.key === "K") && tap) {
        tap.times.push(Math.round(props.frame()));
        props.status(`区切り ${tap.times.length} 回目(${tap.texts[tap.times.length - 1] ?? "テキストが尽きた"})。Escで確定`);
        if (tap.times.length > tap.texts.length) finishTap();
        return true;
      }
      const ks = keySel();
      if ((k.key === "Delete" || k.key === "Backspace") && ks) {
        props.edit({ op: "deleteKey", target: keyTarget(ks), frame: ks.frame });
        setKeySel(null);
        return true;
      }
      if ((k.key === "e" || k.key === "E") && !k.ctrl && ks) {
        const key = keysFor(ks).find((x) => x.frame === ks.frame);
        if (!key) return false;
        const i = EASES.indexOf((typeof key.ease === "string" ? key.ease : "linear") as (typeof EASES)[number]);
        const ease = EASES[(i + 1) % EASES.length];
        props.edit({ op: "setKey", target: keyTarget(ks), frame: ks.frame, value: key.value, ease }).then(() => props.status(`${ks.layer}.${ks.param ?? ks.prop} のフレーム ${ks.frame} から次のキーまでのイージング: ${ease}`));
        return true;
      }
      if ((k.key === "Delete" || k.key === "Backspace") && sel) {
        props.edit({ op: "deleteClips", layer: sel.layer, track: sel.track, ids: [sel.id] });
        props.select(null);
        return true;
      }
      if ((k.key === "s" || k.key === "S") && !k.ctrl && sel) {
        props.edit({ op: "splitClip", layer: sel.layer, track: sel.track, id: sel.id, at: Math.round(props.frame()) });
        return true;
      }
      if (k.key === "Home" && k.shift) {
        fitAll();
        return true;
      }
      return false;
    },
    startTap(texts, layer, track, field) {
      tap = { texts, layer, track, field, times: [] };
      props.status(`区切り打ち: 再生しながら K で区切る(${texts.length}行)。Escで確定`);
    },
  });

  return (
    <canvas
      ref={canvas}
      class="timeline"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onDblClick={onDbl}
      aria-label="タイムライン"
    />
  );
}
