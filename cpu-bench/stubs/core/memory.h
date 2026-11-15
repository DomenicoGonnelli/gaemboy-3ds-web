// POC stub of Memory: flat page table, Read/Write out-of-line like the real MemorySystem.
#pragma once
#include <array>
#include <cstddef>
#include "common/common_types.h"

namespace Memory {

constexpr u32 CITRA_PAGE_SIZE = 0x1000;
constexpr u32 CITRA_PAGE_MASK = CITRA_PAGE_SIZE - 1;
constexpr int CITRA_PAGE_BITS = 12;
constexpr std::size_t PAGE_TABLE_NUM_ENTRIES = 1 << (32 - CITRA_PAGE_BITS);

struct PageTable {
    std::array<u8*, PAGE_TABLE_NUM_ENTRIES> raw{};
    std::array<u8*, PAGE_TABLE_NUM_ENTRIES>& GetPointerArray() {
        return raw;
    }
};

class MemorySystem {
public:
    explicit MemorySystem(PageTable* table) : current_page_table(table) {}

    u8 Read8(VAddr addr);
    u16 Read16(VAddr addr);
    u32 Read32(VAddr addr);
    u64 Read64(VAddr addr);
    void Write8(VAddr addr, u8 data);
    void Write16(VAddr addr, u16 data);
    void Write32(VAddr addr, u32 data);
    void Write64(VAddr addr, u64 data);
    bool WriteExclusive8(VAddr addr, u8 data, u8 expected);
    bool WriteExclusive16(VAddr addr, u16 data, u16 expected);
    bool WriteExclusive32(VAddr addr, u32 data, u32 expected);
    bool WriteExclusive64(VAddr addr, u64 data, u64 expected);

    u64 unmapped_accesses = 0;

private:
    PageTable* current_page_table;
};

} // namespace Memory
