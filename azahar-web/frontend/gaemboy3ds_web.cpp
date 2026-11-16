// GAEMBOY 3DS — minimal libretro frontend for Azahar's libretro core, built with Emscripten.
//
// The module lives in a dedicated Web Worker (web/gaemboy3ds-worker.js) and main() runs in a
// pthread (-sPROXY_TO_PTHREAD), so retro_run() may block freely. Page and AudioWorklet talk to the
// emulator only through the shared-memory struct returned by gb3ds_state(): frames, stats and the
// audio ring are read from it, input is written into it.
#include <atomic>
#include <chrono>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include <sys/stat.h>
#include <emscripten/emscripten.h>
#include <emscripten/html5.h>

#include "common/file_util.h"
#include "libretro.h"

namespace {

constexpr uint32_t kMaxFbPixels = 1024 * 1024;
constexpr uint32_t kAudioRingFrames = 16384; // ~0.5 s of stereo s16 at 32728 Hz

// Layout is mirrored in web/gaemboy3ds.js (Int32/Float32 views at fixed offsets).
struct SharedState {
    std::atomic<int32_t> status;      // 0 boot, 1 loading, 2 running, 3 error
    std::atomic<int32_t> frame_seq;   // bumped after each framebuffer copy
    int32_t fb_width;
    int32_t fb_height;
    int32_t fb_ptr;                   // RGBA8888, fb_width * fb_height
    int32_t throttle;                 // page: 1 = pace to ~60 fps, 0 = run flat out
    std::atomic<int32_t> buttons;     // page: bitmask of RETRO_DEVICE_ID_JOYPAD_*
    std::atomic<int32_t> pointer_x;   // page: libretro pointer coords [-0x7fff, 0x7fff]
    std::atomic<int32_t> pointer_y;
    std::atomic<int32_t> pointer_down;
    std::atomic<int32_t> analog_lx;   // page: circle pad [-0x7fff, 0x7fff]
    std::atomic<int32_t> analog_ly;
    int32_t frames_total;
    int32_t audio_frames_total;       // stereo frames produced by the core (32728 Hz native)
    float last_frame_ms;              // wall time of the last retro_run()
    float avg_frame_ms;               // EMA of retro_run() time
    float emu_fps;                    // frames per wall second over the last ~second
    float load_ms;                    // retro_load_game() time
    int32_t message_seq;
    char message[256];                // last core message / error
    std::atomic<int32_t> analog_rx;   // page: C-stick [-0x7fff, 0x7fff]
    std::atomic<int32_t> analog_ry;
    int32_t audio_ring_ptr;           // stereo s16 ring, kAudioRingFrames frames
    int32_t audio_ring_frames;
    std::atomic<uint32_t> audio_write; // frames written (wraps), producer = emulation thread
    std::atomic<uint32_t> audio_read;  // frames consumed (wraps), consumer = AudioWorklet
    int32_t audio_dropped;            // frames dropped because the ring was full
};

SharedState g_state{};
retro_hw_render_callback g_hw_render{};
std::vector<uint32_t> g_fb(kMaxFbPixels);
std::vector<int16_t> g_audio_ring(kAudioRingFrames * 2);
std::unordered_map<std::string, std::string> g_vars;

void SetMessage(const char* msg) {
    std::snprintf(g_state.message, sizeof(g_state.message), "%s", msg);
    g_state.message_seq++;
    std::printf("[gb3ds] %s\n", msg);
}

void LogCb(enum retro_log_level level, const char* fmt, ...) {
    if (level < RETRO_LOG_INFO) {
        return;
    }
    char buf[1024];
    va_list args;
    va_start(args, fmt);
    std::vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    std::fputs(buf, level >= RETRO_LOG_WARN ? stderr : stdout);
}

bool EnvironmentCb(unsigned cmd, void* data) {
    switch (cmd & ~RETRO_ENVIRONMENT_EXPERIMENTAL) {
    case RETRO_ENVIRONMENT_GET_VARIABLE: {
        auto* var = static_cast<retro_variable*>(data);
        const auto it = g_vars.find(var->key);
        if (it == g_vars.end()) {
            var->value = nullptr;
            return false;
        }
        var->value = it->second.c_str();
        return true;
    }
    case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
        *static_cast<bool*>(data) = false;
        return true;
    case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
        *static_cast<const char**>(data) = "/gaemboy/3ds/system";
        return true;
    case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
        *static_cast<const char**>(data) = "/gaemboy/3ds/saves";
        return true;
    case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
        return *static_cast<retro_pixel_format*>(data) == RETRO_PIXEL_FORMAT_XRGB8888;
    case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
        static_cast<retro_log_callback*>(data)->log = LogCb;
        return true;
    case RETRO_ENVIRONMENT_SET_MESSAGE:
        SetMessage(static_cast<const retro_message*>(data)->msg);
        return true;
    case RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION:
        *static_cast<unsigned*>(data) = 0;
        return true;
    case RETRO_ENVIRONMENT_GET_PREFERRED_HW_RENDER:
        *static_cast<retro_hw_context_type*>(data) = RETRO_HW_CONTEXT_OPENGLES3;
        return true;
    case RETRO_ENVIRONMENT_SET_HW_RENDER: {
        g_hw_render = *static_cast<retro_hw_render_callback*>(data);
        g_hw_render.get_proc_address =
            reinterpret_cast<retro_hw_get_proc_address_t>(emscripten_webgl_get_proc_address);
        g_hw_render.get_current_framebuffer = []() -> uintptr_t { return 0; };
        *static_cast<retro_hw_render_callback*>(data) = g_hw_render;
        return true;
    }
    case RETRO_ENVIRONMENT_SET_VARIABLES:
    case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
    case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
    case RETRO_ENVIRONMENT_SET_SERIALIZATION_QUIRKS:
    case RETRO_ENVIRONMENT_SET_MEMORY_MAPS:
    case RETRO_ENVIRONMENT_SET_GEOMETRY:
    case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO:
        return true;
    default:
        return false;
    }
}

void VideoRefreshCb(const void* data, unsigned width, unsigned height, size_t pitch) {
    if (data == RETRO_HW_FRAME_BUFFER_VALID) {
        g_state.fb_width = static_cast<int32_t>(width);
        g_state.fb_height = static_cast<int32_t>(height);
        g_state.frame_seq.fetch_add(1, std::memory_order_release);
        return;
    }
    if (!data || width == 0 || height == 0 || width * height > kMaxFbPixels) {
        return;
    }
    // XRGB8888 (0xXXRRGGBB) -> RGBA bytes for canvas ImageData.
    const auto* src = static_cast<const uint8_t*>(data);
    for (unsigned y = 0; y < height; y++) {
        const auto* row = reinterpret_cast<const uint32_t*>(src + y * pitch);
        uint32_t* out = g_fb.data() + y * width;
        for (unsigned x = 0; x < width; x++) {
            const uint32_t p = row[x];
            out[x] = 0xFF000000u | ((p >> 16) & 0xFF) | (p & 0xFF00) | ((p & 0xFF) << 16);
        }
    }
    g_state.fb_width = static_cast<int32_t>(width);
    g_state.fb_height = static_cast<int32_t>(height);
    g_state.frame_seq.fetch_add(1, std::memory_order_release);
}

size_t AudioBatchCb(const int16_t* data, size_t frames) {
    g_state.audio_frames_total += static_cast<int32_t>(frames);
    const uint32_t write = g_state.audio_write.load(std::memory_order_relaxed);
    const uint32_t read = g_state.audio_read.load(std::memory_order_acquire);
    const uint32_t free_frames = kAudioRingFrames - (write - read);
    uint32_t n = static_cast<uint32_t>(frames);
    if (n > free_frames) {
        // Consumer is behind (tab hidden, audio muted or slow device): drop the newest frames.
        g_state.audio_dropped += static_cast<int32_t>(n - free_frames);
        n = free_frames;
    }
    for (uint32_t i = 0; i < n; i++) {
        const uint32_t slot = (write + i) % kAudioRingFrames;
        g_audio_ring[slot * 2] = data[i * 2];
        g_audio_ring[slot * 2 + 1] = data[i * 2 + 1];
    }
    g_state.audio_write.store(write + n, std::memory_order_release);
    return frames;
}

void InputPollCb() {}

int16_t InputStateCb(unsigned port, unsigned device, unsigned index, unsigned id) {
    if (port != 0) {
        return 0;
    }
    switch (device) {
    case RETRO_DEVICE_JOYPAD:
        if (id == RETRO_DEVICE_ID_JOYPAD_MASK) {
            return static_cast<int16_t>(g_state.buttons.load());
        }
        return (g_state.buttons.load() >> id) & 1;
    case RETRO_DEVICE_ANALOG:
        if (index == RETRO_DEVICE_INDEX_ANALOG_LEFT) {
            return static_cast<int16_t>(id == RETRO_DEVICE_ID_ANALOG_X ? g_state.analog_lx.load()
                                                                       : g_state.analog_ly.load());
        }
        if (index == RETRO_DEVICE_INDEX_ANALOG_RIGHT) {
            return static_cast<int16_t>(id == RETRO_DEVICE_ID_ANALOG_X ? g_state.analog_rx.load()
                                                                       : g_state.analog_ry.load());
        }
        return 0;
    case RETRO_DEVICE_POINTER:
        if (index != 0) {
            return 0;
        }
        switch (id) {
        case RETRO_DEVICE_ID_POINTER_X:
            return static_cast<int16_t>(g_state.pointer_x.load());
        case RETRO_DEVICE_ID_POINTER_Y:
            return static_cast<int16_t>(g_state.pointer_y.load());
        case RETRO_DEVICE_ID_POINTER_PRESSED:
            return static_cast<int16_t>(g_state.pointer_down.load());
        case RETRO_DEVICE_ID_POINTER_COUNT:
            return g_state.pointer_down.load() ? 1 : 0;
        default:
            return 0;
        }
    default:
        return 0;
    }
}

void DefaultOptions(bool use_sw) {
    g_vars["citra_graphics_api"] = use_sw ? "Software" : "OpenGL";
    g_vars["citra_use_hw_shader"] = "enabled";
    g_vars["citra_use_shader_jit"] = "disabled";
    g_vars["citra_use_cpu_jit"] = "disabled";  // no Dynarmic on wasm32
    g_vars["citra_use_fastinterp"] = "enabled";
    g_vars["citra_layout_option"] = "default"; // top screen above bottom screen
    g_vars["citra_analog_function"] = "c_stick"; // right stick = C-stick only (touch = pointer)
}

using clock_t_gb = std::chrono::steady_clock;
constexpr auto kFrameDur = std::chrono::nanoseconds(16'715'000);
clock_t_gb::time_point g_next_deadline;
clock_t_gb::time_point g_fps_window_start;
int g_fps_window_frames = 0;

void StepFrame() {
    const auto now = clock_t_gb::now();
    if (g_state.throttle && now + std::chrono::milliseconds(2) < g_next_deadline) {
        return; // e.g. 120 Hz display: skip every other rAF to pace ~60 fps
    }
    const auto t0 = now;
    retro_run();
    const auto t1 = clock_t_gb::now();
    const float ms = std::chrono::duration<float, std::milli>(t1 - t0).count();
    g_state.last_frame_ms = ms;
    g_state.avg_frame_ms =
        g_state.frames_total == 0 ? ms : g_state.avg_frame_ms * 0.95f + ms * 0.05f;
    g_state.frames_total++;
    g_fps_window_frames++;
    const float window_s = std::chrono::duration<float>(t1 - g_fps_window_start).count();
    if (window_s >= 1.0f) {
        g_state.emu_fps = g_fps_window_frames / window_s;
        g_fps_window_frames = 0;
        g_fps_window_start = t1;
    }
    if (g_state.throttle) {
        g_next_deadline += kFrameDur;
        if (g_next_deadline < t1) {
            g_next_deadline = t1;
        }
    } else {
        g_next_deadline = t1;
    }
}

// Diagnostic for large game files: reads 16-byte ASCII markers ("@" + offset in hex) written at
// known offsets of a synthetic file through Azahar's own FileUtil::IOFile, with both the
// seek+fread path and the pread path (ReadAtBytes), from the emulation thread.
int RunIoSelfTest(const char* path) {
    FileUtil::IOFile file(path, "rb");
    if (!file.IsOpen()) {
        SetMessage("io-selftest: impossibile aprire il file");
        return 1;
    }
    const uint64_t size = file.GetSize();
    const uint64_t offsets[] = {0x1000ull,     1500000000ull, 0x7FFFF000ull, 0x80000000ull,
                                0x80001000ull, 3000000000ull, 3400000000ull};
    int checked = 0, ok = 0;
    char line[256];
    for (const uint64_t off : offsets) {
        if (off + 16 > size) {
            continue;
        }
        char expected[17];
        std::snprintf(expected, sizeof(expected), "@%015llx", static_cast<unsigned long long>(off));
        char seek_buf[17]{};
        char pread_buf[17]{};
        file.Seek(static_cast<s64>(off), SEEK_SET);
        file.ReadBytes(seek_buf, 16);
        file.ReadAtBytes(pread_buf, 16, static_cast<std::size_t>(off));
        const bool seek_ok = std::memcmp(seek_buf, expected, 16) == 0;
        const bool pread_ok = std::memcmp(pread_buf, expected, 16) == 0;
        checked += 2;
        ok += seek_ok + pread_ok;
        std::snprintf(line, sizeof(line), "io-selftest off=0x%09llx seek=%s pread=%s",
                      static_cast<unsigned long long>(off), seek_ok ? "OK" : "FAIL",
                      pread_ok ? "OK" : "FAIL");
        std::printf("%s\n", line);
    }
    std::snprintf(line, sizeof(line), "io-selftest: size=%llu, letture corrette %d/%d",
                  static_cast<unsigned long long>(size), ok, checked);
    SetMessage(line);
    g_state.status = ok == checked ? 2 : 3;
    return ok == checked ? 0 : 1;
}

} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE SharedState* gb3ds_state() {
    return &g_state;
}

