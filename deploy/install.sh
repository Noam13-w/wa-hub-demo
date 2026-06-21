#!/usr/bin/env bash
# wa-hub-demo · one-command installer
# ─────────────────────────────────────────────────────────────────────────────
# Bootstraps a fresh Ubuntu 24.04 server (x86 or ARM) into a fully working
# WhatsApp HTTP API in ~3 minutes, including:
#   • System update + SSH hardening + ufw + fail2ban
#   • Node 20 + service user + repo clone + npm install
#   • Random HUB_TOKEN + WEBHOOK_SECRET generation
#   • systemd unit with seccomp-safe hardening
#   • Cloudflare Tunnel (Quick mode) + systemd unit
#   • Final summary: public URL, token, secret
#
# Usage (as root on a fresh server):
#   curl -fsSL https://raw.githubusercontent.com/Noam13-w/wa-hub-demo/main/deploy/install.sh | bash
#
# Re-running is mostly idempotent (won't re-generate secrets if .env exists).

set -euo pipefail
umask 022

REPO_URL="${WA_HUB_REPO:-https://github.com/Noam13-w/wa-hub-demo.git}"
RAW_BASE="${WA_HUB_RAW:-https://raw.githubusercontent.com/Noam13-w/wa-hub-demo/main}"
INSTALL_DIR="/srv/wa-hub-demo"
SERVICE_USER="wahub"

# ─── Pretty output ───────────────────────────────────────────────────────────
RED="\033[31m"; GREEN="\033[32m"; YELLOW="\033[33m"; BLUE="\033[34m"; CYAN="\033[36m"; BOLD="\033[1m"; RESET="\033[0m"
step()  { echo -e "\n${BLUE}${BOLD}▸ $*${RESET}"; }
ok()    { echo -e "  ${GREEN}✓${RESET} $*"; }
warn()  { echo -e "  ${YELLOW}!${RESET} $*"; }
fail()  { echo -e "  ${RED}✗${RESET} $*"; exit 1; }

[[ $EUID -eq 0 ]] || fail "Run as root (use sudo bash, or curl ... | sudo bash)."

export DEBIAN_FRONTEND=noninteractive

# ─── 1. System update + base packages ────────────────────────────────────────
step "[1/8] Updating system and installing base packages"
apt-get update -qq
apt-get -y -qq dist-upgrade >/dev/null
apt-get install -y -qq curl git build-essential ufw fail2ban ca-certificates openssl >/dev/null
ok "base packages installed"

# ─── 2. SSH hardening (key only, no root password) ───────────────────────────
step "[2/8] Hardening SSH"
# Only disable password auth if an SSH key is already authorized — otherwise we
# would lock the operator out of a password-only server.
if [[ -s /root/.ssh/authorized_keys ]] || ls /home/*/.ssh/authorized_keys >/dev/null 2>&1; then
  sed -i 's/^#*PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
  sed -i 's/^#*PermitRootLogin .*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
  sed -i 's/^#*PermitEmptyPasswords .*/PermitEmptyPasswords no/' /etc/ssh/sshd_config
  sshd -t && systemctl reload ssh
  ok "sshd: password auth disabled, root login key-only"
else
  warn "No authorized SSH key found — leaving password auth ENABLED to avoid lockout."
  warn "Add your key (ssh-copy-id), then set 'PasswordAuthentication no' in /etc/ssh/sshd_config."
fi

# ─── 3. Firewall ─────────────────────────────────────────────────────────────
step "[3/8] Configuring firewall (ufw)"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp comment 'SSH' >/dev/null
yes | ufw enable >/dev/null
ok "ufw active — only port 22 (SSH) open to internet"

# ─── 4. fail2ban ─────────────────────────────────────────────────────────────
step "[4/8] Enabling fail2ban"
systemctl enable --now fail2ban >/dev/null 2>&1
ok "fail2ban active"

# ─── 5. Node.js 20 ───────────────────────────────────────────────────────────
step "[5/8] Installing Node.js 20"
if ! command -v node >/dev/null || ! node --version | grep -q '^v2[0-9]'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
ok "node $(node --version) / npm $(npm --version)"

# ─── 6. Service user + repo + npm ────────────────────────────────────────────
step "[6/8] Setting up service user and source code"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --shell /usr/sbin/nologin --home-dir "$INSTALL_DIR" "$SERVICE_USER"
fi
if [[ ! -d "$INSTALL_DIR/.git" ]]; then
  rm -rf "$INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR" >/dev/null 2>&1
