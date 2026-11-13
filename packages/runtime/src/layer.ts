// レイヤーの設定(project.json の layers[] の合成まわり)と、レイヤー時刻と作品時刻の変換。
// スケッチが受け取る t・frame はレイヤー時刻。音声・MIDI・イベント・マーカー・拍・クリップは作品時刻で引くので、
// スケッチに渡す関数はレイヤー時刻を受け取り、ここで作品時刻に戻してから引く。

import { evaluate, isKeyed } from "./keyframes.js";
import { inverseTransform, type Blend, type InvTransform, type MatteMode } from "./compositor.js";

export interface LayerSettings {
  id: string;
  /** 作品のフレームで、このレイヤーが出る区間 [start, end) */
  start?: number;
  end?: number;
  /** レイヤー時刻の起点(start の時点でのレイヤーのフレーム) */
  offset?: number;
  /** 再生速度(2で倍速、0.5で半分) */
  speed?: number;
  opacity?: unknown;
  blend?: Blend;
  transform?: { position?: unknown; scale?: unknown; rotation?: unknown; anchor?: unknown };
  /** 別のレイヤーのアルファか輝度で切り抜く。マットに使ったレイヤーは単独では表示しない */
  matte?: { layer: string; mode?: MatteMode };
  /** 内部解像度(出力に対する倍率、0.1〜1) */
  resolution?: number;
  /** false で合成に入れない(inputs.layer やマットからは使える) */
  visible?: boolean;
}

/** レイヤー時刻と作品時刻の対応。設定が変わってもsetupで作った関数が新しい値を使うよう、同じオブジェクトを書き換える */
export class LayerClock {
  start = 0;
  end = Infinity;
  offset = 0;
  speed = 1;
  constructor(public fps: number) {}

  set(s: LayerSettings, fps: number, duration: number) {
    this.fps = fps;
    this.start = Number(s.start ?? 0);
    this.end = Number(s.end ?? duration);
    this.offset = Number(s.offset ?? 0);
    this.speed = Number(s.speed ?? 1) || 1;
  }

  active(frame: number) {
    return frame >= this.start && frame < this.end;
  }

  /** 作品のフレーム → レイヤーのフレーム(小数あり) */
  layerFrame(frame: number) {
    return (frame - this.start) * this.speed + this.offset;
  }

  /** レイヤー時刻(秒) → 作品時刻(秒) */
  toWork = (t: number) => (this.start + (t * this.fps - this.offset) / this.speed) / this.fps;
}

/** obj のメソッドのうち、指定した位置の引数(秒)をレイヤー時刻から作品時刻に直して呼ぶ */
export function bindTime<T extends object>(obj: T, argPos: Record<string, number[]>, toWork: (t: number) => number): T {
  return new Proxy(obj, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      const pos = typeof prop === "string" ? argPos[prop] : undefined;
      if (!pos || typeof v !== "function") return typeof v === "function" ? v.bind(target) : v;
      return (...args: unknown[]) => {
        for (const i of pos) if (typeof args[i] === "number") args[i] = toWork(args[i] as number);
        return v.apply(target, args);
      };
    },
  });
}

/** 時刻を引数に取るメソッドと、その位置 */
export const TIME_ARGS = {
  audio: { rms: [0], band: [1], wave: [0], beat: [0], pulse: [0], onset: [0] },
  midi: { notesAt: [0], ccAt: [1], since: [1], envelope: [1] },
  events: { since: [1], last: [1], count: [1], between: [1, 2] },
  track: { at: [0] },
} satisfies Record<string, Record<string, number[]>>;

const vec2 = (v: unknown, d: [number, number]): [number, number] => {
  if (typeof v === "number") return [v, v];
  if (Array.isArray(v)) return [Number(v[0] ?? d[0]), Number(v[1] ?? d[1])];
  return d;
};

/** レイヤーのフレームでの不透明度と、出力→レイヤーUVの逆変換 */
export function placement(s: LayerSettings, lf: number, w: number, h: number): { opacity: number; inv: InvTransform } {
  const tr = s.transform ?? {};
  const center: [number, number] = [w / 2, h / 2];
  const position = vec2(evaluate("vec2", tr.position, lf), center);
  // scale は数値(縦横同じ)か [x, y]。1が等倍
  const raw = isKeyed(tr.scale) ? tr.scale.value : tr.scale;
  const sc = evaluate(typeof raw === "number" ? "float" : "vec2", tr.scale, lf);
  const scale = vec2(sc, [1, 1]);
  const rotation = Number(evaluate("float", tr.rotation, lf) ?? 0) || 0;
  const anchor = vec2(evaluate("vec2", tr.anchor, lf), center);
  const op = evaluate("float", s.opacity, lf);
  const opacity = Math.max(0, Math.min(1, op === undefined || op === null ? 1 : Number(op)));
  return { opacity, inv: inverseTransform(w, h, position, scale, rotation, anchor) };
}
