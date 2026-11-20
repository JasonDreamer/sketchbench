// 回帰テストと決定性テスト。tests/works の作品とテンプレートを一時の作業フォルダに写し、MCP で連番PNGに書き出して確かめる。
//   決定性: 同じ範囲を順方向・逆順・シャッフルで描き、全フレームのハッシュが一致するか
//          (stateful・sequential は途中のフレームから描くので、保存点や先頭からの追いつきも確かめる)
//   回帰: いくつかのフレームを tests/baseline の基準画像と比べる(GPUの差を見込んだ許容誤差つき)
// 使い方: node tools/regress.mjs [--update] [--only <作品>] [--keep]
//   --update 基準画像を今の結果で作り直す / --keep 一時の作業フォルダを消さない
// 先に開発中のアプリを閉じておく(sb は起動中のアプリにつなぐので、作業フォルダが違うと別の作品を見てしまう)
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { comparePng, decodePng } from "./png.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const update = args.includes("--update");
const keep = args.includes("--keep");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const sb = join(repo, "app/target/debug/sb.exe");
const exe = join(repo, "app/target/debug/sketchbench.exe");
/** 基準画像と比べるフレームと、決定性を確かめる範囲 */
const FRAMES = [0, 30, 75];
const DET = [40, 50];
/** 許容誤差: RGBの差の平均(0〜255)と、16階調を超えて違う画素の割合 */
const TOL = { mean: 0.5, over: 0.002 };

const running = execFileSync("tasklist", ["/FI", "IMAGENAME eq sketchbench.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" });
if (running.includes("sketchbench.exe")) {
  console.error("sketchbench.exe が起動している。閉じてから実行する(作業フォルダの違うアプリにつながってしまう)");
  process.exit(2);
}

// 一時の作業フォルダに作品を写す
const ws = mkdtempSync(join(tmpdir(), "sb-regress-"));
mkdirSync(join(ws, "works"), { recursive: true });
const works = [];
for (const w of readdirSync(join(repo, "tests/works"))) {
  cpSync(join(repo, "tests/works", w), join(ws, "works", w), { recursive: true });
  works.push(w);
}
for (const t of readdirSync(join(repo, "app/resources/workspace/templates"))) {
  cpSync(join(repo, "app/resources/workspace/templates", t), join(ws, "works", `tpl-${t}`), { recursive: true });
  works.push(`tpl-${t}`);
}
// clips の音声はリポジトリに置かず、ここで作る(120BPMのクリック、3.5秒、48kHz モノラル16bit)
writeWav(join(ws, "works/clips/assets/beat.wav"), 3.5, 48000, (t) => {
  const k = (t - 0.1) % 0.5;
  return t >= 0.1 && k < 0.03 ? Math.sin(2 * Math.PI * 1000 * k) * Math.exp(-k * 120) * 0.8 : 0;
});

const started = Date.now();
const client = await mcp();
const list = await client.call("list_works", {});
for (const w of works) if (!list.includes(`"${w}"`)) fail(`作業フォルダが違う(list_works に ${w} がない)。起動中のアプリを閉じてから実行する`);

