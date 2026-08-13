#!/usr/bin/env bash
# Read this machine (and optional peer) — never starts or stops a model.
# Writes probe.json for the packer UI. UMA: trust MemAvailable, not docker stats.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$ROOT/probe-output"
mkdir -p "$OUT_DIR"
OUT_JSON="$OUT_DIR/latest.json"
ROOT_JSON="$ROOT/probe.json"

mem_total_gb() {
  awk '/MemTotal:/ { printf "%.1f", $2 / 1024 / 1024 }' /proc/meminfo
}

mem_avail_gb() {
  awk '/MemAvailable:/ { printf "%.1f", $2 / 1024 / 1024 }' /proc/meminfo
}

# Map running names/ports onto catalog ids. Patterns only — no house hostnames.
detect_ids() {
  local names ports ids
  names="$(docker ps --format '{{.Names}}' 2>/dev/null || true)"
  ports="$(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null || true)"
  ids=""
  if echo "$names" | grep -qiE 'deepseek|dspark|ds4f'; then ids+="ds4f"$'\n'; fi
  if echo "$names" | grep -qiE 'minimax|^h3|h3-'; then ids+="h3"$'\n'; fi
  if echo "$names" | grep -qiE 'qwen-vision|vision-tp|qwen3-vl'; then ids+="vision"$'\n'; fi
  if echo "$names" | grep -qiE 'qwen27|qwen-27|qwen3-27'; then ids+="qwen27"$'\n'; fi
  if echo "$names" | grep -qiE 'gemma'; then ids+="gemma"$'\n'; fi
  if echo "$ports" | grep -qE ':8889\s'; then ids+="helper"$'\n'; fi
  if systemctl --user is-active llama-miaai35.service >/dev/null 2>&1; then
    ids+="helper"$'\n'
  fi
  printf '%s' "$ids" | awk 'NF && !seen[$0]++'
}

node_json() {
  local id="$1"
  local total avail used
  total="$(mem_total_gb)"
  avail="$(mem_avail_gb)"
  used="$(awk -v t="$total" -v a="$avail" 'BEGIN { printf "%.1f", t - a }')"
  printf '{"id":"%s","mem_total_gb":%s,"mem_available_gb":%s,"mem_used_gb":%s}' \
    "$id" "$total" "$avail" "$used"
}

LOCAL_IDS="$(detect_ids | paste -sd, - || true)"
NODES="$(node_json local)"

# Optional second Spark: SPARK_PACK_PEER=user@host (SSH keys, BatchMode).
if [[ -n "${SPARK_PACK_PEER:-}" ]]; then
  if PEER_BLOB="$(ssh -o BatchMode=yes -o ConnectTimeout=4 "$SPARK_PACK_PEER" \
      'awk "/MemTotal:/{t=\$2} /MemAvailable:/{a=\$2} END{printf \"%.1f %.1f\", t/1024/1024, a/1024/1024}" /proc/meminfo; echo; docker ps --format "{{.Names}}" 2>/dev/null || true' \
      2>/dev/null)"; then
    PEER_FREE="$(printf '%s\n' "$PEER_BLOB" | head -n1)"
    PEER_T="${PEER_FREE%% *}"
    PEER_A="${PEER_FREE##* }"
    PEER_U="$(awk -v t="$PEER_T" -v a="$PEER_A" 'BEGIN { printf "%.1f", t - a }')"
    NODES+=",{\"id\":\"peer\",\"mem_total_gb\":$PEER_T,\"mem_available_gb\":$PEER_A,\"mem_used_gb\":$PEER_U}"
    PEER_NAMES="$(printf '%s\n' "$PEER_BLOB" | tail -n +2)"
    if echo "$PEER_NAMES" | grep -qiE 'qwen-vision|vision-tp|qwen3-vl'; then
      LOCAL_IDS="${LOCAL_IDS:+$LOCAL_IDS,}vision"
    fi
    if echo "$PEER_NAMES" | grep -qiE 'deepseek|dspark|ds4f'; then
      LOCAL_IDS="${LOCAL_IDS:+$LOCAL_IDS,}ds4f"
    fi
    if echo "$PEER_NAMES" | grep -qiE 'minimax|^h3|h3-'; then
      LOCAL_IDS="${LOCAL_IDS:+$LOCAL_IDS,}h3"
    fi
  else
    echo "[spark-pack] peer SSH failed — local node only" >&2
  fi
fi

LOCAL_IDS="$(printf '%s\n' "${LOCAL_IDS//,/$'\n'}" | awk 'NF && !seen[$0]++' | paste -sd, - || true)"
DETECTED_JSON="[]"
if [[ -n "$LOCAL_IDS" ]]; then
  DETECTED_JSON="[$(echo "$LOCAL_IDS" | sed 's/,/","/g; s/^/"/; s/$/"/')]"
fi

AS_OF="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$OUT_JSON" <<EOF
{
  "as_of": "$AS_OF",
  "note": "MemAvailable is the truth on unified memory. docker stats under-reports UMA.",
  "detected": $DETECTED_JSON,
  "nodes": [$NODES]
}
EOF
cp "$OUT_JSON" "$ROOT_JSON"
echo "[spark-pack] wrote $ROOT_JSON"
echo "[spark-pack] detected: ${LOCAL_IDS:-none}"
python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$ROOT_JSON"
