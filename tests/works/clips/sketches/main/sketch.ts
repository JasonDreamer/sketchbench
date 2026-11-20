import { defineSketch } from "@sketchbench/runtime";

// クリップトラック・クリップ内のキーフレーム・音声・イベント・マーカー・拍の確認
export default defineSketch({
  mode: "pure",
  renderer: "canvas2d",
  tracks: { words: { fields: { text: "text", size: "float", color: "color" }, tail: 0.3 } },
  params: { hue: { type: "float", default: 200, min: 0, max: 360 } },
  async setup({ assets }) {
    return { song: await assets.audio("beat.wav") };
  },
  draw({ g, t, width, height, p, tracks, events, section, beats }, { song }) {
    g.fillStyle = `hsl(${p.hue}, 30%, ${8 + song.pulse(t, 0.2) * 30}%)`;
    g.fillRect(0, 0, width, height);
    g.fillStyle = "#fff";
    g.font = "14px sans-serif";
    g.fillText(`beat ${beats(t).toFixed(2)} section ${section("b", t).toFixed(2)} flash ${events.count("flash", t)}`, 10, 20);
    for (const c of tracks.words.at(t)) {
      g.globalAlpha = 1 - c.after / 0.3;
      g.fillStyle = String(c.value.color);
      g.font = `${Number(c.value.size)}px sans-serif`;
      g.fillText(String(c.value.text), 40 + c.index * 120, height / 2 + c.progress * 40);
      g.globalAlpha = 1;
    }
  },
});
