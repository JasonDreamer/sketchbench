// タイムラインのデータと座標計算。描画とマウス操作は Timeline.tsx。
// 時刻は project.json と同じくフレームで扱い、表示のときだけ秒に直す。

export interface ProjectLike {
  fps: [number, number];
  duration: number;
  bpm?: number;
  beatOffset?: number;
  markers?: { name: string; start: number; end?: number }[];
  audio?: { asset: string; offset?: number }[];
  eventMap?: Record<string, any>;
  width?: number;
  height?: number;
  layers: LayerLike[];
}

export interface LayerLike {
  id: string;
  sketch: string;
  params?: Record<string, unknown>;
  tracks?: Record<string, Record<string, Clip>>;
  start?: number;
  end?: number;
  offset?: number;
  speed?: number;
  opacity?: unknown;
  blend?: string;
  transform?: Record<string, unknown>;
  matte?: { layer: string; mode?: string };
  resolution?: number;
  visible?: boolean;
}

/** キーを打てるレイヤーの値(project.json での場所) */
export const LAYER_PROPS = ["opacity", "transform.position", "transform.scale", "transform.rotation", "transform.anchor"] as const;

/** レイヤーの値を "transform.position" のような道筋で引く */
export function propOf(l: LayerLike, path: string): unknown {
  return path.split(".").reduce<any>((o, k) => (o == null ? undefined : o[k]), l);
}

/** 作品のフレーム → レイヤーのフレーム(paramsと合成の値のキーはレイヤーのフレームで持つ) */
export function layerFrame(l: LayerLike, frame: number): number {
  return (frame - (l.start ?? 0)) * (l.speed || 1) + (l.offset ?? 0);
}

/** レイヤーのフレーム → 作品のフレーム */
export function workFrame(l: LayerLike, lf: number): number {
  return (l.start ?? 0) + (lf - (l.offset ?? 0)) / (l.speed || 1);
}

export interface Clip {
  start: number;
  end: number;
  value: Record<string, unknown>;
}

export interface TrackDecl {
  fields: Record<string, string>;
  tail?: number;
}

export type Row =
  | { kind: "ruler"; h: number }
  | { kind: "markers"; h: number }
  | { kind: "audio"; h: number; asset: string; offset: number }
  | { kind: "events"; h: number; name: string }
  | { kind: "clips"; h: number; layer: string; track: string; decl: TrackDecl }
  | { kind: "layer"; h: number; layer: string }
  /** param か、合成の値(prop: "opacity" など)のキー */
  | { kind: "keys"; h: number; layer: string; param?: string; prop?: string; keys: KeyLike[] };

export interface KeyLike {
  frame: number;
  value: unknown;
  ease?: unknown;
}

/** キーフレームつきの値なら、そのキー(frame順) */
export function keysOf(v: unknown): KeyLike[] {
  if (!v || typeof v !== "object" || Array.isArray(v) || !("value" in v)) return [];
  const keys = (v as { keys?: KeyLike[] }).keys;
  return Array.isArray(keys) ? [...keys].sort((a, b) => a.frame - b.frame) : [];
}

/** イージングの切り替え順(E キー) */
export const EASES = ["linear", "easeInOut", "easeIn", "easeOut", "hold"] as const;

export function rowsOf(p: ProjectLike, decls: Record<string, any>): Row[] {
  const rows: Row[] = [{ kind: "ruler", h: 22 }, { kind: "markers", h: 18 }];
  for (const a of p.audio ?? []) rows.push({ kind: "audio", h: 48, asset: a.asset, offset: a.offset ?? 0 });
  for (const name of Object.keys(p.eventMap ?? {})) rows.push({ kind: "events", h: 16, name });
  // 上のレイヤーを上に(合成の順は layers の後ろほど上)
  for (const l of [...p.layers].reverse()) {
    rows.push({ kind: "layer", h: 20, layer: l.id });
    for (const prop of LAYER_PROPS) {
      const keys = keysOf(propOf(l, prop));
      if (keys.length) rows.push({ kind: "keys", h: 18, layer: l.id, prop, keys });
    }
    const tracks = decls?.[l.sketch]?.tracks ?? {};
    for (const [track, decl] of Object.entries<any>(tracks)) rows.push({ kind: "clips", h: 30, layer: l.id, track, decl });
    // キーのある params だけ行を出す
    for (const [param, v] of Object.entries(l.params ?? {})) {
      const keys = keysOf(v);
      if (keys.length) rows.push({ kind: "keys", h: 18, layer: l.id, param, keys });
    }
  }
  return rows;
}

export interface View {
  /** 左端のフレーム */
  start: number;
  /** 1フレームあたりのピクセル */
  pxPerFrame: number;
  /** 左側のラベル欄の幅 */
  gutter: number;
}

export const xOf = (v: View, frame: number) => v.gutter + (frame - v.start) * v.pxPerFrame;
export const frameOf = (v: View, x: number) => v.start + (x - v.gutter) / v.pxPerFrame;

export function fpsOf(p: ProjectLike) {
  return p.fps[0] / p.fps[1];
}

/** 吸着先: BPMがあれば拍、なければ音声解析のビート、どちらもなければフレーム */
export function snapFrame(p: ProjectLike, beats: number[], frame: number, pxPerFrame: number, enabled: boolean): number {
  const f = Math.round(frame);
  if (!enabled) return f;
  const fps = fpsOf(p);
  const tolerance = 8 / pxPerFrame; // 8px以内なら吸着
  let cands: number[] = [];
  if (p.bpm) {
    const per = (60 / p.bpm) * fps;
    const off = p.beatOffset ?? 0;
    const k = Math.round((frame - off) / per);
    cands = [off + k * per];
  } else if (beats.length) {
    cands = beats.map((b) => b * fps);
  }
  let best = f;
  let bd = tolerance;
  for (const c of cands) {
    const d = Math.abs(c - frame);
    if (d < bd) {
      bd = d;
      best = Math.round(c);
    }
  }
  return best;
}

export function timecode(frame: number, p: ProjectLike): string {
  const fps = fpsOf(p);
  const s = frame / fps;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
}
