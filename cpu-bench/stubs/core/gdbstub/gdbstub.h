#pragma once
#include "common/common_types.h"

namespace GDBStub {

enum class BreakpointType { None, Execute, Read, Write, Access };

struct BreakpointAddress {
    VAddr address;
    BreakpointType type;
};

inline bool IsServerEnabled() {
    return false;
}
inline bool IsConnected() {
    return false;
}
inline void Break(int) {}
inline void Break(bool) {}
inline BreakpointAddress GetNextBreakpointFromAddress(VAddr addr, BreakpointType) {
    return {addr, BreakpointType::None};
}
inline bool CheckBreakpoint(VAddr, u32, BreakpointType) {
    return false;
}

} // namespace GDBStub
