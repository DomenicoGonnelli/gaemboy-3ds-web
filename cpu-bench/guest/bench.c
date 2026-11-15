// Guest benchmark for the 3DS ARM11 (ARMv6K + VFPv2). Built twice:
//  - for the guest (clang --target=armv6k, raw binary loaded at 0x00100000)
//  - for the host, to compute the expected checksums the emulators must reproduce.
// Everything is deterministic and uses fixed-width integer arithmetic.
#include <stdint.h>
#include "bench_config.h"

typedef uint8_t u8;
typedef uint16_t u16;
typedef uint32_t u32;
typedef int8_t s8;
typedef int32_t s32;

#define NOINLINE __attribute__((noinline))

u32 rng_state;
u32 xorshift(void) {
    u32 x = rng_state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    return rng_state = x;
}

// ---------------------------------------------------------------- entities
#define N_ENT 256
typedef struct {
    s32 x, y, vx, vy;
    u16 hp, flags;
    u8 state, type, timer, pad;
} Entity;
static Entity ents[N_ENT];
static const s32 type_speed[8] = {1, 2, 3, 5, 8, 13, 21, 34};
static const s8 dirs[8][2] = {{1, 0},  {1, 1},   {0, 1},  {-1, 1},
                              {-1, 0}, {-1, -1}, {0, -1}, {1, -1}};

static void ent_init(void) {
    for (int i = 0; i < N_ENT; i++) {
        Entity* e = &ents[i];
        e->x = (s32)(xorshift() & 0xFFFF);
        e->y = (s32)(xorshift() & 0xFFFF);
        e->vx = e->vy = 0;
        e->hp = 100;
        e->flags = (u16)xorshift();
        e->state = (u8)(xorshift() % 3);
        e->type = (u8)(xorshift() & 7);
        e->timer = (u8)((xorshift() & 31) + 1);
    }
}

static NOINLINE u32 w_entities(u32 iters) {
    u32 sum = 0;
    for (u32 it = 0; it < iters; it++) {
        for (int i = 0; i < N_ENT; i++) {
            Entity* e = &ents[i];
            switch (e->state) {
            case 0:
                if (--e->timer == 0) {
                    e->state = 1;
                    e->timer = (u8)((xorshift() & 31) + 1);
                    e->flags = (u16)(e->flags + 8);
                }
                break;
            case 1: {
                const s8* d = dirs[(e->flags >> 3) & 7];
                s32 sp = type_speed[e->type & 7];
                e->vx = d[0] * sp;
                e->vy = d[1] * sp;
                e->x += e->vx;
                e->y += e->vy;
                if ((u32)e->x > 0xFFFF) {
                    e->x &= 0xFFFF;
                    e->flags ^= 0x20;
                }
                if ((u32)e->y > 0xFFFF) {
                    e->y &= 0xFFFF;
                    e->flags ^= 0x10;
                }
                if (--e->timer == 0) {
                    e->state = 2;
                    e->timer = 8;
                }
                break;
            }
            default: {
                Entity* o = &ents[(i + 1) & (N_ENT - 1)];
                u32 dx = (u32)(e->x - o->x), dy = (u32)(e->y - o->y);
                if (dx * dx + dy * dy < 0x40000u) {
                    if (o->hp > 3) {
                        o->hp -= 3;
                    } else {
                        o->hp = 100;
                        o->state = 0;
                        o->timer = 16;
                    }
                }
                if (--e->timer == 0) {
                    e->state = 0;
                    e->timer = (u8)((e->hp & 15) + 1);
                }
                break;
            }
            }
            sum += (u32)e->x ^ ((u32)e->y << 7) ^ e->hp;
        }
    }
    return sum;
}

// ---------------------------------------------------------------- crc32
u32 crc_table[256];
u8 crc_buf[4096];

static void crc_init(void) {
    for (u32 i = 0; i < 256; i++) {
        u32 c = i;
        for (int k = 0; k < 8; k++) {
            c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
        }
        crc_table[i] = c;
    }
    for (int i = 0; i < 4096; i++) {
        crc_buf[i] = (u8)xorshift();
    }
}

