#!/usr/bin/env bash
# Edge-case tests for the installer's port-selection logic.
# ─────────────────────────────────────────────────────────────────────────────
# These run the EXACT port_in_use()/pick_free_port() functions from install.sh
# (extracted from the file, not re-typed) against a MOCKED `ss` so we can drive
# any "busy ports" scenario without touching real sockets — which also makes the
# suite runnable off-Linux (Git Bash / macOS), where `ss` doesn't exist.
#
#   Run:  bash deploy/test/port-selection.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SH="$HERE/../install.sh"
SETUP_SH="$HERE/../cloudflared-setup.sh"
UNIT="$HERE/../cloudflared-wahub.service"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }
eq()   { if [[ "$2" == "$3" ]]; then ok "$1 (= $2)"; else bad "$1 — expected '$3', got '$2'"; fi; }
istrue()  { if "$@"; then ok "true: $*"; else bad "expected TRUE: $*"; fi; }
isfalse() { if "$@"; then bad "expected FALSE: $*"; else ok "false: $*"; fi; }

# `fail` is referenced inside pick_free_port (only on exhaustion). Stub it so the
# function is self-contained when sourced outside the installer.
fail() { printf 'FAIL(stub): %s\n' "$*" >&2; return 1; }

# ── Pull the real functions out of install.sh (the "Port selection" banner up to
#    the next "Hardening mode" banner) and source them, so we test shipping code.
PORT_FUNCS="$(awk '/Port selection/{f=1} /Hardening mode/{f=0} f' "$INSTALL_SH")"
if ! grep -q 'pick_free_port()' <<<"$PORT_FUNCS"; then
  echo "FATAL: could not extract port functions from $INSTALL_SH" >&2; exit 2
fi
# shellcheck disable=SC1090
eval "$PORT_FUNCS"

# ── Mock `ss`. BUSY holds the listener table we want `ss -ltnH` to report. A bash
#    function named `ss` shadows the binary that port_in_use() calls.
BUSY=""
ss() { printf '%s\n' "$BUSY"; }

# A realistic `ss -ltnH` row: State Recv-Q Send-Q Local-Address:Port Peer:* …
row() { printf 'LISTEN 0 4096 %s %s\n' "$1" "0.0.0.0:*"; }

echo "── port_in_use(): exact-match parsing (no partial/substring hits) ──"
BUSY="$(row '127.0.0.1:3060'
        row '127.0.0.1:3061'
        row '0.0.0.0:80'
        row '127.0.0.54:53'
        row '[::1]:13060'
        row '*:22')"
istrue  port_in_use 3060
istrue  port_in_use 3061
istrue  port_in_use 80
istrue  port_in_use 53
istrue  port_in_use 13060            # IPv6 listener detected
istrue  port_in_use 22              # wildcard '*:22'
isfalse port_in_use 3062            # genuinely free
isfalse port_in_use 60             # NOT matched by 3060 (suffix) …
isfalse port_in_use 3             # … nor 53 (prefix) — exact match only
isfalse port_in_use 1306          # NOT matched by 13060

echo "── pick_free_port(): nothing busy → defaults unchanged ──"
BUSY=""
HUB="$(pick_free_port 3060)"
WS="$(pick_free_port 3061 "$HUB")"
eq "HUB default" "$HUB" "3060"
eq "WS default"  "$WS"  "3061"

echo "── pick_free_port(): both defaults busy → walk to next free pair ──"
BUSY="$(row '127.0.0.1:3060'; row '127.0.0.1:3061')"
HUB="$(pick_free_port 3060)"
WS="$(pick_free_port 3061 "$HUB")"
eq "HUB relocated" "$HUB" "3062"
eq "WS relocated"  "$WS"  "3063"
[[ "$HUB" != "$WS" ]] && ok "HUB≠WS" || bad "HUB and WS collided ($HUB)"

echo "── pick_free_port(): only 3060 busy → WS must dodge HUB's new 3061 ──"
BUSY="$(row '127.0.0.1:3060')"
HUB="$(pick_free_port 3060)"              # → 3061 (3060 busy, 3061 free)
WS="$(pick_free_port 3061 "$HUB")"        # 3061 now claimed by HUB → 3062
eq "HUB takes 3061" "$HUB" "3061"
eq "WS dodges to 3062 (same-run collision avoided)" "$WS" "3062"

echo "── pick_free_port(): contiguous block 3060–3069 busy → jump past it ──"
B=""; for p in 3060 3061 3062 3063 3064 3065 3066 3067 3068 3069; do B+="$(row "127.0.0.1:$p")"$'\n'; done
BUSY="$B"
HUB="$(pick_free_port 3060)"
WS="$(pick_free_port 3061 "$HUB")"
eq "HUB jumps to 3070" "$HUB" "3070"
eq "WS jumps to 3071"  "$WS"  "3071"

echo "── pick_free_port(): default free even though 13060/30600/60 are busy ──"
BUSY="$(row '127.0.0.1:13060'; row '127.0.0.1:30600'; row '0.0.0.0:60')"
HUB="$(pick_free_port 3060)"
eq "HUB stays 3060 (no false positive)" "$HUB" "3060"

echo "── tunnel-port rewrite: install.sh sed keeps unit pointed at the real port ──"
# Reproduce the exact substitution install.sh applies to the shipped unit.
patch_unit() { sed "s#http://127.0.0.1:3060#http://127.0.0.1:$1#" "$UNIT"; }
eq "default 3060 → no-op" \
   "$(patch_unit 3060 | grep -c -- '--url http://127.0.0.1:3060')" "1"
got="$(patch_unit 3062 | grep -oE 'http://127\.0\.0\.1:[0-9]+')"
eq "relocated → unit now targets 3062" "$got" "http://127.0.0.1:3062"
isfalse grep -q '127.0.0.1:3060' <(patch_unit 3062)   # old port fully gone

echo "── cloudflared-setup.sh: HUB_PORT read from .env (grep|cut snippet) ──"
TMP_ENV="$(mktemp)"; printf 'HUB_TOKEN=x\nHUB_PORT=3070\nWS_PORT=3071\n' > "$TMP_ENV"
read_hub_port() {  # mirrors the snippet added to cloudflared-setup.sh
  local f="$1" p=3060 _p
  if [[ -f "$f" ]]; then
    _p="$(grep -E '^HUB_PORT=' "$f" | cut -d= -f2- || true)"
    [[ "$_p" =~ ^[0-9]+$ ]] && p="$_p"
  fi
  printf '%s\n' "$p"
}
eq "reads relocated port from .env" "$(read_hub_port "$TMP_ENV")" "3070"
eq "falls back to 3060 when .env absent" "$(read_hub_port /no/such/file)" "3060"
rm -f "$TMP_ENV"

# Guard against drift: the setup script and the unit should still reference HUB_PORT
# / the loopback origin the way these tests assume.
echo "── source-file sanity (catch future regressions) ──"
istrue grep -q 'HUB_PORT=$(pick_free_port 3060)' "$INSTALL_SH"
istrue grep -q 'pick_free_port 3061 "$HUB_PORT"' "$INSTALL_SH"
istrue grep -q '127.0.0.1:$HUB_PORT' "$SETUP_SH"

echo
echo "──────────────────────────────────────────────"
printf 'Result: %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
