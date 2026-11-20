import { defineSketch, text } from "@sketchbench/runtime";

// 文字モジュール(縦書き・ルビ・モーラ)。フォントはシステムのもの(同じ環境での回帰の確認用)
export default defineSketch({
  mode: "pure",
  renderer: "canvas2d",
  draw({ g, t, width }) {
    g.fillStyle = "#101216";
    g.fillRect(0, 0, width, 270);
    const family = "'Yu Gothic', 'Meiryo', sans-serif";
    g.fillStyle = "#eee";
    const v = text.layoutRuby(g, "｜東京《とうきょう》の夜《よる》\nABC、123。", { x: width - 40, y: 20, size: 28, family, vertical: true });
    text.drawPlaced(g, v.base, { family });
    g.fillStyle = "#fc6";
    text.drawPlaced(g, v.ruby, { family });
    const m = text.moras("きょうはっぴー");
    g.fillStyle = "#8cf";
    g.font = `24px ${family}`;
    g.fillText(m.slice(0, Math.floor(t * 4) + 1).join("/"), 20, 200);
  },
});
