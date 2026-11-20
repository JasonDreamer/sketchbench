import { defineSketch } from "@sketchbench/runtime";

// 逐次: 消さずに描き重ね、呼ばれた回数を状態に持つ(戻るシークで先頭からやり直すかの確認用)
export default defineSketch({
  mode: "sequential",
  renderer: "canvas2d",
  setup({ g, width, height }) {
    g.fillStyle = "#000";
    g.fillRect(0, 0, width, height);
    return { calls: 0 };
  },
  draw({ g, width, height }, s) {
    s.calls++;
    const x = (s.calls * 37) % width;
    g.fillStyle = `hsl(${(s.calls * 13) % 360}, 80%, 60%)`;
    g.fillRect(x, (s.calls * 23) % height, 40, 40);
    g.fillStyle = "#000";
    g.fillRect(0, 0, 220, 50);
    g.fillStyle = "#fff";
    g.font = "32px sans-serif";
    g.fillText(`calls ${s.calls}`, 10, 38);
  },
});
