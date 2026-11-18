// GAEMBOY 3DS — minimal libretro frontend for Azahar's libretro core, built with Emscripten.
//
// The module lives in a dedicated Web Worker (web/gaemboy3ds-worker.js); main() and the frame loop
// run on that worker (Emscripten's main thread), so retro_run() may block without freezing the
// page. New pthreads can only be spawned there when the loop yields, so every thread the core
// needs must come from the pre-allocated pool (see PTHREAD_POOL_SIZE in scripts/build.sh). Page and AudioWorklet talk to the
// emulator only through the shared-memory struct returned by gb3ds_state(): frames, stats and the
// audio ring are read from it, input is written into it.
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include <sys/stat.h>
#include <emscripten/emscripten.h>
#include <emscripten/html5.h>

#include "common/file_util.h"
#include "common/settings.h"
#include "core/cheats/cheats.h"
#include "core/cheats/gateway_cheat.h"
#include "core/core.h"
#include "core/frontend/camera/factory.h"
#include "core/hle/service/cam/cam.h"
#include "libretro.h"

struct retro_microphone {
    std::atomic<bool> active{false};
    unsigned rate = 48000;
};

namespace OpenGL {
extern int g_web_stream_mode; // gl_stream_buffer.cpp
extern int g_web_shader_mode; // gl_shader_util.cpp
}

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

constexpr int kCameraWidth = 320;
constexpr int kCameraHeight = 240;
struct SharedCamera {
    std::atomic<int32_t> lock{0};
    std::atomic<int32_t> available{0};
    std::array<uint8_t, kCameraWidth * kCameraHeight * 4> rgba{};
};
static_assert(offsetof(SharedCamera, rgba) == 8);
SharedCamera g_camera;
retro_microphone g_microphone;

EM_JS(int, gb3ds_read_microphone, (int16_t* output, size_t count), {
    const mic = self.__gb3dsMic;
    if (!mic || !Atomics.load(mic.control, 2)) return 0;
    const write = Atomics.load(mic.control, 0) >>> 0;
    let read = Atomics.load(mic.control, 1) >>> 0;
    const available = (write - read) >>> 0;
    const n = Math.min(count, available, mic.samples.length);
    for (let i = 0; i < n; i++) {
        HEAP16[(output >> 1) + i] = mic.samples[(read + i) % mic.samples.length];
    }
    read = (read + n) >>> 0;
    Atomics.store(mic.control, 1, read);
    return n;
});

EM_JS(void, gb3ds_set_microphone_active, (int active), {
    const mic = self.__gb3dsMic;
    if (!mic || Atomics.load(mic.control, 2) === active) return;
    if (!active) Atomics.store(mic.control, 1, Atomics.load(mic.control, 0));
    Atomics.store(mic.control, 2, active);
});

retro_microphone_t* OpenMicrophone(const retro_microphone_params_t* params) {
    if (params && params->rate && params->rate != 48000) return nullptr;
    g_microphone.active = false;
    return &g_microphone;
}

void CloseMicrophone(retro_microphone_t* mic) {
    if (mic != &g_microphone) return;
    g_microphone.active = false;
}

bool GetMicrophoneParams(const retro_microphone_t* mic, retro_microphone_params_t* params) {
    if (mic != &g_microphone || !params) return false;
    params->rate = g_microphone.rate;
    return true;
}

bool SetMicrophoneState(retro_microphone_t* mic, bool active) {
    if (mic != &g_microphone) return false;
    g_microphone.active = active;
    return true;
}

bool GetMicrophoneState(const retro_microphone_t* mic) {
    return mic == &g_microphone && g_microphone.active;
}

int ReadMicrophone(retro_microphone_t* mic, int16_t* samples, size_t count) {
    if (mic != &g_microphone || !samples) return -1;
    return g_microphone.active ? gb3ds_read_microphone(samples, count) : 0;
}

class WebCamera final : public Camera::CameraInterface {
public:
    explicit WebCamera(Service::CAM::Flip flip) : basic_flip(flip) {}

    void StartCapture() override {}
    void StopCapture() override {}
    void SetResolution(const Service::CAM::Resolution& resolution) override {
        std::lock_guard lock{config_mutex};
        width = resolution.width;
        height = resolution.height;
    }
    void SetFlip(Service::CAM::Flip value) override {
        std::lock_guard lock{config_mutex};
        flip = value;
    }
    void SetEffect(Service::CAM::Effect effect) override {
        if (effect != Service::CAM::Effect::NoEffect) {
            std::printf("[gaemboy] effetto fotocamera %d non supportato\n",
                        static_cast<int>(effect));
        }
    }
    void SetFormat(Service::CAM::OutputFormat value) override {
        std::lock_guard lock{config_mutex};
        format = value;
    }
    void SetFrameRate(Service::CAM::FrameRate) override {}
    bool IsPreviewAvailable() override {
        return g_camera.available.load(std::memory_order_acquire) != 0;
    }

