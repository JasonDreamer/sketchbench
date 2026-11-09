# フェーズ0 技術検証の結果

設計書 `docs/design.md` の「先に検証する技術リスク」9項目を、Tauri 2の最小アプリ(`phase0/`)で計測した記録です。生の計測値は `phase0/results/raw.jsonl`(gitに入れない)に追記され、この文書はそこから転記しています。

## 計測環境

| 項目 | 値 |
| --- | --- |
| 日付 | 2026-11-09 |
| OS | Windows 11 Home 10.0.26300 |
| CPU / RAM | Intel Core i7-14700F(内蔵GPUなし)/ 64GB |
| GPU | NVIDIA GeForce RTX 4070 SUPER(ドライバー 32.0.16.1692)。ほかに仮想ディスプレイ(Parsec、MuMuPlayer)のアダプターあり |
| WebView2 | 157.0.4341.42(Chromium 157.0.8103.39) |
| Tauri | tauri 2.12.5(`unstable` 機能を有効)、tauri-runtime-wry 2.12.3、wry 0.57.1、webview2-com 0.39.1 |
| ビルド | Rust 1.93.0、devプロファイル(依存はopt-level 2) |

## 試作アプリの構成

`phase0/` は1つのウィンドウにUI WebViewとスケッチ用の子WebViewを置くTauri 2アプリです。

- UI WebView: `ui/index.html`。データフォルダ `%LOCALAPPDATA%\sb-phase0\ui`、起動引数は既定のまま
- スケッチ用の子WebView: `sketch/tests.html`。データフォルダ `%LOCALAPPDATA%\sb-phase0\sketch`、起動引数は次のとおり

```
--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --disable-background-timer-throttling --enable-features=CanvasDrawElement
```

- 専用URIスキーム `sb`(`http://sb.localhost/`): スケッチのページ配信、結果の返送、生存通知、フレーム受信
- トークン認証付きlocalhost HTTP(axum、127.0.0.1の空きポート): フレーム転送の比較用
- WebView2のCOM APIは webview2-com で直接呼ぶ(`src/wv2.rs`): BrowserProcessId、GetProcessInfos、ProcessFailed、PermissionRequested、CapturePreview、CreateSharedBuffer、PostSharedBufferToScript

実行方法:

```bash
cd phase0
cargo build
./target/debug/sb-phase0.exe --auto
```

`--auto` で全項目を順に流して終了します。`--only=html,hidden` で一部だけ、`--long` で最小化6.5分のタイマー計測、`--gpu-hang` でシェーダーの無限ループ試験を加えます。ボタンから項目ごとに手動実行もできます。項目8は別のバイナリ(`phase0/beat`)です。

## 結果の一覧

| # | リスク | 判定 | 要点 |
| --- | --- | --- | --- |
| 1 | 非表示ウィンドウでの描画 | 採用(方式を変更) | `visible(false)` のウィンドウはページから見て `visible` のままで、フラグなしでもrAF 60fps、6.5分置いても間引きなし。プレビューと環境を共有すると約30fpsに落ちる回があり、書き出しは専用環境にする。最小化ではフラグを付けてもタイマーが最大10秒止まる。wryの `with_native_window_occlusion` は存在しない |
| 2 | UIとスケッチのプロセス分離 | 採用 | ブラウザ・GPU・レンダラーのPIDがすべて別。スケッチの5秒ビジーループ中もUIのrAF間隔は最大16.9ms。無限ループの検知1.8秒、作り直し185ms |
| 3 | 非圧縮フレームの転送速度 | 共有メモリを採用 | 4K RGBA8 1枚の往復: 共有メモリ7.7ms、localhost HTTP 160ms、専用URIスキーム328ms(中央値) |
| 4 | HTMLレンダラー | HTML-in-Canvasを採用 | WebView2 157では起動引数なしでも `drawElementImage` が使え、1080pで6ms。foreignObjectはdata URLで読めばtaintしない(blob URLはtaint)。CSSアニメーションは仮想時計に従わない |
| 5 | WebCodecsの対応コーデック | 採用(H.265は不可) | H.264とAV1はハードウェアで4K可(60フレームを83fps・89fps)。H.265は非対応。RGB入力はBT.709リミテッドに変換されるが、H.264のVUIに色情報が入らない |
| 6 | 子WebView | 採用(リサイズ中は静止画) | UIと別のデータフォルダと起動引数を持つ子WebViewを同じウィンドウに置けた。位置合わせ0.05ms、静止画への切り替え約100ms。60Hzでリサイズすると半数近くのフレームで子WebViewが10〜18px遅れる |
| 7 | GPUの共有 | 採用(ループ上限を追加) | 環境を1つ増やすとワーキングセットが約300MB増える。4Kテクスチャコピー2.5ms。シェーダーの無限ループではスケッチ環境のGPUプロセスだけが11秒後に落ち、UIのWebGLは無事だったが、UIも最大5.9秒止まった |
| 8 | 音声解析モデル | 採用 | beat-this 1.1.0(rten)がWindowsで動き、Python版のgoldenと拍・小節頭ともF値1.0 |
| 9 | GPUの選択 | 条件付き採用 | 計測機がGPU1枚のため、内蔵と外部の切り替えは試せない。使用中のGPU名は両環境から取得できる |

