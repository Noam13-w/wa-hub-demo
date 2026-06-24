#!/usr/bin/env bash
# wa-hub-demo · one-command installer
# ─────────────────────────────────────────────────────────────────────────────
# Bootstraps a fresh Ubuntu 24.04 server (x86 or ARM) into a fully working
# WhatsApp HTTP API in ~3 minutes, including:
#   • System update + SSH hardening + ufw + fail2ban   (FRESH boxes only — see below)
#   • Node 20 + service user + repo clone + npm install
#   • Random HUB_TOKEN + WEBHOOK_SECRET generation
#   • systemd unit with seccomp-safe hardening
#   • Cloudflare Tunnel (Quick mode) + systemd unit
#   • Final summary: public URL, token, secret
#
# Usage (as root):
#   curl -fsSL https://raw.githubusercontent.com/Noam13-w/wa-hub-demo/main/deploy/install.sh | sudo bash
#
# EXISTING SERVERS ARE SAFE: the host-hardening steps (firewall reset, sshd
# changes, dist-upgrade) run ONLY when the box looks clearly fresh. If anything
# else is already running (active ufw, non-22 SSH, other listening ports), the
# installer switches to SAFE mode and touches NONE of them — wa-hub binds
# loopback and is reached via the outbound tunnel, so it needs no open ports.
# Override the choice explicitly with  WA_HUB_HARDEN=full  or  WA_HUB_HARDEN=safe.
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

# ─── Hardening mode — protect EXISTING servers ───────────────────────────────
# This installer was built for a FRESH, dedicated box, where it hardens the host
# (resets ufw to deny-all-but-SSH, disables SSH password auth, dist-upgrades).
# On a server that ALREADY runs other services, doing that would wipe the
# firewall (blocking the existing services — and locking SSH out entirely if SSH
# isn't on port 22) and rewrite sshd. So we choose a mode automatically, BIASED
# toward "safe", overridable with WA_HUB_HARDEN:
#   full → fresh-box hardening (ufw reset, sshd password-auth off, dist-upgrade)
#   safe → touch NOTHING destructive. wa-hub binds loopback (127.0.0.1) and is
#          reached via the OUTBOUND Cloudflare Tunnel, so it needs no open ports.
#   auto → (default) full only when the box looks clearly fresh.

# Detect the SSH port we're actually on, so we never assume 22 and lock anyone out.
SSH_PORT=22
if [[ -n "${SSH_CONNECTION:-}" ]]; then
  _p="$(awk '{print $4}' <<<"$SSH_CONNECTION" || true)"
  [[ "$_p" =~ ^[0-9]+$ ]] && SSH_PORT="$_p"
else
  _p="$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}' || true)"
  [[ "$_p" =~ ^[0-9]+$ ]] && SSH_PORT="$_p"
fi

looks_fresh() {
  # Not fresh if ufw is already active …
  ufw status 2>/dev/null | grep -qi 'Status: active' && return 1
  # … or SSH isn't on the default port …
  [[ "$SSH_PORT" != "22" ]] && return 1
  # … or anything listens on a non-loopback address on a port other than 22.
  local extra
  extra="$(ss -ltnH 2>/dev/null | awk '{print $4}' \
            | grep -vE '^(127\.|\[::1\]|::1|\[::ffff:127)' | grep -vE ':22$' | head -1 || true)"
  [[ -n "$extra" ]] && return 1
  return 0
}

HARDEN_MODE="${WA_HUB_HARDEN:-auto}"
case "$HARDEN_MODE" in
  full|safe) ;;
  *) if looks_fresh; then HARDEN_MODE=full; else HARDEN_MODE=safe; fi ;;
esac

if [[ "$HARDEN_MODE" == "safe" ]]; then
  step "Mode: SAFE — existing server detected (or WA_HUB_HARDEN=safe)"
  warn "Your firewall and SSH config will NOT be modified, and the system won't be dist-upgraded."
  warn "wa-hub listens only on loopback and reaches the internet via the outbound tunnel — it needs no open ports."
  warn "To force full fresh-box hardening, re-run with:  WA_HUB_HARDEN=full"
else
  step "Mode: FULL — fresh-box hardening (SSH port $SSH_PORT)"
fi