    std::vector<u16> ReceiveFrame() override {
        int w, h;
        Service::CAM::Flip current_flip;
        Service::CAM::OutputFormat current_format;
        {
            std::lock_guard lock{config_mutex};
            w = width;
            h = height;
            current_flip = flip;
            current_format = format;
        }
        if (w <= 0 || h <= 0 || w > 1024 || h > 1024) return {};
        const bool rgb = current_format == Service::CAM::OutputFormat::RGB565;
        std::vector<u16> output(static_cast<size_t>(w) * h, rgb ? 0 : 0x8000);
        if (!g_camera.available.load(std::memory_order_acquire)) return output;

        std::vector<uint8_t> pixels(g_camera.rgba.size());
        int32_t expected = 0;
        if (!g_camera.lock.compare_exchange_strong(expected, 1, std::memory_order_acquire))
            return output;
        std::copy(g_camera.rgba.begin(), g_camera.rgba.end(), pixels.begin());
        g_camera.lock.store(0, std::memory_order_release);

        const auto horizontal = [](Service::CAM::Flip f) {
            return f == Service::CAM::Flip::Horizontal || f == Service::CAM::Flip::Reverse;
        };
        const auto vertical = [](Service::CAM::Flip f) {
            return f == Service::CAM::Flip::Vertical || f == Service::CAM::Flip::Reverse;
        };
        const bool flip_x = horizontal(basic_flip) != horizontal(current_flip);
        const bool flip_y = vertical(basic_flip) != vertical(current_flip);
        const auto pixel = [&](int x, int y) {
            const int sx = (flip_x ? w - 1 - x : x) * kCameraWidth / w;
            const int sy = (flip_y ? h - 1 - y : y) * kCameraHeight / h;
            const size_t pos = (static_cast<size_t>(sy) * kCameraWidth + sx) * 4;
            return std::array<int, 3>{pixels[pos], pixels[pos + 1], pixels[pos + 2]};
        };
        const auto clamp = [](int v) { return std::clamp(v, 0, 255); };
        const auto yuv = [&](const std::array<int, 3>& p) {
            const int r = p[0], g = p[1], b = p[2];
            return std::array<int, 3>{
                clamp((77 * r + 150 * g + 29 * b + 128) >> 8),
                clamp(((-43 * r - 85 * g + 128 * b + 128) >> 8) + 128),
                clamp(((128 * r - 107 * g - 21 * b + 128) >> 8) + 128)};
        };
        for (int y = 0; y < h; ++y) {
            for (int x = 0; x < w; x += rgb ? 1 : 2) {
                const auto p = pixel(x, y);
                const size_t pos = static_cast<size_t>(y) * w + x;
                if (rgb) {
                    output[pos] = static_cast<u16>(((p[0] >> 3) << 11) |
                                                   ((p[1] >> 2) << 5) | (p[2] >> 3));
                } else if (x + 1 < w) {
                    const auto a = yuv(p);
                    const auto b = yuv(pixel(x + 1, y));
                    output[pos] = static_cast<u16>(a[0] | (((a[1] + b[1]) / 2) << 8));
                    output[pos + 1] = static_cast<u16>(b[0] | (((a[2] + b[2]) / 2) << 8));
                } else {
                    output[pos] = static_cast<u16>(yuv(p)[0] | 0x8000);
                }
            }
        }
        return output;
    }

private:
    std::mutex config_mutex;
    int width = 0;
    int height = 0;
    const Service::CAM::Flip basic_flip;
    Service::CAM::Flip flip = Service::CAM::Flip::NoFlip;
    Service::CAM::OutputFormat format = Service::CAM::OutputFormat::YUV422;
};

class WebCameraFactory final : public Camera::CameraFactory {
public:
    std::unique_ptr<Camera::CameraInterface> Create(const std::string&,
                                                    const Service::CAM::Flip& flip) override {
        return std::make_unique<WebCamera>(flip);
    }
};

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
    case RETRO_ENVIRONMENT_GET_MICROPHONE_INTERFACE & ~RETRO_ENVIRONMENT_EXPERIMENTAL: {
        auto* mic = static_cast<retro_microphone_interface*>(data);
        if (mic->interface_version != RETRO_MICROPHONE_INTERFACE_VERSION) return false;
        *mic = {RETRO_MICROPHONE_INTERFACE_VERSION, OpenMicrophone, CloseMicrophone,
                GetMicrophoneParams, SetMicrophoneState, GetMicrophoneState, ReadMicrophone};
        return true;
    }
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

