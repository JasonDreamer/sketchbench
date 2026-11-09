---
name: sketchbench-sketch
description: Sketchbenchの作品(works/<作品名>/)を新しく作る、またはスケッチ(sketch.ts、shader.fs)を書き換えるときに使う。p5・Canvas2D・WebGL・ISFシェーダーで、時刻tの関数として映像を描く手順。
---

# Sketchbenchのスケッチを書く

1. 新しい作品なら、`templates/` から近いものを選んで `works/<作品名>/` に複製する。作品名は英数字・`-`・`_` だけにする
2. `works/<作品名>/project.json` で解像度・fps・尺(フレーム数)を決める。fpsは `[分子, 分母]`(29.97なら `[30000, 1001]`)
3. `sketches/main/sketch.ts` を書く。書き方は作業フォルダの `AGENTS.md` と `types/sketchbench-runtime.d.ts` に従う
   - 描画は `t` と `frame` だけから決める。前のフレームの結果に頼らない
   - 乱数は `rand`。フレームごとに同じ値が出るので、ちらつかせたくない値はインデックスから決める(`rand.noise(i, t)` など)
   - 調整したい値は `params` に宣言し、draw では `p.名前` で読む
4. 保存するとアプリのプレビューが更新される。エラーはアプリのコンソールに出る
5. 書き出しはアプリの「MP4」「連番PNG」ボタンで行う。出力は `works/<作品名>/renders/`

## よくある間違い

- p5のグローバル関数(`circle()`)を使う。`g.circle()` と書く
- p5の `setup` で `createCanvas` を呼ぶ。キャンバスはアプリが作る
- `frameCount` や `millis()` で動かす。`frame` と `t` を使う
- 外部URLの画像やCDNのライブラリを読む。素材は `assets/` に置く
