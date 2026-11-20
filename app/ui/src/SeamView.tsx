// ループの継ぎ目の確認。ループの最後のフレームと最初のフレームを並べ、その差分を、範囲の中の普通の1フレームぶんの差と比べる。
// 継ぎ目の差が普通の差と同じくらいなら、つなぎ目は目立たない。画像は書き出し用のWebViewで描いたPNG(劣化なし)を使う。
import { createSignal, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

type Img = { frame: number; data: ImageData; url: string };

async function decode(b64: string): Promise<{ data: ImageData; url: string }> {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: "image/png" });
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext("2d")!;
  g.drawImage(bmp, 0, 0);
  return { data: g.getImageData(0, 0, bmp.width, bmp.height), url: URL.createObjectURL(blob) };
}

/** RGBの差の平均(0〜1)と、差を4倍にした画像 */
function diff(a: ImageData, b: ImageData): { mean: number; url: Promise<string> } {
  const n = Math.min(a.data.length, b.data.length);
  const out = new ImageData(a.width, a.height);
  let sum = 0;
  for (let i = 0; i < n; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[i + c] - b.data[i + c]);
      sum += d;
      out.data[i + c] = Math.min(255, d * 4);
    }
    out.data[i + 3] = 255;
  }
  const c = new OffscreenCanvas(a.width, a.height);
  c.getContext("2d")!.putImageData(out, 0, 0);
  return { mean: sum / ((n / 4) * 3 * 255), url: c.convertToBlob({ type: "image/png" }).then((b) => URL.createObjectURL(b)) };
}

export function SeamView(props: { start: number; end: number; label: (f: number) => string; close: () => void }) {
  const [imgs, setImgs] = createSignal<Img[] | null>(null);
  const [seam, setSeam] = createSignal<{ mean: number; url: string } | null>(null);
  const [normal, setNormal] = createSignal<number | null>(null);
  const [error, setError] = createSignal("");
  onMount(async () => {
    const last = props.end - 1, first = props.start;
    const frames = [last, first, Math.min(first + 1, last)];
    try {
      const r = await invoke<{ images: { frame: number; png: string }[] }>("render_stills", { frames, maxSize: 960 });
      const byFrame = new Map(r.images.map((i) => [i.frame, i.png]));
      const dec = await Promise.all(frames.map(async (f) => ({ frame: f, ...(await decode(byFrame.get(f)!)) })));
      setImgs(dec);
      const s = diff(dec[0].data, dec[1].data);
      setSeam({ mean: s.mean, url: await s.url });
      setNormal(diff(dec[1].data, dec[2].data).mean);
    } catch (e) {
      setError(String(e));
    }
  });
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  const verdict = () => {
    const s = seam()?.mean, n = normal();
    if (s == null || n == null) return "";
    if (s <= Math.max(n * 1.5, 0.002)) return "継ぎ目の差は普通の1フレームと同じくらいです。";
    return `継ぎ目の差が普通の1フレームの ${(s / Math.max(n, 1e-6)).toFixed(1)} 倍あります。最後のフレームの次が最初のフレームにつながるよう調整してください。`;
  };
  return (
    <div class="seam">
      <h3>ループの継ぎ目</h3>
      <Show when={!error()} fallback={<p class="hint">描けませんでした: {error()}</p>}>
        <Show when={imgs()} fallback={<p class="hint">最後と最初のフレームを描いています…</p>}>
          {(im) => (
            <>
              <div class="seam-row">
                <figure><img src={im()[0].url} alt="" /><figcaption>最後 {props.label(im()[0].frame)}</figcaption></figure>
                <figure><img src={im()[1].url} alt="" /><figcaption>最初 {props.label(im()[1].frame)}</figcaption></figure>
                <Show when={seam()}>{(s) => <figure><img src={s().url} alt="" /><figcaption>差分(4倍)</figcaption></figure>}</Show>
              </div>
              <p>
                継ぎ目の差 <b>{seam() ? pct(seam()!.mean) : "…"}</b> ・ 範囲の中の普通の1フレームの差 {normal() != null ? pct(normal()!) : "…"}
              </p>
              <p class="hint">{verdict()}</p>
            </>
          )}
        </Show>
      </Show>
      <div class="actions"><button onClick={props.close}>閉じる</button></div>
    </div>
  );
}
