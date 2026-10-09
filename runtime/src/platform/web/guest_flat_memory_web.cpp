#include "guest_flat_memory.h"

// wasm counterpart of guest_flat_memory.cpp: there is no 4 GiB view to reserve, so this
// module only owns the backing stores. Regions with the same backing (the cached and
// uncached MEM1/MEM2 mirrors) share one store, which preserves aliasing without mapping
// tricks. Translated code reaches the stores through the Memory page tables
// (MKW_GUEST_FLAT_TABLED), and the policies the native build enforces with page
// protections live on the checked Memory::* path.

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <vector>

namespace GuestFlat {
namespace {

struct Store {
    Backing kind = Backing::Owned;
    uint32_t owned = 0;
    uint64_t size = 0;
    uint8_t* host = nullptr;
};

struct Mapping {
    uint32_t base = 0;
    uint64_t size = 0;
    uint8_t* host = nullptr;
};

std::mutex g_mutex;
std::vector<Store> g_stores;
std::vector<Mapping> g_mappings;
std::vector<RegionRequest> g_layout;
bool g_active = false;

inline uint64_t RoundUp(uint64_t value, uint64_t align) {
    return (value + align - 1) & ~(align - 1);
}

uint64_t Offset(const RegionRequest& r) {
    if (r.backing == Backing::Mem1) return r.base & 0x1fffffffu;
    if (r.backing == Backing::Mem2) return (r.base & 0x1fffffffu) - 0x10000000u;
    return 0;
}

bool Same(const std::vector<RegionRequest>& a, const std::vector<RegionRequest>& b) {
    return a.size() == b.size() && std::equal(a.begin(), a.end(), b.begin(),
        [](const auto& x, const auto& y) { return x.base == y.base && x.size == y.size && x.backing == y.backing; });
}

} // namespace

bool IsActive() { return g_active; }

void Initialize(const std::vector<RegionRequest>& regions) {
    std::lock_guard lock(g_mutex);
    if (g_active) {
        if (!Same(g_layout, regions))
            throw std::runtime_error("flat guest layout cannot be remapped");
        return;
    }

    std::vector<Store> stores;
    for (const auto& r : regions) {
        if (!r.size) continue;
        const uint32_t owned = r.backing == Backing::Owned ? r.base : 0;
        auto it = std::find_if(stores.begin(), stores.end(), [&](const Store& s) {
            return s.kind == r.backing && s.owned == owned;
        });
        const uint64_t need = RoundUp(Offset(r) + r.size, kGuestPageSize);
        if (it == stores.end()) {
            stores.push_back({r.backing, owned, need, nullptr});
        } else {
            it->size = std::max(it->size, need);
        }
    }

    for (auto& s : stores) {
        // Eight spare bytes let a bias-table access that starts in the last page
        // read past the end without leaving the allocation.
        void* host = std::aligned_alloc(kGuestPageSize, static_cast<size_t>(s.size + kGuestPageSize));
        if (host == nullptr) {
            for (auto& prior : stores) std::free(prior.host);
            throw std::runtime_error("unable to allocate wasm guest backing store");
        }
        std::memset(host, 0, static_cast<size_t>(s.size + kGuestPageSize));
        s.host = static_cast<uint8_t*>(host);
    }

    for (const auto& r : regions) {
        if (!r.size) continue;
        const uint32_t owned = r.backing == Backing::Owned ? r.base : 0;
        const auto& s = *std::find_if(stores.begin(), stores.end(), [&](const Store& x) {
            return x.kind == r.backing && x.owned == owned;
        });
        g_mappings.push_back({r.base, r.size, s.host + Offset(r)});
    }

    g_layout = regions;
    g_stores = std::move(stores);
    g_active = true;
}

uint8_t* HostPointer(uint32_t a) {
    for (const auto& m : g_mappings) {
        if (a >= m.base && uint64_t(a - m.base) < m.size) {
            return m.host + (a - m.base);
        }
    }
    return nullptr;
}

void ProtectDeferredRange(uint32_t, size_t) {}
void UnprotectDeferredRange(uint32_t, size_t) {}
void RegisterExecutableRange(uint32_t, uint32_t) {}
FaultCounters Counters() { return {}; }
void LogFaultSummary() noexcept {}
bool HandleAccessViolation(void*, bool) noexcept { return false; }

} // namespace GuestFlat