void StepFrame(void*);
// Schedule the next frame via MessageChannel so the worker yields to the event loop (allowing
// OffscreenCanvas to composite and messages to arrive) without browser setTimeout throttling.
EM_JS(void, gb3ds_schedule_next, (), {
    if (!self.__gb3ds_mc) {
        self.__gb3ds_mc = new MessageChannel();
        self.__gb3ds_mc.port1.onmessage = () => _gb3ds_tick();
    }
    self.__gb3ds_mc.port2.postMessage(0);
});

extern "C" EMSCRIPTEN_KEEPALIVE void gb3ds_tick() {
    StepFrame(nullptr);
}

void StepFrame(void*) {
    gb3ds_set_microphone_active(g_microphone.active.load() ? 1 : 0);
    const auto t0 = clock_t_gb::now();
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
        if (g_next_deadline <= t1) {
            g_next_deadline = t1;
        } else {
            std::this_thread::sleep_until(g_next_deadline);
        }
    } else {
        g_next_deadline = t1;
    }
    gb3ds_schedule_next();
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

bool GameRunning() {
    return g_state.status.load() == 2 && Core::System::GetInstance().IsPoweredOn();
}

std::shared_ptr<Cheats::CheatBase> GetCheat(int index) {
    if (!GameRunning() || index < 0) return {};
    const auto cheats = Core::System::GetInstance().CheatEngine().GetCheats();
    return static_cast<size_t>(index) < cheats.size() ? cheats[index] : nullptr;
}

bool IsHex(char c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

std::string g_cheat_string;

} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE SharedState* gb3ds_state() {
    return &g_state;
}

EMSCRIPTEN_KEEPALIVE int gb3ds_state_size() {
    return static_cast<int>(sizeof(SharedState));
}

EMSCRIPTEN_KEEPALIVE SharedCamera* gb3ds_camera_buffer() {
    return &g_camera;
}

