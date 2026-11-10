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
  layers: { id: string; sketch: string; tracks?: Record<string, Record<string, Clip>> }[];
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
  | { kind: "clips"; h: number; layer: string; track: string; decl: TrackDecl };

export function rowsOf(p: ProjectLike, decls: Record<string, any>): Row[] {
  const rows: Row[] = [{ kind: "ruler", h: 22 }, { kind: "markers", h: 18 }];
  for (const a of p.audio ?? []) rows.push({ kind: "audio", h: 48, asset: a.asset, offset: a.offset ?? 0 });
  for (const name of Object.keys(p.eventMap ?? {})) rows.push({ kind: "events", h: 16, name });
  for (const l of p.layers) {
    const tracks = decls?.[l.sketch]?.tracks ?? {};
    for (const [track, decl] of Object.entries<any>(tracks)) rows.push({ kind: "clips", h: 30, layer: l.id, track, decl });
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
