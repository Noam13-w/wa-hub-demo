# wa-hub-demo — Production Deployment Notes

> ⚠️ **Legal / ToS notice:** this deploys an *unofficial* WhatsApp client. It is not affiliated with WhatsApp/Meta and may violate their Terms of Service. You are solely responsible for messaging only consenting recipients and for complying with GDPR / CAN-SPAM / TCPA / local anti-spam law. No warranty; the author is not liable for bans or legal consequences. See [../DISCLAIMER.md](../DISCLAIMER.md).

Condensed operational reference. The full step-by-step (buy a VPS → live API in ~45 min, with
screenshots-level detail in Hebrew) is **[BUILD_GUIDE_HE.md](BUILD_GUIDE_HE.md)** — read that first if
you're starting from scratch. This file is the "I already know my way around a server" version.

## Install routes

| Route | Command | When |
|---|---|---|
| **Express** (one-liner) | `curl -fsSL https://raw.githubusercontent.com/Noam13-w/wa-hub-demo/main/deploy/install.sh \| bash` | Fast, on a fresh Ubuntu 24.04 box as root. ~3 min. |
| **Manual** | follow `deploy/install.sh` step by step | You want to understand each step (webinar / first time). |
| **Claude Code** | point an agent at the repo + your server IP | You'd rather supervise an AI doing it. |

All three install the **same** hardened `deploy/wa-hub.service`.

### Fresh box vs. existing server (host hardening)

The installer's **host-hardening** steps — `ufw --force reset` to deny-all-but-SSH, disabling SSH
password auth, and `apt dist-upgrade` — run **only when the box looks clearly fresh**. On a server
that already runs other services (active `ufw`, SSH on a non-22 port, or any non-loopback listener)
the installer auto-selects **safe mode** and modifies **none** of them. wa-hub binds loopback and is
reached via the **outbound** tunnel, so it needs no inbound ports regardless. Override the auto choice:

| Value | Effect |
|---|---|
| `WA_HUB_HARDEN=auto` | *(default)* full hardening only on a clearly-fresh box, else safe |
| `WA_HUB_HARDEN=full` | force fresh-box hardening (resets `ufw`, sshd password-auth off, dist-upgrade) |
| `WA_HUB_HARDEN=safe` | never touch the firewall / sshd / system upgrade — just install wa-hub |

```bash
# Example: install on an existing production server without touching its firewall
curl -fsSL https://raw.githubusercontent.com/Noam13-w/wa-hub-demo/main/deploy/install.sh | sudo WA_HUB_HARDEN=safe bash
```

## What the server ends up with

- Node 20, a `wahub` system user, the repo at `/srv/wa-hub-demo`, deps installed reproducibly (`npm ci --omit=dev --ignore-scripts`).
- `/srv/wa-hub-demo/.env` (`chmod 600`, owned by `wahub`) with random `HUB_TOKEN` + `WEBHOOK_SECRET`.
- `wa-hub.service` (REST `:3060`, WS `:3061`, loopback) — `Restart=always`, `MemoryMax=512M`.
- **Fresh box only:** `ufw` reset so only SSH is open, fail2ban active, SSH password-auth disabled. On an existing server these are left as-is.
- Cloudflare Tunnel exposing `:3060` over HTTPS (Quick or Named).

## Tunnel: Quick vs Named

- **Quick Tunnel** (`cloudflared tunnel --url http://127.0.0.1:3060`) — random `*.trycloudflare.com`
  URL that **changes on every restart**. Great for demos; runs as `cloudflared-wahub.service`.
- **Named Tunnel** — stable URL on your own domain (`wa.example.com`) that **survives restarts**. Use
  this for production. One command: `sudo deploy/cloudflared-setup.sh named`. Full walkthrough
  (prerequisites, manual steps, the required `protocol: http2`, troubleshooting) →
  **[SUBDOMAIN.md](SUBDOMAIN.md)**. After switching, update the URL anywhere you referenced the
  temporary one.

## Environment (`.env`)

