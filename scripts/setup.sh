#!/bin/bash
# Setup script for gordian-coder
# Builds, links, and ensures ~/.bun/bin is on PATH.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BUN_BIN="$HOME/.bun/bin"

cd "$PROJECT_ROOT"

echo "=== gordian-coder setup ==="

# 1. Build
echo "[1/3] Building..."
bun run build

# 2. Link globally
echo "[2/3] Linking globally..."
bun link

# 3. Ensure ~/.bun/bin is on PATH
echo "[3/3] Checking PATH..."

SHELL_NAME="$(basename "$SHELL")"
case "$SHELL_NAME" in
  zsh)  RC_FILE="$HOME/.zshrc" ;;
  bash) RC_FILE="$HOME/.bashrc" ;;
  *)    RC_FILE="$HOME/.profile" ;;
esac

if echo "$PATH" | tr ':' '\n' | grep -qx "$BUN_BIN"; then
  echo "  ✔ $BUN_BIN already in PATH"
else
  if grep -q "$BUN_BIN" "$RC_FILE" 2>/dev/null; then
    echo "  ✔ $BUN_BIN already in $RC_FILE (restart shell to apply)"
  else
    echo "" >> "$RC_FILE"
    echo "# bun" >> "$RC_FILE"
    echo "export PATH=\"\$HOME/.bun/bin:\$PATH\"" >> "$RC_FILE"
    echo "  ✔ Added $BUN_BIN to $RC_FILE"
  fi
  export PATH="$BUN_BIN:$PATH"
fi

# Verify
echo ""
if command -v gdc &>/dev/null; then
  echo "=== Setup complete ==="
  echo "  gdc is available at: $(which gdc)"
  echo ""
  echo "Commands:"
  echo "  gdc --init     Install Cline hooks"
  echo "  gdc --help     Show help"
else
  echo "=== Setup complete (restart shell to use gdc) ==="
fi
