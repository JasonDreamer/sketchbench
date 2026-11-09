import { defineSketch } from "@sketchbench/runtime";

// Canvas2Dで線を流す最小の例。乱数は rand を使う(フレームごとに同じ値が出る)。
export default defineSketch({
  mode: "pure",
  renderer: "canvas2d",
  params: {
    density: { type: "float", default: 0.4, min: 0, max: 1 },
    color: { type: "color", default: "#9fd3ff" },
  },
  draw({ g, t, width, height, p, rand }) {
    g.fillStyle = "#0b0d12";
    g.fillRect(0, 0, width, height);
    g.strokeStyle = p.color;
    g.lineWidth = 2;
    const n = Math.round(20 + p.density * 200);
    for (let i = 0; i < n; i++) {
      // 線ごとの位置はシードとフレームでなく i で決め、時刻で動かす
      const x = ((i * 137.5) % width + t * 120 * (0.5 + (i % 7) / 7)) % width;
      const y = (i * 61.8) % height;
      const len = 40 + 120 * Math.abs(rand.noise(i * 0.1, t * 0.5));
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x, y + len);
      g.stroke();
    }
  },
});
