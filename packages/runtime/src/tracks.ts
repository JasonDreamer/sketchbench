// クリップトラック。GUIで作った「どの時刻に、何を」をスケッチから時刻で引く。
// クリップの時刻は作品時刻のフレームで保存し、at(t) は秒の作品時刻で引く。
// フィールドの値は { value, keys } にでき、キーの frame はクリップ開始からの相対フレーム(クリップを動かすとキーも一緒に動く)。

import { evaluate, isKeyed } from "./keyframes.js";

export interface TrackDecl {
  fields: Record<string, string>;
  /** 終了後もこの秒数だけ at() に含める */
  tail?: number;
}

export interface ClipData {
  start: number;
  end: number;
  value: Record<string, unknown>;
}

export interface ActiveClip<V = Record<string, unknown>> {
  id: string;
  value: V;
  /** クリップ開始からの経過(秒) */
  elapsed: number;
  /** クリップ内の進み具合(0〜1。終了後は1) */
  progress: number;
  /** 開始時刻順の通し番号(0から) */
  index: number;
  /** 終了後の経過(秒)。終了前は0 */
  after: number;
  start: number;
  end: number;
}

export class ClipTrack {
  private clips: (ClipData & { id: string; index: number; startSec: number; endSec: number })[];

  constructor(data: Record<string, ClipData>, private decl: TrackDecl, private fps: number) {
    // 開始時刻順、同時なら作成順(JSONでの並び)
    const list = Object.entries(data ?? {}).map(([id, c], order) => ({ id, order, ...c }));
    list.sort((a, b) => a.start - b.start || a.order - b.order);
    this.clips = list.map((c, index) => ({ ...c, index, startSec: c.start / fps, endSec: c.end / fps }));
  }

  /** 時刻tに有効なクリップ(開始時刻順)。宣言の tail の秒数だけ終了後も返す */
  at(t: number): ActiveClip[] {
    const tail = this.decl.tail ?? 0;
    const out: ActiveClip[] = [];
    for (const c of this.clips) {
      if (c.startSec > t) break;
      if (t >= c.endSec + tail) continue;
      const dur = Math.max(1e-9, c.endSec - c.startSec);
      out.push({
        id: c.id, value: this.valueAt(c.value, (t - c.startSec) * this.fps), index: c.index, start: c.startSec, end: c.endSec,
        elapsed: t - c.startSec, progress: Math.min(1, (t - c.startSec) / dur), after: Math.max(0, t - c.endSec),
      });
    }
    return out;
  }

  /** キーフレームつきのフィールドを、クリップ開始からのフレームで評価する */
  private valueAt(value: Record<string, unknown>, rel: number): Record<string, unknown> {
    let keyed = false;
    for (const v of Object.values(value ?? {})) if (isKeyed(v)) keyed = true;
    if (!keyed) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = evaluate(this.decl.fields[k] ?? "text", v, rel);
    return out;
  }

  /** 全クリップ(開始時刻順) */
  all(): ActiveClip[] {
    return this.clips.map((c) => ({ id: c.id, value: c.value, index: c.index, start: c.startSec, end: c.endSec, elapsed: 0, progress: 0, after: 0 }));
  }
}

export function makeTracks(decls: Record<string, TrackDecl> | undefined, data: Record<string, Record<string, ClipData>> | undefined, fps: number) {
  const out: Record<string, ClipTrack> = {};
  for (const [name, decl] of Object.entries(decls ?? {})) out[name] = new ClipTrack(data?.[name] ?? {}, decl, fps);
  return out;
}
