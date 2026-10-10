// Native THP video decode: replaces the SDK's __THPDecompressYUV.
//
// THPVideoDecode parses the frame's JPEG headers (quantization and Huffman tables, frame and
// scan headers) into the guest THPFileInfo and then calls __THPDecompressYUV, which does all of
// the per-pixel work: Huffman decoding, a float AAN IDCT built from paired-single math, and
// u8 stores into locked-cache strips that are DMA'd into the destination textures. As
// translated PowerPC that inner loop dominated every screen with movie previews (course
// select runs four at once), so the header parsing stays in the guest and this file takes
// over from the decompression step, reading the tables the guest already built.
//
// Output layout matches the SDK exactly: every 16-pixel strip of Y (8 of U/V) is written in
// GX I8 tile order (8x4-pixel tiles, tile rows of width*4 bytes) and copied to the
// destination with the same per-strip sizes, so the textures the THP player hands to GX are
// byte-compatible. Pixel values come from the same AAN factorization and constants, rounded
// the way the paired-single u8 store does (truncate, clamp); they can differ from the guest
// decoder's by float rounding in rare cases, which only ever affects displayed video.

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <vector>

#include "hle_stubs.h"
#include "isa/big_endian.h"
#include "memory.h"
#include "ppc_runtime.h"
#include "runtime_log.h"
#include "hle/gx/gx_internal.h"

namespace {

// __THPInfo (r13 - 25084 in __THPDecompressYUV): pointer to the THPFileInfo that
// THPVideoDecode placed at the start of the caller's work area.
constexpr uint32_t kThpInfoPointerAddr = 0x80386A04u;

// THPFileInfo field offsets (RVL_SDK THP, "release build: Aug 8 2007").
constexpr uint32_t kQuantTabsOffset = 0;        // f32[3][64]
constexpr uint32_t kHuffmanTabsOffset = 768;    // THPHuffmanTab[4], 224 bytes each
constexpr uint32_t kHuffmanTabSize = 224;
constexpr uint32_t kHuffVijOffset = 64;         // u8* Vij
constexpr uint32_t kHuffMaxCodeOffset = 68;     // s32 maxCode[18]
constexpr uint32_t kHuffValPtrOffset = 140;     // s32 valPtr[18]
constexpr uint32_t kComponentsOffset = 1664;    // THPComponent[3], 6 bytes each
constexpr uint32_t kComponentSize = 6;
constexpr uint32_t kXPixelSizeOffset = 1682;
constexpr uint32_t kYPixelSizeOffset = 1684;
constexpr uint32_t kMcusPerRowOffset = 1686;
constexpr uint32_t kDecompressedYOffset = 1688;
constexpr uint32_t kCurrentByteOffset = 1692;   // u8* c (next byte after the scan header)
constexpr uint32_t kRestartOffset = 1705;       // u8 RST
constexpr uint32_t kRestartIntervalOffset = 1706;  // u16 nMCU
constexpr uint32_t kRestartCounterOffset = 1708;   // u16 currMCU
constexpr uint32_t kDestinationsOffset = 1712;  // u8* dLC[3]
constexpr uint32_t kThpFileInfoSize = 1724;

constexpr std::array<uint8_t, 80> kNaturalOrder = {
    0,  1,  8,  16, 9,  2,  3,  10, 17, 24, 32, 25, 18, 11, 4,  5,
    12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6,  7,  14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
    // Corrupt streams can run k past 63; park those writes on the last coefficient.
    63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63,
};

struct HuffmanTable {
    const uint8_t* values = nullptr;  // Vij
    int32_t maxCode[18]{};
    int32_t valPtr[18]{};
};

// MSB-first reader over the entropy-coded data. THP strips JPEG byte stuffing and restart
// markers, so the scan is a plain bitstream; restarts only realign to a byte boundary.
class BitReader {
public:
    BitReader(const uint8_t* data, size_t size) : m_data(data), m_size(size) {}

    uint32_t Bit() {
        const size_t byte = m_bit >> 3;
        const uint32_t value = byte < m_size ? (m_data[byte] >> (7 - (m_bit & 7))) & 1u : 0u;
        ++m_bit;
        return value;
    }

    uint32_t Bits(uint32_t count) {
        uint32_t value = 0;
        for (uint32_t i = 0; i < count; ++i) {
            value = (value << 1) | Bit();
        }
        return value;
    }

