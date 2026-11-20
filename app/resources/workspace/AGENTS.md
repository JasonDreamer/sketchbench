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
| `band(名前, t)`(名前は "low"・"mid"・"high") | 帯域のエネルギー(0〜1)。low は〜200Hz、mid は200〜2000Hz、high は2000Hz〜 |
| `beat(t)` | 何拍目か、拍の中の進み具合、何小節目か、小節の何拍目か |
| `pulse(t, 減衰秒)` / `onset(t, 減衰秒)` | 直前のビート/オンセットから減衰する値 |
| `beats` / `downbeats` / `onsets` / `bpm` | 時刻の配列と推定BPM |

`offset` は作品のフレーム数です。`t` は作品の時刻なので、offset を変えてもスケッチは書き換えずに済みます。

### MIDI・イベント・マーカー・拍

```ts
async setup({ assets }) {
  return { drums: await assets.midi("drums.mid") };   // assets/drums.mid
},
draw({ t, events, section, beats }, { drums }) {
  const hit = drums.envelope({ note: 36 }, t, { decay: 0.25 }); // ノート36のADSR(0〜1)
  const notes = drums.notesAt(t);                             // 鳴っているノート
  const cc = drums.ccAt(1, t);                                // CC1の値(0〜1)
  const flash = events.since("block_appear", t) < 0.2;        // eventMap の名前で引く
  const k = section("drop", t);                               // マーカー区間内の0〜1(外は -1)
  const beat = beats(t);                                      // bpm からの拍単位の時刻
},
```

`project.json` に書くもの(時刻はフレーム):

```json
"bpm": 128,
"beatOffset": 12,
"markers": [{ "name": "intro", "start": 0 }, { "name": "drop", "start": 900, "end": 1800 }],
"eventMap": {
  "block_appear": { "midi": "assets/events.mid", "note": 36 },
  "flash": { "times": [1.5, 3.0] }
}
```

`eventMap` はノート番号と演出の名前の対応表です。割り当てを変えてもスケッチは書き換えずに済みます。

### クリップトラック(歌詞・テロップなど)

「どの時刻に何を」はアプリのタイムラインで作り、スケッチは宣言して読むだけにします。

```ts
export default defineSketch({
  tracks: { words: { fields: { text: "text", color: "color" }, tail: 0.5 } },
  draw({ g, t, tracks }) {
    for (const c of tracks.words.at(t)) {
      // c.value.text、c.progress(0〜1)、c.elapsed(秒)、c.after(終了後の秒)、c.index(通し番号)
    }
  },
});
```

クリップは `project.json` の `layers[].tracks.words` に id をキーにして入ります。JSONで直接足すときは配列で書けば、アプリが id を振ります(`{ "start": 120, "end": 180, "value": { "text": "あ" } }`)。

### キーフレーム

params の値と、クリップのフィールドの値は、そのままの値の代わりに `{ "value": 既定値, "keys": [...] }` と書くと時刻で動きます。スケッチ側は何も変えずに `p.density` や `c.value.size` が評価済みの値になります。

```json
"params": {
  "density": { "value": 0.4, "keys": [
    { "frame": 0, "value": 0, "ease": "easeInOut" },
    { "frame": 120, "value": 1 }
  ] }
}
```

- `frame` は params ならレイヤーの時刻、クリップのフィールドならクリップ開始からの相対フレームです(クリップを動かすとキーも一緒に動きます)
- `ease` はそのキーから次のキーまでの区間に効きます。`"linear"`(既定)、`"hold"`、`"easeIn"`、`"easeOut"`、`"easeInOut"`、または cubic-bezier の `[x1, y1, x2, y2]`
- float・int・vec2・color は補間し、それ以外の型(bool、enum、text など)は次のキーまで値を保ちます
- 最初のキーより前は最初のキーの値、最後のキーより後は最後のキーの値になります

アプリでは、パラメータパネルの項目にカーソルを乗せて `I` でキーを打ち、`Alt+I` で消します。キーのある項目の値を変えると、そのフレームにキーが打たれます。タイムラインの◆はドラッグで移動、`Delete` で削除、`E` でイージングを切り替えます。

