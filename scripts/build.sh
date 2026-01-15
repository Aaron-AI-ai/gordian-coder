#!/bin/bash
# Build script for gordian-coder

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

echo "=== Building gordian-coder ==="

# Clean previous build
echo "[1/3] Cleaning dist..."
rm -rf dist

# Build with bun
echo "[2/3] Building with bun..."
bun build src/index.ts --outdir dist --target bun --format esm

# Generate type declarations
echo "[3/3] Generating type declarations..."
npx tsc --emitDeclarationOnly

echo "=== Build complete ==="
