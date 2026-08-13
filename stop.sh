#!/usr/bin/env bash
# Stop the localhost packer server if we own the port.
set -euo pipefail
PORT="${PORT:-8768}"
if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" 2>/dev/null || true
fi
echo "[spark-pack] stop attempted on :${PORT}"
