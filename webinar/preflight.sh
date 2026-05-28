#!/usr/bin/env bash
# preflight.sh — 30-second pre-webinar sanity check.
#
# Run this 5 minutes before going live. It SSHes to your wa-hub-demo server
# and verifies everything the live demo depends on.
#
# Usage (from your local laptop):
#   bash preflight.sh root@91.99.167.114
# Or with a custom SSH key:
#   SSH_KEY=~/.ssh/my-key bash preflight.sh root@91.99.167.114
#
# Exits 0 if all checks pass, 1 if anything is wrong.

set -uo pipefail

GREEN="\033[32m"; RED="\033[31m"; YELLOW="\033[33m"; BLUE="\033[34m"; BOLD="\033[1m"; RESET="\033[0m"
pass() { echo -e "  ${GREEN}✓${RESET} $*"; }
fail() { echo -e "  ${RED}✗${RESET} $*"; FAILED=1; }
warn() { echo -e "  ${YELLOW}!${RESET} $*"; }
hdr()  { echo -e "\n${BLUE}${BOLD}▸ $*${RESET}"; }

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  echo "Usage: bash preflight.sh user@host"
  echo "Example: bash preflight.sh root@91.99.167.114"
  exit 1
fi

SSH_OPTS="-o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new"
[[ -n "${SSH_KEY:-}" ]] && SSH_OPTS="$SSH_OPTS -i $SSH_KEY -o IdentitiesOnly=yes"

FAILED=0

# Capture all checks remotely in a single SSH call to minimize round-trips.
REMOTE=$(ssh $SSH_OPTS "$TARGET" 'bash -s' <<'REMOTE_SCRIPT' 2>&1
TOKEN=$(grep ^HUB_TOKEN /srv/wa-hub-demo/.env | cut -d= -f2)
[[ -z "$TOKEN" ]] && { echo "ERR:no_token"; exit 1; }

echo "WA_HUB_ACTIVE=$(systemctl is-active wa-hub.service 2>/dev/null)"
echo "TUNNEL_ACTIVE=$(systemctl is-active cloudflared-wahub.service 2>/dev/null)"
echo "HEALTHZ=$(curl -sS --max-time 4 http://127.0.0.1:3060/healthz | head -c 500)"
echo "STATUS=$(curl -sS --max-time 4 -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3060/api/instance/status | head -c 500)"
echo "DIAGNOSE=$(curl -sS --max-time 8 -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3060/api/instance/diagnose | head -c 800)"
echo "WEBHOOK=$(curl -sS --max-time 4 -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3060/api/instance/webhook | head -c 300)"
echo "TUNNEL_URL=$(journalctl -u cloudflared-wahub --no-pager 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1)"
echo "MEM_FREE=$(free -m | awk '/^Mem:/ {print $7}')"
echo "DISK_AVAIL=$(df -BG / | awk 'NR==2 {gsub("G",""); print $4}')"
echo "RECENT_ERRORS=$(journalctl -u wa-hub --since "1 hour ago" --no-pager 2>/dev/null | grep -cE 'ERROR|FATAL' || echo 0)"
REMOTE_SCRIPT
)

if [[ -z "$REMOTE" ]] || echo "$REMOTE" | grep -q "ERR:no_token"; then
  fail "Cannot reach server or .env missing HUB_TOKEN"
  echo
  echo "$REMOTE" | head -5
  exit 1
fi

get() { echo "$REMOTE" | grep -E "^$1=" | head -1 | cut -d= -f2- ; }

# ── 1. systemd services ─────────────────────────────────────────────────────
hdr "Services"
[[ "$(get WA_HUB_ACTIVE)" == "active" ]] && pass "wa-hub.service is active" || fail "wa-hub.service NOT active (was: $(get WA_HUB_ACTIVE))"
[[ "$(get TUNNEL_ACTIVE)" == "active" ]] && pass "cloudflared-wahub.service is active" || fail "cloudflared-wahub.service NOT active"

# ── 2. /healthz ──────────────────────────────────────────────────────────────
hdr "/healthz"
HEALTHZ=$(get HEALTHZ)
if echo "$HEALTHZ" | grep -q '"ok":true'; then
  pass "/healthz returns ok"
else
  fail "/healthz did not return ok"
  echo "    raw: $HEALTHZ"
