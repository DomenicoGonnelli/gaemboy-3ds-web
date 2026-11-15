#!/usr/bin/env bash
# Sparse, blobless checkout of only the Azahar sources the CPU benchmark needs (~4 MB).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/third_party/azahar"
COMMIT="${AZAHAR_COMMIT:-11eceda5e0e682a1f44e396bf954a1b9137097ca}" # master, 2026-11-12

if [ ! -d "$DEST/.git" ]; then
  mkdir -p "$ROOT/third_party"
  git clone --filter=blob:none --sparse --no-checkout https://github.com/azahar-emu/azahar.git "$DEST"
fi
cd "$DEST"
git sparse-checkout set --no-cone '/src/core/arm/' '/src/common/' '/src/core/core_timing.*' \
  '/src/core/memory.h' '/src/core/core.cpp' '/CMakeLists.txt' '/src/core/CMakeLists.txt'
git fetch --depth 1 origin "$COMMIT"
git checkout --quiet "$COMMIT"
echo "azahar @ $(git rev-parse --short HEAD) -> $DEST"
