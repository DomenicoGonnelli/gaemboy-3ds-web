// POC stub of the HLE kernel: svc 0x03 (ExitProcess) ends the benchmark, svc 0x3D (OutputDebugString) prints.
#pragma once
#include "common/common_types.h"

namespace Core {
class System;
}

namespace Kernel {

class SVCContext {
public:
    explicit SVCContext(Core::System& system);
    ~SVCContext();
    void CallSVC(u32 immediate);

private:
    Core::System& system;
};

} // namespace Kernel
