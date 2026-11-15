// Implementations behind the POC stub headers (memory bus + tiny HLE kernel).
#include <cstdio>
#include <cstring>
#include "core/core.h"
#include "core/hle/kernel/svc.h"
#include "core/memory.h"

namespace Memory {

// Out-of-line like Azahar's MemorySystem: the interpreters pay a real call per slow-path access.
template <typename T>
static T ReadT(PageTable* pt, u64& unmapped, VAddr addr) {
    const u8* page = pt->raw[addr >> CITRA_PAGE_BITS];
    if (page) [[likely]] {
        T value;
        std::memcpy(&value, page + (addr & CITRA_PAGE_MASK), sizeof(T));
        return value;
    }
    unmapped++;
    return 0;
}

template <typename T>
static void WriteT(PageTable* pt, u64& unmapped, VAddr addr, T data) {
    u8* page = pt->raw[addr >> CITRA_PAGE_BITS];
    if (page) [[likely]] {
        std::memcpy(page + (addr & CITRA_PAGE_MASK), &data, sizeof(T));
        return;
    }
    unmapped++;
}

u8 MemorySystem::Read8(VAddr a) { return ReadT<u8>(current_page_table, unmapped_accesses, a); }
u16 MemorySystem::Read16(VAddr a) { return ReadT<u16>(current_page_table, unmapped_accesses, a); }
u32 MemorySystem::Read32(VAddr a) { return ReadT<u32>(current_page_table, unmapped_accesses, a); }
u64 MemorySystem::Read64(VAddr a) { return ReadT<u64>(current_page_table, unmapped_accesses, a); }
void MemorySystem::Write8(VAddr a, u8 d) { WriteT(current_page_table, unmapped_accesses, a, d); }
void MemorySystem::Write16(VAddr a, u16 d) { WriteT(current_page_table, unmapped_accesses, a, d); }
void MemorySystem::Write32(VAddr a, u32 d) { WriteT(current_page_table, unmapped_accesses, a, d); }
void MemorySystem::Write64(VAddr a, u64 d) { WriteT(current_page_table, unmapped_accesses, a, d); }

template <typename T>
static bool WriteExclusiveT(PageTable* pt, u64& unmapped, VAddr addr, T data, T expected) {
    u8* page = pt->raw[addr >> CITRA_PAGE_BITS];
    if (!page) {
        unmapped++;
        return false;
    }
    T current;
    std::memcpy(&current, page + (addr & CITRA_PAGE_MASK), sizeof(T));
    if (current != expected) {
        return false;
    }
    std::memcpy(page + (addr & CITRA_PAGE_MASK), &data, sizeof(T));
    return true;
}

bool MemorySystem::WriteExclusive8(VAddr a, u8 d, u8 e) {
    return WriteExclusiveT(current_page_table, unmapped_accesses, a, d, e);
}
bool MemorySystem::WriteExclusive16(VAddr a, u16 d, u16 e) {
    return WriteExclusiveT(current_page_table, unmapped_accesses, a, d, e);
}
bool MemorySystem::WriteExclusive32(VAddr a, u32 d, u32 e) {
    return WriteExclusiveT(current_page_table, unmapped_accesses, a, d, e);
}
bool MemorySystem::WriteExclusive64(VAddr a, u64 d, u64 e) {
    return WriteExclusiveT(current_page_table, unmapped_accesses, a, d, e);
}

} // namespace Memory

namespace Kernel {

SVCContext::SVCContext(Core::System& system_) : system(system_) {}
SVCContext::~SVCContext() = default;

void SVCContext::CallSVC(u32 immediate) {
    auto& cpu = system.GetRunningCore();
    switch (immediate) {
    case 0x03: // ExitProcess
        system.exit_requested = true;
        system.exit_code = cpu.GetReg(0);
        cpu.PrepareReschedule();
        cpu.GetTimer().ForceExceptionCheck(0);
        break;
    default:
        std::fprintf(stderr, "unhandled svc 0x%02X at pc %08X\n", immediate, cpu.GetPC());
        system.exit_requested = true;
        system.exit_code = 0xDEADDEAD;
        cpu.PrepareReschedule();
        cpu.GetTimer().ForceExceptionCheck(0);
        break;
    }
}

} // namespace Kernel
