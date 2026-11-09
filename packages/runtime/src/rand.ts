// シード固定の乱数。Math.random と crypto.getRandomValues もこれに差し替える。
// 純粋スケッチは毎フレーム「シードとフレーム番号」から初期化するので、順不同に描いても同じ結果になる。

let state = 1;

function next(): number {
  // mulberry32
  state = (state + 0x6d2b79f5) | 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function hash(a: number, b: number): number {
  let h = (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35)) | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  return h | 0;
}

export function seed(base: number, frame: number) {
  state = hash(base | 0, frame | 0);
}

export interface Rand {
  (): number;
  range(min: number, max: number): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
  /** 値ノイズ(-1〜1)。同じ引数なら常に同じ値 */
  noise(x: number, y?: number, z?: number): number;
}

const fade = (t: number) => t * t * (3 - 2 * t);
const lattice = (x: number, y: number, z: number) => (hash(hash(x, y), z) >>> 0) / 4294967296 * 2 - 1;

export const rand: Rand = Object.assign(() => next(), {
  range: (min: number, max: number) => min + (max - min) * next(),
  int: (min: number, max: number) => Math.floor(min + (max - min + 1) * next()),
  pick: <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)],
  chance: (p: number) => next() < p,
  noise(x: number, y = 0, z = 0) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = fade(x - xi), yf = fade(y - yi), zf = fade(z - zi);
    const l = (a: number, b: number, t: number) => a + (b - a) * t;
    const c = (dx: number, dy: number, dz: number) => lattice(xi + dx, yi + dy, zi + dz);
    return l(
      l(l(c(0, 0, 0), c(1, 0, 0), xf), l(c(0, 1, 0), c(1, 1, 0), xf), yf),
      l(l(c(0, 0, 1), c(1, 0, 1), xf), l(c(0, 1, 1), c(1, 1, 1), xf), yf),
      zf,
    );
  },
});

export function install() {
  Math.random = () => next();
  const orig = crypto.getRandomValues.bind(crypto);
  (crypto as any).getRandomValues = <T extends ArrayBufferView | null>(arr: T): T => {
    if (!arr) return orig(arr as any) as T;
    const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    for (let i = 0; i < u8.length; i++) u8[i] = Math.floor(next() * 256);
    return arr;
  };
}
