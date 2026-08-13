#!/usr/bin/env bash
# One-command try: probe this box (best effort), then serve the packer.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
PORT="${PORT:-8768}"

bash "$ROOT/probe.sh" || echo "[spark-pack] probe skipped (not a Spark, or no docker) — catalog still works"

echo "spark-pack  →  http://127.0.0.1:${PORT}/"
echo "Catalog works without a GPU. Ctrl-C to stop."
# Bind localhost only — this is a local tool, not a LAN advert.
exec python3 -m http.server "$PORT" --bind 127.0.0.1
