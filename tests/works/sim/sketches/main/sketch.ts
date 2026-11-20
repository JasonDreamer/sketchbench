import { defineSketch } from "@sketchbench/runtime";

// 状態あり: 毎フレーム粒を足し、重力で落とす(保存点とシークの確認用)
const N = 4000;
export default defineSketch({
  mode: "stateful",
  renderer: "canvas2d",
  params: { gravity: { type: "float", default: 400, min: 0, max: 2000 } },
  setup() {
    return { x: new Float32Array(N), y: new Float32Array(N), vx: new Float32Array(N), vy: new Float32Array(N), n: 0 };
  },
  simulate(s, { dt, p, rand, width }) {
    for (let k = 0; k < 20 && s.n < N; k++, s.n++) {
      s.x[s.n] = rand() * width;
      s.y[s.n] = 0;
      s.vx[s.n] = rand.range(-60, 60);
      s.vy[s.n] = rand.range(0, 100);
    }
    for (let i = 0; i < s.n; i++) {
      s.vy[i] += p.gravity * dt;
      s.x[i] += s.vx[i] * dt;
      s.y[i] += s.vy[i] * dt;
    }
  },
  draw({ g, width, height }, s) {
    g.fillStyle = "#0c0f14";
    g.fillRect(0, 0, width, height);
    g.fillStyle = "#ffd27a";
    for (let i = 0; i < s.n; i++) if (s.y[i] < height) g.fillRect(s.x[i], s.y[i], 3, 3);
  },
});
