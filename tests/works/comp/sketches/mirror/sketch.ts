import { defineSketch } from "@sketchbench/runtime";

// inputs.layer で下のレイヤー(bg)を引き、右下に上下反転の縮小を置く
export default defineSketch({
  mode: "pure",
  renderer: "canvas2d",
  draw({ g, width, height, inputs }) {
    g.clearRect(0, 0, width, height);
    const bg = inputs.layer("bg");
    if (!bg) return;
    g.save();
    g.translate(width * 0.7, height * 0.95);
    g.scale(1, -1);
    g.drawImage(bg, 0, 0, width * 0.28, height * 0.28);
    g.restore();
    g.strokeStyle = "#ff0";
    g.lineWidth = 4;
    g.strokeRect(width * 0.7, height * 0.67, width * 0.28, height * 0.28);
  },
});
