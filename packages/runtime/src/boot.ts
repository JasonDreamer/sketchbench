// スケッチWebViewの入口。仮想時計と乱数を最初に差し替えてから、モードに応じてプレビューか書き出しを始める。

import { real, withRealTimers, onError } from "./clock.js";
import { install as installRandom } from "./rand.js";
import { errorText, listen, log, mode, post, query, setPhase, work } from "./bridge.js";
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
        await engine.render(frame);
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
          async write(chunk: { data: Uint8Array; position: number }) {
            const r = await fetch(`/export/write?job=${job}&pos=${chunk.position}`, { method: "POST", body: chunk.data });
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
    for (const f of frames) {
      await engine.render(f);
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
        const px = engine.out2d.getImageData(0, 0, width, height).data;
        sharedView!.set(px);
        const r = await post(`/export/frame?job=${job}&i=${f}`);
        if (!r.ok) throw new Error(`フレーム送信失敗: ${await r.text()}`);
      }
      n++;
      if (n % 10 === 0) post(`/export/progress?job=${job}&done=${n}`).catch(() => {});
    }
    if (output) await withRealTimers(() => output.finalize());
    if (sharedView) (window as any).chrome.webview.releaseBuffer(sharedView.buffer);
    await post(`/export/done?job=${job}`);
  } catch (e) {
    log("error", `書き出し失敗: ${errorText(e)}`);
    await fail(e);
  }
}

if (mode === "export") exportJob();
else if ((mode as string) === "verify") import("./verify.js").then((m) => m.verify());
else preview();