static NOINLINE u32 w_crc(u32 iters) {
    u32 crc = 0xFFFFFFFFu;
    for (u32 it = 0; it < iters; it++) {
        for (int i = 0; i < 4096; i++) {
            crc = crc_table[(crc ^ crc_buf[i]) & 0xFF] ^ (crc >> 8);
        }
        crc_buf[it & 4095] ^= (u8)crc;
    }
    return ~crc;
}

// ---------------------------------------------------------------- shellsort
#define N_SORT 1024
static s32 sort_buf[N_SORT];

static NOINLINE u32 w_sort(u32 iters) {
    static const int gaps[] = {701, 301, 132, 57, 23, 10, 4, 1};
    u32 sum = 0;
    for (u32 it = 0; it < iters; it++) {
        for (int i = 0; i < N_SORT; i++) {
            sort_buf[i] = (s32)xorshift() >> 4;
        }
        for (int g = 0; g < 8; g++) {
            int gap = gaps[g];
            for (int i = gap; i < N_SORT; i++) {
                s32 tmp = sort_buf[i];
                int j = i;
                for (; j >= gap && sort_buf[j - gap] > tmp; j -= gap) {
                    sort_buf[j] = sort_buf[j - gap];
                }
                sort_buf[j] = tmp;
            }
        }
        sum += (u32)sort_buf[it % N_SORT] ^ (u32)sort_buf[N_SORT / 2];
    }
    return sum;
}

// ---------------------------------------------------------------- vertex transform (VFP)
#define N_VERT 512
typedef struct {
    float x, y, z, w;
} Vec4;
static Vec4 verts[N_VERT];
static Vec4 vout[N_VERT];
static float mtx[16];

static void vert_init(void) {
    for (int i = 0; i < N_VERT; i++) {
        verts[i].x = (float)(s32)(xorshift() & 0xFFF) * (1.0f / 256.0f) - 8.0f;
        verts[i].y = (float)(s32)(xorshift() & 0xFFF) * (1.0f / 256.0f) - 8.0f;
        verts[i].z = (float)(s32)(xorshift() & 0xFFF) * (1.0f / 256.0f) - 8.0f;
        verts[i].w = 1.0f;
    }
    for (int i = 0; i < 16; i++) {
        mtx[i] = (i % 5 == 0) ? 1.0f : 0.0625f * (float)(i & 3);
    }
}

static NOINLINE u32 w_vertex(u32 iters) {
    u32 acc = 0;
    for (u32 it = 0; it < iters; it++) {
        float s = 0.001f * (float)(it & 63);
        mtx[0] = 1.0f - s;
        mtx[5] = 1.0f + s;
        mtx[12] = s * 4.0f;
        for (int i = 0; i < N_VERT; i++) {
            const Vec4 v = verts[i];
            float x = mtx[0] * v.x + mtx[4] * v.y + mtx[8] * v.z + mtx[12] * v.w;
            float y = mtx[1] * v.x + mtx[5] * v.y + mtx[9] * v.z + mtx[13] * v.w;
            float z = mtx[2] * v.x + mtx[6] * v.y + mtx[10] * v.z + mtx[14] * v.w;
            float w = mtx[3] * v.x + mtx[7] * v.y + mtx[11] * v.z + mtx[15] * v.w;
            float inv = 1.0f / (w > 0.25f ? w : 0.25f);
            x *= inv;
            y *= inv;
            z *= inv;
            float len = __builtin_sqrtf(x * x + y * y + z * z) + 0.001f;
            vout[i].x = x / len;
            vout[i].y = y / len;
            vout[i].z = z;
            vout[i].w = len;
        }
        for (int i = 0; i < N_VERT; i += 16) {
            acc += (u32)(s32)(vout[i].x * 1024.0f) ^ (u32)(s32)(vout[i].w * 16.0f);
        }
    }
    return acc;
}

