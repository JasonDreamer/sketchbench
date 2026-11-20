// 文字モジュール。Canvas2Dに機能がない縦書きとルビを組み、歌詞をモーラに分け、フォントのグリフを輪郭と点列で返す。
// 組版は位置の計算だけを行い、描くのは drawPlaced(Canvas2D の fillText)。p5 では g.drawingContext を渡す。
// グリフはフォントファイルを opentype.js(MIT)で読む。

/** 置いた1文字 */
export interface Placed {
  ch: string;
  /** 文字の中心 */
  x: number;
  y: number;
  /** 文字の大きさ(px) */
  size: number;
  /** 縦書きで90度回して置く(英数字・括弧・長音など) */
  rotate: boolean;
  /** 元の文字列での位置(文字単位) */
  index: number;
  /** 何行目(縦書きでは右から何列目) */
  line: number;
}

export interface RubySegment {
  base: string;
  ruby?: string;
}

export interface LayoutOptions {
  /** 1文字目の中心(縦書きは1列目の中心のx、上端のy。横書きは左端のx、1行目の中心のy) */
  x: number;
  y: number;
  /** 文字の大きさ(px) */
  size: number;
  /** フォント(CSSの font-family。assets.font で読み込んだ名前) */
  family: string;
  /** フォントの太さなど(CSS の font の前半。例 "bold") */
  weight?: string;
  /** 文字の間隔(文字の大きさに対する割合) */
  letterSpacing?: number;
  /** 行の間隔(文字の大きさに対する割合。既定 0.6) */
  lineGap?: number;
  /** 1行に入れる最大の長さ(px)。超えたら折り返す */
  maxLength?: number;
}

