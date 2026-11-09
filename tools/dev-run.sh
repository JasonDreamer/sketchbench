#!/usr/bin/env bash
# 開発中の動作確認: 起動中のアプリを止め、UIとRustをビルドし、.dev-workspace で起動してスクリーンショットを撮る。
# 使い方: tools/dev-run.sh [待つ秒数]
set -euo pipefail
cd "$(dirname "$0")/.."
taskkill //IM sketchbench.exe //F > /dev/null 2>&1 || true
sleep 2
npm run ui:build > /dev/null
(cd app && cargo build 2>&1 | grep -E "^(error|warning)" -A7 || true)
mkdir -p .dev-workspace
log=".dev-workspace/run.log"
(cd app && SB_WORKSPACE="$(cygpath -w "$PWD/../.dev-workspace")" ./target/debug/sketchbench.exe > "../$log" 2>&1 &)
sleep "${1:-10}"
powershell -ExecutionPolicy Bypass -File tools/screenshot-window.ps1 -Title Sketchbench -Out .dev-workspace/shot.png
cat "$log"
