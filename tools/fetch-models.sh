#!/usr/bin/env bash
# beat-this(Beat This!のRust移植、MIT)のモデルを取得して %LOCALAPPDATA%\sketchbench\models に置く。
# 取得元は作者のリポジトリ danigb/beat-this-rs。版を固定し、SHA-256を照合する。
# 使い方: tools/fetch-models.sh [--small]   (--small は約10MBの小モデルだけ)
set -euo pipefail
COMMIT=1ae768e78f1ad83b0ed3886241dc29ffde853c40
RAW="https://github.com/danigb/beat-this-rs/raw/${COMMIT}/models"
REL="https://github.com/danigb/beat-this-rs/releases/download/model-large"
DIR="$(cygpath -u "${LOCALAPPDATA}")/sketchbench/models"
mkdir -p "$DIR"

fetch() { # url name sha256
  local url=$1 name=$2 sha=$3
  if [ -f "$DIR/$name" ] && echo "$sha  $DIR/$name" | sha256sum -c --status; then
    echo "$name: 取得済み"
    return
  fi
  curl -fL --retry 3 -o "$DIR/$name.part" "$url"
  echo "$sha  $DIR/$name.part" | sha256sum -c --status || { echo "$name: SHA-256が一致しない" >&2; rm -f "$DIR/$name.part"; exit 1; }
  mv "$DIR/$name.part" "$DIR/$name"
  echo "$name: 取得した"
}

fetch "$RAW/mel_spectrogram.onnx" mel_spectrogram.onnx fdd59e65c515331308e4c8841edf99972deca646bdf6197744c2a5b7755e3de9
fetch "$RAW/beat_this_small.onnx" beat_this_small.onnx a5f8d39d989f31859454ba27afe61c5317ca95e4d9373e6853e5361b8937172f
if [ "${1:-}" != "--small" ]; then
  fetch "$REL/beat_this.onnx" beat_this.onnx 5f810debe53459b559127fb55bbad40035bb47cc567b20e501670f968c770f02
fi
