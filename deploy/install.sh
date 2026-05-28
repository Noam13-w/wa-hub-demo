#!/usr/bin/env bash
# One-command installer for wa-hub-demo on a fresh Ubuntu 22.04 / 24.04 server.
#
# Usage (as root or with sudo):
#   curl -fsSL https://raw.githubusercontent.com/noamnissan/wa-hub-demo/main/deploy/install.sh | sudo bash
#
# What it does:
#   1. Hardens SSH (PasswordAuthentication=no), enables ufw, installs fail2ban
#   2. Installs Node.js 20, git, build-essential
#   3. Creates the `wahub` service user (no shell, no home access)
#   4. Clones the repo to /srv/wa-hub-demo
#   5. npm install
#   6. Generates a strong HUB_TOKEN and WEBHOOK_SECRET, writes .env
#   7. Installs the systemd unit and enables it
#   8. Prints the pairing URL
#
# Re-run is idempotent.

set -euo pipefail
umask 022

REPO_URL="${WA_HUB_REPO:-https://github.com/noamnissan/wa-hub-demo.git}"
INSTALL_DIR="/srv/wa-hub-demo"
SERVICE_USER="wahub"
SERVICE_NAME="wa-hub.service"

# ─── pretty output ────────────────────────────────────────────────────
GREEN="\033[32m"; YELLOW="\033[33m"; BLUE="\033[34m"; RED="\033[31m"; RESET="\033[0m"
step()  { echo -e "\n${BLUE}▸ $*${RESET}"; }
ok()    { echo -e "  ${GREEN}✓${RESET} $*"; }
warn()  { echo -e "  ${YELLOW}!${RESET} $*"; }
fail()  { echo -e "  ${RED}✗${RESET} $*"; exit 1; }

[[ $EUID -eq 0 ]] || fail "Run as root (use sudo)."

# ─── 1. Base packages ─────────────────────────────────────────────────
step "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git build-essential ufw fail2ban ca-certificates >/dev/null
ok "base packages installed"

# ─── 2. Node 20 (via NodeSource) ──────────────────────────────────────
step "Installing Node.js 20"
if ! command -v node >/dev/null || ! node --version | grep -q '^v20\|^v21\|^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
ok "node $(node --version), npm $(npm --version)"

# ─── 3. SSH hardening ─────────────────────────────────────────────────
step "Hardening SSH"
sed -i 's/^#*PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#*PermitRootLogin .*/PermitRootLogin no/'                /etc/ssh/sshd_config
sed -i 's/^#*PermitEmptyPasswords .*/PermitEmptyPasswords no/'      /etc/ssh/sshd_config
sshd -t && systemctl reload ssh
ok "sshd_config validated and reloaded"

# ─── 4. Firewall (ufw) ────────────────────────────────────────────────
step "Configuring firewall"
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
# REST + WS are NOT exposed publicly — Cloudflare Tunnel routes them.
yes | ufw enable >/dev/null
ok "ufw active: only SSH allowed in"

# ─── 5. fail2ban ──────────────────────────────────────────────────────
step "Enabling fail2ban"
systemctl enable --now fail2ban >/dev/null 2>&1
ok "fail2ban enabled"

# ─── 6. Service user ──────────────────────────────────────────────────
step "Creating service user '$SERVICE_USER'"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --shell /usr/sbin/nologin --home-dir "$INSTALL_DIR" --create-home "$SERVICE_USER"
fi
ok "user $SERVICE_USER ready (uid=$(id -u $SERVICE_USER))"

# ─── 7. Clone repo ────────────────────────────────────────────────────
step "Fetching wa-hub-demo source"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  sudo -u "$SERVICE_USER" git -C "$INSTALL_DIR" pull --ff-only
else
  rm -rf "$INSTALL_DIR"
  sudo -u "$SERVICE_USER" git clone "$REPO_URL" "$INSTALL_DIR"
fi
ok "source at $INSTALL_DIR"

# ─── 8. npm install ───────────────────────────────────────────────────
step "Installing npm dependencies"
sudo -u "$SERVICE_USER" -- bash -c "cd '$INSTALL_DIR' && npm ci --omit=dev --no-audit --no-fund" 2>&1 | tail -3
ok "npm packages installed"

# ─── 9. .env generation ───────────────────────────────────────────────
step "Generating .env (secrets are randomized — copy them now)"
ENV_FILE="$INSTALL_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  HUB_TOKEN=$(openssl rand -hex 32)
  WEBHOOK_SECRET=$(openssl rand -hex 32)
  cat >"$ENV_FILE" <<EOF
HUB_NAME=$(hostname -s)
HUB_TOKEN=$HUB_TOKEN
WEBHOOK_SECRET=$WEBHOOK_SECRET
HUB_PORT=3060
WS_PORT=3061
WEBHOOK_URL=
WEBHOOK_EVENTS=
RATE_LIMIT_PER_MIN=120
DATA_DIR=$INSTALL_DIR/data
LOG_LEVEL=info
EOF
  chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "new .env written to $ENV_FILE (mode 600)"
else
  warn ".env already exists — leaving it untouched"
fi
mkdir -p "$INSTALL_DIR/data"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/data"

# ─── 10. systemd unit ─────────────────────────────────────────────────
step "Installing systemd unit"
install -m 644 "$INSTALL_DIR/deploy/wa-hub.service" /etc/systemd/system/$SERVICE_NAME
systemctl daemon-reload
systemctl enable --now $SERVICE_NAME >/dev/null
sleep 3
if systemctl is-active --quiet $SERVICE_NAME; then
  ok "$SERVICE_NAME is active"
else
  fail "$SERVICE_NAME failed to start. Check: journalctl -u $SERVICE_NAME -n 50"
fi

# ─── 11. Summary ──────────────────────────────────────────────────────
echo
echo "════════════════════════════════════════════════════════════════"
echo "  wa-hub-demo is running!"
echo "════════════════════════════════════════════════════════════════"
echo "  HUB_TOKEN:      $(grep ^HUB_TOKEN $ENV_FILE | cut -d= -f2)"
echo "  WEBHOOK_SECRET: $(grep ^WEBHOOK_SECRET $ENV_FILE | cut -d= -f2)"
echo "  REST API:       http://127.0.0.1:3060   (loopback only)"
echo "  WebSocket:      ws://127.0.0.1:3061     (loopback only)"
echo
echo "  Next steps:"
echo "    1. Pair the device:"
echo "         curl -H \"Authorization: Bearer \$HUB_TOKEN\" \\"
echo "              http://127.0.0.1:3060/api/instance/qr.png > /tmp/qr.png"
echo "       (transfer /tmp/qr.png to a device and scan from WhatsApp → Linked Devices)"
echo
echo "    2. Expose the API to the internet:"
echo "         sudo $INSTALL_DIR/deploy/cloudflared-setup.sh"
echo
echo "    3. Logs:"
echo "         journalctl -u $SERVICE_NAME -f"
echo "════════════════════════════════════════════════════════════════"
