// スケッチWebViewの入口。仮想時計と乱数を最初に差し替えてから、モードに応じてプレビューか書き出しを始める。

import { real, withRealTimers, onError } from "./clock.js";
import { install as installRandom } from "./rand.js";
import { errorText, label, listen, log, mode, post, query, setPhase, work } from "./bridge.js";
import { Engine } from "./engine.js";

installRandom();
onError((e) => log("error", `タイマー/rAFのコールバックで例外: ${errorText(e)}`));

const engine = new Engine(document.getElementById("stage")!);

async function preview() {
  type TimeMsg = { frame: number; playing: boolean; fps: number; duration: number; unixMs: number };
  let time: TimeMsg = { frame: 0, playing: false, fps: 30, duration: 300, unixMs: real.unixMs() };
  let dirty = true;
  let busy = false;
  let reloadPending = false;
  // 計測用: Rustが変更を検知した時刻(UNIX ms)
  let reloadDetectedAt = 0;

  await listen("sb:time", (m: TimeMsg) => {
    time = m;
    if (!m.playing) dirty = true;
  });
  // ライブMIDI: CC割り当てだけに使う(プレビューのみ。書き出しは録音ファイルの値)
  await listen("sb:midi", (m: { type: string; channel: number; controller: number; value: number }) => {
    if (m.type !== "cc") return;
    engine.liveCc.set(`${m.channel}:${m.controller}`, m.value);
    engine.liveCc.set(`*:${m.controller}`, m.value);
    dirty = true;
  });
  await listen("sb:reload", (m: { unixMs: number }) => {
    reloadPending = true;
    reloadDetectedAt = m.unixMs;
  });

  // プレビューにフォーカスがあるときのキー操作はUIへ渡す(ショートカットはUIが持つ)
  addEventListener("keydown", (e) => {
    if (e.code === "Space" || e.key === " " || e.key.startsWith("Arrow") || e.key === "Home") e.preventDefault();
    post("/key", JSON.stringify({ code: e.code, key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey })).catch(() => {});
  });

  setPhase("setup");
  await engine.load();
  setPhase("ready");

  // 描画時間を2秒ごとに送る(get_diagnostics の frameTimeMs)
  let frameTimes: number[] = [];
  real.setInterval(() => {
    if (frameTimes.length === 0) return;
    const s = [...frameTimes].sort((a, b) => a - b);
    const avg = s.reduce((a, b) => a + b, 0) / s.length;
    post("/stats", JSON.stringify({ label, frames: s.length, avgMs: Math.round(avg * 100) / 100, p95Ms: Math.round(s[Math.floor(s.length * 0.95)] * 100) / 100, maxMs: Math.round(s[s.length - 1] * 100) / 100 })).catch(() => {});
    frameTimes = [];
  }, 2000);
  installRegionSelect(engine);

  // 描画のペースは差し替え前の本物のrAFで決める
  const tick = async () => {
    real.requestAnimationFrame(tick);
    if (busy) return;
    busy = true;
    try {
      if (reloadPending) {
        reloadPending = false;
        setPhase("setup");
        await engine.load();
        setPhase("ready");
        dirty = true;
      }
      const measuring = reloadDetectedAt > 0 && dirty;
      let f = time.frame;
      if (time.playing) f += ((real.unixMs() - time.unixMs) / 1000) * time.fps;
      const dur = engine.project?.duration ?? time.duration;
      let frame = Math.floor(f + 1e-6);
      if (dur > 0) frame = ((frame % dur) + dur) % dur;
      if (frame !== engine.lastFrame || dirty) {
        dirty = false;
        const r0 = real.performanceNow();
        await engine.render(frame);
        frameTimes.push(real.performanceNow() - r0);
        if (measuring) {
          const done = real.unixMs();
          log("info", `変更の検知から描画まで ${Math.round(done - reloadDetectedAt)} ms(描画時刻 ${Math.round(done)})`, { detectedUnixMs: reloadDetectedAt, renderedUnixMs: done });
          reloadDetectedAt = 0;
        }
      }
    } catch (e) {
      log("error", errorText(e));
    } finally {
      busy = false;
    }
  };
  real.requestAnimationFrame(tick);
}

