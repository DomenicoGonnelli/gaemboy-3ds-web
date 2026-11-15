// POC stub of Core::System: just enough for the interpreters' SVC/timer paths.
#pragma once
#include "core/arm/arm_interface.h"

namespace Core {

class System {
public:
    ARM_Interface& GetRunningCore() {
        return *running_core;
    }
    ARM_Interface* running_core = nullptr;
    bool exit_requested = false;
    u32 exit_code = 0;
};

} // namespace Core