EMSCRIPTEN_KEEPALIVE int gb3ds_state_size() {
    return static_cast<int>(sizeof(SharedState));
}

} // extern "C"

int main(int argc, char** argv) {
    const char* rom = argc > 1 ? argv[1] : "/rom/game.3dsx";
    g_state.fb_ptr = static_cast<int32_t>(reinterpret_cast<uintptr_t>(g_fb.data()));
    g_state.audio_ring_ptr = static_cast<int32_t>(reinterpret_cast<uintptr_t>(g_audio_ring.data()));
    g_state.audio_ring_frames = static_cast<int32_t>(kAudioRingFrames);
    g_state.throttle = 1;
    for (const char* dir :
         {"/gaemboy", "/gaemboy/3ds", "/gaemboy/3ds/system", "/gaemboy/3ds/saves"}) {
        mkdir(dir, 0755);
    }
    bool use_sw = false;
    bool io_selftest = false;
    for (int i = 2; i < argc; i++) {
        if (std::strcmp(argv[i], "--sw") == 0) use_sw = true;
        if (std::strcmp(argv[i], "--io-selftest") == 0) io_selftest = true;
    }
    DefaultOptions(use_sw);
    if (io_selftest) {
        return RunIoSelfTest(rom);
    }

    retro_set_environment(EnvironmentCb);
    retro_set_video_refresh(VideoRefreshCb);
    retro_set_audio_sample_batch(AudioBatchCb);
    retro_set_input_poll(InputPollCb);
    retro_set_input_state(InputStateCb);
    retro_init();

    g_state.status = 1;
    retro_game_info info{};
    info.path = rom;
    const auto load_start = std::chrono::steady_clock::now();
    if (!retro_load_game(&info)) {
        char reason[sizeof(g_state.message)];
        std::snprintf(reason, sizeof(reason), "Caricamento fallito: %s",
                      g_state.message_seq > 0 ? g_state.message : "formato non riconosciuto");
        g_state.status = 3;
        SetMessage(reason);
        return 1;
    }
    if (!use_sw && g_hw_render.context_reset != nullptr) {
        EmscriptenWebGLContextAttributes attrs;
        emscripten_webgl_init_context_attributes(&attrs);
        attrs.majorVersion = 2;
        attrs.minorVersion = 0;
        attrs.alpha = false;
        attrs.depth = true;
        attrs.stencil = true;
        attrs.antialias = false;
        attrs.preserveDrawingBuffer = false;
        EM_ASM({
            if (typeof specialHTMLTargets !== 'undefined' && Module['canvas']) {
                specialHTMLTargets['#canvas'] = Module['canvas'];
            }
        });
        EMSCRIPTEN_WEBGL_CONTEXT_HANDLE ctx = emscripten_webgl_create_context("#canvas", &attrs);
        if (ctx <= 0) {
            g_state.status = 3;
            SetMessage("Impossibile creare il contesto WebGL2 sull'OffscreenCanvas");
            return 1;
        }
        emscripten_webgl_make_context_current(ctx);
        g_hw_render.context_reset();
    }
    g_state.load_ms =
        std::chrono::duration<float, std::milli>(std::chrono::steady_clock::now() - load_start)
            .count();
    g_state.status = 2;

    g_next_deadline = clock_t_gb::now();
    g_fps_window_start = g_next_deadline;
    emscripten_set_main_loop(StepFrame, 0, false);
    return 0;
}
