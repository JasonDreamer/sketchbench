# Sketchbench

映像制作用の自分専用ビジュアルコーディング環境。Windows専用のTauri 2アプリ(Rustコア + WebView2)。
設計の正は `docs/design.md`。実装で設計と食い違う判断をしたら、先に design.md を直してから実装する。

## 進め方
- `docs/design.md` の「開発フェーズ」の順に作る。各フェーズの完了条件を満たすまで次へ進まない。
- フェーズ3(AIが自分で確認できる)まで完了(結果は design.md の開発フェーズ)。次はフェーズ4(制作ソフトとしての基盤)。フェーズ0の結果は `docs/phase0-results.md`、試作は `phase0/`(本体からは参照しない)。
- アプリ本体は `app/`(Rustコア、`app/ui` がUI)、ランタイムは `packages/runtime`(`@sketchbench/runtime`)。ランタイムのTSはRustコアがOxcで変換して配信する。
- 開発中の作業フォルダは環境変数 `SB_WORKSPACE` で指定する(既定は `%USERPROFILE%\Documents\Sketchbench`)。リポジトリ内で試すときは `.dev-workspace/`(gitに入れない)を使う。

## 守ること
- 独自言語は作らない。スケッチはTypeScriptと既存ライブラリ、ランタイムAPIは薄く保つ。
- 既存の部品があれば自作しない。design.md の「既存OSSの検討」「技術スタック」に挙げたクレート・パッケージを使う。足す場合はライセンスを確認し、AGPLをアプリ本体に組み込まない。
- project.json を書くのはRustコアだけ。UIとMCPは操作を送る。
- 純粋スケッチは時刻と入力だけで結果が決まること。決定性テストを壊す変更をしない。
- スケッチWebViewに許可する通信は design.md の「スケッチWebViewとの通信」表のものだけ。
- 未確認のAPI名・フラグ・数値を推測で書かない。公式ドキュメントかソースで確かめ、確かめられなければ技術検証の項目にする。
- CLI名は `sb`、ランタイムのパッケージ名は `@sketchbench/runtime`。
- 動作確認で実際のマウスやキーを送らない(利用者の別のウィンドウに入力が漏れる)。開発ビルドを `SB_DEBUG_PORT=<番号>` で起動し、`node tools/ui-cdp.mjs <番号> "<式>"` でUIを操作し、`tools/screenshot-window.ps1` で取り込む。
- ランタイム・合成・書き出しを変えたら `node tools/regress.mjs` で回帰テストと決定性テストを通す(先に開発ビルドのアプリを閉じる)。見た目を意図して変えたときだけ `--update` で基準画像(`tests/baseline/`)を作り直す。
- MCPの動作確認は `node tools/mcp-call.mjs <sb.exe> <出力先> '<呼び出しのJSON配列>'` で行う(結果はパイプに通さずファイルへ書く。アプリが出力を握ったままになることがある)。