// ---------------------------------------------------------------- bytecode VM
// A tiny stack VM, similar in spirit to the script engines games run every frame.
enum { OP_PUSH, OP_LOAD, OP_STORE, OP_ADD, OP_SUB, OP_MUL, OP_XOR, OP_SHR, OP_AND, OP_DUP,
       OP_JNZ, OP_DEC, OP_HALT };
const u8 vm_prog[] = {
    OP_PUSH, 200,           // counter
    OP_STORE, 0,            //
    /* loop @4 */
    OP_LOAD, 1, OP_PUSH, 33, OP_MUL, OP_LOAD, 0, OP_XOR, OP_STORE, 1,
    OP_LOAD, 2, OP_LOAD, 1, OP_PUSH, 3, OP_SHR, OP_ADD, OP_PUSH, 255, OP_AND, OP_STORE, 2,
    OP_LOAD, 0, OP_DEC, OP_DUP, OP_STORE, 0,
    OP_JNZ, 4,
    OP_LOAD, 1, OP_LOAD, 2, OP_ADD, OP_HALT,
};

u32 vm_run(const u8* prog, u32 seed) {
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

static NOINLINE u32 w_vm(u32 iters) {
    u32 acc = 0;
    for (u32 it = 0; it < iters; it++) {
        acc += vm_run(vm_prog, acc ^ it);
    }
    return acc;
}

// ---------------------------------------------------------------- block copy
#define N_BLK 2048
static u32 blk_a[N_BLK];
static u32 blk_b[N_BLK];

static NOINLINE void blk_copy(u32* __restrict dst, const u32* __restrict src, u32 words) {
    while (words >= 8) {
        u32 a = src[0], b = src[1], c = src[2], d = src[3];
        u32 e = src[4], f = src[5], g = src[6], h = src[7];
        dst[0] = a; dst[1] = b; dst[2] = c; dst[3] = d;
        dst[4] = e; dst[5] = f; dst[6] = g; dst[7] = h;
        dst += 8;
        src += 8;
        words -= 8;
    }
    while (words--) {
        *dst++ = *src++;
    }
}

static NOINLINE u32 w_blkcopy(u32 iters) {
    for (int i = 0; i < N_BLK; i++) {
        blk_a[i] = xorshift();
    }
    for (u32 it = 0; it < iters; it++) {
        blk_copy(blk_b, blk_a, N_BLK);
        blk_a[it & (N_BLK - 1)] += blk_b[(it * 7) & (N_BLK - 1)];
    }
    return blk_b[3] ^ blk_b[N_BLK - 5] ^ blk_a[17];
}

// ---------------------------------------------------------------- thumb variants (thumb.c)
u32 w_crc_thumb(u32 iters);
u32 w_vm_thumb(u32 iters);

// ---------------------------------------------------------------- entry
static void bench_init(void) {
    rng_state = 0x2545F491u;
    ent_init();
    crc_init();
    vert_init();
}

static u32 run_workload(u32 w, u32 iters) {
    switch (w) {
    case W_ENTITIES: return w_entities(iters);
    case W_CRC: return w_crc(iters);
    case W_SORT: return w_sort(iters);
    case W_VERTEX: return w_vertex(iters);
    case W_VM: return w_vm(iters);
    case W_BLKCOPY: return w_blkcopy(iters);
    case W_CRC_THUMB: return w_crc_thumb(iters);
    case W_VM_THUMB: return w_vm_thumb(iters);
    default: return 0;
    }
}

u32 bench_main(u32 w, u32 iters) {
    bench_init();
    if (w != W_MIX) {
        return run_workload(w, iters);
    }
    // "mix": one frame worth of every workload, repeated
    u32 acc = 0;
    for (u32 it = 0; it < iters; it++) {
        acc += run_workload(W_ENTITIES, 4);
        acc ^= run_workload(W_CRC, 16);
        acc += run_workload(W_SORT, 1);
        acc ^= run_workload(W_VERTEX, 6);
        acc += run_workload(W_VM, 16);
        acc ^= run_workload(W_BLKCOPY, 24);
        acc += run_workload(W_CRC_THUMB, 16);
        acc ^= run_workload(W_VM_THUMB, 16);
    }
    return acc;
}
