# Connect a stable subdomain (Cloudflare Named Tunnel)

The installer gives you a free **Quick Tunnel** URL (`https://<random>.trycloudflare.com`) so you can
pair and try the API in minutes. That URL is **temporary** — it changes every time `cloudflared`
restarts (a reboot, a crash, an update). That's fine for a demo, but unusable for anything ongoing:
the moment it changes, every webhook, integration, and saved link breaks.

For real use, put the Hub behind a **stable subdomain on your own domain** (e.g.
`wa.yourdomain.com`) with a Cloudflare **Named Tunnel**. You keep all the upsides of the Quick Tunnel
— still **no open inbound ports**, still **free**, automatic HTTPS — but the URL never changes.

```
 WhatsApp  ⇄  your phone        Internet ──HTTPS──▶  wa.yourdomain.com  (Cloudflare edge)
                                                            │  Named Tunnel (outbound, TCP/http2)
                                                            ▼
                                              cloudflared  ──▶  127.0.0.1:3060  (wa-hub, loopback)
```

---

## Prerequisites

1. **A domain on Cloudflare.** The domain's DNS must be managed by Cloudflare (the free plan is
   enough). If it isn't yet:
   - Add the site at <https://dash.cloudflare.com> → *Add a site*.
   - Change your registrar's nameservers to the two Cloudflare gives you.
   - Wait until the zone shows **Active** (minutes to a few hours).
2. **wa-hub already installed and running** on the server:
   ```bash
   systemctl is-active wa-hub          # → active
   curl -s http://127.0.0.1:3060/healthz   # → {"ok":true,...}
   ```
3. **Root / sudo** on the server.

---

## The easy way — the bundled script

```bash
sudo /srv/wa-hub-demo/deploy/cloudflared-setup.sh named
```

It walks you through everything:

1. **Login** — it prints a URL. Open it in **any** browser (on any device), log in, and pick the
   domain you want to use. This authorizes `cloudflared` and is a one-time step.
2. **Tunnel name** — e.g. `wa-hub`.
3. **Hostname** — the subdomain to expose, e.g. `wa.yourdomain.com`.

The script then creates the tunnel, writes `/etc/cloudflared/config.yml` (with **`protocol: http2`** —
see note below), routes the DNS record, installs a `cloudflared` systemd service, and **disables the
temporary Quick Tunnel** so you're not running both.

**Verify:**
```bash
curl https://wa.yourdomain.com/healthz       # → {"ok":true,"connection":...}
```
Then open the console / pair page on your stable URL:
```
https://wa.yourdomain.com/pair#<YOUR_HUB_TOKEN>
```

---

## The manual way (understand each step)

```bash
# 1. Authenticate cloudflared with your Cloudflare account (opens a browser URL).
cloudflared tunnel login

# 2. Create a named tunnel (writes a credentials JSON under ~/.cloudflared/<id>.json).
cloudflared tunnel create wa-hub
cloudflared tunnel list                       # note the Tunnel ID (UUID)

# 3. Config file. Move the credentials somewhere the system service can read,
#    and force http2 (TCP) so a UDP-blocked network can't kill the tunnel.
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/<TUNNEL_ID>.json /etc/cloudflared/<TUNNEL_ID>.json
sudo tee /etc/cloudflared/config.yml >/dev/null <<'YAML'
tunnel: <TUNNEL_ID>
credentials-file: /etc/cloudflared/<TUNNEL_ID>.json
protocol: http2
ingress:
  - hostname: wa.yourdomain.com
    service: http://127.0.0.1:3060
  - service: http_status:404
YAML

# 4. Create the DNS record (a CNAME wa → <id>.cfargotunnel.com).
cloudflared tunnel route dns wa-hub wa.yourdomain.com

# 5. Run it as a service.
sudo cloudflared service install
sudo systemctl enable --now cloudflared

# 6. Stop the temporary Quick Tunnel so only the named one runs.
sudo systemctl disable --now cloudflared-wahub.service

# 7. Verify.
curl https://wa.yourdomain.com/healthz
```

> **Why `protocol: http2`?** `cloudflared` defaults to QUIC (outbound **UDP 7844**), which many
> networks, ISPs, and clouds silently drop — and it does **not** fall back to TCP. The tunnel then
> registers but never carries traffic (the URL looks valid but is dead). `http2` runs the edge
> connection over **TCP**, which is open virtually everywhere. This is the same fix the Quick Tunnel
> unit ships with.

---

## After switching

- **Pair / console:** `https://wa.yourdomain.com/pair#<HUB_TOKEN>` — the live QR, and after linking the
  console (smoke test, API examples, webhook setup).
- **Update consumers:** anything that pointed at the old `*.trycloudflare.com` URL — your API base URL
  in code, and any service you told to call the Hub — should now use `https://wa.yourdomain.com`.
- The subdomain is **stable across reboots and restarts** — no more changing URLs.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `curl` to the subdomain hangs / `error 1033` | DNS not routed. Re-run `cloudflared tunnel route dns <name> <host>` and check the CNAME `wa → <id>.cfargotunnel.com` in the Cloudflare DNS dashboard. |
| `error 502` / `1016` from the edge | Tunnel is up but the origin isn't reachable: `systemctl status wa-hub`, confirm it listens on `127.0.0.1:3060`. |
| `cloudflared` keeps logging `Failed to dial ... quic` | UDP 7844 is blocked. Make sure `protocol: http2` is in `/etc/cloudflared/config.yml`, then `systemctl restart cloudflared`. |
| Both tunnels seem to run | Disable the Quick one: `sudo systemctl disable --now cloudflared-wahub.service`. |
| Logs | `journalctl -u cloudflared -f` |

---

## Notes

- **One hostname per Hub instance.** Running several WhatsApp numbers means several wa-hub instances on
  different ports — give each its own `ingress` hostname (or its own subdomain) pointing at its port.
- **Zero-Trust (optional):** because the Hub is now on your domain, you can put a Cloudflare Access
  policy in front of `/pair` for an extra human-auth layer while leaving `/api/*` token-gated for
  machines. Out of scope here, but supported.

See also: [DEPLOY.md](DEPLOY.md) · [API.md](API.md).
