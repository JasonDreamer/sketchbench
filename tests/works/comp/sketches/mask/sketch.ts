import { defineSketch } from "@sketchbench/runtime";

// マット用: 透明の上に白い円を描く(半径が時刻で変わる)
export default defineSketch({
  mode: "pure",
  renderer: "canvas2d",
  draw({ g, t, width, height }) {
    g.clearRect(0, 0, width, height);
    g.fillStyle = "#fff";
    g.beginPath();
    g.arc(width / 2, height / 2, height * (0.2 + 0.15 * Math.sin(t * 2)), 0, Math.PI * 2);
    g.fill();
  },
});