## 1. 非表示ウィンドウでの描画

### 前提の訂正

設計書が挙げたwryの `with_native_window_occlusion(false)`(wry PR #1742)は、マージされずに2026年6月10日に閉じられていました。wry 0.57.1のソースにも該当するAPIはありません。同PRの説明によれば中身は `--disable-features` に `CalculateNativeWinOcclusion` を足すだけなので、試作では `additional_browser_args` に直接書きました(機能名はChromiumの `ui/base/ui_base_features.cc` で確認)。Tauriの `background_throttling` はWindowsでは未対応とソースのドキュメントに明記されています。

### 短時間の計測(各方式2.5秒、1280x720のWebGL、毎フレームreadPixelsで値を検証)

下の表は、他の計測と重ならない単独実行(5回目)の値です。「環境」の共有は、メインウィンドウのプレビュー用子WebView(`sketch` データフォルダ)と同じWebView2環境を使うことを指します。専用は、同じ起動引数で別のデータフォルダ(`sketch2`)にした場合です。

| 条件 | 環境 | visibilityState | rAF | setTimeout(0) | MessageChannel | Worker + OffscreenCanvas | setInterval(500ms)の最大間隔 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 表示(基準) | 共有 | visible | 60fps | 160fps | 1743fps | 170fps | 503ms |
| `visible(false)`、フラグあり | 共有 | visible | 60fps | 161fps | 1762fps | 189fps | 505ms |
| `visible(false)`、フラグあり | 専用 | visible | 60fps | 175fps | 2798fps | 175fps | 502ms |
| `visible(false)`、間引き停止のみ | 専用 | visible | 60fps | 144fps | 1827fps | 148fps | 512ms |
| `visible(false)`、フラグなし | 専用 | visible | 60fps | 162fps | 2282fps | 176fps | 519ms |
| 最小化、フラグあり | 共有 | hidden | 0 | 12.8fps | 4fps | 応答なし | 2801ms |
| 最小化、フラグあり | 専用 | hidden | 計測関数が60秒以内に戻らず | | | | |
| 最小化、フラグなし | 専用 | hidden | 0 | 1.6fps | 2fps | 100fps | 4749ms |
| 他のウィンドウで覆う、フラグあり | 共有 | visible | 50fps | 31fps | 50fps | 31fps | 533ms |
| 他のウィンドウで覆う、フラグあり | 専用 | visible | 60fps | 152fps | 727fps | 147fps | 506ms |
| 他のウィンドウで覆う、間引き停止のみ | 専用 | visible | 60fps | 186fps | 2805fps | 184fps | 503ms |
| 他のウィンドウで覆う、フラグなし | 専用 | visible | 60fps | 185fps | 3244fps | 182fps | 502ms |
| 画面外(-12000, -12000) | 共有 | visible | 60fps | 60fps | 60fps | 60fps | 531ms |

「フラグあり」はスケッチ用の起動引数すべて、「間引き停止のみ」は `--disable-background-timer-throttling` だけ、「フラグなし」はwryの既定値だけです。描画できたフレームではreadPixelsの値がすべて期待値と一致しました(不一致0)。「他のウィンドウで覆う」は、UIウィンドウを最前面にして試験ウィンドウを完全に覆った状態です。

回をまたいだ傾向:

- `visible(false)` のウィンドウは、5回の実行すべてでページから `visible` に見え、rAFは50〜60fpsで動いた
- 最小化は回によって大きく変わる。1回目は「フラグあり」でsetTimeout(0)が170fps出たが、5回目は12.8fpsで、Workerも応答しなかった。「フラグなし」は毎回setTimeoutが1秒に1回程度まで落ちた
- プレビューの子WebViewと環境を共有した書き出し用ウィンドウは、4回中3回、どれかの条件でsetTimeout・MessageChannel・Workerが約30fpsに張り付いた(1回目の「覆う」、2回目の「表示」「`visible(false)`」「最小化」、5回目の「覆う」)。専用環境の条件では一度も起きなかった
- 「画面外」は2回とも全方式が60fpsで頭打ちになった
- 3・4回目は、誤って試作アプリを2つ同時に動かしたため捨てた

### 長時間の計測(6.5分)

| 条件 | setInterval(500ms)の最大間隔 | 連鎖setTimeout(500ms)の最大間隔 | 分ごとの最大間隔 |
| --- | --- | --- | --- |
| `visible(false)`、フラグあり | 505ms | 504ms | 502〜504ms |
| `visible(false)`、フラグなし | 505ms | 505ms | 502〜505ms |
| 最小化、フラグあり | 10,093ms | 10,093ms | 951、692、7046、10093、5342、7336、4842ms |
| 最小化、フラグなし | 50,721ms | 2,639ms | 1417、1218、2639ms の後、3分間は計測ループ自体が回らず、最後の分に50,721ms |

最小化では、`--disable-background-timer-throttling` を付けても数秒から10秒止まる区間が出ました。付けない場合は1分近く止まります(3回目の一部が重なった計測では242秒止まった)。

### CapturePreview

`visible(false)`・画面外・覆った状態では毎回成功し、取り込んだPNGにページの中身が写っていました(`phase0/results/capture_*.png` を目視で確認)。最小化は1回目は成功し、5回目は10秒でタイムアウトしました。

### 判断

- 書き出し用とCLI用のスケッチWebViewは `visible(false)` のウィンドウにする。ページからは表示中に見え、rAFもタイマーも間引かれない。ユーザーが最小化することもない
- このウィンドウはプレビューと別のWebView2環境(別のデータフォルダ、同じ起動引数)で作る。環境を共有すると約30fpsに張り付く回があった。費用は約300MBで、書き出し中だけ作る
- 書き出しの進行はrAFに頼らず、MessageChannelかPromiseの連鎖で1フレームずつ進める
- 最小化中は、フラグを付けてもタイマーが10秒止まることがある。設計どおり、最小化中は生存通知の判定を止め、最小化したウィンドウで描画や取り込みをしない
- `--disable-background-timer-throttling` は最小化時の停止を短くするので残す。`CalculateNativeWinOcclusion` の無効化は効果を観測できなかったが、Chromiumの既定動作に依存しないよう引数には残す
- Worker + OffscreenCanvasは `visible(false)` では間引かれなかったが、最小化では止まる回があった。上の方式で足りるため今は採らない

## 2. UIとスケッチのプロセス分離

| 計測 | 結果 |
| --- | --- |
| ブラウザプロセスのPID | UI 37092、スケッチ 29152(別) |
| 環境ごとのプロセス | 各5個(browser、gpu、renderer、utility×2)。共有するPIDなし |
| スケッチの5秒ビジーループ中のUI | rAF間隔 中央値16.7ms・最大16.9ms(待機時 最大16.8ms)、setTimeoutの遅れ 最大1.7ms |
| `while(true)` からの検知 | 生存通知(500ms間隔)が2秒途切れたことを1800ms後に検知 |
| 作り直し | 固まった子WebViewの `close()` は0.01msで戻り、新しい子WebViewが読み込みを終えるまで185ms。その間UIのrAFは最大17.2ms |
| ProcessFailed | レンダラーを強制終了してから14msで `RENDER_PROCESS_EXITED`(理由 TERMINATED、終了コード1)。作り直しまで210ms |

判断: 別のWebView2環境で作れば、ブラウザ・GPU・レンダラーのすべてが分かれる。設計どおり採用し、Workerへの切り替えは不要。

## 3. 非圧縮フレームの転送速度

4K RGBA8(33,177,600バイト)を15回送り、1回目を除いた14回の値です。Rust側は受け取ったデータの1MBごとの値を足して返し、送った内容と一致することを確かめています(不一致0)。

| 方式 | 中央値 | 最小 | 最大 | 1回目 |
| --- | --- | --- | --- | --- |
| 共有メモリ(書き込み + 専用URIスキームで通知 + Rust側で別バッファへコピー) | 7.7ms | 5.8ms | 44.4ms | 26.3ms |
| トークン認証付きlocalhost HTTP(axum) | 159.7ms | 153.6ms | 165.5ms | 164.9ms |
| 専用URIスキームへのPOST | 328.0ms | 317.2ms | 338.2ms | 320.8ms |

内訳と関連する値:

- 共有メモリの作成と `PostSharedBufferToScript`: 0.35ms(Rust側、1回だけ)
- JSから共有メモリへの書き込み(`Uint8Array.set`)だけ: 中央値2.1ms
- 専用URIスキームの短い通知の往復: 中央値1.0ms
- `readPixels` で共有メモリへ直接書く: 中央値12.7ms(値も正しく入る)。通常の配列への4K `readPixels` は7.0ms、PBOとfenceで非同期に読むと20.9ms
- `chrome.webview.releaseBuffer` は成功
- `http://sb.localhost` から `http://127.0.0.1` へのfetchで、PermissionRequestedは一度も発火せず、通信も成功した(WebView2 157時点)

判断: 共有メモリを採用する。localhost HTTPは使わず、許可リストからも外す。専用URIスキームは書き終えた通知などの短いメッセージに使う。

## 4. HTMLレンダラー

### HTML-in-Canvas

| 項目 | スケッチ用環境(`CanvasDrawElement` 指定) | UI環境(指定なし) |
| --- | --- | --- |
| `drawElementImage` | あり | あり |
| `texElementSubImage2D` / 旧 `texElementImage2D` | あり / なし | あり / なし |
| `updateElementGeometry`、`requestPaint`、`onpaint` | あり | あり |
| `drawElementImage` の戻り値 | undefined(Chrome 155以降の形) | undefined |
| 1080pの描画(getImageDataまで) | 中央値6.0〜6.5ms | 中央値6.2〜6.4ms |
| 描画結果 | 2,064,960画素に描画、うち半透明2,046,100画素(アルファ保持) | 同じ |

WebView2 157では、起動引数を付けない環境でもHTML-in-Canvasが使えました。描画後のcanvasは `getImageData` で読めます。

### foreignObject

1回目の計測は、試験コードのXHTMLで `<img>` を閉じていなかったため無効です。2回目以降の結果:

| 確認内容 | 結果 |
| --- | --- |
| SVGをblob URLで読んで描いたcanvas | taint(`getImageData` が SecurityError)。文字だけのSVGでも同じ |
| SVGをdata URLで読んで描いたcanvas(html-to-imageと同じ方式) | taintしない |
| foreignObjectを含まないSVG(data URL) | taintしない |
| SVG内の `<img>`、同一オリジンの外部URL | 描かれない |
| SVG内の `<img>`、data URL | 描かれる |
| 文書側で `FontFace` として読み込んだフォント | SVG内では使われない |
| SVG内の `@font-face`、外部URL | 使われない |
| SVG内の `@font-face`、data URL | 使われる |
| 同じ入力を5回描いた結果(1080p、グラデーション・影・角丸・画像入り) | 5回とも一致 |
| 1080pの描画時間 | data URLで中央値11.4ms(blob URLでは2.2ms) |

### 仮想時計とCSSアニメーション

`performance.now`、`Date.now`、`requestAnimationFrame` を差し替えて仮想時刻を0に止め、実時間で400ms待つと、CSSトランジション、CSSアニメーション、Web Animationsのどれも約37px(1秒で100px動く設定)進んでいました。CSSアニメーションは仮想時計に従いません。`document.getAnimations()` で取った3つを `pause()` して `currentTime = 500` にすると3つとも50px、`250` に戻すと25pxで、時刻を戻す方向のシークもできました。

### CapturePreview(画面取り込み)

| 条件 | 1回の時間(中央値) | PNGのサイズ |
| --- | --- | --- |
| 子WebView 960x540、単色の背景 | 50〜100ms | 約3.6KB |
| 非表示ウィンドウ 1920x1080、文字とグラデーション | 267ms | 834KB |

判断: HTMLレンダラーはHTML-in-Canvasを第一候補とし、起動引数は付けたまま機能検出で分岐する。foreignObject方式はSVGをdata URLで読み、画像とフォントもdata URLにして埋め込む(blob URLや外部URLは使わない)。CSSアニメーションはgetAnimationsで時刻を合わせる設計のままでよい。画面取り込みは1080pで約3.7fpsなので、表現できないCSSがある場合の最後の手段にとどめる。

## 5. WebCodecsの対応コーデック

`VideoEncoder.isConfigSupported` の結果(30fps):

| コーデック | 1080p HW | 1080p SW | 4K HW | 4K SW |
| --- | --- | --- | --- | --- |
| H.264 High L5.2(avc1.640034) | 可 | 可 | 可 | 可 |
| H.265 Main L5.1(hvc1.1.6.L153.B0) | 不可 | 不可 | 不可 | 不可 |
| AV1 Main L5.1(av01.0.13M.08) | 可 | 可 | 可 | 可 |
| VP9 Profile 0 L5.1(vp09.00.51.08) | 不可 | 可 | 不可 | 可 |

4Kの実エンコード(Canvas2Dに描いてVideoFrameにし、60フレーム、40Mbps、`prefer-hardware`): H.264は722msで83fps、AV1は675msで89fps。

YUV変換の確認: 赤・緑・青・白・黒・灰(128)・(200,100,50)の色票を1080pのcanvasに描いてエンコードし、デコードしたNV12の値を4つの候補と比べました。

| 入力 | コーデック | 最も近い候補(平均誤差) | 他の候補の平均誤差 |
| --- | --- | --- | --- |
| canvasのRGB(入力のcolorSpaceは matrix rgb、fullRange true) | H.264、AV1 | BT.709リミテッド(0.11) | BT.601リミテッド 5.14、BT.709フル 6.77、BT.601フル 7.94 |
| 自前でBT.709リミテッドに変換したNV12、colorSpaceを明示 | H.264、AV1 | BT.709リミテッド(0.11) | 同上 |

赤のデコード値は(Y, U, V) = (63, 102, 240)で、BT.709リミテッドの理論値と一致します。

色情報の書き込み:

- H.264のSPS(avcCから取り出して解析)はVUIを持つが、`video_signal_type_present_flag` が0で、原色・伝達特性・行列・レンジがビットストリームに入らない。RGB入力でもNV12入力でも同じ
- `decoderConfig.colorSpace` はRGB入力で `{bt709, iec61966-2-1, bt709, limited}`、NV12入力で `{bt709, bt709, bt709, limited}` と、メタデータ側にだけ反映される

判断: H.264とAV1をWebCodecsで使う。H.265はこの環境のWebView2では使えないので、H.264で通らない解像度はAV1、それも駄目ならffmpeg経由に切り替える。VUIはffmpegのビットストリームフィルターで書き込む設計のままとする。RGBを直接渡してもBT.709リミテッドになったが、エンコーダーの実装やGPUで変わりうるため、シェーダーでNV12に変換してcolorSpaceを明示する設計は維持する。

## 6. 子WebView

| 計測 | 結果 |
| --- | --- |
| UIと別のデータフォルダ・起動引数の子WebViewを `Window::add_child` で追加 | 成功。追加から読み込み完了まで257〜309ms |
| ウィンドウを30回リサイズしたときの追従 | UIのResizeObserverから専用URIスキームで矩形を送る往復が中央値6.8ms(最大48ms)、Rustの `set_bounds` は中央値0.05ms(最大0.78ms) |
| `hide()` / `show()` の呼び出し | どちらも0.2ms未満 |
| 静止画への切り替え(CapturePreview、UIで表示、子WebViewを隠す) | 中央値104ms(最大134ms)。うちUIでの取得とデコードは3.4ms |
| 子WebViewを隠したときのページ | `visibilityState` が hidden になる |

ちらつきは目視の代わりに画面の取り込みで判定しました。ウィンドウを約16msごとにリサイズしながら、GDIでウィンドウ内を取り込み、子WebViewの下にあるUI側プレビュー領域の背景色(#222222)が見えている画素を数えます。

| 条件 | 背景が見えたフレーム | 見えた画素数 |
| --- | --- | --- |
| 静止中(20フレーム) | 0 | 0 |
| 約60Hzでリサイズ中(120フレーム) | 56 | 中央値0、95パーセンタイル18,780、最大19,140 |

最も悪いフレーム(`phase0/results/flicker_drag_worst.png`)では、子WebViewの右に約18px、下に約10pxの帯としてUI側の背景が見えていました。UIのレイアウトが先に変わり、その矩形がRustに届いてから子WebViewが動くため、1〜2フレーム遅れます。

判断: 子WebViewは採用。ウィンドウのリサイズ中も、エリアのドラッグ中と同じく子WebViewを隠して静止画を表示する。静止画への切り替えは約100msかかるので、メニューを開く操作では先に直前フレームの静止画を用意しておく(プレビューの描画ごとに縮小画像を保持する)方向で、フェーズ1の実装時に詰める。隠した子WebViewは `hidden` になるため、設計どおり隠している間は生存通知の判定を止める。

## 7. GPUの共有

| 計測 | 結果 |
| --- | --- |
| UI環境だけのワーキングセット | 308MB(5プロセス) |
| スケッチ用環境を足した後 | UI環境315MB + スケッチ環境307MB。1080pのWebGLを3秒描いた後のスケッチ環境は311MB |
| 4Kのcanvasから合成用コンテキストへのtexImage2D | RGBA8 中央値2.5ms(初回48.6ms)、RGBA16F 中央値2.5ms(初回6.4ms)。20回とも値が正しい |
| WebGL2コンテキスト(メインスレッド) | 32個作ると16個が生存、16個が喪失 |
| WebGL2コンテキスト(Worker、OffscreenCanvas) | 32個作ると4個が生存 |
| シェーダーの無限ループ | 下記 |

### シェーダーの無限ループ(`--gpu-hang`)

スケッチ用環境で、終わらないforループを持つフラグメントシェーダーを4K全面に描き、`readPixels` で完了を待ちました。同時にUI側では毎フレーム小さなWebGLを描いて `readPixels` し、rAFの間隔とコンテキスト喪失を記録しました。

| 計測 | 結果 |
| --- | --- |
| スケッチの `readPixels` が戻るまで | 8.2秒 |
| スケッチのWebGLコンテキスト喪失 | 11.2秒後に発生(`getError` は CONTEXT_LOST_WEBGL)。復帰イベントは来ない |
| ProcessFailed | 11.3秒後にスケッチ環境だけで `GPU_PROCESS_EXITED`(理由 CRASHED、終了コード34) |
| UIのWebGLコンテキスト | 失われなかった(850フレーム描画、エラー0) |
| UIのrAF間隔とsetTimeoutの遅れ | 中央値16.7ms、最大5.9秒 |

UIの最大5.9秒の停止には、試験のためにUI側で毎フレーム `readPixels` してGPUの完了を待っていた分が含まれます。GPUを使わないUIでどこまで止まるかは、この試験では切り分けていません。UI側の環境は作り直さずに済みました。

判断: スケッチ用環境のGPUプロセスが落ちてもUIの環境は壊れず、ProcessFailedの `GPU_PROCESS_EXITED` を受けてスケッチWebViewを作り直す設計で復旧できる。ただしGPUが占有されている間はUIも数秒止まりうるため、アプリが組み立てるシェーダー(ISFとshaderレンダラー)にはループ回数の上限を自動で挿入する。three.jsやp5が内部で作るシェーダーは対象外とし、上の作り直しで扱う。

判断(メモリとコピー): 環境を2つ持つ費用は約300MBで、許容する。コピーは4Kで2.5msなので、レンダラー別コンテキストから合成用コンテキストへコピーする設計のままでよい。メインスレッドの上限16とWorkerの上限4は、設計書の記述どおりだった。

## 8. 音声解析モデル

`phase0/beat` は crates.io の beat-this 1.1.0(既定のrtenバックエンド)を使います。モデルは作者のリポジトリ(danigb/beat-this-rs、コミット 1ae768e)の `models/` と、Releasesの `model-large` から取得し、SHA-256を照合しました。比較対象は同リポジトリの `tests/fixtures/golden_full.json` で、Python版 beat_this が同じmp3から出した結果です。

| 計測 | フルモデル | 小モデル |
| --- | --- | --- |
| Python版goldenとの比較(±70ms) | 拍 F=1.0(575/575)、小節頭 F=1.0(144/144)、平均ずれ3.6ms、最大20ms | (goldenはフルモデル用のため比較せず) |
| 解析時間(テスト曲、mp3) | 5.9秒(モデル読み込み40ms) | 5.0秒 |
| 合成クリック(120BPM、4拍子、1拍目を低音で強調、30秒)の拍 | F=0.99、平均ずれ16.9ms | F=0.99、平均ずれ18.6ms |
| 同じく小節頭 | F=0.47(44個検出、正解15個) | F=1.0 |
| 合成クリックの推定BPM | 120 | 120 |

最大ずれ20msはモデルの時間解像度(50fps)の1フレーム分です。合成クリックでフルモデルが小節頭を出しすぎたのは、楽曲でない信号に対する振る舞いで、Python版との一致とは別の問題です。

判断: beat-thisクレートを採用し、Pythonの前処理器は不要。小節頭の誤検出に備え、タイムライン上で拍子と1拍目を手で直せるようにする(フェーズ2)。

## 9. GPUの選択

計測機はCPUに内蔵GPUがなく、外部GPUが1枚のデスクトップです。WebGPUの `powerPreference` を high-performance と low-power のどちらにしても同じアダプター(nvidia、lovelace)が返りました。WebGLの `UNMASKED_RENDERER_WEBGL` は両環境とも `ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 SUPER (0x00002783) Direct3D11 vs_5_0 ps_5_0, D3D11)` で、使用中のGPU名は診断に表示できます。

判断: 条件付き採用。使用中のGPUを診断に表示する仕組み(WebGLの UNMASKED_RENDERER_WEBGL とWebGPUのアダプター情報)は使える。内蔵GPUと外部GPUを持つノートPCで、スケッチ用環境がどちらで描画・エンコードするかは未確認のまま残し、ハイブリッド機が手元に来たときに確かめる。外部GPUが使われない場合は、設計書の代替案(固定版ランタイムの実行ファイルにWindowsのグラフィック設定で高パフォーマンスGPUを割り当てる)に切り替える。

## 未完了の項目

- 9のハイブリッドGPU機での確認

## 補足

- cpal(音声出力の遅延の取得)はCLAUDE.mdでTauri最小アプリで測る対象に挙がっているが、9項目には含まれないため今回は扱っていない