async function exportJob() {
  const job = query.get("job")!;
  const format = query.get("format") ?? "mp4";
  const from = Number(query.get("from") ?? 0);
  const to = Number(query.get("to") ?? 0);
  const fail = (e: unknown) => post(`/export/fail?job=${job}`, errorText(e));
  try {
    setPhase("setup");
    if (!(await engine.load())) throw new Error("スケッチを読み込めない(ログを参照)");
    setPhase("ready");
    const { width, height, fps } = engine.project;
    const frameDur = fps[1] / fps[0];

    // frames・sheet: 描いたフレームをJPEGで返す(MCPの render_frames と render_contact_sheet)
    if (format === "frames" || format === "sheet") {
      await post(`/export/ready?job=${job}`);
      const maxSize = Number(query.get("maxSize") ?? 1024);
      const scale = Math.min(1, maxSize / Math.max(width, height));
      const jpeg = async (c: OffscreenCanvas) => {
        const b = await withRealTimers(() => c.convertToBlob({ type: "image/jpeg", quality: 0.85 }));
        return new Uint8Array(await b.arrayBuffer());
      };
      if (format === "frames") {
        const list = (query.get("frames") ?? "").split(",").filter(Boolean).map(Number);
        for (const f of list) {
          await engine.render(f);
          const c = new OffscreenCanvas(Math.round(width * scale), Math.round(height * scale));
          c.getContext("2d")!.drawImage(engine.output, 0, 0, c.width, c.height);
          const r = await post(`/export/image?job=${job}&i=${f}`, await jpeg(c));
          if (!r.ok) throw new Error(await r.text());
        }
      } else {
        const n = Number(query.get("count") ?? 12);
        const cols = Math.ceil(Math.sqrt(n));
        const rows = Math.ceil(n / cols);
        const cw = Math.floor(Math.min(maxSize / cols, (maxSize / rows) * (width / height)));
        const ch = Math.floor(cw * (height / width));
        const sheet = new OffscreenCanvas(cw * cols, ch * rows);
        const g = sheet.getContext("2d")!;
        g.fillStyle = "#000";
        g.fillRect(0, 0, sheet.width, sheet.height);
        for (let i = 0; i < n; i++) {
          const f = Math.min(to - 1, from + Math.floor((i * (to - from)) / n));
          await engine.render(f);
          const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
          g.drawImage(engine.output, x, y, cw, ch);
          // フレーム番号と秒を左上に
          const label = `${f} (${(f * frameDur).toFixed(2)}s)`;
          g.font = `${Math.max(10, Math.round(ch / 12))}px sans-serif`;
          g.fillStyle = "rgba(0,0,0,0.6)";
          g.fillRect(x, y, g.measureText(label).width + 8, Math.max(14, Math.round(ch / 12) + 6));
          g.fillStyle = "#fff";
          g.fillText(label, x + 4, y + Math.max(11, Math.round(ch / 12)));
        }
        const r = await post(`/export/image?job=${job}&i=-1`, await jpeg(sheet));
        if (!r.ok) throw new Error(await r.text());
      }
      await post(`/export/done?job=${job}`);
      return;
    }

    let sharedView: Uint8Array | null = null;
    if (format === "png") {
      const got = new Promise<ArrayBuffer>((resolve) => {
        (window as any).chrome.webview.addEventListener("sharedbufferreceived", (e: any) => resolve(e.getBuffer()), { once: true });
      });
      await post(`/export/ready?job=${job}`);
      sharedView = new Uint8Array(await got);
    } else {
      await post(`/export/ready?job=${job}`);
    }

    // MP4: WebCodecs + Mediabunny。H.264で通らなければAV1にする(WebView2はH.265を使えない。フェーズ0)
    let output: any = null;
    let source: any = null;
    // 音声: Rustコアがミックスした48kHzのPCMを受け取り、映像と同じ時刻の基準で多重化する
    const SR = 48000;
    let audioSource: any = null;
    let audioPcm: Float32Array | null = null;
    let audioSent = 0; // 送ったサンプル数(1チャンネルあたり)
    let mbAudioSample: any = null;
    if (format === "mp4") {
      await withRealTimers(async () => {
        const mb: any = await import("mediabunny");
        const bitrate = Math.round(width * height * fps[0] / fps[1] * 0.2);
        let codec = "avc";
        if (!(await mb.canEncodeVideo("avc", { width, height, bitrate }))) {
          if (await mb.canEncodeVideo("av1", { width, height, bitrate })) codec = "av1";
          else throw new Error(`${width}x${height} をH.264でもAV1でもエンコードできない(ffmpeg経由はフェーズ5)`);
        }
        const writable = new WritableStream({
          async write(chunk: { data: Uint8Array<ArrayBuffer>; position: number }) {
            const r = await fetch(`/export/write?job=${job}&pos=${chunk.position}`, { method: "POST", body: chunk.data as Uint8Array<ArrayBuffer> });
            if (!r.ok) throw new Error(`書き込み失敗: ${await r.text()}`);
          },
        });
        output = new mb.Output({ format: new mb.Mp4OutputFormat(), target: new mb.StreamTarget(writable, { chunked: true }) });
        source = new mb.CanvasSource(engine.output, { codec, bitrate, keyFrameInterval: 2 });
        output.addVideoTrack(source, { frameRate: fps[0] / fps[1] });
        if ((engine.project.audio ?? []).length > 0) {
          const r = await fetch(`/work/${encodeURIComponent(work)}/mixdown/${from}-${to}@${SR}`);
          if (!r.ok) throw new Error(`音声をミックスできない: ${await r.text()}`);
          audioPcm = new Float32Array(await r.arrayBuffer());
          const acodec = (await mb.canEncodeAudio("aac", { numberOfChannels: 2, sampleRate: SR, bitrate: 192000 })) ? "aac" : "opus";
          audioSource = new mb.AudioSampleSource({ codec: acodec, bitrate: 192000 });
          output.addAudioTrack(audioSource);
          mbAudioSample = mb.AudioSample;
          log("info", `音声: ${acodec} 48kHz ステレオ ${(audioPcm.length / 2 / SR).toFixed(2)}秒`);
        }
        await output.start();
        log("info", `MP4書き出し: ${codec} ${width}x${height} ${bitrate} bps`);
      });
    }

    // 描く順番(純粋スケッチの決定性の確認用)。MP4は常に順方向
    const frames = Array.from({ length: to - from }, (_, i) => from + i);
    const order = query.get("order") ?? "forward";
    if (order === "reverse") frames.reverse();
    if (order === "shuffle") {
      let s = 12345;
      for (let i = frames.length - 1; i > 0; i--) {
        s = (s * 1103515245 + 12345) >>> 0;
        const j = s % (i + 1);
        [frames[i], frames[j]] = [frames[j], frames[i]];
      }
    }
    let n = 0;
    // 内訳(ms): 描画と、エンコード・送信
    let tRender = 0, tOut = 0;
    for (const f of frames) {
      const t0 = real.performanceNow();
      await engine.render(f);
      const t1 = real.performanceNow();
      tRender += t1 - t0;
      if (format === "mp4") {
        await withRealTimers(() => source.add((f - from) * frameDur, frameDur));
        // 映像の進みに合わせて、1秒ぶんずつ音声を送る
        if (audioPcm) {
          const until = Math.min(audioPcm.length / 2, Math.ceil((f - from + 1) * frameDur * SR));
          while (audioSent < until && (until - audioSent >= SR || f === to - 1)) {
            const n = Math.min(SR, audioPcm.length / 2 - audioSent);
            const data = audioPcm.slice(audioSent * 2, (audioSent + n) * 2);
            const ts = audioSent / SR;
            await withRealTimers(() => audioSource.add(new mbAudioSample({ data, format: "f32", numberOfChannels: 2, sampleRate: SR, timestamp: ts })));
            audioSent += n;
          }
        }
      } else {
        engine.readPixels(sharedView!);
        const r = await post(`/export/frame?job=${job}&i=${f}`);
        if (!r.ok) throw new Error(`フレーム送信失敗: ${await r.text()}`);
      }
      tOut += real.performanceNow() - t1;
      n++;
      if (n % 10 === 0) post(`/export/progress?job=${job}&done=${n}`).catch(() => {});
    }
    log("info", `書き出しの内訳: 描画 ${(tRender / n).toFixed(1)} ms/フレーム、エンコード・送信 ${(tOut / n).toFixed(1)} ms/フレーム(${n}フレーム)`);
    if (output) await withRealTimers(() => output.finalize());
    if (sharedView) (window as any).chrome.webview.releaseBuffer(sharedView.buffer);
    await post(`/export/done?job=${job}`);
  } catch (e) {
    log("error", `書き出し失敗: ${errorText(e)}`);
    await fail(e);
  }
}