else
  git -C "$INSTALL_DIR" pull --ff-only >/dev/null 2>&1 || true
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

# Install deps as wahub. Prefer `npm ci` for a reproducible, lockfile-pinned
# tree (integrity-checked); fall back to `npm install` only if the lockfile is
# out of sync. `--ignore-scripts` blocks arbitrary install-time code execution
# (supply-chain hardening) — none of our deps need a build step.
sudo -u "$SERVICE_USER" bash -c "cd '$INSTALL_DIR' && (npm ci --omit=dev --no-audit --no-fund --ignore-scripts || npm install --omit=dev --no-audit --no-fund --ignore-scripts)" 2>&1 | tail -3
ok "code at $INSTALL_DIR, dependencies installed"

# ─── 7. .env + systemd + start ───────────────────────────────────────────────
step "[7/8] Generating secrets and installing systemd unit"
ENV_FILE="$INSTALL_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  warn ".env already exists — keeping existing secrets"
  HUB_TOKEN=$(grep ^HUB_TOKEN "$ENV_FILE" | cut -d= -f2-)
  WEBHOOK_SECRET=$(grep ^WEBHOOK_SECRET "$ENV_FILE" | cut -d= -f2-)
else
  HUB_TOKEN=$(openssl rand -hex 32)
  WEBHOOK_SECRET=$(openssl rand -hex 32)
  cat >"$ENV_FILE" <<EOF
HUB_NAME=$(hostname -s)
HUB_TOKEN=$HUB_TOKEN
WEBHOOK_SECRET=$WEBHOOK_SECRET
HUB_PORT=3060
WS_PORT=3061
# Bound to loopback — only the local Cloudflare Tunnel reaches the API/WS.
HUB_HOST=127.0.0.1
WS_HOST=127.0.0.1
WEBHOOK_URL=
WEBHOOK_EVENTS=
RATE_LIMIT_PER_MIN=120
# We run behind the Cloudflare Tunnel (a trusted local proxy), so trust its
# forwarded client IP — the rate limiter keys on the real caller, not 127.0.0.1.
TRUST_PROXY=true
DATA_DIR=$INSTALL_DIR/data
LOG_LEVEL=info
EOF
  chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi
mkdir -p "$INSTALL_DIR/data"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/data"

# Install the Hub's systemd unit + the seccomp drop-in (Node 20 needs syscalls
# that the strict default blocks → core-dump status=31/SYS).
install -m 644 "$INSTALL_DIR/deploy/wa-hub.service" /etc/systemd/system/wa-hub.service
mkdir -p /etc/systemd/system/wa-hub.service.d
printf '[Service]\nSystemCallFilter=\n' > /etc/systemd/system/wa-hub.service.d/syscall-fix.conf

systemctl daemon-reload
systemctl enable --now wa-hub.service >/dev/null
sleep 4
systemctl is-active --quiet wa-hub.service \
  && ok "wa-hub.service is active" \
  || fail "wa-hub.service failed to start. Check: journalctl -u wa-hub.service -n 50"

# ─── 8. Cloudflare Tunnel ────────────────────────────────────────────────────
step "[8/8] Installing Cloudflare Tunnel (Quick mode)"
if ! command -v cloudflared >/dev/null; then
  ARCH=$(dpkg --print-architecture)  # amd64 (CX23) or arm64 (CAX11)
  curl -fsSL -o /tmp/cloudflared.deb \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH.deb"
  dpkg -i /tmp/cloudflared.deb >/dev/null
  rm /tmp/cloudflared.deb
fi
ok "cloudflared $(cloudflared --version | head -1 | awk '{print $3}')"

# Pull the cloudflared systemd unit from the repo (no heredoc — robust against paste mangling).
install -m 644 "$INSTALL_DIR/deploy/cloudflared-wahub.service" /etc/systemd/system/cloudflared-wahub.service
systemctl daemon-reload
systemctl enable --now cloudflared-wahub.service >/dev/null

# Wait for the tunnel URL to appear in the journal (Quick Tunnel returns within ~5s)
TUNNEL_URL=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  TUNNEL_URL=$(journalctl -u cloudflared-wahub.service --no-pager 2>/dev/null \
                | grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1)
  [[ -n "$TUNNEL_URL" ]] && break
  sleep 2