fi
echo "$HEALTHZ" | grep -q '"connection":"connected"' && pass "WhatsApp connection: connected" || fail "WhatsApp connection NOT connected"
echo "$HEALTHZ" | grep -q '"webhookConfigured":true' && pass "webhook is configured" || warn "webhook NOT configured (set via .env or PUT /api/instance/webhook)"

# ── 3. /api/instance/diagnose ────────────────────────────────────────────────
hdr "/api/instance/diagnose"
DIAG=$(get DIAGNOSE)
if echo "$DIAG" | grep -q '"summary":"pass"'; then
  pass "diagnose: pass (internet, authDir, env, socket, webhook all green)"
elif echo "$DIAG" | grep -q '"summary":"degraded"'; then
  warn "diagnose: degraded — investigate before going live"
  echo "    $DIAG"
else
  fail "diagnose: fail or unreachable"
  echo "    $DIAG"
fi

# ── 4. Paired number ─────────────────────────────────────────────────────────
hdr "Paired WhatsApp"
STATUS=$(get STATUS)
NUMBER=$(echo "$STATUS" | grep -oE '"number":"[0-9]+"' | head -1 | cut -d'"' -f4)
NAME=$(echo "$STATUS" | grep -oE '"name":"[^"]+"' | tail -1 | cut -d'"' -f4)
if [[ -n "$NUMBER" ]]; then
  pass "paired number: +$NUMBER"
  [[ -n "$NAME" ]] && echo "    name: $NAME"
else
  fail "no paired number — re-pair before going live"
fi

# ── 5. Webhook target ────────────────────────────────────────────────────────
hdr "Webhook target"
WH=$(get WEBHOOK)
WH_URL=$(echo "$WH" | grep -oE '"url":"[^"]+"' | cut -d'"' -f4)
if [[ -n "$WH_URL" && "$WH_URL" != "null" ]]; then
  pass "webhook URL: $WH_URL"
  echo "$WH" | grep -q '"message.incoming"' && pass "  receives message.incoming" || warn "  does NOT receive message.incoming"
  echo "$WH" | grep -q '"message.outgoing"' && pass "  receives message.outgoing" || warn "  does NOT receive message.outgoing"
else
  warn "no webhook target — incoming messages won't reach Base44 / your app"
fi

# ── 6. Public tunnel URL ─────────────────────────────────────────────────────
hdr "Public tunnel URL"
TUNNEL=$(get TUNNEL_URL)
if [[ -n "$TUNNEL" ]]; then
  pass "tunnel: $TUNNEL"
  echo
  echo "  Quick test from this laptop:"
  echo "    curl ${TUNNEL}/healthz"
else
  warn "tunnel URL not found in journal — may need to wait or restart cloudflared-wahub"
fi

# ── 7. Resources ─────────────────────────────────────────────────────────────
hdr "Server resources"
FREE=$(get MEM_FREE)
DISK=$(get DISK_AVAIL)
[[ -n "$FREE" && "$FREE" -gt 500 ]] && pass "free memory: ${FREE}MB" || warn "low free memory: ${FREE}MB (will hit 512MB systemd cap on the Hub)"
[[ -n "$DISK" && "$DISK" -gt 5 ]] && pass "free disk: ${DISK}GB" || warn "low free disk: ${DISK}GB"

# ── 8. Recent errors ────────────────────────────────────────────────────────
hdr "Recent errors (last hour)"
ERR=$(get RECENT_ERRORS)
if [[ "$ERR" == "0" ]]; then
  pass "no errors in journal"
else
  warn "$ERR error/fatal log lines in the last hour"
  echo "    investigate with: ssh $TARGET 'journalctl -u wa-hub --since \"1 hour ago\" | grep -E \"ERROR|FATAL\"'"
fi

# ── Final verdict ────────────────────────────────────────────────────────────
echo
if [[ $FAILED -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}════════════════════════════════════════════════════════════════${RESET}"
  echo -e "${GREEN}${BOLD}  ✓ ALL CRITICAL CHECKS PASSED — you're cleared for takeoff${RESET}"
  echo -e "${GREEN}${BOLD}════════════════════════════════════════════════════════════════${RESET}"
  exit 0
else
  echo -e "${RED}${BOLD}════════════════════════════════════════════════════════════════${RESET}"
  echo -e "${RED}${BOLD}  ✗ AT LEAST ONE CRITICAL CHECK FAILED — fix before going live${RESET}"
  echo -e "${RED}${BOLD}════════════════════════════════════════════════════════════════${RESET}"
  exit 1
fi
