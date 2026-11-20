import { defineSketch } from "@sketchbench/runtime";

// 全面を1色で塗る(合成の確認用)
export default defineSketch({
  mode: "pure",
  renderer: "canvas2d",
  params: { color: { type: "color", default: "#4080c0" } },
  draw({ g, width, height, p }) {
    g.fillStyle = p.color;
    g.fillRect(0, 0, width, height);
  },
});
