#!/usr/bin/env bash
# Configure + build the WiiCompiled web (wasm) target.
# Usage: web/build-web.sh [configure|build] [ninja targets...]
# Toolchain: $MKW_TOOLS (default ../tools next to the repo) holding emsdk/, bin/ninja.exe and CMake.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS="${MKW_TOOLS:-$(cd "$ROOT/.." && pwd)/tools}"
EMSDK="$TOOLS/emsdk"
export EMSDK
export EM_CONFIG="$EMSDK/.emscripten"
export EMSDK_PYTHON="$EMSDK/python/3.13.3_64bit/python.exe"
export PATH="$EMSDK/upstream/emscripten:$EMSDK/node/24.19.0_64bit:$EMSDK/python/3.13.3_64bit:$TOOLS/bin:$TOOLS/cmake-4.3.3-windows-x86_64/bin:$PATH"

SRC="$ROOT/runtime"
BUILD="$ROOT/web-build"
JOBS="${JOBS:-$(nproc)}"

# Every object must agree on wasm EH and SIMD; aurora and its dependencies included.
WEB_FLAGS="-msimd128 -mavx2 -mfma -fwasm-exceptions"

step="${1:-build}"
shift || true

if [[ "$step" == "configure" || ! -f "$BUILD/build.ninja" ]]; then
    cmake -S "$SRC" -B "$BUILD" -G Ninja \
        -DCMAKE_TOOLCHAIN_FILE="$EMSDK/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_MAKE_PROGRAM="$TOOLS/bin/ninja.exe" \
        -DCMAKE_C_FLAGS="$WEB_FLAGS" -DCMAKE_CXX_FLAGS="$WEB_FLAGS" \
        -DCMAKE_EXE_LINKER_FLAGS="-fwasm-exceptions" \
        -DAURORA_SDL3_PROVIDER=vendor -DBUILD_SHARED_LIBS=OFF \
        -DMKW_TRANSLATED_COMPILE_JOBS="$JOBS"
fi

if [[ "$step" != "configure" ]]; then
    ninja -C "$BUILD" -j "$JOBS" -k 0 "$@"
fi
