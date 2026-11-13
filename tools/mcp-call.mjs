// 開発中の動作確認: `sb mcp` を起動し、MCPのツールを順に呼ぶ(エージェントアプリと同じ標準入出力の経路)。
// 使い方: node tools/mcp-call.mjs <sb.exe> <出力フォルダ> '<[{"name":"ツール","arguments":{...}}, ...]>'
// 呼び出しには __sleep(待つ)と until(結果に文字列が出るまで呼び直す)も使える。
// 画像の結果は出力フォルダに <連番>_<ツール>_<n>.jpg として保存し、文字の結果は標準出力に出す。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [sb, outDir, callsJson] = process.argv.slice(2);
const calls = callsJson ? JSON.parse(callsJson) : [{ name: "__list" }];
mkdirSync(outDir, { recursive: true });
const child = spawn(sb, ["mcp"], { stdio: ["pipe", "pipe", "inherit"], env: process.env });
child.on("exit", (code) => { console.log(`sb が終了した(code ${code})`); process.exit(1); });
const rl = createInterface({ input: child.stdout });
const waiting = new Map();
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id != null && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
});
let id = 0;
const req = (method, params) => new Promise((resolve) => {
  const i = ++id;
  waiting.set(i, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
});
const init = await req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-call", version: "0" } });
console.log("server:", JSON.stringify(init.result?.serverInfo ?? init.error));
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
let k = 0;
for (const c of calls) {
  k++;
  if (c.name === "__list") {
    const r = await req("tools/list", {});
    console.log("tools:", r.result.tools.map((t) => `${t.name}${t.annotations?.destructiveHint ? "(破壊的)" : ""}`).join(", "));
    continue;
  }
  // 待つ: {"name":"__sleep","ms":1000}。until を付けると、そのツールの結果の文字列に until が含まれるまで ms ごとに呼び直す(最大 tries 回)
  if (c.name === "__sleep") {
    await new Promise((r) => setTimeout(r, c.ms ?? 1000));
    continue;
  }
  if (c.until) {
    for (let i = 0; i < (c.tries ?? 120); i++) {
      const r = await req("tools/call", { name: c.name, arguments: c.arguments ?? {} });
      const text = (r.result?.content ?? []).map((p) => p.text ?? "").join("");
      if (text.includes(c.until)) break;
      await new Promise((res) => setTimeout(res, c.ms ?? 1000));
    }
  }
  const t0 = Date.now();
  const r = await req("tools/call", { name: c.name, arguments: c.arguments ?? {} });
  const ms = Date.now() - t0;
  if (r.error) { console.log(`#${k} ${c.name} エラー(${ms}ms):`, JSON.stringify(r.error)); continue; }
  console.log(`#${k} ${c.name}${r.result.isError ? " [isError]" : ""}(${ms}ms)`);
  let n = 0;
  for (const part of r.result.content ?? []) {
    if (part.type === "text") console.log(part.text.length > 3000 ? part.text.slice(0, 3000) + " …" : part.text);
    if (part.type === "image") {
      const f = join(outDir, `${String(k).padStart(2, "0")}_${c.name}_${n++}.jpg`);
      writeFileSync(f, Buffer.from(part.data, "base64"));
      console.log(`[画像] ${f}`);
    }
  }
}
child.stdin.end();
child.kill();
process.exit(0);
