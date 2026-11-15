// POC stub of Core::Timing: only the per-core Timer used by the ARM backends.
#pragma once
#include "common/common_types.h"

namespace Core::Timing {

constexpr u64 BASE_CLOCK_RATE_ARM11 = 268111856;

class Timer {
public:
    explicit Timer(s64 base_ticks = 0) : ticks(base_ticks) {}

    void AddTicks(u64 t) {
        ticks += t;
        downcount -= static_cast<s64>(t);
    }
    s64 GetDowncount() const {
        return downcount;
    }
    u64 GetTicks() const {
        return ticks;
    }
    void SetNextSlice(s64 slice) {
        downcount = slice;
    }
    void ForceExceptionCheck(s64 cycles) {
        if (downcount > cycles) {
            downcount = cycles;
        }
    }

private:
    u64 ticks = 0;
    s64 downcount = 0;
};

} // namespace Core::Timing
