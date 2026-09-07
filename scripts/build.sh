#!/bin/bash
# Build only. No link, no PATH changes — use scripts/setup.sh for that.
# ponytail: delegates to package.json "build" so the entry point list lives in one place.

set -e

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "=== Building gordian-coder ==="

echo "[1/2] Cleaning dist..."
rm -rf dist

echo "[2/2] Building (bundle + type declarations)..."
bun run build

echo "=== Build complete: $(pwd)/dist ==="
