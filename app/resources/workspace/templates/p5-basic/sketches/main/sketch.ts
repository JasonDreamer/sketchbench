import { defineSketch } from "@sketchbench/runtime";

// p5の円を時刻tで回す最小の例。g は p5 インスタンス。
export default defineSketch({
  mode: "pure",
  renderer: "p5",
  params: {
    count: { type: "int", default: 24, min: 3, max: 80 },
    color: { type: "color", default: "#9fd3ff" },
  },
  draw({ g, t, width, height, p }) {
    g.background(12);
    g.noFill();
    g.stroke(p.color);
    g.strokeWeight(3);
    for (let i = 0; i < p.count; i++) {
      const a = (i / p.count) * Math.PI * 2 + t * 0.5;
      const r = height * 0.3 * (1 + 0.2 * Math.sin(t * 2 + i));
      g.circle(width / 2 + Math.cos(a) * r, height / 2 + Math.sin(a) * r, 40 + 20 * Math.sin(t * 3 + i));
    }
  },
});
