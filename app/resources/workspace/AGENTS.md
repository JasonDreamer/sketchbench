# Sketchbench 作業フォルダ

このフォルダは映像制作アプリ Sketchbench の作業フォルダです。1本の映像が `works/<作品名>/` の1フォルダで、保存するとアプリのプレビューに即座に反映されます。

## フォルダ構成

```
works/<作品名>/
  project.json       作品の正(解像度・fps・尺・レイヤー・paramsの値)
  sketches/<名前>/
    sketch.ts        描画コード(TypeScript)
    shader.fs        またはISFシェーダー(sketch.tsの代わり)
  assets/            画像・フォント・データなど
  .cache/            アプリが作るキャッシュ(触らない)
  renders/           書き出し先(触らない)
templates/           新規作品のひな形
types/               型定義(アプリが更新するので編集しない)
```

## スケッチの書き方

描画は「時刻tの関数」として書きます。前のフレームの状態に頼らず、`t`(秒)と `frame` から毎回描くと、任意の時刻へのシークと書き出しが同じ結果になります。

```ts
import { defineSketch } from "@sketchbench/runtime";

export default defineSketch({
  mode: "pure",            // 時刻tだけで結果が決まるなら "pure"
  renderer: "p5",          // "canvas2d" | "webgl" | "p5"
  params: {
    count: { type: "int", default: 24, min: 3, max: 80 },
    color: { type: "color", default: "#9fd3ff" },
  },
  setup({ assets }) {
    return {};             // 戻り値は draw の第2引数になる
  },
  draw({ g, t, frame, width, height, p, rand }, state) {
    g.background(12);      // p5 なら g は p5 インスタンス
  },
  dispose(state) {},       // ホットリロード前に呼ばれる
});
```

| 名前 | 内容 |
| --- | --- |
| `g` | rendererのコンテキスト。canvas2d は CanvasRenderingContext2D、webgl は WebGL2RenderingContext、p5 は p5インスタンス |
| `t` / `frame` | 秒とフレーム番号。書き出し時も同じ値 |
| `width` / `height` | 出力解像度(project.json の値) |
| `p` | params宣言の値。project.json の `layers[].params` で上書きできる |
| `rand` | シード固定の乱数。`rand()`、`rand.range(a, b)`、`rand.int(a, b)`、`rand.pick(配列)`、`rand.chance(確率)`、`rand.noise(x, y, z)` |
| `assets` | setupで使う。`assets.audio("song.wav")`、`assets.image("a.png")`、`assets.json("data.json")`、`assets.font("名前", "f.ttf")` は `assets/` 以下を読む |

paramsの型は float、int、bool、color、vec2、enum、text、file、curve、list\<text>。

### p5

- `g` が p5 インスタンスなので、`g.circle(...)`、`g.background(...)` のように書きます。グローバル関数(`circle()` など)は使えません
- アプリが `noLoop()` と `redraw()` で1フレームずつ駆動します。`createCanvas`、`frameRate`、`loop` は呼ばないでください
- 時間は `frameCount` や `millis()` より、引数の `t` と `frame` を使ってください

### 音に合わせる

音声は `project.json` の `audio` に登録すると再生と書き出しに入り、スケッチからは `assets.audio()` で解析済みの値を時刻で引けます。リアルタイムの解析(Web AudioのAnalyserNode)は使わないでください。シークや書き出しで値がずれます。

```json
"audio": [{ "asset": "assets/song.wav", "offset": 0 }]
```

```ts
async setup({ assets }) {
  return { song: await assets.audio("song.wav") };
},
draw({ g, t }, { song }) {
  const kick = song.pulse(t, 0.15);     // ビートの瞬間に1、そこから減衰
  const low = song.band("low", t);     // 低音のエネルギー(0〜1)
  const b = song.beat(t);              // { index, phase, bar, beatInBar, downbeat }
},
```

| 関数 | 内容 |
| --- | --- |
| `rms(t)` | 音量(0〜1) |
| `band("low" | "mid" | "high", t)` | 帯域のエネルギー(0〜1)。low は〜200Hz、mid は200〜2000Hz、high は2000Hz〜 |
| `beat(t)` | 何拍目か、拍の中の進み具合、何小節目か、小節の何拍目か |
| `pulse(t, 減衰秒)` / `onset(t, 減衰秒)` | 直前のビート/オンセットから減衰する値 |
| `beats` / `downbeats` / `onsets` / `bpm` | 時刻の配列と推定BPM |

`offset` は作品のフレーム数です。`t` は作品の時刻なので、offset を変えてもスケッチは書き換えずに済みます。

### シェーダー(ISF)

`sketch.ts` の代わりに `shader.fs` を置くとシェーダーモードになります。先頭のJSONで入力を宣言し、`TIME`、`RENDERSIZE`、`FRAMEINDEX`、`isf_FragNormCoord` が使えます。今は単一パスで、入力型は float、bool、long、color、point2D、event だけです。

## 守ること

- `Math.random()` と `Date.now()` より、引数の `rand` と `t` を使ってください。どちらも差し替え済みで結果は同じですが、意図が読みやすくなります
- 前のフレームの結果を残す表現(フィードバック、粒子の蓄積)は、今は `mode: "sequential"` で書いてください。シークは先頭からの再実行になります
- 外部のURLから素材やライブラリを読み込まないでください。素材は `assets/` に置きます。使えるライブラリは同梱の `p5` だけです(今後増えます)
- `project.json` は人もアプリも編集します。書き換えるときはJSONとして正しい形を保ち、知らないキーは消さないでください
- `types/`、`.cache/`、`renders/` は編集しないでください

## テンプレート

| 名前 | 内容 |
| --- | --- |
| `templates/p5-basic` | p5で円を回す |
| `templates/canvas2d-basic` | Canvas2Dで線を流す |
| `templates/shader-basic` | ISFで同心円を描く |

新しい作品は、テンプレートのフォルダを `works/<作品名>/` に複製して作ります(アプリの「新規」でも同じことができます)。

## 確かめ方

保存するとアプリのプレビューに反映されます。変換エラーや実行時の例外はアプリのコンソールに出ます。描画結果を画像で確かめる仕組み(MCPの `render_frames`)は今後追加します。
