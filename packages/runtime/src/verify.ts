// 書き出したMP4の音と映像の同期を確かめる(開発用)。
// 映像は左端と右端の明るさからフラッシュしたフレームを、音声は振幅の立ち上がりからキックの時刻を拾い、突き合わせる。

import { withRealTimers } from "./clock.js";
import { log, post, query, work } from "./bridge.js";

export async function verify() {
  const file = query.get("file") ?? "";
  try {
    const result = await withRealTimers(async () => {
      const mb: any = await import("mediabunny");
      const input = new mb.Input({ source: new mb.UrlSource(`/work/${encodeURIComponent(work)}/files/${file}`), formats: mb.ALL_FORMATS });
      const vt = await input.getPrimaryVideoTrack();
      const at = await input.getPrimaryAudioTrack();
      if (!vt || !at) throw new Error("映像か音声のトラックがない");

      // 映像: 左右それぞれ、黒から白に変わったフレームの時刻
      const c = new OffscreenCanvas(64, 36);
      const g = c.getContext("2d", { willReadFrequently: true })!;
      const flashes: Record<"left" | "right", number[]> = { left: [], right: [] };
      const prev = { left: false, right: false };
      let frames = 0, firstVideoTs = NaN, lastVideoTs = 0;
      for await (const s of new mb.VideoSampleSink(vt).samples()) {
        s.draw(g, 0, 0, 64, 36);
        const ts = s.timestamp;
        s.close();
        if (frames === 0) firstVideoTs = ts;
        lastVideoTs = ts;
        frames++;
        const d = g.getImageData(0, 0, 64, 36).data;
        const lum = (x0: number, x1: number) => {
          let sum = 0, cnt = 0;
          for (let y = 4; y < 28; y++) for (let x = x0; x < x1; x++) { sum += d[(y * 64 + x) * 4]; cnt++; }
          return sum / cnt;
        };
        for (const [side, x0, x1] of [["left", 1, 10], ["right", 54, 63]] as const) {
          const on = lum(x0, x1) > 128;
          if (on && !prev[side]) flashes[side].push(ts);
          prev[side] = on;
        }
      }

      // 音声: 無音に近い状態からしきい値を越えた時刻(キック)
      const onsets: number[] = [];
      let firstAudioTs = NaN, audioEnd = 0, quietSince = -1;
      for await (const s of new mb.AudioSampleSink(at).samples()) {
        if (isNaN(firstAudioTs)) firstAudioTs = s.timestamp;
        const buf: AudioBuffer = s.toAudioBuffer();
        const ch = buf.getChannelData(0);
        const sr = buf.sampleRate;
        for (let i = 0; i < ch.length; i++) {
          const t = s.timestamp + i / sr;
          const v = Math.abs(ch[i]);
          if (v > 0.3 && quietSince >= 0 && t - quietSince > 0.2) {
            onsets.push(t);
            quietSince = -1;
          } else if (v < 0.3 && quietSince < 0) quietSince = t;
        }
        audioEnd = s.timestamp + buf.duration;
        s.close();
      }

      const frameDur = 1 / (frames / (lastVideoTs - firstVideoTs + (lastVideoTs - firstVideoTs) / Math.max(1, frames - 1)));
      // 各オンセットに対して、それを含むはずのフレーム(最も近い直前のフラッシュ)とのずれ
      const compare = (fl: number[]) => {
        const errs: number[] = [];
        let missing = 0;
        for (const o of onsets) {
          let best = Infinity;
          for (const f of fl) if (Math.abs(f - o) < Math.abs(best)) best = f - o;
          if (Math.abs(best) > 0.25) missing++;
          else errs.push(best);
        }
        const abs = errs.map(Math.abs).sort((a, b) => a - b);
        const ms = (x: number) => Math.round(x * 10000) / 10;
        return {
          matched: errs.length, missing, flashes: fl.length,
          meanErrorMs: ms(errs.reduce((a, b) => a + b, 0) / Math.max(1, errs.length)),
          maxAbsErrorMs: ms(abs[abs.length - 1] ?? NaN),
          withinOneFrame: errs.filter((e) => Math.abs(e) < frameDur).length,
        };
      };
      // 正解の時刻(assets/clicks.json があれば)との直接比較。音声の遅れと、映像の置き場所を別々に見る
      let truth: any = null;
      const tr = await fetch(`/work/${encodeURIComponent(work)}/files/assets/clicks.json`);
      if (tr.ok) {
        const kicks: number[] = (await tr.json()).kicks;
        const nearest = (arr: number[], x: number) => arr.reduce((b, v) => (Math.abs(v - x) < Math.abs(b - x) ? v : b), Infinity);
        const audioErr = kicks.map((k) => nearest(onsets, k) - k);
        // 映像: キックを含むフレームの先頭がフラッシュの時刻のはず
        const videoErr = kicks.map((k) => nearest(flashes.left, k) - Math.floor(k / frameDur + 1e-9) * frameDur);
        const st = (v: number[]) => {
          const a = v.map(Math.abs).sort((x, y) => x - y);
          return { meanMs: Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 1e4) / 10, maxAbsMs: Math.round(a[a.length - 1] * 1e4) / 10 };
        };
        const outliers = kicks
          .map((k, i) => ({ kick: k, audioErrMs: Math.round(audioErr[i] * 1e4) / 10, flashMinusKickMs: Math.round((nearest(flashes.left, k) - k) * 1e4) / 10 }))
          .filter((o) => Math.abs(o.flashMinusKickMs) >= frameDur * 1000 || Math.abs(o.audioErrMs) > 5);
        const extraOnsets = onsets.filter((o) => Math.abs(nearest(kicks, o) - o) > 0.05).map((o) => Math.round(o * 1000) / 1000);
        truth = { kicks: kicks.length, audioOnsetMinusKick: st(audioErr), flashFrameMinusExpectedFrame: st(videoErr), outliers, extraOnsets };
      }
      return {
        truth,
        file, videoFrames: frames, frameDurationMs: Math.round(frameDur * 1e5) / 100,
        firstVideoTs, firstAudioTs, videoEnd: lastVideoTs + frameDur, audioEnd,
        audioOnsets: onsets.length,
        groundTruth: compare(flashes.left),
        analyzedBeats: compare(flashes.right),
      };
    });
    log("info", `同期の検証: ${JSON.stringify(result)}`);
    await post("/verify/result", JSON.stringify({ ok: true, result }));
  } catch (e) {
    log("error", `同期の検証に失敗: ${e}`);
    await post("/verify/result", JSON.stringify({ ok: false, error: String(e) }));
  }
}
