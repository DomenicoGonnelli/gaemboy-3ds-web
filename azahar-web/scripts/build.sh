#!/usr/bin/env bash
# Builds Azahar (libretro core, software renderer, FastInterp CPU) + the GAEMBOY web frontend
# with Emscripten into azahar-web/dist/{gaemboy3ds.js,gaemboy3ds.wasm} and copies the web page.
#   usage: scripts/build.sh [--reconfigure]
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
AZ="$ROOT/third_party/azahar-full"
BUILD="$ROOT/build-azahar-wasm"
DIST="$HERE/dist"
export PATH="/opt/homebrew/bin:$PATH"
# shellcheck disable=SC1091
source "${EMSDK:-$HOME/emsdk}/emsdk_env.sh" >/dev/null 2>&1

# Native wasm exceptions/longjmp: the core uses C++ exceptions (default Emscripten would abort).
# -ffile-prefix-map strips local absolute paths from __FILE__ strings embedded in the wasm.
CFLAGS="-pthread -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -ffile-prefix-map=$ROOT/= -ffile-prefix-map=$HOME/="
LINK_FLAGS="-pthread -fwasm-exceptions -sSUPPORT_LONGJMP=wasm \
 -sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency+8 -sMIN_WEBGL_VERSION=2 -sMAX_WEBGL_VERSION=2 -sFULL_ES3=1 -sOFFSCREENCANVAS_SUPPORT=1 \
 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=1024MB -sMAXIMUM_MEMORY=4GB \
 -sSTACK_SIZE=8MB -sDEFAULT_PTHREAD_STACK_SIZE=2MB \
 -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createGaemboy3DS -sENVIRONMENT=web,worker \
 -sFORCE_FILESYSTEM=1 -lworkerfs.js -lidbfs.js \
 -sEXPORTED_FUNCTIONS=_main,_malloc,_free,_gb3ds_state,_gb3ds_state_size,_gb3ds_tick,_gb3ds_camera_buffer,_gb3ds_microphone_active,_gb3ds_save_state_file,_gb3ds_load_state_file,_gb3ds_cheat_count,_gb3ds_cheat_name,_gb3ds_cheat_code,_gb3ds_cheat_enabled,_gb3ds_cheat_add,_gb3ds_cheat_set_enabled,_gb3ds_cheat_remove,_gb3ds_cheat_clear \
 -sEXPORTED_RUNTIME_METHODS=FS,wasmMemory,addRunDependency,removeRunDependency,UTF8ToString"
# PROFILE=1 keeps wasm function names for DevTools profiles (optimization level unchanged).
if [ "${PROFILE:-0}" = "1" ]; then
  LINK_FLAGS="$LINK_FLAGS --profiling-funcs"
fi

if [ ! -f "$BUILD/CMakeCache.txt" ] || [ "${1:-}" = "--reconfigure" ] || [ -n "${PROFILE:-}" ]; then
  emcmake cmake -S "$AZ" -B "$BUILD" \
    -DCMAKE_BUILD_TYPE=Release -DENABLE_GENERIC=ON -DENABLE_LIBRETRO=ON \
    -DENABLE_OPENGL=ON -DENABLE_VULKAN=OFF -DENABLE_SOFTWARE_RENDERER=ON \
    -DENABLE_TESTS=OFF -DENABLE_LTO=OFF -DCITRA_WARNINGS_AS_ERRORS=OFF \
    -DCITRA_USE_PRECOMPILED_HEADERS=OFF -DENABLE_MICROPROFILE=OFF \
    -DCMAKE_C_FLAGS="$CFLAGS" -DCMAKE_CXX_FLAGS="$CFLAGS" \
    -DGAEMBOY3DS_FRONTEND="$HERE/frontend/gaemboy3ds_web.cpp" \
    -DGAEMBOY3DS_LINK_FLAGS="$LINK_FLAGS"
fi

make -C "$BUILD" -j"$(sysctl -n hw.ncpu)" gaemboy3ds

mkdir -p "$DIST"
cp "$BUILD"/bin/Release/gaemboy3ds.js "$BUILD"/bin/Release/gaemboy3ds.wasm "$DIST"/
cp "$HERE"/web/* "$DIST"/
ls -la "$DIST"
