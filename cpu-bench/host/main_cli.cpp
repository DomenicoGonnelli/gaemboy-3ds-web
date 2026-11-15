// CLI driver (native and Node/WASM via NODERAWFS): runs every workload on both
// interpreters, validates the checksums and prints MIPS and % of 3DS real time.
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#define BENCH_CONFIG_TABLE
#include "../guest/bench_config.h"
#include "harness.h"

#ifndef POC_TARGET
#define POC_TARGET "native"
#endif

static std::vector<uint8_t> ReadFile(const char* path) {
    std::ifstream f(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>()};
}

int main(int argc, char** argv) {
    if (argc < 3) {
        std::fprintf(stderr, "usage: %s bench.bin expected.txt [--only N] [--json out.json]\n",
                     argv[0]);
        return 2;
    }
    const auto image = ReadFile(argv[1]);
    if (image.empty()) {
        std::fprintf(stderr, "cannot read %s\n", argv[1]);
        return 2;
    }
    uint32_t expected[W_COUNT] = {};
    {
        std::ifstream f(argv[2]);
        unsigned w, iters;
        std::string hex;
        while (f >> w >> iters >> hex) {
            if (w < W_COUNT) {
                expected[w] = static_cast<uint32_t>(std::stoul(hex, nullptr, 16));
            }
        }
    }
    int only = -1;
    const char* json_path = nullptr;
    for (int i = 3; i < argc; i++) {
        if (!std::strcmp(argv[i], "--only") && i + 1 < argc) {
            only = std::atoi(argv[++i]);
        } else if (!std::strcmp(argv[i], "--json") && i + 1 < argc) {
            json_path = argv[++i];
        }
    }

    std::printf("target: %s   (3DS ARM11 = %.1f MHz)\n", POC_TARGET, kArm11Hz / 1e6);
    std::printf("%-24s %8s | %8s %8s | %8s %8s %8s | %9s %9s | %s\n", "workload", "Minstr",
                "dyn s", "dyn MIPS", "fi s", "fi MIPS", "fi Mtick", "dyn %RT", "fi %RT",
                "checksums");

    std::string json = "{\"target\":\"" POC_TARGET "\",\"workloads\":[";
    bool all_ok = true;
    for (unsigned w = 0; w < W_COUNT; w++) {
        if (only >= 0 && static_cast<unsigned>(only) != w) {
            continue;
        }
        const unsigned iters = kWorkloadIters[w];
        const RunResult dyn = RunGuest(CoreKind::DynCom, image, w, iters);
        const RunResult fi = RunGuest(CoreKind::FastInterp, image, w, iters);

        // DynCom accounts exactly one tick per executed instruction -> instruction count.
        // FastInterp uses Azahar's per-instruction cycle table (same as Dynarmic) -> the
        // amount of emulated ARM11 time this work represents on a real 3DS.
        const double instr = static_cast<double>(dyn.ticks);
        const double guest_seconds = static_cast<double>(fi.ticks) / kArm11Hz;
        const double dyn_mips = instr / dyn.seconds / 1e6;
        const double fi_mips = instr / fi.seconds / 1e6;
        const double dyn_rt = 100.0 * guest_seconds / dyn.seconds;
        const double fi_rt = 100.0 * guest_seconds / fi.seconds;
        const bool dyn_ok = dyn.exited && dyn.checksum == expected[w] && dyn.unmapped == 0;
        const bool fi_ok = fi.exited && fi.checksum == expected[w] && fi.unmapped == 0;
        all_ok = all_ok && dyn_ok && fi_ok;

        char status[96];
        std::snprintf(status, sizeof(status), "dyn %s fi %s", dyn_ok ? "OK" : "FAIL",
                      fi_ok ? "OK" : "FAIL");
        std::printf("%-24s %8.1f | %8.3f %8.1f | %8.3f %8.1f %8.1f | %8.1f%% %8.1f%% | %s\n",
                    kWorkloadNames[w], instr / 1e6, dyn.seconds, dyn_mips, fi.seconds, fi_mips,
                    fi.ticks / 1e6, dyn_rt, fi_rt, status);
        if (!dyn_ok || !fi_ok) {
            std::printf("    expected %08X dyn %08X (exit=%d unmapped=%llu) fi %08X (exit=%d "
                        "unmapped=%llu)\n",
                        expected[w], dyn.checksum, dyn.exited, (unsigned long long)dyn.unmapped,
                        fi.checksum, fi.exited, (unsigned long long)fi.unmapped);
        }
        std::fflush(stdout);

        char buf[512];
        std::snprintf(buf, sizeof(buf),
                      "%s{\"id\":%u,\"name\":\"%s\",\"iters\":%u,\"instructions\":%.0f,"
                      "\"fi_ticks\":%llu,\"dyncom\":{\"seconds\":%.6f,\"mips\":%.2f,"
                      "\"realtime_pct\":%.2f,\"ok\":%s},\"fastinterp\":{\"seconds\":%.6f,"
                      "\"mips\":%.2f,\"realtime_pct\":%.2f,\"ok\":%s}}",
                      json.back() == '[' ? "" : ",", w, kWorkloadNames[w], iters, instr,
                      (unsigned long long)fi.ticks, dyn.seconds, dyn_mips, dyn_rt,
                      dyn_ok ? "true" : "false", fi.seconds, fi_mips, fi_rt,
                      fi_ok ? "true" : "false");
        json += buf;
    }
    json += "]}\n";
    if (json_path) {
        std::ofstream(json_path) << json;
    }
    std::printf("%s\n", all_ok ? "ALL CHECKSUMS OK" : "CHECKSUM MISMATCH");
    return all_ok ? 0 : 1;
}
