// キーフレームの評価。ランタイム(描画)とUI(パネルの表示)の両方が使う。
// project.json の params の値は { value, keys: [{ frame, value, ease? }] }。frame はレイヤー時刻のフレーム。
// ease はそのキーから次のキーまでの区間に効く。数値・vec2・色は補間し、それ以外は次のキーまで値を保つ。

export type Ease = "linear" | "hold" | "easeIn" | "easeOut" | "easeInOut" | [number, number, number, number];

export interface Key {
  frame: number;
  value: unknown;
  ease?: Ease;
}

export interface Keyed {
  value: unknown;
  keys?: Key[];
}

const PRESETS: Record<string, [number, number, number, number]> = {
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
};

/** CSSの cubic-bezier と同じ曲線で、x(時間の進み)から y(値の進み)を求める */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bx = (t: number) => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t * t * (1 - t) + t ** 3;
  const by = (t: number) => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t * t * (1 - t) + t ** 3;
  // 二分法でxからtを求める(単調なので必ず収束する)
  let lo = 0, hi = 1, t = x;
  for (let i = 0; i < 40; i++) {
    t = (lo + hi) / 2;
    if (bx(t) < x) lo = t;
    else hi = t;
  }
  return by(t);
}

export function easeAmount(ease: Ease | undefined, x: number): number {
  if (!ease || ease === "linear") return x;
  if (ease === "hold") return 0;
  const c = Array.isArray(ease) ? ease : PRESETS[ease];
  return c ? cubicBezier(c[0], c[1], c[2], c[3], x) : x;
}

function hexToRgba(hex: string): number[] {
  const m = hex.replace("#", "");
  const n = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  return [0, 2, 4, 6].map((i) => (i < n.length ? parseInt(n.slice(i, i + 2), 16) : 255));
}

function rgbaToHex(c: number[], withAlpha: boolean): string {
  const h = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return "#" + h(c[0]) + h(c[1]) + h(c[2]) + (withAlpha ? h(c[3]) : "");
}

/** 2つの値の間を k(0〜1)で補間する。補間できない型は a を返す */
export function lerpValue(type: string, a: unknown, b: unknown, k: number): unknown {
  if (type === "float") return (a as number) + ((b as number) - (a as number)) * k;
  if (type === "int") return Math.round((a as number) + ((b as number) - (a as number)) * k);
  // vec2 と、ISFの色([r, g, b, a]の0〜1)は要素ごとに補間する
  if ((type === "vec2" || type === "rgba") && Array.isArray(a) && Array.isArray(b)) return a.map((x, i) => x + ((b[i] ?? x) - x) * k);
  if (type === "color" && typeof a === "string" && typeof b === "string") {
    const ca = hexToRgba(a), cb = hexToRgba(b);
    return rgbaToHex(ca.map((v, i) => v + (cb[i] - v) * k), a.length > 7 || b.length > 7);
  }
  return a;
}

/** 補間できる型か(できない型はホールドになる) */
export function interpolates(type: string): boolean {
  return type === "float" || type === "int" || type === "vec2" || type === "color" || type === "rgba";
}

/** キーフレームの値か(project.json の { value, keys }) */
export function isKeyed(v: unknown): v is Keyed {
  return !!v && typeof v === "object" && !Array.isArray(v) && "value" in (v as object);
}

/** frame(小数可)での値。キーがなければ value */
export function evaluate(type: string, entry: unknown, frame: number): unknown {
  if (!isKeyed(entry)) return entry;
  const keys = (entry.keys ?? []).filter((k) => k && typeof k.frame === "number").slice().sort((a, b) => a.frame - b.frame);
  if (keys.length === 0) return entry.value;
  if (frame <= keys[0].frame) return keys[0].value;
  const last = keys[keys.length - 1];
  if (frame >= last.frame) return last.value;
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1].frame <= frame) i++;
  const a = keys[i], b = keys[i + 1];
  if (!interpolates(type) || a.ease === "hold") return a.value;
  const x = (frame - a.frame) / (b.frame - a.frame);
  return lerpValue(type, a.value, b.value, easeAmount(a.ease, x));
}
