#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <type_traits>

#include "isa/host_byteswap.h"

namespace BigEndian {

inline uint16_t Read16(const uint8_t* src) {
    uint16_t value = 0;
    std::memcpy(&value, src, sizeof(value));
    return MkwByteSwap16(value);
}

inline uint32_t Read32(const uint8_t* src) {
    uint32_t value = 0;
    std::memcpy(&value, src, sizeof(value));
    return MkwByteSwap32(value);
}

inline float ReadFloat32(const uint8_t* src) {
    const uint32_t bits = Read32(src);
    float value = 0.0f;
    static_assert(sizeof(bits) == sizeof(value));
    std::memcpy(&value, &bits, sizeof(value));
    return value;
}

inline void Write16(uint8_t* dst, uint16_t value) {
    const uint16_t swapped = MkwByteSwap16(value);
    std::memcpy(dst, &swapped, sizeof(swapped));
}

inline void Write32(uint8_t* dst, uint32_t value) {
    const uint32_t swapped = MkwByteSwap32(value);
    std::memcpy(dst, &swapped, sizeof(swapped));
}

inline void Write64(uint8_t* dst, uint64_t value) {
    Write32(dst, static_cast<uint32_t>(value >> 32));
    Write32(dst + sizeof(uint32_t), static_cast<uint32_t>(value));
}

inline void WriteFloat32(uint8_t* dst, float value) {
    uint32_t bits = 0;
    static_assert(sizeof(bits) == sizeof(value));
    std::memcpy(&bits, &value, sizeof(bits));
    Write32(dst, bits);
}

inline void Write16(uint8_t* dst, std::size_t offset, uint16_t value) {
    Write16(dst + offset, value);
}

inline void Write32(uint8_t* dst, std::size_t offset, uint32_t value) {
    Write32(dst + offset, value);
}

inline void Write64(uint8_t* dst, std::size_t offset, uint64_t value) {
    Write64(dst + offset, value);
}

inline void WriteFloat32(uint8_t* dst, std::size_t offset, float value) {
    WriteFloat32(dst + offset, value);
}

template <typename Offset>
inline void Append16(uint8_t* dst, Offset& offset, uint16_t value) {
    static_assert(std::is_integral_v<Offset>);
    Write16(dst + offset, value);
    offset += static_cast<Offset>(sizeof(value));
}

template <typename Offset>
inline void Append32(uint8_t* dst, Offset& offset, uint32_t value) {
    static_assert(std::is_integral_v<Offset>);
    Write32(dst + offset, value);
    offset += static_cast<Offset>(sizeof(value));
}

template <typename Offset>
inline void AppendFloat32(uint8_t* dst, Offset& offset, float value) {
    static_assert(std::is_integral_v<Offset>);
    WriteFloat32(dst + offset, value);
    offset += static_cast<Offset>(sizeof(value));
}

} // namespace BigEndian
