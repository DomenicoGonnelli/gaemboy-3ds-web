// POC stub: logging disabled (benchmark must not pay for formatting).
#pragma once
#include <cstdio>
#define LOG_TRACE(...) ((void)0)
#define LOG_DEBUG(...) ((void)0)
#define LOG_INFO(...) ((void)0)
#define LOG_WARNING(...) ((void)0)
#define LOG_ERROR(cls, fmt, ...) (std::fprintf(stderr, "[error] " #cls ": " fmt "\n"))
#define LOG_CRITICAL(cls, fmt, ...) (std::fprintf(stderr, "[critical] " #cls ": " fmt "\n"))
