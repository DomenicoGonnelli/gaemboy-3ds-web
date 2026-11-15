#!/usr/bin/env bash
# Fetches Azahar (pinned) with only the submodules the web build needs, adds robin-map and applies
# the GAEMBOY wasm patches. Result: third_party/azahar-full ready for scripts/build.sh (~210 MB).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DEST="$ROOT/third_party/azahar-full"
COMMIT="${AZAHAR_COMMIT:-11eceda5e0e682a1f44e396bf954a1b9137097ca}" # master, 2026-11-12

if [ ! -d "$DEST/.git" ]; then
  git clone --no-checkout https://github.com/azahar-emu/azahar.git "$DEST" --filter=blob:none
fi
cd "$DEST"
git fetch --depth 1 origin "$COMMIT"
git checkout --quiet "$COMMIT"
git submodule update --init --depth 1 --jobs 8 \
  externals/boost externals/cryptopp externals/fmt externals/inih/inih externals/microtar \
  externals/nihstro externals/faad2/faad2 externals/soundtouch externals/teakra externals/zstd \
  externals/enet externals/libretro-common/libretro-common externals/libressl \
  externals/lodepng/lodepng externals/xxHash externals/dds-ktx dist/compatibility_list

# robin-map normally comes bundled inside dynarmic, which is not built for wasm32.
if [ ! -d externals/robin-map ]; then
  git clone --quiet --depth 1 --branch v1.4.1 https://github.com/Tessil/robin-map.git externals/robin-map
  rm -rf externals/robin-map/.git
fi

if git apply --check "$HERE/patches/azahar.patch" 2>/dev/null; then
  git apply "$HERE/patches/azahar.patch"
  git -C externals/libressl apply "$HERE/patches/libressl.patch"
  echo "patches applied"
else
  echo "patches already applied (or tree modified)"
fi
echo "azahar @ $(git rev-parse --short HEAD) ready in $DEST"
