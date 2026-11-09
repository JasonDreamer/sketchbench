// 保存からプレビュー反映までの時間を測る。アプリを起動した状態で実行する。
// 使い方: node tools/measure-reload.mjs <sketch.ts> <アプリのログ> [回数]
import { readFileSync, writeFileSync } from "node:fs";

const [file, logFile, nArg] = process.argv.slice(2);
const n = Number(nArg ?? 10);
const orig = readFileSync(file, "utf8");
const writes = [];
for (let i = 0; i < n; i++) {
  // 線の太さを変えて保存する(見た目が変わる変更)
  const src = orig.replace(/g\.strokeWeight\(([\d.]+)\)/, `g.strokeWeight(${2 + (i % 3)})`);
  const t = Date.now();
  writeFileSync(file, src);
  writes.push(t);
  await new Promise((r) => setTimeout(r, 1200));
}
writeFileSync(file, orig);
await new Promise((r) => setTimeout(r, 1200));
const rendered = [...readFileSync(logFile, "utf8").matchAll(/変更の検知から描画まで (\d+) ms\(描画時刻 (\d+)\)/g)].map((m) => ({ detectToRender: +m[1], at: +m[2] }));
const res = writes.map((w) => {
  const r = rendered.find((x) => x.at >= w && x.at - w < 1200);
  return r ? { saveToRender: r.at - w, detectToRender: r.detectToRender } : null;
});
const ok = res.filter(Boolean);
const s = (k) => ok.map((x) => x[k]).sort((a, b) => a - b);
const med = (v) => v[v.length >> 1];
console.log(JSON.stringify({ samples: n, measured: ok.length, saveToRenderMs: { median: med(s("saveToRender")), max: Math.max(...s("saveToRender")), min: Math.min(...s("saveToRender")) }, detectToRenderMs: { median: med(s("detectToRender")), max: Math.max(...s("detectToRender")) } }, null, 1));
