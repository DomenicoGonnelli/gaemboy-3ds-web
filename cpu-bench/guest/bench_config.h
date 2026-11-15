// Workload table shared by the guest program, the host-native reference run and
// the interpreter harness. Iteration counts are sized so each workload executes
// roughly 30-100 million ARM11 instructions.
#pragma once

#define W_ENTITIES 0
#define W_CRC 1
#define W_SORT 2
#define W_VERTEX 3
#define W_VM 4
#define W_BLKCOPY 5
#define W_CRC_THUMB 6
#define W_VM_THUMB 7
#define W_MIX 8
#define W_COUNT 9

#ifdef BENCH_CONFIG_TABLE
static const char* const kWorkloadNames[W_COUNT] = {
    "entities (game logic)", "crc32 (table lookups)", "shellsort",
    "vertex xform (VFP)",    "bytecode VM (script)",  "block copy (ldm/stm)",
    "crc32 [thumb]",         "bytecode VM [thumb]",   "mix (all of the above)",
};
static const unsigned kWorkloadIters[W_COUNT] = {
    4000, 2000, 300, 2000, 1200, 8000, 1200, 1200, 60,
};
#endif