done
[[ -n "$TUNNEL_URL" ]] && ok "tunnel URL: $TUNNEL_URL" \
                      || warn "tunnel URL not captured yet — run 'journalctl -u cloudflared-wahub.service | grep trycloudflare' in 30s"

# ─── Final summary ───────────────────────────────────────────────────────────
echo
echo -e "${GREEN}${BOLD}════════════════════════════════════════════════════════════════${RESET}"
echo -e "${GREEN}${BOLD}  🎉 wa-hub-demo is live!${RESET}"
echo -e "${GREEN}${BOLD}════════════════════════════════════════════════════════════════${RESET}"
echo
echo -e "${BOLD}Public URL:${RESET}        ${CYAN}${TUNNEL_URL:-(check in a moment)}${RESET}"
# Only echo raw secrets to an interactive terminal. When the installer is piped
# (curl ... | bash) stdout is not a TTY, and printing would leak them into the
# pipe / CI logs / scrollback — so we point to the 0600 .env instead.
if [[ -t 1 ]]; then
  echo -e "${BOLD}HUB_TOKEN:${RESET}         $HUB_TOKEN"
  echo -e "${BOLD}WEBHOOK_SECRET:${RESET}    $WEBHOOK_SECRET"
  echo
  echo -e "${BOLD}${YELLOW}⚠ Save the two secrets above to your password manager NOW.${RESET}"
  TOKDISP="$HUB_TOKEN"
else
  echo -e "${BOLD}Secrets:${RESET}           stored in ${CYAN}$ENV_FILE${RESET} (chmod 600, owner $SERVICE_USER)"
  echo -e "                   reveal: ${CYAN}sudo grep -E '^(HUB_TOKEN|WEBHOOK_SECRET)=' $ENV_FILE${RESET}"
  echo
  echo -e "${BOLD}${YELLOW}⚠ Secrets were NOT printed (you piped the installer into bash). Read them from the file above and store them in a password manager.${RESET}"
  TOKDISP='$HUB_TOKEN'
fi
echo
echo -e "${BOLD}Next steps:${RESET}"
echo
echo -e "  ${BOLD}1. Pair WhatsApp — open the live QR page in your browser:${RESET}"
echo
if [[ -n "$TUNNEL_URL" ]]; then
  if [[ -t 1 ]]; then
    echo -e "       ${CYAN}${TUNNEL_URL}/pair#${HUB_TOKEN}${RESET}"
    echo -e "       (one-click — the token rides in the URL #fragment, which never leaves your browser)"
  else
    echo -e "       ${CYAN}${TUNNEL_URL}/pair${RESET}  — then paste your HUB_TOKEN when asked"
  fi
else
  echo -e "       ${CYAN}\$TUNNEL_URL/pair${RESET}  — then paste your HUB_TOKEN when asked"
fi
echo
echo -e "       The QR refreshes itself and flips to “Linked” automatically when you scan"
echo -e "       (WhatsApp → Settings → Linked Devices → Link a Device)."
echo
echo -e "       ${BOLD}Headless alternative${RESET} (no browser) — fetch the QR as a PNG:"
if [[ -n "$TUNNEL_URL" ]]; then
  echo -e "       ${CYAN}curl -fsS -H \"Authorization: Bearer $TOKDISP\" $TUNNEL_URL/api/instance/qr.png -o ~/qr.png${RESET}"
else
  echo -e "       ${CYAN}curl -fsS -H \"Authorization: Bearer \$HUB_TOKEN\" \$TUNNEL_URL/api/instance/qr.png -o ~/qr.png${RESET}"
fi
echo
echo -e "  ${BOLD}2. Send a test message:${RESET}"
if [[ -n "$TUNNEL_URL" ]]; then
  echo -e "       ${CYAN}curl -X POST -H \"Authorization: Bearer $TOKDISP\" \\${RESET}"
  echo -e "       ${CYAN}     -H 'Content-Type: application/json' \\${RESET}"
  echo -e "       ${CYAN}     -d '{\"to\":\"<recipient>\",\"text\":\"hi\"}' \\${RESET}"
  echo -e "       ${CYAN}     $TUNNEL_URL/api/messages/send/text${RESET}"
fi
echo
echo -e "  ${BOLD}Logs:${RESET}             journalctl -u wa-hub -f"
echo -e "  ${BOLD}Tunnel logs:${RESET}      journalctl -u cloudflared-wahub -f"
echo
echo -e "${GREEN}${BOLD}════════════════════════════════════════════════════════════════${RESET}"