# ─── 1. System update + base packages ────────────────────────────────────────
step "[1/8] Updating system and installing base packages"
apt-get update -qq
# Full system upgrade only on a fresh box — a dist-upgrade can restart services
# or pull a new kernel, which we must not do unasked-for on an existing server.
if [[ "$HARDEN_MODE" == "full" ]]; then
  apt-get -y -qq dist-upgrade >/dev/null
fi
apt-get install -y -qq curl git build-essential ufw fail2ban ca-certificates openssl >/dev/null
ok "base packages installed"

# ─── 2. SSH hardening (key only, no root password) ───────────────────────────
step "[2/8] Hardening SSH"
if [[ "$HARDEN_MODE" == "safe" ]]; then
  ok "skipped — leaving your SSH configuration untouched (safe mode)"
# Only disable password auth if an SSH key is already authorized — otherwise we
# would lock the operator out of a password-only server.
elif [[ -s /root/.ssh/authorized_keys ]] || ls /home/*/.ssh/authorized_keys >/dev/null 2>&1; then
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
if [[ "$HARDEN_MODE" == "safe" ]]; then
  # NEVER reset an existing firewall — that would block the server's other
  # services and could lock SSH out. wa-hub needs no inbound ports anyway.
  if ufw status 2>/dev/null | grep -qi 'Status: active'; then
    ufw allow "$SSH_PORT"/tcp comment 'SSH (ensured by wa-hub)' >/dev/null 2>&1 || true
    ok "firewall left intact — ensured SSH (port $SSH_PORT) stays allowed"
  else
    ok "firewall left untouched (ufw inactive; wa-hub opens no ports)"
  fi
else
  # Fresh box: deny everything inbound except SSH (on its real port).
  ufw --force reset >/dev/null
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow "$SSH_PORT"/tcp comment 'SSH' >/dev/null
  # `ufw --force enable` skips the interactive prompt without piping `yes` — under
  # `set -o pipefail`, `yes | ufw enable` aborts the script (yes gets SIGPIPE when
  # ufw closes the pipe after reading one line).
  ufw --force enable >/dev/null
  ok "ufw active — only SSH (port $SSH_PORT) open to internet"
fi

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

# Wait for THIS run's Quick Tunnel URL. We filter the journal by cloudflared's
# CURRENT systemd InvocationID so we never scrape a STALE *.trycloudflare.com URL
# left over from a previous run: Quick Tunnel URLs are ephemeral (a fresh one every
# restart), so on a re-install the old, now-dead URL is still in the unit's journal
# and a naive `tail -1` would grab it. Fall back to the plain unit filter if the
# InvocationID can't be read (older systemd). `|| true` keeps a not-yet-present URL
# (grep exit 1) from aborting under `set -o pipefail`.
TUNNEL_URL=""
for _ in $(seq 1 15); do
  invoc="$(systemctl show -p InvocationID --value cloudflared-wahub.service 2>/dev/null || true)"
  if [[ -n "$invoc" ]]; then
    TUNNEL_URL=$(journalctl _SYSTEMD_INVOCATION_ID="$invoc" --no-pager 2>/dev/null \
                  | grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)
  else
    TUNNEL_URL=$(journalctl -u cloudflared-wahub.service --no-pager 2>/dev/null \
                  | grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)
  fi
  [[ -n "$TUNNEL_URL" ]] && break
  sleep 2
done
[[ -n "$TUNNEL_URL" ]] && ok "tunnel URL: $TUNNEL_URL" \
                      || warn "tunnel URL not captured yet — run 'journalctl -u cloudflared-wahub.service | grep trycloudflare' in 30s"

# A registered Quick Tunnel URL can still be DEAD if cloudflared can't reach the
# Cloudflare edge. The classic cause is QUIC/UDP 7844 egress being blocked — now
# forced onto TCP via `--protocol http2` in the unit — but we still PROBE the public
# /healthz here so the installer never hands the user a link that silently doesn't
# work. (/healthz needs no token, so a 200 proves the whole tunnel→API path is live.)
TUNNEL_OK=0
if [[ -n "$TUNNEL_URL" ]]; then
  step "Verifying the public tunnel actually carries traffic"
  for _ in $(seq 1 20); do
    if [[ "$(curl -fsS -m 5 -o /dev/null -w '%{http_code}' "$TUNNEL_URL/healthz" 2>/dev/null || true)" == "200" ]]; then
      TUNNEL_OK=1; break
    fi
    sleep 2
  done
  if [[ "$TUNNEL_OK" == "1" ]]; then
    ok "tunnel is live — $TUNNEL_URL/healthz returned 200"
  else
    warn "tunnel registered but not reachable yet (it can take ~30s after first boot)."
    warn "If it stays down, this host is blocking cloudflared's egress to the edge. Check:"
    warn "  journalctl -u cloudflared-wahub.service | grep -Ei 'register|fail|protocol'"
  fi
fi

# ─── Final summary ───────────────────────────────────────────────────────────
echo
echo -e "${GREEN}${BOLD}════════════════════════════════════════════════════════════════${RESET}"
echo -e "${GREEN}${BOLD}  🎉 wa-hub-demo is live!${RESET}"
echo -e "${GREEN}${BOLD}════════════════════════════════════════════════════════════════${RESET}"
echo
echo -e "${BOLD}Public URL:${RESET}        ${CYAN}${TUNNEL_URL:-(check in a moment)}${RESET}$( [[ -n "$TUNNEL_URL" && "$TUNNEL_OK" == "1" ]] && echo -e "  ${GREEN}✓ live${RESET}" )"
[[ -n "$TUNNEL_URL" && "$TUNNEL_OK" != "1" ]] && \
  echo -e "                   ${YELLOW}↳ not reachable yet — give it ~30s and reload; if it stays down see 'Tunnel logs' below${RESET}"
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
  echo -e "       ${YELLOW}Tunnel URL not ready yet — fetch it once cloudflared settles:${RESET}"
  echo -e "       ${CYAN}journalctl -u cloudflared-wahub | grep -Eo 'https://[a-z0-9-]+\\.trycloudflare\\.com' | tail -1${RESET}"
  echo -e "       then open  ${BOLD}<that-URL>/pair${RESET}  and paste your HUB_TOKEN when asked"
fi
echo
echo -e "       The QR refreshes itself and flips to “Linked” automatically when you scan"
echo -e "       (WhatsApp → Settings → Linked Devices → Link a Device)."
echo
echo -e "       ${BOLD}Headless alternative${RESET} (no browser) — fetch the QR as a PNG:"
if [[ -n "$TUNNEL_URL" ]]; then
  echo -e "       ${CYAN}curl -fsS -H \"Authorization: Bearer $TOKDISP\" $TUNNEL_URL/api/instance/qr.png -o ~/qr.png${RESET}"
else
  echo -e "       (once you have the URL above, with your HUB_TOKEN from ${CYAN}$ENV_FILE${RESET}:)"
  echo -e "       ${CYAN}curl -fsS -H \"Authorization: Bearer <HUB_TOKEN>\" <URL>/api/instance/qr.png -o ~/qr.png${RESET}"
fi
echo
echo -e "  ${BOLD}2. Send a test message:${RESET}"
if [[ -n "$TUNNEL_URL" ]]; then
  echo -e "       ${CYAN}curl -X POST -H \"Authorization: Bearer $TOKDISP\" ${RESET}\\"
  echo -e "       ${CYAN}     -H 'Content-Type: application/json' ${RESET}\\"
  echo -e "       ${CYAN}     -d '{\"to\":\"<recipient>\",\"text\":\"hi\"}' ${RESET}\\"
  echo -e "       ${CYAN}     $TUNNEL_URL/api/messages/send/text${RESET}"
fi
echo
echo -e "  ${BOLD}3. Once paired, that same /pair page becomes your console${RESET}"
echo -e "       — copy-paste API examples, webhook setup, and a one-click smoke test."
echo
echo -e "  ${YELLOW}${BOLD}⚠ This public URL is TEMPORARY${RESET}${YELLOW} — a free Quick Tunnel whose address"
echo -e "     changes on every restart. For production, point a stable ${BOLD}subdomain${RESET}${YELLOW} at the"
echo -e "     Hub with a Cloudflare Named Tunnel:${RESET}"
echo -e "       ${CYAN}sudo $INSTALL_DIR/deploy/cloudflared-setup.sh named${RESET}   (guide: ${CYAN}docs/SUBDOMAIN.md${RESET})"
echo
echo -e "  ${BOLD}Logs:${RESET}             journalctl -u wa-hub -f"
echo -e "  ${BOLD}Tunnel logs:${RESET}      journalctl -u cloudflared-wahub -f"
echo
echo -e "${GREEN}${BOLD}════════════════════════════════════════════════════════════════${RESET}"
