#!/usr/bin/env bash
# Builds the CPU benchmark harness around Azahar's real ARM11 interpreters.
#   build-host.sh native   -> build/native/cpu_bench          (Apple clang, -O3)
#   build-host.sh android  -> build/android/cpu_bench         (NDK clang -O3, arm64, run via adb)
#   build-host.sh node     -> build/node/cpu_bench.js         (emcc -O3, NODERAWFS, runs in V8)
#   build-host.sh web      -> build/web/ (index.html + worker + wasm; run build-guest.sh first)
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
AZ="${AZAHAR_SRC:-$HERE/../third_party/azahar/src}"
TARGET="${1:-native}"
OUT="$HERE/build/$TARGET"
mkdir -p "$OUT"

ARM="$AZ/core/arm"
CORE_SRCS=(
  "$ARM/fastinterp/fastinterp.cpp"
  "$ARM/fastinterp/fastinterp_decode.cpp"
  "$ARM/dynarmic/arm_tick_counts.cpp"
  "$ARM/dyncom/arm_dyncom.cpp"
  "$ARM/dyncom/arm_dyncom_dec.cpp"
  "$ARM/dyncom/arm_dyncom_interpreter.cpp"
  "$ARM/dyncom/arm_dyncom_thumb.cpp"
  "$ARM/dyncom/arm_dyncom_trans.cpp"
  "$ARM/skyeye_common/armstate.cpp"
  "$ARM/skyeye_common/armsupp.cpp"
  "$ARM/skyeye_common/vfp/vfp.cpp"
  "$ARM/skyeye_common/vfp/vfpdouble.cpp"
  "$ARM/skyeye_common/vfp/vfpinstr.cpp"
  "$ARM/skyeye_common/vfp/vfpsingle.cpp"
  "$HERE/host/stubs_impl.cpp"
  "$HERE/host/harness.cpp"
)
# Stubs first so core.h/memory.h/svc.h/... resolve to the POC versions; everything
# under core/arm/ comes unmodified from Azahar.
# Force-includes mirror Azahar's precompiled header (some ARM sources rely on it).
CXXFLAGS=(-std=c++20 -O3 -DNDEBUG -I"$HERE/stubs" -I"$AZ"
          -include common/common_types.h -include common/logging/log.h -include common/assert.h
          -Wno-unused-result -Wno-deprecated-declarations -Wno-format)

case "$TARGET" in
  native)
    clang++ "${CXXFLAGS[@]}" -DPOC_TARGET='"native-'"$(uname -m)"'"' \
      "${CORE_SRCS[@]}" "$HERE/host/main_cli.cpp" -o "$OUT/cpu_bench"
    ;;
  android)
    # Native arm64 Android binary (run via adb) to compare against Chrome/WASM on the same phone.
    NDK="${ANDROID_NDK:-$(ls -d "$HOME"/Library/Android/sdk/ndk/* | sort -V | tail -1)}"
    "$NDK"/toolchains/llvm/prebuilt/*/bin/aarch64-linux-android30-clang++ "${CXXFLAGS[@]}" \
      -DPOC_TARGET='"native-android-arm64"' -static-libstdc++ \
      "${CORE_SRCS[@]}" "$HERE/host/main_cli.cpp" -o "$OUT/cpu_bench"
    ;;
  node)
    source "$HOME/emsdk/emsdk_env.sh" >/dev/null 2>&1
    em++ "${CXXFLAGS[@]}" -DPOC_TARGET='"wasm-node"' \
      "${CORE_SRCS[@]}" "$HERE/host/main_cli.cpp" -o "$OUT/cpu_bench.js" \
      -sNODERAWFS=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=256MB -sEXIT_RUNTIME=1
    ;;
  web)
    source "$HOME/emsdk/emsdk_env.sh" >/dev/null 2>&1
    em++ "${CXXFLAGS[@]}" -DPOC_TARGET='"wasm-browser"' \
      "${CORE_SRCS[@]}" "$HERE/host/main_web.cpp" -o "$OUT/cpu_bench_web.js" \
      -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker -sALLOW_MEMORY_GROWTH=1 \
      -sINITIAL_MEMORY=256MB -sEXPORTED_FUNCTIONS=_poc_set_image,_poc_workloads,_poc_run,_malloc,_free \
      -sEXPORTED_RUNTIME_METHODS=UTF8ToString,HEAPU8
    # Self-contained static folder: serve build/web/ and open index.html (desktop or phone).
    cp "$HERE/web/index.html" "$HERE/web/bench-worker.js" "$OUT/"
    cp "$HERE/build/guest/bench.bin" "$HERE/build/guest/expected.txt" "$OUT/"
    ;;
  *)
    echo "unknown target $TARGET" >&2
    exit 2
    ;;
esac
echo "built $TARGET -> $OUT"
