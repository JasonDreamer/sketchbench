// 開発用: PNG(8bit・16bit、RGBA・RGB、インターレースなし)を読んで RGBA8 の画素にする。回帰テストで画像を比べるのに使う
import { inflateSync } from "node:zlib";

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("PNGではない");
  let o = 8;
  let w = 0, h = 0, depth = 8, color = 6, interlace = 0;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString("ascii", o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      color = data[9];
      interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    o += 12 + len;
  }
  if (interlace) throw new Error("インターレースのPNGは読めない");
  const ch = color === 6 ? 4 : color === 2 ? 3 : 0;
  if (!ch || (depth !== 8 && depth !== 16)) throw new Error(`未対応の形式(色 ${color}、深度 ${depth})`);
  const bpp = (ch * depth) / 8;
  const stride = w * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
    prev = cur;
  }
  const rgba = new Uint8Array(w * h * 4);
  const step = depth / 8;
  for (let i = 0; i < w * h; i++) {
    for (let k = 0; k < 4; k++) {
      // 16bit は上位バイト(ビッグエンディアンの先頭)を使う
      rgba[i * 4 + k] = k < ch ? px[(i * ch + k) * step] : 255;
    }
  }
  return { width: w, height: h, rgba };
}

/** 2枚の差: RGBの差の平均(0〜255)と、差が threshold を超える画素の割合 */
export function comparePng(a, b, threshold = 16) {
  if (a.width !== b.width || a.height !== b.height) return { sizeMismatch: true, mean: Infinity, over: 1 };
  let sum = 0, over = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(a.rgba[i * 4 + k] - b.rgba[i * 4 + k]);
      sum += d;
      if (d > m) m = d;
    }
    if (m > threshold) over++;
  }
  return { mean: sum / (n * 3), over: over / n };
}
