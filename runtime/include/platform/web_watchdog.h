#pragma once

#include <cstdint>

// Web build: guest code that spin-waits (polling the time base, toggling interrupts) for
// progress that only happens while the browser has control - audio consumption, timers,
// input, GPU callbacks - would hang the page forever. Hot polling points call this; it
// yields to the browser (JSPI) once the page has gone ~50 ms without a turn of its event
// loop, and logs a stack trace the first time a stall passes a second.
// See mkw_web_watchdog in platform/web/mkw_web.js. Native builds compile it away.

#if defined(__EMSCRIPTEN__)
extern "C" int32_t mkw_web_watchdog(void);

inline void MkwWebWatchdog() noexcept {
    // The JS check costs a wasm->JS call, so only every 256th poll pays it.
    static uint32_t s_polls = 0;
    if ((++s_polls & 255u) == 0) {
        mkw_web_watchdog();
    }
}
#else
inline void MkwWebWatchdog() noexcept {}
#endif
