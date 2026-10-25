#!/usr/bin/env bash
# Send example Meta webhook payloads to a local n8n instance, no WhatsApp needed.
#
# Usage: scripts/simulate.sh <verify|text|human|image|status|all> [--test]
#   --test   use /webhook-test/... (workflow open in the editor, "Listen for test event")
#            instead of /webhook/... (workflow active)
#
# Environment (all optional):
#   BASE_URL         default http://localhost:5678
#   WA_VERIFY_TOKEN  default: read from .env, else "your-verify-token-here"
#   WA_APP_SECRET    default: read from .env; if set, POSTs carry X-Hub-Signature-256
#                    like Meta's (needs openssl)
#   SIM_KEEP_ID=1    keep the original message ids (to see deduplication drop the 2nd send)
set -euo pipefail

cd "$(dirname "$0")/.."
FIXTURES="scripts/fixtures"
BASE_URL="${BASE_URL:-http://localhost:5678}"
PREFIX="/webhook"
CMD="${1:-}"
[ "${2:-}" = "--test" ] && PREFIX="/webhook-test"

if [ -z "${WA_VERIFY_TOKEN:-}" ] && [ -f .env ]; then
  WA_VERIFY_TOKEN="$(grep -E '^WA_VERIFY_TOKEN=' .env | head -n1 | cut -d= -f2- || true)"
fi
WA_VERIFY_TOKEN="${WA_VERIFY_TOKEN:-your-verify-token-here}"
if [ -z "${WA_APP_SECRET:-}" ] && [ -f .env ]; then
  WA_APP_SECRET="$(grep -E '^WA_APP_SECRET=' .env | head -n1 | cut -d= -f2- || true)"
fi

verify() {
  local query
  query="$(head -n1 "$FIXTURES/verify-request.txt" | sed -E 's#^GET [^?]*\?([^ ]*) HTTP.*#\1#')"
  query="${query//__WA_VERIFY_TOKEN__/$WA_VERIFY_TOKEN}"
  echo ">> GET $PREFIX/whatsapp?$query"
  curl -sS -o /dev/stderr -w '\n<< HTTP %{http_code}\n' "$BASE_URL$PREFIX/whatsapp?$query"
}

post() {
  local file="$FIXTURES/$1.json" body
  body="$(cat "$file")"
  if [ "${SIM_KEEP_ID:-0}" != "1" ]; then
    # unique message id per run, otherwise the dedupe node drops repeats
    body="$(printf '%s' "$body" | sed -E "s/(\"id\": \"wamid\.[A-Za-z0-9]+)/\1$(date +%s)/")"
  fi
  local sig=()
  if [ -n "${WA_APP_SECRET:-}" ]; then
    # Same signature Meta sends: HMAC-SHA256 of the exact body with the app secret
    sig=(-H "X-Hub-Signature-256: sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$WA_APP_SECRET" | sed 's/^.* //')")
  fi
  echo ">> POST $PREFIX/whatsapp  ($1)"
  curl -sS -o /dev/stderr -w '\n<< HTTP %{http_code}\n' -X POST \
    -H 'Content-Type: application/json' ${sig[@]+"${sig[@]}"} --data-binary "$body" "$BASE_URL$PREFIX/whatsapp"
}

case "$CMD" in
  verify) verify ;;
  text|human|image) post "$([ "$CMD" = text ] && echo text-message || ([ "$CMD" = human ] && echo human-request || echo image-message))" ;;
  status) post status-update ;;
  all) verify; post text-message; post human-request; post image-message; post status-update ;;
  *) sed -n '2,13p' "$0"; exit 1 ;;
esac
