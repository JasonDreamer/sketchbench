// プレビューキャッシュ(RAM)。pure なレイヤーの描画結果を、合成用のWebGLコンテキストのテクスチャとしてフレームごとに持つ。
// キーにはそのフレームの入力(コードの版、評価済みの params、有効なクリップ、レイヤー時刻、作品全体の設定)を入れるので、
// キーフレームを動かしたときは値が変わったフレームだけが外れる。上限を超えたら古く使ったものから捨てる。
// 書き出しでは使わない(毎回描く)。

export interface CacheEntry {
  tex: WebGLTexture;
  bytes: number;
  layer: string;
  frame: number;
}

export class FrameCache {
  private map = new Map<string, CacheEntry>();
  bytes = 0;
  /** 全レイヤーが揃っている(合成をすぐ作れる)フレーム */
  complete = new Set<number>();
  /** 変わったら UI へ知らせる */
  changed = false;

  constructor(private gl: WebGL2RenderingContext, public budget: number) {}

  get(key: string): WebGLTexture | null {
    const e = this.map.get(key);
    if (!e) return null;
    // 使った順に並べ直す(Map は入れた順)
    this.map.delete(key);
    this.map.set(key, e);
    return e.tex;
  }

  put(key: string, e: CacheEntry) {
    const old = this.map.get(key);
    if (old) this.remove(key, old);
    this.map.set(key, e);
    this.bytes += e.bytes;
    while (this.bytes > this.budget && this.map.size > 1) {
      const [k, v] = this.map.entries().next().value!;
      this.remove(k, v);
    }
  }

  private remove(key: string, e: CacheEntry) {
    this.map.delete(key);
    this.bytes -= e.bytes;
    this.gl.deleteTexture(e.tex);
    if (this.complete.delete(e.frame)) this.changed = true;
  }

  /** そのレイヤーのものを全部捨てる(コードを読み直したとき) */
  dropLayer(layer: string) {
    for (const [k, v] of [...this.map]) if (v.layer === layer) this.remove(k, v);
    this.markAllIncomplete();
  }

  clear() {
    for (const [k, v] of [...this.map]) this.remove(k, v);
    this.markAllIncomplete();
  }

  markAllIncomplete() {
    if (this.complete.size) this.changed = true;
    this.complete.clear();
  }

  /** 揃っているフレームを区間 [start, end) の列にする(UIのタイムラインに出す) */
  ranges(): [number, number][] {
    const f = [...this.complete].sort((a, b) => a - b);
    const out: [number, number][] = [];
    for (const x of f) {
      const last = out[out.length - 1];
      if (last && last[1] === x) last[1] = x + 1;
      else out.push([x, x + 1]);
    }
    return out;
  }
}

/** 文字列の短いハッシュ(FNV-1a 32bit を2本) */
export function hashText(s: string): string {
  let a = 0x811c9dc5, b = 0x9e3779b1;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x85ebca77);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}