### レイヤーの合成

`project.json` の `layers` は先頭が一番下で、後ろほど上に重なります。各レイヤーに次の設定を書けます(省略時の値はかっこ内)。

| キー | 内容 |
| --- | --- |
| `start` / `end` | 作品のフレームで、レイヤーが出る区間(0 / 尺) |
| `offset` / `speed` | レイヤー時刻の起点と速度(0 / 1)。スケッチの `t`・`frame` は `(作品のフレーム − start) × speed + offset` |
| `opacity` | 不透明度 0〜1(1)。キーフレーム可 |
| `blend` | `"normal"`・`"add"`・`"multiply"`・`"screen"`・`"difference"`("normal") |
| `transform` | `position`(出力のピクセル、中央)、`scale`(数値か `[x, y]`、1)、`rotation`(度、時計回り、0)、`anchor`(レイヤーのピクセル、中央)。どれもキーフレーム可 |
| `matte` | `{ "layer": "id", "mode": "alpha" }` で別のレイヤーのアルファか輝度で切り抜く(mode は alpha・alphaInverted・luma・lumaInverted)。マットに使ったレイヤーは単独では表示されない |
| `resolution` | 内部解像度 0.1〜1(1)。重いレイヤーだけ下げる。スケッチの `width`・`height` はこの倍率をかけた値 |
| `visible` | `false` で合成に入れない(true) |

```json
{ "id": "words", "sketch": "sketches/words", "start": 120, "blend": "screen",
  "transform": { "rotation": { "value": 0, "keys": [{ "frame": 0, "value": -5 }, { "frame": 30, "value": 0, "ease": "easeOut" }] } },
  "matte": { "layer": "mask", "mode": "luma" } }
```

合成の値(opacity と transform)とparamsのキーの `frame` はレイヤーのフレームです。レイヤーを動かすとキーも一緒に動きます。

ほかのレイヤーの描画結果は `inputs.layer("id")` でcanvasとして引けます(`g.drawImage(inputs.layer("bg"), 0, 0)` など)。引けるのは自分より下にあり、今のフレームで出ているレイヤーだけで、それ以外は null です。

音声・MIDI・`events`・`section`・`beats`・`tracks` の関数には、スケッチが受け取った `t`(レイヤー時刻)をそのまま渡せます。アプリが作品時刻に直して引きます。`markers` と、`song.beats` などの時刻の配列は作品時刻の秒です。

### 状態を持つ表現(stateful)

粒子や物理のように前のフレームの結果から次を作る表現は、状態を `setup` で作り、`simulate` で1フレームずつ進め、`draw` では読むだけにします。アプリが2秒ごとに状態を複製して保存点にし、シークでは直前の保存点から計算し直すので、どの時刻へ飛んでも、書き出しでも同じ結果になります。

```ts
export default defineSketch({
  mode: "stateful",
  renderer: "canvas2d",
  setup() {
    return { x: new Float32Array(1000), y: new Float32Array(1000), n: 0 };
  },
  simulate(s, { dt, p, rand, frame }) {
    // フレーム0から順に1回ずつ呼ばれる。s を書き換えるか、新しい状態を返す
  },
  draw({ g }, s) {
    // s を読んで描くだけ(書き換えない)
  },
});
```

- 状態は複製できるデータ(オブジェクト・配列・型付き配列・Map・Set)で持ちます。関数やクラスのインスタンス、canvas は入れられません
- 乱数は引数の `rand` を使います(シードとフレーム番号で決まる)
- params やクリップを変えると保存点を作り直すので、長い作品の後半では最初の表示に時間がかかります

### MIDIコントローラーでparamsを動かす

`project.json` の `ccMap` に `"レイヤー.param": { "cc": 1, "min": 0, "max": 1 }` を書くか、アプリの「MIDI」→「学習」で割り当てます。プレビュー中はコントローラーの値で動き、録音すると `source` に録音ファイルが入り、書き出しではその値を使います。スケッチからライブのMIDI入力は直接読めません(書き出しで結果が変わるため)。

