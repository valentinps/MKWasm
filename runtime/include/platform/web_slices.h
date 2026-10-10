#pragma once

#include <cstdint>

// Web build: stall attribution for guest threads. Guest threads are cooperative fibers on
// the page's single thread, so a frame can only be late when some guest thread ran a long
// stretch without reaching the scheduler. The scheduler reports every hand-over here and
// the frame-pacing log (aurora's [web-spike]) prints the longest stretch of the frame.

#if defined(__EMSCRIPTEN__)
#include <emscripten.h>

extern "C" {
extern double g_mkwWebMaxSliceMs;       // defined in aurora (web build), reset per present
extern uint32_t g_mkwWebMaxSliceThread; // guest OSThread that ran it (0 = idle)
extern int32_t g_mkwWebMaxSlicePriority;
extern uint32_t g_mkwWebIrqServices;     // interrupt deliveries inside long slices
}

namespace MkwWebSlices {
inline double s_sliceStart = 0.0;
inline uint32_t s_sliceThread = 0;
inline int32_t s_slicePriority = -1;

// `thread` is about to run (0 = the scheduler's idle loop); the previous slice ends now.
inline void Begin(uint32_t thread, int32_t priority) noexcept {
    const double now = emscripten_get_now();
    if (s_sliceStart != 0.0 && now - s_sliceStart > g_mkwWebMaxSliceMs) {
        g_mkwWebMaxSliceMs = now - s_sliceStart;
        g_mkwWebMaxSliceThread = s_sliceThread;
        g_mkwWebMaxSlicePriority = s_slicePriority;
    }
    s_sliceStart = now;
    s_sliceThread = thread;
    s_slicePriority = priority;
}
} // namespace MkwWebSlices
#endif
