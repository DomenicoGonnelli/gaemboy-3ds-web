#!/usr/bin/env bash
# Builds the ARMv6K guest benchmark (raw binary @ 0x00100000) and the host-native
# reference checksums. Needs Apple/LLVM clang with the ARM backend + emsdk's lld.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
G="$HERE/guest"
OUT="$HERE/build/guest"
mkdir -p "$OUT"

CLANG="${CLANG:-clang}"
LLD="${LLD:-$HOME/emsdk/upstream/bin/lld}"
OBJCOPY="${OBJCOPY:-$HOME/emsdk/upstream/bin/llvm-objcopy}"

# 3DS app core: ARM11 MPCore (ARMv6K), VFPv2, hard-float.
ARMFLAGS=(--target=armv6k-none-eabihf -mcpu=mpcore -mfpu=vfpv2 -mfloat-abi=hard
          -O2 -ffreestanding -fno-builtin -nostdlib -fno-math-errno -ffp-contract=off
          -fno-unwind-tables -fno-asynchronous-unwind-tables -fomit-frame-pointer)

"$CLANG" "${ARMFLAGS[@]}" -marm -c "$G/bench.c" -o "$OUT/bench.o"
"$CLANG" "${ARMFLAGS[@]}" -mthumb -c "$G/thumb.c" -o "$OUT/thumb.o"
"$CLANG" "${ARMFLAGS[@]}" -marm -c "$G/rt.c" -o "$OUT/rt.o"
"$LLD" -flavor gnu -T "$G/link.ld" --no-dynamic-linker -static \
    "$OUT/rt.o" "$OUT/bench.o" "$OUT/thumb.o" -o "$OUT/bench.elf"
"$OBJCOPY" -O binary "$OUT/bench.elf" "$OUT/bench.bin"

# Reference checksums from the same C code compiled for the host.
"$CLANG" -O2 -fno-math-errno -ffp-contract=off "$G/bench.c" "$G/thumb.c" "$G/expected_main.c" \
    -o "$OUT/expected"
"$OUT/expected" > "$OUT/expected.txt"

echo "guest: $(wc -c < "$OUT/bench.bin") bytes -> $OUT/bench.bin"
cat "$OUT/expected.txt"