const results = [];
for (const w of works.filter((x) => !only || x === only)) {
  const r = { work: w, problems: [] };
  results.push(r);
  const diag = JSON.parse(await client.call("get_diagnostics", { work: w }));
  if (diag.compile?.length) r.problems.push(`変換: ${JSON.stringify(diag.compile).slice(0, 200)}`);
  if (diag.types?.errors?.length) r.problems.push(`型: ${JSON.stringify(diag.types.errors).slice(0, 200)}`);
  if (diag.projectJson?.errors?.length) r.problems.push(`project.json: ${diag.projectJson.errors.join(" / ").slice(0, 200)}`);
  if (diag.missingAssets?.length) r.problems.push(`素材がない: ${diag.missingAssets.map((m) => m.path).join(", ")}`);
  // 決定性
  const hashes = {};
  for (const order of ["forward", "reverse", "shuffle"]) {
    const dir = await exportPng(client, w, DET[0], DET[1], order);
    if (!dir) {
      r.problems.push(`${order} で書き出せない`);
      continue;
    }
    hashes[order] = readdirSync(dir).filter((f) => f.endsWith(".png")).sort().map((f) => createHash("sha256").update(readFileSync(join(dir, f))).digest("hex"));
  }
  if (hashes.forward && hashes.reverse && hashes.shuffle) {
    const bad = hashes.forward.map((h, i) => (h !== hashes.reverse[i] || h !== hashes.shuffle[i] ? DET[0] + i : -1)).filter((i) => i >= 0);
    r.determinism = bad.length ? `一致しない ${bad.join(",")}` : `${hashes.forward.length}フレーム一致`;
    if (bad.length) r.problems.push(`決定性: フレーム ${bad.join(",")} が順番で変わる`);
  }
  // 回帰
  r.frames = [];
  for (const f of FRAMES) {
    const dir = await exportPng(client, w, f, f + 1, "forward");
    const file = dir && join(dir, `frame_${String(f).padStart(6, "0")}.png`);
    if (!file || !existsSync(file)) {
      r.problems.push(`フレーム ${f} を書き出せない`);
      continue;
    }
    const base = join(repo, "tests/baseline", w, `frame_${String(f).padStart(6, "0")}.png`);
    if (update || !existsSync(base)) {
      mkdirSync(dirname(base), { recursive: true });
      cpSync(file, base);
      r.frames.push(`${f}: 基準を作った`);
      continue;
    }
    const c = comparePng(decodePng(readFileSync(file)), decodePng(readFileSync(base)));
    const ok = !c.sizeMismatch && c.mean <= TOL.mean && c.over <= TOL.over;
    r.frames.push(`${f}: 平均差 ${c.mean.toFixed(3)}、外れ ${(c.over * 100).toFixed(3)}%${ok ? "" : " ✗"}`);
    if (!ok) r.problems.push(`回帰: フレーム ${f} が基準と違う(平均差 ${c.mean.toFixed(3)}、外れ ${(c.over * 100).toFixed(3)}%)`);
  }
  // 描画中の例外
  const after = JSON.parse(await client.call("get_diagnostics", { work: w }));
  const errs = (after.runtime ?? []).filter((x) => x.level === "error");
  if (errs.length) r.problems.push(`実行時: ${errs.map((x) => x.message).join(" / ").slice(0, 300)}`);
}
client.close();

let failed = 0;
for (const r of results) {
  const ok = r.problems.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? "OK  " : "NG  "} ${r.work.padEnd(22)} 決定性: ${r.determinism ?? "-"} / ${(r.frames ?? []).join(" / ")}`);
  for (const p of r.problems) console.log(`       ${p}`);
}
console.log(`${results.length - failed}/${results.length} 通過(${((Date.now() - started) / 1000).toFixed(0)}秒)${update ? "。基準画像を作り直した" : ""}`);

// このテストのために sb が起動したアプリだけを止める
try {
  execFileSync("powershell", ["-NoProfile", "-Command", `Get-Process sketchbench -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${exe}' -and $_.StartTime -gt (Get-Date).AddMilliseconds(-${Date.now() - started + 5000}) } | Stop-Process -Force`]);
} catch {}
if (!keep) rmSync(ws, { recursive: true, force: true });
else console.log(`作業フォルダ: ${ws}`);
process.exit(failed ? 1 : 0);

async function exportPng(client, work, from, to, order) {
  const text = await client.call("export", { work, format: "png", from, to, order });
  try {
    return JSON.parse(text).path;
  } catch {
    console.error(`  ${work} ${from}-${to} ${order}: ${text.slice(0, 200)}`);
    return null;
  }
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

function writeWav(file, seconds, rate, f) {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, f(i / rate))) * 32767), 44 + i * 2);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, b);
}

/** sb mcp に標準入出力でつなぐ最小のMCPクライアント(tools/mcp-call.mjs と同じ経路) */
async function mcp() {
  const child = spawn(sb, ["mcp"], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, SB_WORKSPACE: ws } });
  const rl = createInterface({ input: child.stdout });
  const waiting = new Map();
  rl.on("line", (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id != null && waiting.has(m.id)) {
      waiting.get(m.id)(m);
      waiting.delete(m.id);
    }
  });
  let id = 0;
  const req = (method, params) =>
    new Promise((res) => {
      const i = ++id;
      waiting.set(i, res);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
    });
  await req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "regress", version: "0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return {
    async call(name, a) {
      const r = await req("tools/call", { name, arguments: a });
      return (r.result?.content ?? []).map((p) => p.text ?? "").join("") || JSON.stringify(r.error ?? null);
    },
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}
