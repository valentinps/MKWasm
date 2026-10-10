#pragma once

#include <cstdint>

// Host byte swaps for guest (big-endian) data.
//
// WebAssembly has no byte-swap instruction: __builtin_bswap32 lowers to a chain of shifts,
// masks and ors that V8 does not fuse back into BSWAP. A one-lane SIMD shuffle (splat,
// i8x16.swizzle, extract) compiles to three x86 instructions instead; in V8 that made a
// swapped guest load about 5x cheaper and a swapped store about 6x cheaper than the scalar
// form. Native builds keep the builtins, which already map to BSWAP/REV.

#if defined(__wasm_simd128__)
#include <wasm_simd128.h>

inline uint16_t MkwByteSwap16(uint16_t value) noexcept {
    return wasm_u16x8_extract_lane(
        wasm_i8x16_swizzle(wasm_i16x8_splat(static_cast<int16_t>(value)),
                           wasm_i8x16_const(1, 0, 3, 2, 5, 4, 7, 6, 9, 8, 11, 10, 13, 12, 15, 14)),
        0);
}

inline uint32_t MkwByteSwap32(uint32_t value) noexcept {
    return static_cast<uint32_t>(wasm_i32x4_extract_lane(
        wasm_i8x16_swizzle(wasm_i32x4_splat(static_cast<int32_t>(value)),
                           wasm_i8x16_const(3, 2, 1, 0, 7, 6, 5, 4, 11, 10, 9, 8, 15, 14, 13, 12)),
        0));
}

inline uint64_t MkwByteSwap64(uint64_t value) noexcept {
    return static_cast<uint64_t>(wasm_i64x2_extract_lane(
        wasm_i8x16_swizzle(wasm_i64x2_splat(static_cast<int64_t>(value)),
                           wasm_i8x16_const(7, 6, 5, 4, 3, 2, 1, 0, 15, 14, 13, 12, 11, 10, 9, 8)),
        0));
}
#else
inline uint16_t MkwByteSwap16(uint16_t value) noexcept { return __builtin_bswap16(value); }
inline uint32_t MkwByteSwap32(uint32_t value) noexcept { return __builtin_bswap32(value); }
inline uint64_t MkwByteSwap64(uint64_t value) noexcept { return __builtin_bswap64(value); }
#endif