| Var | Default | Notes |
|---|---|---|
| `HUB_NAME` | `wa-hub-demo` | Cosmetic label (shows in `/healthz`, `/status`, webhook UA, linked-device name). |
| `HUB_TOKEN` | — (required, ≥16 chars) | Bearer token. `openssl rand -hex 32`. |
| `WEBHOOK_SECRET` | — (required, ≥16 chars) | HMAC key for outbound webhooks. |
| `HUB_PORT` | `3060` | REST port. |
| `WS_PORT` | `3061` | WebSocket port. |
| `HUB_HOST` / `WS_HOST` | `127.0.0.1` | Bind address. Loopback by default (reachable only via the local tunnel). Set `0.0.0.0` to expose directly — then firewall it yourself. |
| `ADMIN_TOKEN` | — (optional) | When set, `POST /instance/logout` and `PUT /instance/webhook` also require an `X-Admin-Token` header (privilege separation from the send/read token). |
| `WEBHOOK_URL` | — | **Default** webhook target; a runtime `PUT /api/instance/webhook` (persisted to `data/webhook.json`) overrides it. |
| `WEBHOOK_EVENTS` | (all) | Comma-separated event filter, e.g. `message.incoming,message.outgoing`. |
| `RATE_LIMIT_PER_MIN` | `120` | Per-minute cap **per client IP**; `0` disables. |
| `TRUST_PROXY` | `false` | Trust `CF-Connecting-IP`/`X-Forwarded-For` for the rate-limit key. **Set `true` behind the Cloudflare Tunnel** (the installer does this). |
| `MEDIA_CONCURRENCY` | `4` | Max concurrent media sends (bounds peak memory). |
| `WS_MAX_CLIENTS` | `64` | Max simultaneous WebSocket clients. |
| `ALLOW_PRIVATE_EGRESS` | `false` | Allow webhook/media fetches to private/loopback/metadata IPs. Keep `false` to block SSRF. |
| `ALLOW_QUERY_TOKEN` | `false` | Accept `?token=` on REST routes (leaks into logs). Header auth is always on. |
| `WS_ALLOWED_ORIGINS` | (none) | Comma-separated Origin allowlist for browser WS clients. |
| `DATA_DIR` | `./data` | Holds `auth/` (session) + `webhook.json` + failure logs. |
| `LOG_LEVEL` | `info` | `trace…fatal`. |

## Operations

| Task | Command |
|---|---|
| Logs | `journalctl -u wa-hub -f` |
| Restart | `systemctl restart wa-hub` |
| Health | `curl -s http://127.0.0.1:3060/healthz` |
| Self-test | `curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3060/api/instance/diagnose` |
| Pair / re-pair | Open `<tunnel-url>/pair` in a browser (live, auto-refreshing QR). To re-pair: `POST /api/instance/logout`, then reload `/pair`. |
| Rotate token | edit `HUB_TOKEN` in `.env` → `systemctl restart wa-hub` → update consumers (~30 s downtime) |

## Monitoring & backup

- **Uptime:** point Uptime Robot (or similar) at `…/healthz` — it's open and never 500s.
- **Memory:** the 5-min heartbeat logs RSS and WARNs past 80% of `MemoryMax`; systemd restarts on OOM.
- **Backup:** `data/auth/` *is* the WhatsApp session. `rsync` it (or all of `data/`) to S3/R2 daily so a
  disk loss doesn't force a re-pair. The `WEBHOOK_SECRET`/`HUB_TOKEN` belong in a password manager.

## Known operational notes

- **Linked-device 14-day timeout.** If the primary phone is offline for 14 days, WhatsApp unlinks all
  devices and you must re-pair. Keep the phone online at least every ~13 days.
- **`status=31/SYS` core-dump.** Only relevant if you re-add a `SystemCallFilter` to the unit; the shipped
  unit leaves it unset for Node 20 compatibility. If you hardened it and hit this, clear the filter via a
  drop-in (`/etc/systemd/system/wa-hub.service.d/syscall-fix.conf` → `[Service]\nSystemCallFilter=`).
- **High volume / multi-number.** One number = one instance. For several numbers, run multiple instances
  (separate ports / containers). See [ROADMAP.md](ROADMAP.md).

See also: [API.md](API.md) · [ARCHITECTURE.md](ARCHITECTURE.md).
