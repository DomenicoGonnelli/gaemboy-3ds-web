// Minimal freestanding runtime for the guest: entry point + the ARM EABI helpers
// clang may call (ARMv6K has no hardware divide).
#include <stddef.h>
#include <stdint.h>

typedef uint32_t u32;
typedef int32_t s32;
typedef uint64_t u64;

u32 bench_main(u32 workload, u32 iters);

// Host sets r0/r1 (workload, iterations) and sp before jumping here.
__attribute__((naked, section(".text.start"))) void _start(void) {
    __asm__ volatile("bl bench_main\n\t"
                     "svc #0x03\n\t" // ExitProcess: r0 = checksum
                     "1: b 1b\n\t");
}

static u32 udiv(u32 n, u32 d, u32* rem) {
    if (d == 0) {
        *rem = n;
        return 0xFFFFFFFFu;
    }
    u32 q = 0, r = 0;
    for (int i = 31; i >= 0; i--) {
        r = (r << 1) | ((n >> i) & 1);
        if (r >= d) {
            r -= d;
            q |= 1u << i;
        }
    }
    *rem = r;
    return q;
}

u32 __aeabi_uidiv(u32 n, u32 d) {
    u32 r;
    return udiv(n, d, &r);
}

s32 __aeabi_idiv(s32 n, s32 d) {
    u32 r;
    u32 q = udiv(n < 0 ? -(u32)n : (u32)n, d < 0 ? -(u32)d : (u32)d, &r);
    return ((n < 0) != (d < 0)) ? -(s32)q : (s32)q;
}

u64 __aeabi_uidivmod(u32 n, u32 d) {
    u32 r;
    u32 q = udiv(n, d, &r);
    return ((u64)r << 32) | q;
}

u64 __aeabi_idivmod(s32 n, s32 d) {
    u32 r;
    u32 q = udiv(n < 0 ? -(u32)n : (u32)n, d < 0 ? -(u32)d : (u32)d, &r);
    s32 sq = ((n < 0) != (d < 0)) ? -(s32)q : (s32)q;
    s32 sr = n < 0 ? -(s32)r : (s32)r;
    return ((u64)(u32)sr << 32) | (u32)sq;
}

void* memcpy(void* dst, const void* src, size_t n) {
    unsigned char* d = dst;
    const unsigned char* s = src;
    while (n--) {
        *d++ = *s++;
    }
    return dst;
}

void* memset(void* dst, int c, size_t n) {
    unsigned char* d = dst;
    while (n--) {
        *d++ = (unsigned char)c;
    }
    return dst;
}

void __aeabi_memcpy(void* d, const void* s, size_t n) { memcpy(d, s, n); }
void __aeabi_memcpy4(void* d, const void* s, size_t n) { memcpy(d, s, n); }
void __aeabi_memcpy8(void* d, const void* s, size_t n) { memcpy(d, s, n); }
void __aeabi_memset(void* d, size_t n, int c) { memset(d, c, n); }
void __aeabi_memset4(void* d, size_t n, int c) { memset(d, c, n); }
void __aeabi_memclr(void* d, size_t n) { memset(d, 0, n); }
void __aeabi_memclr4(void* d, size_t n) { memset(d, 0, n); }
void __aeabi_memclr8(void* d, size_t n) { memset(d, 0, n); }