/** 縦書きで90度回す文字(英数字・記号・括弧・長音・波線) */
const ROTATE = /[A-Za-z0-9!-/:-@[-`{-~ー－〜～―‐…‥（）「」『』［］｛｝〈〉《》【】〔〕]/;
/** 縦書きで右上に寄せる小書きの仮名 */
const SMALL = /[ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰ-ㇿ]/;
/** 縦書きで右上へ置く句読点 */
const PUNCT = /[、。，．]/;

const fontOf = (o: { size: number; family: string; weight?: string }, size = o.size) => `${o.weight ? o.weight + " " : ""}${size}px ${o.family}`;

/**
 * 縦書きの配置。右から左へ列を進める。"\n" と maxLength で改行する
 */
export function layoutVertical(g: CanvasRenderingContext2D, text: string, o: LayoutOptions): Placed[] {
  g.save();
  g.font = fontOf(o);
  const out: Placed[] = [];
  const step = o.size * (1 + (o.letterSpacing ?? 0));
  const colStep = o.size * (1 + (o.lineGap ?? 0.6));
  let line = 0, y = 0;
  const chars = [...text];
  chars.forEach((ch, index) => {
    if (ch === "\n") {
      line++;
      y = 0;
      return;
    }
    const rotate = ROTATE.test(ch);
    // 回す文字は実際の幅だけ進める(英数字は全角より狭い)
    const adv = rotate ? Math.max(g.measureText(ch).width, o.size * 0.3) + step - o.size : step;
    if (o.maxLength && y > 0 && y + adv > o.maxLength) {
      line++;
      y = 0;
    }
    let dx = 0, dy = 0;
    if (SMALL.test(ch)) {
      dx = o.size * 0.1;
      dy = -o.size * 0.1;
    } else if (PUNCT.test(ch)) {
      dx = o.size * 0.55;
      dy = -o.size * 0.55;
    }
    out.push({ ch, x: o.x - line * colStep + dx, y: o.y + y + adv / 2 + dy, size: o.size, rotate, index, line });
    y += adv;
  });
  g.restore();
  return out;
}

/** 横書きの配置(文字ごとの位置が要るとき。1文字ずつ動かす演出など) */
export function layoutHorizontal(g: CanvasRenderingContext2D, text: string, o: LayoutOptions): Placed[] {
  g.save();
  g.font = fontOf(o);
  const out: Placed[] = [];
  const lineStep = o.size * (1 + (o.lineGap ?? 0.6));
  const space = o.size * (o.letterSpacing ?? 0);
  let line = 0, x = 0;
  [...text].forEach((ch, index) => {
    if (ch === "\n") {
      line++;
      x = 0;
      return;
    }
    const w = g.measureText(ch).width;
    if (o.maxLength && x > 0 && x + w > o.maxLength) {
      line++;
      x = 0;
    }
    out.push({ ch, x: o.x + x + w / 2, y: o.y + line * lineStep, size: o.size, rotate: false, index, line });
    x += w + space;
  });
  g.restore();
  return out;
}

/** 置いた文字を描く(塗りの色などは描く前に g に設定しておく) */
export function drawPlaced(g: CanvasRenderingContext2D, items: Placed[], o: { family: string; weight?: string }) {
  g.save();
  g.textAlign = "center";
  g.textBaseline = "middle";
  let font = "";
  for (const it of items) {
    const f = fontOf({ ...o, size: it.size });
    if (f !== font) g.font = font = f;
    if (it.rotate) {
      g.save();
      g.translate(it.x, it.y);
      g.rotate(Math.PI / 2);
      g.fillText(it.ch, 0, 0);
      g.restore();
    } else {
      g.fillText(it.ch, it.x, it.y);
    }
  }
  g.restore();
}

/**
 * ルビの記法を読む(青空文庫と同じ)。「｜親文字《るび》」、または漢字の続きの直後の「《るび》」。
 * 例: "｜東京《とうきょう》へ行《い》く" → [{base:"東京", ruby:"とうきょう"}, {base:"へ"}, {base:"行", ruby:"い"}, {base:"く"}]
 */
export function parseRuby(s: string): RubySegment[] {
  const out: RubySegment[] = [];
  const re = /[｜|]([^｜|《]+)《([^》]*)》|([\p{Script=Han}々〆ヶ]+)《([^》]*)》/gu;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index! > last) out.push({ base: s.slice(last, m.index) });
    out.push({ base: m[1] ?? m[3], ruby: m[2] ?? m[4] });
    last = m.index! + m[0].length;
  }
  if (last < s.length) out.push({ base: s.slice(last) });
  return out;
}

/**
 * ルビつきの配置。親文字を横書きか縦書きで並べ、ルビをその上(縦書きでは右)に、親文字の範囲の中央へ揃える。
 * ルビが親文字より長いときは、はみ出して中央に置く
 */
export function layoutRuby(g: CanvasRenderingContext2D, segs: RubySegment[] | string, o: LayoutOptions & { vertical?: boolean; rubySize?: number }): { base: Placed[]; ruby: Placed[] } {
  const list = typeof segs === "string" ? parseRuby(segs) : segs;
  const text = list.map((x) => x.base).join("");
  const base = o.vertical ? layoutVertical(g, text, o) : layoutHorizontal(g, text, o);
  const rs = o.rubySize ?? o.size * 0.5;
  const ruby: Placed[] = [];
  let i = 0;
  g.save();
  g.font = fontOf(o, rs);
  for (const seg of list) {
    const n = [...seg.base].length;
    const span = base.filter((b) => b.index >= i && b.index < i + n);
    i += n;
    if (!seg.ruby || span.length === 0) continue;
    const chars = [...seg.ruby];
    // 行をまたぐ親文字は最初の行の分だけで揃える
    const first = span.filter((b) => b.line === span[0].line);
    if (o.vertical) {
      const top = first[0].y - o.size / 2, bottom = first[first.length - 1].y + o.size / 2;
      const len = chars.length * rs;
      const y0 = (top + bottom) / 2 - len / 2;
      chars.forEach((ch, k) => ruby.push({ ch, x: first[0].x + o.size / 2 + rs / 2, y: y0 + rs * (k + 0.5), size: rs, rotate: ROTATE.test(ch), index: k, line: first[0].line }));
    } else {
      const widths = chars.map((ch) => g.measureText(ch).width);
      const total = widths.reduce((a, b) => a + b, 0);
      const left = first[0].x - g.measureText(first[0].ch).width / 2;
      const right = first[first.length - 1].x + g.measureText(first[first.length - 1].ch).width / 2;
      let x = (left + right) / 2 - total / 2;
      chars.forEach((ch, k) => {
        ruby.push({ ch, x: x + widths[k] / 2, y: first[0].y - o.size / 2 - rs / 2, size: rs, rotate: false, index: k, line: first[0].line });
        x += widths[k];
      });
    }
  }
  g.restore();
  return { base, ruby };
}

/**
 * 仮名をモーラに分ける(歌詞を音の単位で出すとき)。小書きの ゃゅょ・ぁぃぅぇぉ・ゎ は前の文字に付け、
 * っ・ん・ー はそれぞれ1モーラ。仮名以外の文字は1文字を1つとして返す
 */
export function moras(s: string): string[] {
  const out: string[] = [];
  const attach = /[ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ]/;
  for (const ch of s) {
    if (attach.test(ch) && out.length > 0 && !/^[っッんンー]$/.test(out[out.length - 1])) out[out.length - 1] += ch;
    else if (!/\s/.test(ch)) out.push(ch);
  }
  return out;
}

// ---- グリフ(フォントファイルの輪郭) ----

export interface PathCommand {
  type: "M" | "L" | "Q" | "C" | "Z";
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}

/** フォントファイルを読んだもの。輪郭(Path2D とコマンド)と、輪郭に沿った点列を返す */
export class GlyphFont {
  private font: any;
  constructor(font: any) {
    this.font = font;
  }

  /** 文字列の幅(px) */
  width(text: string, size: number): number {
    return this.font.getAdvanceWidth(text, size);
  }

  /** 文字列の輪郭。x, y はベースラインの左端 */
  path(text: string, x: number, y: number, size: number): { commands: PathCommand[]; path2d: Path2D } {
    const p = this.font.getPath(text, x, y, size);
    const commands = p.commands as PathCommand[];
    return { commands, path2d: new Path2D(p.toPathData(3)) };
  }

  /** 1文字ずつの輪郭と送り幅(文字ごとに動かすとき) */
  glyphs(text: string, x: number, y: number, size: number): { ch: string; x: number; width: number; commands: PathCommand[]; path2d: Path2D }[] {
    const out: { ch: string; x: number; width: number; commands: PathCommand[]; path2d: Path2D }[] = [];
    let cx = x;
    for (const ch of text) {
      const w = this.font.getAdvanceWidth(ch, size);
      out.push({ ch, x: cx, width: w, ...this.path(ch, cx, y, size) });
      cx += w;
    }
    return out;
  }

  /**
   * 輪郭に沿って spacing(px)ごとに置いた点。輪郭(閉じた線)ごとの配列で返す。
   * 曲線は細かく折れ線にしてから等間隔に取るので、文字の大きさが変わっても点の間隔は同じ
   */
  points(text: string, x: number, y: number, size: number, spacing = 4): { x: number; y: number }[][] {
    return contours(this.path(text, x, y, size).commands).map((c) => resample(c, spacing));
  }
}

/** コマンドを輪郭ごとの折れ線にする */
function contours(cmds: PathCommand[]): { x: number; y: number }[][] {
  const out: { x: number; y: number }[][] = [];
  let cur: { x: number; y: number }[] = [];
  let px = 0, py = 0, sx = 0, sy = 0;
  const N = 12;
  for (const c of cmds) {
    if (c.type === "M") {
      if (cur.length > 1) out.push(cur);
      cur = [{ x: c.x!, y: c.y! }];
      px = sx = c.x!;
      py = sy = c.y!;
    } else if (c.type === "L") {
      cur.push({ x: c.x!, y: c.y! });
      px = c.x!;
      py = c.y!;
    } else if (c.type === "Q") {
      for (let i = 1; i <= N; i++) {
        const t = i / N, u = 1 - t;
        cur.push({ x: u * u * px + 2 * u * t * c.x1! + t * t * c.x!, y: u * u * py + 2 * u * t * c.y1! + t * t * c.y! });
      }
      px = c.x!;
      py = c.y!;
    } else if (c.type === "C") {
      for (let i = 1; i <= N; i++) {
        const t = i / N, u = 1 - t;
        cur.push({
          x: u * u * u * px + 3 * u * u * t * c.x1! + 3 * u * t * t * c.x2! + t * t * t * c.x!,
          y: u * u * u * py + 3 * u * u * t * c.y1! + 3 * u * t * t * c.y2! + t * t * t * c.y!,
        });
      }
      px = c.x!;
      py = c.y!;
    } else if (c.type === "Z") {
      cur.push({ x: sx, y: sy });
      if (cur.length > 1) out.push(cur);
      cur = [];
      px = sx;
      py = sy;
    }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

/** 折れ線を長さに沿って等間隔に取り直す */
function resample(line: { x: number; y: number }[], spacing: number): { x: number; y: number }[] {
  const out = [line[0]];
  let carry = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let d = spacing - carry;
    while (d <= len) {
      const k = d / len;
      out.push({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
      d += spacing;
    }
    carry = len - (d - spacing);
  }
  return out;
}

/** フォントファイルを読む(assets.glyphs から使う) */
export async function loadGlyphFont(url: string): Promise<GlyphFont> {
  const { parse } = await import("opentype.js");
  const buf = await (await fetch(url)).arrayBuffer();
  return new GlyphFont(parse(buf));
}
