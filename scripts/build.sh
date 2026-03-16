#!/bin/bash
# Build script for gordian-coder

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

echo "=== Building gordian-coder ==="

# Clean previous build
echo "[1/4] Cleaning dist..."
rm -rf dist

# Build with bun
echo "[2/4] Building with bun..."
bun build src/index.ts --outdir dist --target bun --format esm

# Generate type declarations
echo "[3/4] Generating type declarations..."
npx tsc --emitDeclarationOnly

# Link for local development
echo "[4/4] Linking package for local development..."
bun link

echo "=== Build complete ==="
echo ""
echo "Package linked! Add to your OpenCode config:"
echo '  { "plugins": ["gordian-coder"] }'
