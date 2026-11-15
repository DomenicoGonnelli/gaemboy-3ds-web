// Thumb-1 (ARMv6K has no Thumb-2) copies of two workloads; built with -mthumb for the guest.
#include <stdint.h>

typedef uint8_t u8;
typedef uint32_t u32;

extern u32 crc_table[256];
extern u8 crc_buf[4096];
extern const u8 vm_prog[];

u32 w_crc_thumb(u32 iters) {
    u32 crc = 0xFFFFFFFFu;
    for (u32 it = 0; it < iters; it++) {
        for (int i = 0; i < 4096; i++) {
            crc = crc_table[(crc ^ crc_buf[i]) & 0xFF] ^ (crc >> 8);
        }
        crc_buf[it & 4095] ^= (u8)crc;
    }
    return ~crc;
}

enum { OP_PUSH, OP_LOAD, OP_STORE, OP_ADD, OP_SUB, OP_MUL, OP_XOR, OP_SHR, OP_AND, OP_DUP,
       OP_JNZ, OP_DEC, OP_HALT };

static u32 vm_run_thumb(const u8* prog, u32 seed) {
    u32 stack[16];
    u32 vars[4] = {0, seed, seed & 0xFF, 0};
    int sp = 0;
    u32 pc = 0;
    for (;;) {
        u8 op = prog[pc++];
        switch (op) {
        case OP_PUSH: stack[sp++] = prog[pc++]; break;
        case OP_LOAD: stack[sp++] = vars[prog[pc++]]; break;
        case OP_STORE: vars[prog[pc++]] = stack[--sp]; break;
        case OP_ADD: sp--; stack[sp - 1] += stack[sp]; break;
        case OP_SUB: sp--; stack[sp - 1] -= stack[sp]; break;
        case OP_MUL: sp--; stack[sp - 1] *= stack[sp]; break;
        case OP_XOR: sp--; stack[sp - 1] ^= stack[sp]; break;
        case OP_SHR: sp--; stack[sp - 1] >>= (stack[sp] & 31); break;
        case OP_AND: sp--; stack[sp - 1] &= stack[sp]; break;
        case OP_DUP: stack[sp] = stack[sp - 1]; sp++; break;
        case OP_JNZ: { u8 target = prog[pc++]; if (stack[--sp]) pc = target; break; }
        case OP_DEC: stack[sp - 1]--; break;
        default: return stack[sp - 1];
        }
    }
}

u32 w_vm_thumb(u32 iters) {
    u32 acc = 0;
    for (u32 it = 0; it < iters; it++) {
        acc += vm_run_thumb(vm_prog, acc ^ it);
    }
    return acc;
}
