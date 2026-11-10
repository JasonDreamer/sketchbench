// 検証用のMIDIファイルを作る: CC1を0から127まで秒数をかけて上げ、毎秒ノート36を鳴らす。
// テンポは途中で変える(テンポマップから秒に直す処理の確認用)。
// 使い方: node tools/make-cc-midi.mjs <出力.mid> [秒数]
import { writeFileSync } from "node:fs";

const [out, secArg] = process.argv.slice(2);
const secs = Number(secArg ?? 10);
const TPQ = 480;
const vlq = (n) => { const b = [n & 0x7f]; while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80); return b; };
// 前半は120BPM(1秒=960ティック)、5秒目から60BPM(1秒=480ティック)
const tickOf = (s) => (s <= 5 ? s * 960 : 5 * 960 + (s - 5) * 480);
const ev = [];
ev.push([0, [0xff, 0x51, 0x03, 0x07, 0xa1, 0x20]]); // 500000us
ev.push([tickOf(5), [0xff, 0x51, 0x03, 0x0f, 0x42, 0x40]]); // 1000000us
for (let i = 0; i <= 127; i++) ev.push([Math.round(tickOf((i / 127) * secs)), [0xb0, 1, i]]);
for (let s = 0; s < secs; s++) {
  ev.push([Math.round(tickOf(s)), [0x90, 36, 100]]);
  ev.push([Math.round(tickOf(s + 0.1)), [0x80, 36, 0]]);
}
ev.sort((a, b) => a[0] - b[0]);
const body = [];
let last = 0;
for (const [t, bytes] of ev) { body.push(...vlq(t - last), ...bytes); last = t; }
body.push(0, 0xff, 0x2f, 0);
const trk = Buffer.from([0x4d, 0x54, 0x72, 0x6b, ...[24, 16, 8, 0].map((s) => (body.length >> s) & 255), ...body]);
const hdr = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, TPQ >> 8, TPQ & 255]);
writeFileSync(out, Buffer.concat([hdr, trk]));
console.log(`${out}: CC1 0→127 を${secs}秒、ノート36を毎秒、5秒目でテンポ120→60`);
