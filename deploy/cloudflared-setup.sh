#!/usr/bin/env bash
# Install Cloudflare Tunnel and expose wa-hub-demo to the internet over HTTPS.
#
# Two modes:
#   (a) NAMED TUNNEL  — recommended. Stable URL (api.your-domain.com), needs a
#       Cloudflare account + a domain managed by Cloudflare.
#   (b) QUICK TUNNEL  — zero-config. Gives you a one-off https://<random>.trycloudflare.com
#       URL that resets every restart. Useful for demos, not production.
#
# Usage:
#   sudo ./cloudflared-setup.sh           # interactive — picks named or quick
#   sudo ./cloudflared-setup.sh quick     # force quick tunnel
#   sudo ./cloudflared-setup.sh named     # force named tunnel (will prompt for login)

set -euo pipefail

MODE="${1:-}"
GREEN="\033[32m"; YELLOW="\033[33m"; BLUE="\033[34m"; RED="\033[31m"; RESET="\033[0m"
step() { echo -e "\n${BLUE}▸ $*${RESET}"; }
ok()   { echo -e "  ${GREEN}✓${RESET} $*"; }
warn() { echo -e "  ${YELLOW}!${RESET} $*"; }
fail() { echo -e "  ${RED}✗${RESET} $*"; exit 1; }

[[ $EUID -eq 0 ]] || fail "Run as root (use sudo)."

# ─── 1. Install cloudflared ───────────────────────────────────────────
step "Installing cloudflared"
if ! command -v cloudflared >/dev/null; then
  ARCH=$(dpkg --print-architecture)   # amd64 | arm64
  curl -fsSL -o /tmp/cloudflared.deb \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH.deb"
  dpkg -i /tmp/cloudflared.deb >/dev/null
  rm /tmp/cloudflared.deb
fi
ok "cloudflared $(cloudflared --version 2>&1 | head -1)"

# ─── 2. Pick mode ─────────────────────────────────────────────────────
if [[ -z "$MODE" ]]; then
  echo
  echo "  Choose tunnel mode:"
  echo "    [1] quick — random URL, no account needed (best for first demo)"
  echo "    [2] named — stable URL like api.yourdomain.com (best for production)"
  read -rp "  Mode [1/2]: " choice
  case "$choice" in
    1) MODE=quick ;;
    2) MODE=named ;;
    *) fail "Invalid choice" ;;
  esac
fi

# ─── 3a. Quick tunnel ─────────────────────────────────────────────────
if [[ "$MODE" == "quick" ]]; then
  step "Starting QUICK tunnel (random URL)"
  cat >/etc/systemd/system/cloudflared-quick.service <<'EOF'
[Unit]
Description=Cloudflare Quick Tunnel for wa-hub-demo
After=network-online.target wa-hub.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:3060
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now cloudflared-quick.service
  sleep 6
  URL=$(journalctl -u cloudflared-quick.service -n 50 --no-pager 2>/dev/null | grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1)
  if [[ -n "$URL" ]]; then
    ok "Public URL: $URL"
    echo
    echo "  Test:"
    echo "    curl $URL/healthz"
  else
    warn "URL not parsed yet. Run: journalctl -u cloudflared-quick.service -n 50"
  fi
  exit 0
fi

# ─── 3b. Named tunnel ─────────────────────────────────────────────────
if [[ "$MODE" == "named" ]]; then
  step "Authenticating with Cloudflare (a browser URL will appear)"
  cloudflared tunnel login

  read -rp "  Tunnel name (e.g. wa-hub-demo): " TUNNEL_NAME
  read -rp "  Hostname to expose (e.g. api.yourdomain.com): " HOSTNAME

  step "Creating tunnel '$TUNNEL_NAME'"
  cloudflared tunnel create "$TUNNEL_NAME" || true
  TUNNEL_ID=$(cloudflared tunnel list 2>/dev/null | awk -v n="$TUNNEL_NAME" '$2==n {print $1}')
  [[ -n "$TUNNEL_ID" ]] || fail "Could not find tunnel id for $TUNNEL_NAME"
  ok "tunnel id: $TUNNEL_ID"

  step "Writing /etc/cloudflared/config.yml"
  mkdir -p /etc/cloudflared
  # `cloudflared tunnel create` writes the credentials JSON under the invoking
  # user's ~/.cloudflared (only /root if sudo reset HOME). Locate it robustly and
  # copy it to /etc/cloudflared so the system service can always read it.
  CRED_SRC=$(find "$HOME/.cloudflared" /root/.cloudflared -name "$TUNNEL_ID.json" 2>/dev/null | head -1)
  [[ -n "$CRED_SRC" ]] || fail "Could not locate tunnel credentials file $TUNNEL_ID.json"
  install -m 600 "$CRED_SRC" "/etc/cloudflared/$TUNNEL_ID.json"
  cat >/etc/cloudflared/config.yml <<EOF
tunnel: $TUNNEL_ID
credentials-file: /etc/cloudflared/$TUNNEL_ID.json
# Force the edge connection over TCP. The default (QUIC, UDP 7844) is dropped on
# many networks/ISPs/clouds and cloudflared does NOT fall back — the tunnel would
# come up but never carry traffic. http2 (TCP) works virtually everywhere.
protocol: http2
ingress:
  - hostname: $HOSTNAME
    service: http://127.0.0.1:3060
  - service: http_status:404
EOF

  step "Routing DNS"
  cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME"

  step "Installing systemd service"
  cloudflared service install
  systemctl enable --now cloudflared
  sleep 3

  if systemctl is-active --quiet cloudflared; then
    ok "Tunnel running. Public URL: https://$HOSTNAME"
    # Stop the temporary Quick Tunnel the installer set up, so we don't run both
    # against the same origin (the random *.trycloudflare.com URL is no longer needed).
    if systemctl is-active --quiet cloudflared-wahub.service 2>/dev/null \
       || systemctl is-enabled --quiet cloudflared-wahub.service 2>/dev/null; then
      systemctl disable --now cloudflared-wahub.service >/dev/null 2>&1 || true
      ok "stopped the temporary Quick Tunnel — your subdomain is the endpoint now"
    fi
  else
    fail "cloudflared service did not start. Check: journalctl -u cloudflared -n 50"
  fi
  echo
  echo "  Test:"
  echo "    curl https://$HOSTNAME/healthz"
  exit 0
fi

fail "Unknown mode: $MODE"