### シェーダー(ISF)

`sketch.ts` の代わりに `shader.fs` を置くとシェーダーモードになります。先頭のJSONで入力を宣言し、`TIME`、`RENDERSIZE`、`FRAMEINDEX`、`isf_FragNormCoord` が使えます。今は単一パスで、入力型は float、bool、long、color、point2D、event だけです。

## 守ること

- `Math.random()` と `Date.now()` より、引数の `rand` と `t` を使ってください。どちらも差し替え済みで結果は同じですが、意図が読みやすくなります
- 前のフレームの結果を使う表現(粒子・物理・蓄積)は `mode: "stateful"` と `simulate` で書いてください(「状態を持つ表現」)。`mode: "sequential"` は既存のコードをそのまま動かすためのもので、戻るシークのたびに先頭から描き直します
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

## 確かめ方(MCP)

Sketchbench のMCPサーバー(`sketchbench`)につながっていれば、人の操作なしに確かめられます。スケッチを直したら、完了を報告する前に必ず次を行ってください。

1. `get_diagnostics`: 変換エラー、型エラー(TypeScript 7)、project.json の検証エラー、実行時の例外、描画時間
2. `render_frames`(指定した秒やフレームの画像)か `render_contact_sheet`(区間をn枚並べた1枚)で見た目を確かめる
3. 直したらもう一度 1 と 2

| ツール | 内容 |
| --- | --- |
| `list_works` / `get_work` / `list_templates` | 作品の一覧、project.json と宣言、テンプレートの一覧 |
| `create_work` / `add_sketch` | テンプレートから作品を作る、作品にスケッチとレイヤーを足す |
| `render_frames` / `render_contact_sheet` | 描いた画像を返す(長辺1024pxのJPEG) |
| `get_diagnostics` / `inspect_asset` | 診断、素材の中身(音声のBPM・ビート、MIDIのノートなど) |
| `set_params` / `set_keyframes` / `update_layer` / `set_layers` / `set_event_map` / `get_tracks` / `set_clips` | project.json を変える(直接書かずにこれを使う)。`set_keyframes` は params・クリップのフィールド・合成の値(`property`)のキーを丸ごと置き換え、`update_layer` はレイヤー1つの設定を部分的に変える |
| `export` | MP4(音声付き)か連番PNGで書き出し、終わるまで待つ。大きさ(`width`・`height`)、連番PNGの `depth`(8・16)と `alpha`(straight・premultiplied・none)、`motionBlur`(`{ samples, shutter }`、pure のスケッチだけ)、MP4の `loudness`(`{ lufs: -14 }` など。トゥルーピークは -1 dBTP に抑える)、ファイル名に付ける `name` を指定できる |
| `queue_add` / `queue_list` / `queue_cancel` | レンダーキュー。`export` と同じ仕様を配列で積み、登録順に1つずつ書き出す(16:9 と 9:16 などをまとめて)。積んだらすぐ返るので、`queue_list` で状態を見る |
| `list_history` / `restore_history` | 履歴(git)の一覧と巻き戻し(その作品だけ) |
| `get_ui_context` | 人がアプリで指し示しているもの(作品、フレーム、選んだクリップ、プレビュー上で Alt+ドラッグで囲んだ範囲)と画像 |

スケッチのファイル(sketch.ts、shader.fs)は直接編集してかまいません。保存すると5秒後に履歴へ自動でコミットされ、MCPのツールで変えた分はツール呼び出しごとにコミットされます。

### MCPサーバーの登録

アプリに同梱の `sb.exe` を、標準入出力のMCPサーバーとして登録します(アプリが起動していなければ、ウィンドウを出さずに起動します)。

- Claude Code: `claude mcp add sketchbench -- <sb.exe のパス> mcp`
- Codex: `codex mcp add sketchbench -- <sb.exe のパス> mcp`、または `~/.codex/config.toml` に

```toml
[mcp_servers.sketchbench]
command = "<sb.exe のパス>"
args = ["mcp"]
```

書き出しはコマンドでもできます: `sb render <作品> --format mp4 --from 0 --to 300`