    void AlignToByte() { m_bit = (m_bit + 7) & ~size_t{7}; }

private:
    const uint8_t* m_data;
    size_t m_size;
    size_t m_bit = 0;
};

int32_t DecodeSymbol(BitReader& bits, const HuffmanTable& table) {
    int32_t code = static_cast<int32_t>(bits.Bit());
    int length = 1;
    while (length <= 16 && code > table.maxCode[length]) {
        code = (code << 1) | static_cast<int32_t>(bits.Bit());
        ++length;
    }
    if (length > 16 || table.values == nullptr) {
        return 0;  // corrupt stream: treat as EOB / zero diff
    }
    return table.values[code + table.valPtr[length]];
}

int32_t Extend(uint32_t value, uint32_t size) {
    if (size == 0) {
        return 0;
    }
    return value < (1u << (size - 1)) ? static_cast<int32_t>(value) + static_cast<int32_t>((~0u << size) + 1u)
                                      : static_cast<int32_t>(value);
}

void DecodeBlock(BitReader& bits, const HuffmanTable& dc, const HuffmanTable& ac, int16_t& predDc,
                 int16_t (&block)[64]) {
    std::memset(block, 0, sizeof(block));
    const uint32_t dcSize = static_cast<uint32_t>(DecodeSymbol(bits, dc));
    const int32_t diff = Extend(bits.Bits(dcSize), dcSize);
    predDc = static_cast<int16_t>(predDc + diff);
    block[0] = predDc;
    for (int k = 1; k < 64; ++k) {
        const int32_t symbol = DecodeSymbol(bits, ac);
        const uint32_t run = static_cast<uint32_t>(symbol) >> 4;
        const uint32_t size = static_cast<uint32_t>(symbol) & 15u;
        if (size != 0) {
            k += static_cast<int>(run);
            block[kNaturalOrder[std::min(k, 79)]] = static_cast<int16_t>(Extend(bits.Bits(size), size));
        } else if (run == 15) {
            k += 15;  // ZRL (the loop adds the 16th)
        } else {
            break;    // EOB
        }
    }
}

inline uint8_t StoreSample(float value) {
    // psq_st with GQR6 (u8, scale 2^-3): bias 1024 / 8 = the +128 level shift.
    const float scaled = (value + 1024.0f) * 0.125f;
    if (!(scaled > 0.0f)) {
        return 0;
    }
    if (scaled >= 255.0f) {
        return 255;
    }
    return static_cast<uint8_t>(scaled);
}

// Float AAN IDCT (rows, then columns, as the SDK's two passes) of one dequantized block into
// a strip in GX I8 tile order. `rowBase` is 0 for the top 8 rows of a strip, 8 for the bottom.
void InverseDctToTiles(const int16_t (&in)[64], const float (&quant)[64], uint8_t* strip, uint32_t stripWidth,
                       uint32_t xPos, uint32_t rowBase) {
    constexpr float kC4 = 1.414213562f;
    constexpr float kC2 = 1.847759065f;
    constexpr float kC2C6s = 1.082392200f;
    constexpr float kC2C6a = -2.613125930f;

    float ws[64];
    for (int row = 0; row < 8; ++row) {
        const int16_t* c = &in[row * 8];
        const float* q = &quant[row * 8];
        const float d0 = c[0] * q[0], d1 = c[1] * q[1], d2 = c[2] * q[2], d3 = c[3] * q[3];
        const float d4 = c[4] * q[4], d5 = c[5] * q[5], d6 = c[6] * q[6], d7 = c[7] * q[7];

        const float tmp10 = d0 + d4;
        const float tmp11 = d0 - d4;
        const float tmp13 = d2 + d6;
        const float tmp12 = (d2 - d6) * kC4 - tmp13;
        const float e0 = tmp10 + tmp13, e3 = tmp10 - tmp13, e1 = tmp11 + tmp12, e2 = tmp11 - tmp12;

        const float z13 = d5 + d3, z10 = d5 - d3, z11 = d1 + d7, z12 = d1 - d7;
        const float o7 = z11 + z13;
        const float o11 = (z11 - z13) * kC4;
        const float z5 = (z10 + z12) * kC2;
        const float o10 = kC2C6s * z12 - z5;
        const float o12 = kC2C6a * z10 + z5;
        const float o6 = o12 - o7;
        const float o5 = o11 - o6;
        const float o4 = o10 + o5;

        float* w = &ws[row * 8];
        w[0] = e0 + o7; w[7] = e0 - o7;
        w[1] = e1 + o6; w[6] = e1 - o6;
        w[2] = e2 + o5; w[5] = e2 - o5;
        w[4] = e3 + o4; w[3] = e3 - o4;
    }

    const uint32_t tileRowBytes = stripWidth * 4;
    for (int col = 0; col < 8; ++col) {
        const float d0 = ws[0 * 8 + col], d1 = ws[1 * 8 + col], d2 = ws[2 * 8 + col], d3 = ws[3 * 8 + col];
        const float d4 = ws[4 * 8 + col], d5 = ws[5 * 8 + col], d6 = ws[6 * 8 + col], d7 = ws[7 * 8 + col];

        const float tmp10 = d0 + d4;
        const float tmp11 = d0 - d4;
        const float tmp13 = d2 + d6;
        const float tmp12 = (d2 - d6) * kC4 - tmp13;
        const float e0 = tmp10 + tmp13, e3 = tmp10 - tmp13, e1 = tmp11 + tmp12, e2 = tmp11 - tmp12;

        const float z13 = d5 + d3, z10 = d5 - d3, z11 = d1 + d7, z12 = d1 - d7;
        const float o7 = z11 + z13;
        const float o11 = (z11 - z13) * kC4;
        const float z5 = (z10 + z12) * kC2;
        const float o10 = kC2C6s * z12 - z5;
        const float o12 = kC2C6a * z10 + z5;
        const float o6 = o12 - o7;
        const float o5 = o11 - o6;
        const float o4 = o10 + o5;

        const float out[8] = {e0 + o7, e1 + o6, e2 + o5, e3 - o4, e3 + o4, e2 - o5, e1 - o6, e0 - o7};
        const uint32_t x = xPos + static_cast<uint32_t>(col);
        for (int row = 0; row < 8; ++row) {
            const uint32_t y = rowBase + static_cast<uint32_t>(row);
            const uint32_t offset = (y >> 2) * tileRowBytes + (x >> 3) * 32 + (y & 3) * 8 + (x & 7);
            strip[offset] = StoreSample(out[row]);
        }
    }
}

const uint8_t* GuestBytes(uint32_t addr, size_t want, size_t& got) {
    // The frame lives inside one mapped region; probe down until the range fits in it.
    for (size_t size = want; size >= 64; size >>= 1) {
        if (Memory::Contains(addr, size)) {
            got = size;
            return Memory::GetPointer(addr, size);
        }
    }
    got = 0;
    return nullptr;
}

void CopyToGuest(uint32_t dest, const uint8_t* src, uint32_t size) {
    if (size == 0) {
        return;
    }
    if (Memory::Contains(dest, size)) {
        std::memcpy(Memory::GetPointer(dest, size), src, size);
        GxNotifyGuestRamDmaWrite(dest, size);
    }
}

} // namespace

