// Browser entry points (called from web/bench-worker.js).
#include <cstdio>
#include <string>
#include <vector>

#include <emscripten/emscripten.h>

#define BENCH_CONFIG_TABLE
#include "../guest/bench_config.h"
#include "harness.h"

static std::vector<uint8_t> g_image;
static std::string g_json;

extern "C" {

EMSCRIPTEN_KEEPALIVE void poc_set_image(const uint8_t* data, uint32_t size) {
    g_image.assign(data, data + size);
}

EMSCRIPTEN_KEEPALIVE const char* poc_workloads() {
    g_json = "[";
    for (unsigned w = 0; w < W_COUNT; w++) {
        char buf[160];
        std::snprintf(buf, sizeof(buf), "%s{\"id\":%u,\"name\":\"%s\",\"iters\":%u}",
                      w ? "," : "", w, kWorkloadNames[w], kWorkloadIters[w]);
        g_json += buf;
    }
    g_json += "]";
    return g_json.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* poc_run(int core, int workload, int iters) {
    const RunResult r = RunGuest(static_cast<CoreKind>(core), g_image, workload, iters);
    char buf[256];
    std::snprintf(buf, sizeof(buf),
                  "{\"core\":\"%s\",\"exited\":%s,\"checksum\":%u,\"ticks\":%llu,"
                  "\"seconds\":%.6f,\"unmapped\":%llu}",
                  CoreName(static_cast<CoreKind>(core)), r.exited ? "true" : "false", r.checksum,
                  static_cast<unsigned long long>(r.ticks), r.seconds,
                  static_cast<unsigned long long>(r.unmapped));
    g_json = buf;
    return g_json.c_str();
}

} // extern "C"
