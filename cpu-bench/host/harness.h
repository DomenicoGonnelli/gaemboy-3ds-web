// Runs the guest benchmark on Azahar's ARM11 interpreters (DynCom or FastInterp).
#pragma once
#include <cstdint>
#include <vector>

enum class CoreKind : int { DynCom = 0, FastInterp = 1 };

struct RunResult {
    bool exited = false;     // guest reached svc 0x03
    uint32_t checksum = 0;   // r0 at exit
    uint64_t ticks = 0;      // emulated ARM11 ticks accounted by the backend
    double seconds = 0.0;    // wall time spent inside the CPU backend loop
    uint64_t unmapped = 0;   // accesses that missed the page table (should be 0)
};

constexpr double kArm11Hz = 268111856.0;

const char* CoreName(CoreKind core);

RunResult RunGuest(CoreKind core, const std::vector<uint8_t>& image, uint32_t workload,
                   uint32_t iters);
