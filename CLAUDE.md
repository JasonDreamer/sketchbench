# Sketchbench

映像制作用の自分専用ビジュアルコーディング環境。Windows専用のTauri 2アプリ(Rustコア + WebView2)。
設計の正は `docs/design.md`。実装で設計と食い違う判断をしたら、先に design.md を直してから実装する。

## 進め方
- `docs/design.md` の「開発フェーズ」の順に作る。各フェーズの完了条件を満たすまで次へ進まない。
- 今はフェーズ1(最小ループ)。フェーズ0の結果は `docs/phase0-results.md`、試作は `phase0/`(本体からは参照しない)。
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