extern "C" void THPDecompressYUV_HLE_801b4a58(CpuContext* ctx)
{
    const uint32_t destinations[3] = {
        static_cast<uint32_t>(ctx->gpr[3]), static_cast<uint32_t>(ctx->gpr[4]), static_cast<uint32_t>(ctx->gpr[5])};

    uint32_t infoAddr = 0;
    if (!Memory::TryRead32(kThpInfoPointerAddr, infoAddr) || infoAddr == 0) {
        return;
    }
    if (!Memory::Contains(infoAddr, kThpFileInfoSize)) {
        return;
    }
    uint8_t* info = Memory::GetPointer(infoAddr, kThpFileInfoSize);

    float quant[3][64];
    for (int t = 0; t < 3; ++t) {
        for (int i = 0; i < 64; ++i) {
            quant[t][i] = BigEndian::ReadFloat32(info + kQuantTabsOffset + (t * 64 + i) * 4);
        }
    }
    HuffmanTable tables[4];
    for (int t = 0; t < 4; ++t) {
        const uint8_t* tab = info + kHuffmanTabsOffset + t * kHuffmanTabSize;
        size_t valuesSize = 0;
        tables[t].values = GuestBytes(BigEndian::Read32(tab + kHuffVijOffset), 256, valuesSize);
        for (int i = 0; i < 18; ++i) {
            tables[t].maxCode[i] = static_cast<int32_t>(BigEndian::Read32(tab + kHuffMaxCodeOffset + i * 4));
            tables[t].valPtr[i] = static_cast<int32_t>(BigEndian::Read32(tab + kHuffValPtrOffset + i * 4));
        }
    }

    uint8_t quantSelector[3], dcSelector[3], acSelector[3];
    int16_t predDc[3];
    for (int c = 0; c < 3; ++c) {
        const uint8_t* comp = info + kComponentsOffset + c * kComponentSize;
        quantSelector[c] = std::min<uint8_t>(comp[0], 2);
        dcSelector[c] = static_cast<uint8_t>((comp[1] << 1) & 3);
        acSelector[c] = static_cast<uint8_t>(((comp[2] << 1) + 1) & 3);
        predDc[c] = static_cast<int16_t>(BigEndian::Read16(comp + 4));
    }

    const uint32_t width = BigEndian::Read16(info + kXPixelSizeOffset);
    const uint32_t height = BigEndian::Read16(info + kYPixelSizeOffset);
    const uint32_t mcusPerRow = BigEndian::Read16(info + kMcusPerRowOffset);
    const uint32_t startY = BigEndian::Read16(info + kDecompressedYOffset);
    const bool restarts = info[kRestartOffset] != 0;
    const uint32_t restartInterval = BigEndian::Read16(info + kRestartIntervalOffset);
    uint32_t restartCounter = BigEndian::Read16(info + kRestartCounterOffset);
    if (width == 0 || mcusPerRow == 0) {
        return;
    }

    size_t dataSize = 0;
    const uint8_t* data = GuestBytes(BigEndian::Read32(info + kCurrentByteOffset), 1u << 20, dataSize);
    if (data == nullptr) {
        return;
    }
    BitReader bits(data, dataSize);

    // Per-strip sizes the SDK DMAs: 512x448 and 640x480 have dedicated row decoders with
    // fixed sizes; every other size copies whole 16-pixel MCUs only (floor), as the generic one.
    uint32_t ySize, cSize;
    if (width == 512 && height == 448) {
        ySize = 0x2000; cSize = 0x800;
    } else if (width == 640 && height == 480) {
        ySize = 0x2800; cSize = 0xA00;
    } else {
        ySize = 256 * (width / 16); cSize = 64 * (width / 16);
    }

    // Strips are addressed with the true width as the tile-row stride; the last MCU of a width
    // that is not a multiple of 16 lands past it, exactly as in the locked-cache buffer.
    const uint32_t chromaWidth = width / 2;
    static std::vector<uint8_t> yStrip, uStrip, vStrip;
    yStrip.assign(static_cast<size_t>(width) * 16 + mcusPerRow * 512 + 64, 0);
    uStrip.assign(static_cast<size_t>(chromaWidth) * 8 + mcusPerRow * 256 + 64, 0);
    vStrip.assign(uStrip.size(), 0);

    uint32_t dest[3] = {destinations[0], destinations[1], destinations[2]};
    int16_t block[6][64];
    for (uint32_t y = startY; y < height; y += 16) {
        for (uint32_t mcu = 0; mcu < mcusPerRow; ++mcu) {
            for (int b = 0; b < 4; ++b) {
                DecodeBlock(bits, tables[dcSelector[0]], tables[acSelector[0]], predDc[0], block[b]);
            }
            DecodeBlock(bits, tables[dcSelector[1]], tables[acSelector[1]], predDc[1], block[4]);
            DecodeBlock(bits, tables[dcSelector[2]], tables[acSelector[2]], predDc[2], block[5]);

            const uint32_t xPos = mcu * 16;
            InverseDctToTiles(block[0], quant[quantSelector[0]], yStrip.data(), width, xPos, 0);
            InverseDctToTiles(block[1], quant[quantSelector[0]], yStrip.data(), width, xPos + 8, 0);
            InverseDctToTiles(block[2], quant[quantSelector[0]], yStrip.data(), width, xPos, 8);
            InverseDctToTiles(block[3], quant[quantSelector[0]], yStrip.data(), width, xPos + 8, 8);
            InverseDctToTiles(block[4], quant[quantSelector[1]], uStrip.data(), chromaWidth, xPos / 2, 0);
            InverseDctToTiles(block[5], quant[quantSelector[2]], vStrip.data(), chromaWidth, xPos / 2, 0);

            if (restarts && --restartCounter == 0) {
                restartCounter = restartInterval;
                bits.AlignToByte();
                predDc[0] = predDc[1] = predDc[2] = 0;
            }
        }
        CopyToGuest(dest[0], yStrip.data(), ySize);
        CopyToGuest(dest[1], uStrip.data(), cSize);
        CopyToGuest(dest[2], vStrip.data(), cSize);
        dest[0] += ySize;
        dest[1] += cSize;
        dest[2] += cSize;
    }

    // Leave the guest-visible decoder state as the SDK would after a frame.
    for (int c = 0; c < 3; ++c) {
        BigEndian::Write16(info + kComponentsOffset + c * kComponentSize + 4, static_cast<uint16_t>(predDc[c]));
    }
    BigEndian::Write16(info + kRestartCounterOffset, static_cast<uint16_t>(restartCounter));
    for (int c = 0; c < 3; ++c) {
        BigEndian::Write32(info + kDestinationsOffset + c * 4, dest[c]);
    }
}

PPC_NATIVE_OVERRIDE_VOID(801b4a58, THPDecompressYUV_HLE_801b4a58, (CpuContext* ctx), (ctx)); // __THPDecompressYUV
