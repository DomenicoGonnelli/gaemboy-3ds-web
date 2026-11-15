// Host-native reference: prints the checksum each workload must produce.
#include <stdint.h>
#include <stdio.h>
#define BENCH_CONFIG_TABLE
#include "bench_config.h"

uint32_t bench_main(uint32_t workload, uint32_t iters);

int main(void) {
    for (unsigned w = 0; w < W_COUNT; w++) {
        printf("%u %u 0x%08X\n", w, kWorkloadIters[w], bench_main(w, kWorkloadIters[w]));
    }
    return 0;
}
