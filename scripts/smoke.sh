#!/usr/bin/env bash
# Light path: syntax, catalog JSON, packer headline in the served page.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash -n "$ROOT/setup.sh"
bash -n "$ROOT/probe.sh"
bash -n "$ROOT/stop.sh"
python3 -c "import json; json.load(open('$ROOT/catalog.json'))"
PORT="${PORT:-18768}"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ROOT" >/tmp/spark-pack-smoke-http.log 2>&1 &
PID=$!
cleanup() { kill "$PID" 2>/dev/null || true; }
trap cleanup EXIT
sleep 0.6
curl -fsS "http://127.0.0.1:${PORT}/catalog.json" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['tank_gb']==121"
HOME_HTML="$(curl -fsS "http://127.0.0.1:${PORT}/")"
echo "$HOME_HTML" | grep -q '121 GB packer' || { echo "FAIL: headline"; exit 1; }
echo "$HOME_HTML" | grep -q 'Won' || true
echo "$HOME_HTML" | grep -q 'js/pack.js' || { echo "FAIL: pack.js"; exit 1; }
if command -v brave-browser >/dev/null 2>&1; then
  DOM="$(brave-browser --headless --disable-gpu --no-sandbox --dump-dom --virtual-time-budget=8000 \
    "http://127.0.0.1:${PORT}/" 2>/dev/null || true)"
  echo "$DOM" | grep -q 'TIGHT\|FITS\|Won' || { echo "FAIL: no verdict in DOM"; exit 1; }
  echo "$DOM" | grep -q 'DS4F-0731' || { echo "FAIL: default stack missing"; exit 1; }
fi
echo "SMOKE PASS — catalog + packer"
