// 同期の検証用に、正解のわかっているドラムの曲を作る(48kHz、16bitステレオWAV)。
// キックは各拍、スネアは2・4拍目、ハイハットは8分の裏。キックの時刻を clicks.json に書く。
// 使い方: node tools/make-beat-track.mjs <出力フォルダ> [秒数] [BPM] [先頭の無音(秒)]
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [dir, secArg, bpmArg, leadArg] = process.argv.slice(2);
const secs = Number(secArg ?? 60), bpm = Number(bpmArg ?? 120), lead = Number(leadArg ?? 0.37);
const SR = 48000, n = Math.round(secs * SR);
const L = new Float32Array(n), R = new Float32Array(n);
let seed = 7;
const noise = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
const add = (t, fn, len) => {
  const i0 = Math.round(t * SR);
  for (let i = 0; i < len * SR && i0 + i < n; i++) {
    const v = fn(i / SR);
    L[i0 + i] += v;
    R[i0 + i] += v;
  }
};
const beat = 60 / bpm, kicks = [];
for (let k = 0; lead + k * beat < secs - 0.5; k++) {
  const t = lead + k * beat;
  kicks.push(+t.toFixed(6));
  // キック: 周波数が下がる正弦波。立ち上がりは最初のサンプル
  add(t, (x) => 0.9 * Math.exp(-x * 18) * Math.sin(2 * Math.PI * (50 + 120 * Math.exp(-x * 40)) * x), 0.35);
  if (k % 2 === 1) add(t, (x) => 0.35 * Math.exp(-x * 25) * noise(), 0.2);
  add(t + beat / 2, (x) => 0.12 * Math.exp(-x * 60) * noise(), 0.06);
}
// 低いベース音を小節ごとに(拍の位置は変えない)
for (let b = 0; lead + b * 4 * beat < secs - 1; b++) {
  const f = [55, 55, 65.4, 49][b % 4];
  add(lead + b * 4 * beat, (x) => 0.15 * Math.sin(2 * Math.PI * f * x) * Math.min(1, x * 50) * Math.exp(-x * 0.8), 4 * beat);
}
const pcm = Buffer.alloc(44 + n * 4);
pcm.write("RIFF", 0); pcm.writeUInt32LE(36 + n * 4, 4); pcm.write("WAVE", 8);
pcm.write("fmt ", 12); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(2, 22);
pcm.writeUInt32LE(SR, 24); pcm.writeUInt32LE(SR * 4, 28); pcm.writeUInt16LE(4, 32); pcm.writeUInt16LE(16, 34);
pcm.write("data", 36); pcm.writeUInt32LE(n * 4, 40);
const clip = (v) => Math.max(-1, Math.min(1, v)) * 32767;
for (let i = 0; i < n; i++) { pcm.writeInt16LE(clip(L[i]) | 0, 44 + i * 4); pcm.writeInt16LE(clip(R[i]) | 0, 46 + i * 4); }
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "drums.wav"), pcm);
writeFileSync(join(dir, "clicks.json"), JSON.stringify({ bpm, lead, kicks }));
console.log(`drums.wav ${secs}s ${bpm}BPM、キック ${kicks.length} 個`);
