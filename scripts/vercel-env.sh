#!/usr/bin/env bash
# Copies the Broadcast server settings from .env.local into the linked Vercel project (production).
# Values are piped to the Vercel CLI and never printed. Run it yourself: bash scripts/vercel-env.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env.local ] || { echo "no .env.local"; exit 1; }
KEYS="STATIC_CONTRACT RELAYER_ADDRESS RELAYER_PK BROADCAST_SECRET CRON_SECRET RPC_URL TAPES_PER_DAY"
for k in $KEYS; do
  v=$(grep -E "^${k}=" .env.local | head -1 | cut -d= -f2-)
  if [ -z "$v" ]; then echo "skip $k (empty)"; continue; fi
  if printf '%s' "$v" | npx --yes vercel@latest env add "$k" production >/dev/null 2>&1; then
    echo "set  $k"
  else
    echo "skip $k (already set? remove it with: npx vercel env rm $k production)"
  fi
done
echo "done. Redeploy with: npx vercel --prod"
