// POC stub of Azahar's common/assert.h without the logging backend.
#pragma once
#include <cstdio>
#include <cstdlib>
#include "common/common_funcs.h"
#define ASSERT(_a_)                                                                                \
    do {                                                                                           \
        if (!(_a_)) [[unlikely]] {                                                                 \
            std::fprintf(stderr, "Assertion failed: %s (%s:%d)\n", #_a_, __FILE__, __LINE__);     \
            std::abort();                                                                          \
        }                                                                                          \
    } while (0)
#define ASSERT_MSG(_a_, ...) ASSERT(_a_)
#define UNREACHABLE() (std::fprintf(stderr, "Unreachable %s:%d\n", __FILE__, __LINE__), std::abort())
#define UNREACHABLE_MSG(...) UNREACHABLE()
#define DEBUG_ASSERT(_a_)
#define DEBUG_ASSERT_MSG(_a_, ...)
#define UNIMPLEMENTED() ((void)0)
#define UNIMPLEMENTED_MSG(...) ((void)0)