EMSCRIPTEN_KEEPALIVE int gb3ds_microphone_active() {
    return g_microphone.active ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int gb3ds_save_state_file(const char* path) {
    if (!GameRunning() || !path) return 0;
    constexpr size_t max_size = 512 * 1024 * 1024;
    try {
        const size_t size = retro_serialize_size();
        if (size == 0 || size > max_size) {
            std::fprintf(stderr, "[gaemboy] save state non disponibile o troppo grande\n");
            return 0;
        }
        std::vector<uint8_t> data(size);
        if (!retro_serialize(data.data(), data.size())) return 0;
        std::ofstream file(path, std::ios::binary | std::ios::trunc);
        if (!file) return 0;
        file.write(reinterpret_cast<const char*>(data.data()), data.size());
        file.close();
        return file ? 1 : 0;
    } catch (const std::exception& e) {
        std::fprintf(stderr, "[gaemboy] errore save state: %s\n", e.what());
        return 0;
    }
}

EMSCRIPTEN_KEEPALIVE int gb3ds_load_state_file(const char* path) {
    if (!GameRunning() || !path) return 0;
    constexpr size_t max_size = 512 * 1024 * 1024;
    try {
        std::ifstream file(path, std::ios::binary | std::ios::ate);
        if (!file) return 0;
        const auto size = file.tellg();
        if (size <= 0 || static_cast<size_t>(size) > max_size) return 0;
        std::vector<uint8_t> data(static_cast<size_t>(size));
        file.seekg(0);
        if (!file.read(reinterpret_cast<char*>(data.data()), size)) return 0;
        return retro_unserialize(data.data(), data.size()) ? 1 : 0;
    } catch (const std::exception& e) {
        std::fprintf(stderr, "[gaemboy] errore caricamento save state: %s\n", e.what());
        return 0;
    }
}

EMSCRIPTEN_KEEPALIVE int gb3ds_cheat_count() {
    if (!GameRunning()) return -1;
    return static_cast<int>(Core::System::GetInstance().CheatEngine().GetCheats().size());
}

EMSCRIPTEN_KEEPALIVE const char* gb3ds_cheat_name(int index) {
    const auto cheat = GetCheat(index);
    if (!cheat) return nullptr;
    g_cheat_string = cheat->GetName();
    return g_cheat_string.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* gb3ds_cheat_code(int index) {
    const auto cheat = GetCheat(index);
    if (!cheat) return nullptr;
    g_cheat_string = cheat->GetCode();
    return g_cheat_string.c_str();
}

EMSCRIPTEN_KEEPALIVE int gb3ds_cheat_enabled(int index) {
    const auto cheat = GetCheat(index);
    return cheat ? static_cast<int>(cheat->IsEnabled()) : -1;
}

EMSCRIPTEN_KEEPALIVE int gb3ds_cheat_add(const char* name, const char* code, int enabled) {
    if (!GameRunning() || !name || !code) return 0;
    const std::string cheat_name(name);
    if (cheat_name.empty() || cheat_name.size() > 512 ||
        cheat_name.find_first_of("[]\r\n") != std::string::npos ||
        std::strlen(code) > 65536) return 0;
    std::istringstream input(code);
    std::vector<Cheats::GatewayCheat::CheatLine> lines;
    std::string line;
    while (std::getline(input, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.empty()) continue;
        if (lines.size() >= 256 || line.size() != 17 || line[8] != ' ' ||
            !std::all_of(line.begin(), line.begin() + 8, IsHex) ||
            !std::all_of(line.begin() + 9, line.end(), IsHex)) return 0;
        lines.emplace_back(line);
        if (!lines.back().valid) return 0;
    }
    if (lines.empty()) return 0;
    for (size_t i = 0; i < lines.size(); ++i) {
        const auto type = static_cast<int>(lines[i].type);
        if (type == static_cast<int>(Cheats::GatewayCheat::CheatType::Patch)) {
            const size_t data_lines = (static_cast<size_t>(lines[i].value) + 7) / 8;
            if (data_lines > lines.size() - i - 1) return 0;
            i += data_lines;
        } else if (type > 0x0C && (type < 0xD0 || type > 0xDD)) {
            return 0;
        } else if (type == static_cast<int>(Cheats::GatewayCheat::CheatType::Loop) &&
                   lines[i].value > 4096) {
            return 0;
        }
    }
    if (enabled < 0) return 1;
    auto cheat = std::make_shared<Cheats::GatewayCheat>(cheat_name, std::move(lines), "");
    cheat->SetEnabled(enabled != 0);
    std::shared_ptr<Cheats::CheatBase> base = std::move(cheat);
    Core::System::GetInstance().CheatEngine().AddCheat(std::move(base));
    return 1;
}

EMSCRIPTEN_KEEPALIVE int gb3ds_cheat_set_enabled(int index, int enabled) {
    const auto cheat = GetCheat(index);
    if (!cheat) return 0;
    auto replacement =
        std::make_shared<Cheats::GatewayCheat>(cheat->GetName(), cheat->GetCode(),
                                               cheat->GetComments());
    replacement->SetEnabled(enabled != 0);
    std::shared_ptr<Cheats::CheatBase> base = std::move(replacement);
    Core::System::GetInstance().CheatEngine().UpdateCheat(static_cast<size_t>(index),
                                                          std::move(base));
    return 1;
}

EMSCRIPTEN_KEEPALIVE int gb3ds_cheat_remove(int index) {
    if (!GetCheat(index)) return 0;
    Core::System::GetInstance().CheatEngine().RemoveCheat(static_cast<size_t>(index));
    return 1;
}

EMSCRIPTEN_KEEPALIVE int gb3ds_cheat_clear() {
    if (!GameRunning()) return 0;
    auto& engine = Core::System::GetInstance().CheatEngine();
    while (!engine.GetCheats().empty()) engine.RemoveCheat(engine.GetCheats().size() - 1);
    return 1;
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
        if (std::strcmp(argv[i], "--stream=ring") == 0) {
            OpenGL::g_web_stream_mode = 0;
            std::printf("[gaemboy] stream buffer GL: ring + bufferSubData\n");
        }
        if (std::strcmp(argv[i], "--shaders=sync") == 0) {
            OpenGL::g_web_shader_mode = 0;
            std::printf("[gaemboy] shader GL: compilazione sincrona\n");
        }
    }
    DefaultOptions(use_sw);
    // --opt=key=value overrides any core option (e.g. citra_cpu_clock_percentage=75).
    for (int i = 2; i < argc; i++) {
        const std::string arg = argv[i];
        const auto eq = arg.find('=', 6);
        if (arg.rfind("--opt=", 0) == 0 && eq != std::string::npos) {
            g_vars[arg.substr(6, eq - 6)] = arg.substr(eq + 1);
            std::printf("[gaemboy] opzione %s\n", arg.c_str() + 6);
        }
    }
    if (io_selftest) {
        return RunIoSelfTest(rom);
    }

    Camera::RegisterFactory("web", std::make_unique<WebCameraFactory>());
    Settings::values.camera_name.fill("web");
    retro_set_environment(EnvironmentCb);
    retro_set_video_refresh(VideoRefreshCb);
    retro_set_audio_sample_batch(AudioBatchCb);
    retro_set_input_poll(InputPollCb);
    retro_set_input_state(InputStateCb);
    retro_init();
    // HLE IPC "async" requests (FS reads/opens, AM, ...) normally spawn one std::async thread per
    // request. On the web a pool miss cannot be serviced while the frame loop blocks, which
    // deadlocked retail-style boots after a few hundred FS requests. Run them inline instead.
    Settings::values.deterministic_async_operations.SetValue(true);

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
    gb3ds_schedule_next();
    return 0;
}
