#include "harness.h"

#include <chrono>
#include <cstring>
#include <memory>

#include "core/arm/dyncom/arm_dyncom.h"
#include "core/arm/fastinterp/fastinterp.h"
#include "core/arm/skyeye_common/armstate.h"
#include "core/core.h"
#include "core/core_timing.h"
#include "core/memory.h"

namespace {

constexpr u32 kCodeBase = 0x00100000; // 3DS application load address
constexpr u32 kCodeSize = 16u << 20;  // code + data + bss + heap
constexpr u32 kStackTop = 0x10000000; // 3DS main thread stack top
constexpr u32 kStackSize = 1u << 20;
constexpr s64 kSliceTicks = static_cast<s64>(kArm11Hz) / 234; // Azahar's MAX_SLICE_LENGTH
constexpr u64 kRunawayTicks = 400ull * 268111856ull;           // 400 emulated seconds

void MapRange(Memory::PageTable& pt, u32 vaddr, u8* backing, u32 size) {
    for (u32 off = 0; off < size; off += Memory::CITRA_PAGE_SIZE) {
        pt.raw[(vaddr + off) >> Memory::CITRA_PAGE_BITS] = backing + off;
    }
}

} // namespace

const char* CoreName(CoreKind core) {
    return core == CoreKind::DynCom ? "dyncom" : "fastinterp";
}

RunResult RunGuest(CoreKind core, const std::vector<uint8_t>& image, uint32_t workload,
                   uint32_t iters) {
    RunResult result;

    auto page_table = std::make_shared<Memory::PageTable>();
    std::vector<u8> code(kCodeSize, 0);
    std::vector<u8> stack(kStackSize, 0);
    std::memcpy(code.data(), image.data(), std::min<size_t>(image.size(), code.size()));
    MapRange(*page_table, kCodeBase, code.data(), kCodeSize);
    MapRange(*page_table, kStackTop - kStackSize, stack.data(), kStackSize);

    Memory::MemorySystem memory(page_table.get());
    Core::System system;
    auto timer = std::make_shared<Core::Timing::Timer>();

    std::unique_ptr<Core::ARM_Interface> cpu;
    if (core == CoreKind::DynCom) {
        cpu = std::make_unique<Core::ARM_DynCom>(system, memory, USER32MODE, 0, timer);
    } else {
        cpu = std::make_unique<Core::FastInterp::ARM_FastInterp>(system, memory, 0, timer);
    }
    system.running_core = cpu.get();
    cpu->SetPageTable(page_table);

    for (int i = 0; i < 15; i++) {
        cpu->SetReg(i, 0);
    }
    cpu->SetReg(0, workload);
    cpu->SetReg(1, iters);
    cpu->SetReg(13, kStackTop);
    cpu->SetCPSR(USER32MODE); // user mode, ARM state, flags clear
    cpu->SetVFPSystemReg(VFP_FPEXC, 0x40000000); // VFP enabled
    cpu->SetVFPSystemReg(VFP_FPSCR, 0);          // IEEE round-to-nearest, no flush-to-zero
    cpu->SetPC(kCodeBase);

    const auto t0 = std::chrono::steady_clock::now();
    while (!system.exit_requested && timer->GetTicks() < kRunawayTicks) {
        timer->SetNextSlice(kSliceTicks);
        cpu->Run();
    }
    const auto t1 = std::chrono::steady_clock::now();

    result.exited = system.exit_requested;
    result.checksum = system.exit_code;
    result.ticks = timer->GetTicks();
    result.seconds = std::chrono::duration<double>(t1 - t0).count();
    result.unmapped = memory.unmapped_accesses;
    return result;
}