/**
 * プレビュー上を Alt+ドラッグで囲むと、その範囲(出力画像に対する0〜1の矩形)をRustへ送る。
 * エージェントが get_ui_context で読み、「ここを」の指示に使う。Escか、囲まずにクリックで解除
 */
function installRegionSelect(engine: Engine) {
  const box = document.createElement("div");
  box.style.cssText = "position:absolute;border:2px solid #f2a541;background:rgba(242,165,65,0.12);pointer-events:none;display:none;z-index:10";
  document.body.appendChild(box);
  let start: { x: number; y: number } | null = null;
  const toImage = (e: MouseEvent) => {
    const r = engine.output.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const show = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const r = engine.output.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = `${r.left + Math.min(a.x, b.x) * r.width}px`;
    box.style.top = `${r.top + Math.min(a.y, b.y) * r.height}px`;
    box.style.width = `${Math.abs(b.x - a.x) * r.width}px`;
    box.style.height = `${Math.abs(b.y - a.y) * r.height}px`;
  };
  const clear = () => {
    box.style.display = "none";
    post("/region", "null").catch(() => {});
  };
  addEventListener("pointerdown", (e) => {
    if (!e.altKey) {
      if (box.style.display === "block") clear();
      return;
    }
    start = toImage(e);
  });
  addEventListener("pointermove", (e) => start && show(start, toImage(e)));
  addEventListener("pointerup", (e) => {
    if (!start) return;
    const end = toImage(e);
    const rect = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) };
    start = null;
    if (rect.w < 0.01 || rect.h < 0.01) return clear();
    const p = engine.project;
    post("/region", JSON.stringify({ ...rect, pixels: { x: Math.round(rect.x * p.width), y: Math.round(rect.y * p.height), w: Math.round(rect.w * p.width), h: Math.round(rect.h * p.height) }, frame: engine.lastFrame })).catch(() => {});
  });
  addEventListener("keydown", (e) => e.key === "Escape" && clear());
}

if (mode === "export") exportJob();
else if ((mode as string) === "verify") import("./verify.js").then((m) => m.verify());
else preview();
