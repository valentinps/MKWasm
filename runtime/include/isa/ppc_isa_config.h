#pragma once

#include <atomic>
#include <cstdint>

#define MKW_RESTRICT __restrict
#if defined(__x86_64__) || defined(__wasm__)
// wasm builds with -msimd128 -mavx2 -mfma, so Emscripten's SSE/AVX2/FMA headers
// lower the x86 intrinsic paths onto wasm SIMD128; both share MKW_HOST_X86_SIMD.
#include <immintrin.h>
#if defined(__wasm__)
#include <wasm_simd128.h>
#endif
#define MKW_HOST_X86_SIMD 1
#elif defined(__aarch64__)
#include <arm_neon.h>
#else
#error "ppc_isa_config.h has no SIMD intrinsics header for this architecture"
#endif

#include <cmath>

// Fused multiply-add for the PPC scalar fmadd family. wasm has no scalar FMA, so std::fma is
// a libm software routine there (~1,400 call sites in physics/matrix code); relaxed SIMD's
// madd lowers to the host FMA instruction, which native builds already require (x86-64-v3).
inline double MkwFmaInline(double a, double b, double c) noexcept
{
#if defined(__wasm_relaxed_simd__)
    return wasm_f64x2_extract_lane(
        wasm_f64x2_relaxed_madd(wasm_f64x2_splat(a), wasm_f64x2_splat(b), wasm_f64x2_splat(c)), 0);
#else
    return std::fma(a, b, c);
#endif
}


inline constexpr bool MkwStateFreeAbiEnabled(uint32_t) noexcept
{
    return true;
}

#if defined(_WIN32)
#define MKW_PPC_FORCE_INLINE __forceinline
#define MKW_PPC_NO_INLINE __declspec(noinline)
#define MKW_PPC_INTERNAL_CALL __regcall
#else
// __forceinline/__declspec are MS-extension keywords Clang only recognizes when targeting
// Windows (MSVC or mingw); native Linux Clang needs the GNU-attribute spellings instead.
// __regcall has no portable non-Windows equivalent worth chasing here - the extra register
// args it saves matter for the hot PPC interpreter loop on Windows, but plain calls are fine
// elsewhere.
#define MKW_PPC_FORCE_INLINE __attribute__((always_inline)) inline
#define MKW_PPC_NO_INLINE __attribute__((noinline))
#define MKW_PPC_INTERNAL_CALL
#endif
#define MKW_PPC_ALWAYS_INLINE_BODY __attribute__((always_inline))
#define MKW_PPC_COLD __attribute__((cold))


using MkwStateFreeResult2 = uint64_t __attribute__((ext_vector_type(2)));
