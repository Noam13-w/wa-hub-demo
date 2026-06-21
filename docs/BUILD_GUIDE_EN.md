**🌐 Language:** **English** · [עברית](BUILD_GUIDE_HE.md)

# Build Your Own Self-Hosted WhatsApp Hub — Full Guide

> **What you'll have by the end of this guide:** a secured REST API that talks to
> WhatsApp, runs on your own server, is exposed to the internet sensibly, and talks
> to any platform you want — Base44, Bubble, Firebase, Make, Python, or anything
> that speaks HTTP.

> **Hands-on time:** ~45 minutes. **Cost:** €3.79–€3.99 per month (Hetzner CAX11 or CX23).
> **License:** MIT. **Source code:** [github.com/Noam13-w/wa-hub-demo](https://github.com/Noam13-w/wa-hub-demo)

> ⚠️ **Disclaimer — read before you deploy.** This project is **not affiliated with, endorsed by, or sponsored by WhatsApp or Meta.** It uses the unofficial, reverse-engineered [Baileys](https://github.com/WhiskeySockets/Baileys) library and connects by impersonating a WhatsApp "linked device" — which **may violate WhatsApp's Terms of Service** and can get the connected number **banned** at Meta's sole discretion, especially for bulk or unsolicited messaging. Provided **"as is", no warranty.** **You alone are responsible** for messaging only people who gave prior opt-in consent and for complying with all applicable law (GDPR, CAN-SPAM, TCPA, Israel's §30A "Spam Law", etc.). Not legal advice. See **[DISCLAIMER.md](../DISCLAIMER.md)**.

---

## Table of Contents

1. [What Are We Building?](#what-are-we-building)
2. [Checklist of What You Need Before You Start](#checklist-of-what-you-need-before-you-start)
3. [Step 1 — Buying a Hetzner Server](#step-1--buying-a-hetzner-server)
4. [Step 2 — First SSH Connection](#step-2--first-ssh-connection)
5. [Step 3 — Choosing a Route](#step-3--choosing-a-route)
6. [Step 4 — Route A: Manual Installation](#step-4--route-a-manual-installation)
7. [Step 4 Alternative — Route B: With Claude Code](#step-4-alternative--route-b-with-claude-code)
8. [Step 5 — WhatsApp Pairing](#step-5--whatsapp-pairing)
9. [Step 6 — Exposing to the Internet with Cloudflare Tunnel](#step-6--exposing-to-the-internet-with-cloudflare-tunnel)
10. [Step 7 — Using It From Any System](#step-7--using-it-from-any-system)
11. [Step 8 — Connecting Through a vibe-coding System](#step-8--connecting-through-a-vibe-coding-system)
12. [Step 9 — Safe Sending: Avoiding a WhatsApp Ban](#step-9--safe-sending-avoiding-a-whatsapp-ban)
13. [Step 10 — Production Security](#step-10--production-security)
14. [Step 11 — Connecting an AI Model](#step-11--connecting-an-ai-model)
15. [Tips From the Field](#tips-from-the-field--things-you-wont-find-in-the-docs)
16. [Common Troubleshooting](#common-troubleshooting)
17. [FAQ](#faq)
18. [Appendix — Quick Emergency Guide](#appendix--quick-emergency-guide)

---

## What Are We Building?

<div class="arch-diagram"><div class="arch-row"><div class="arch-card"><div class="arch-icon">📱</div><div class="arch-title">Your Phone</div><div class="arch-body"><div class="arch-line-bold">WhatsApp</div><div class="arch-sub">pairing via QR</div></div></div><div class="arch-conn"><div class="arch-conn-line"></div><div class="arch-conn-label">WhatsApp Web<br/>protocol</div></div><div class="arch-card arch-primary"><div class="arch-icon">🖥️</div><div class="arch-title">Hetzner Server</div><div class="arch-subtitle"><span dir="ltr">€3.79 / mo</span></div><div class="arch-mono"><div><span dir="ltr">wa-hub-demo (Node 20)</span></div><div><span dir="ltr">├ Baileys</span></div><div><span dir="ltr">├ REST :3060</span></div><div><span dir="ltr">├ WS :3061</span></div><div><span dir="ltr">└ Webhook → HMAC</span></div></div><div class="arch-footer">loopback only · blocked by ufw</div></div><div class="arch-conn"><div class="arch-conn-line"></div><div class="arch-conn-label">Cloudflare<br/>Tunnel (HTTPS)</div></div><div class="arch-card"><div class="arch-icon">🔌</div><div class="arch-title">Any App</div><div class="arch-body"><div>Base44</div><div>Bubble · Webflow</div><div>Firebase</div><div>Make · n8n · Zapier</div><div>Python · PHP</div><div>Apps Script</div></div></div></div><div class="arch-flowlegend"><div class="arch-flow-item"><span class="arch-flow-num">1</span>The phone opens an encrypted connection to the server (WhatsApp protocol).</div><div class="arch-flow-item"><span class="arch-flow-num">2</span>The server runs <span dir="ltr">wa-hub-demo</span>, which wraps the protocol in a REST API.</div><div class="arch-flow-item"><span class="arch-flow-num">3</span>External apps talk to the API over encrypted traffic through Cloudflare Tunnel.</div></div></div>

### What it is:

- **A simple HTTP API** on top of the WhatsApp Web protocol. POST to send, Webhook to receive. Nothing complicated.
- **Full ownership** — your code, your server, your token, your messages.
- **Fixed cost** — €3.79 per month, all month, regardless of whether you sent 10 or a million messages.
- **Open source** (MIT) — take it apart, modify it, publish it, sell it.

### The code you'll install

The `wa-hub-demo` project is open source, available at **[github.com/Noam13-w/wa-hub-demo](https://github.com/Noam13-w/wa-hub-demo)**. It includes:

- **A Baileys layer** that handles the WhatsApp Web protocol (connection, pairing, automatic reconnection, message normalization)
- **A REST API** in Express with over 20 endpoints — sending text/image/file/audio/location/reaction, pairing, status, webhook management, group management, checking whether a number is registered on WhatsApp
- **A WebSocket server** that broadcasts real-time events (`message.incoming`, `message.outgoing`, `message.status` with the blue checkmark)
- **Outbound webhooks** with an HMAC-SHA256 signature for verification
- **Bearer auth** with constant-time comparison + rate-limit
- **Handling of Baileys 7+ LIDs** (the `senderPn`/`participantPn`/`remoteJidAlt` fields, used to extract the real phone number)
- **A hardened systemd unit** with `NoNewPrivileges`, `ProtectSystem=strict`, an empty `CapabilityBoundingSet=`, and `MemoryMax=512M`
- **Full API documentation** in `docs/API.md` and `docs/ARCHITECTURE.md`

It's all MIT — you can do whatever you want with it.

### What it is not:

- **Not official from Meta.** WhatsApp doesn't provide a direct API like this. We impersonate a Linked Device.
  It works because the protocol is public, but if you push 10K spam messages a day through your code —
  WhatsApp will ban the number. Use it only for messages someone asked for.
- **Not multi-tenant out-of-the-box.** One number = one server = one instance. If you want
  to serve several clients, each client gets a separate instance (see "Next Steps").
- **Not plug-and-play with Meta's WhatsApp Cloud API.** That's something else — it's Meta's, requires
  business approval, and involves per-message billing. The two worlds don't overlap.

### Who this guide is for:

- **Developers** who want full control over their WhatsApp stack
- **No-code builders** (Base44, Bubble, Webflow) who want to connect WhatsApp without buying a plugin
- **Automation people** (Make, n8n, Zapier) who need a reliable integration
- **Small businesses** that prefer paying a fixed €3.79 per month instead of $0.05 per message

---

## Checklist of What You Need Before You Start

- [ ] A credit card (Hetzner charges €3.79 in the first month)
- [ ] A phone with an active WhatsApp (to add as a Linked Device)
- [ ] A GitHub account (free, for cloning the code)
- [ ] A Cloudflare account (free, optional — for the Tunnel)
- [ ] A terminal (Mac/Linux: built in. Windows: PowerShell or WSL)

---

## Step 1 — Buying a Hetzner Server

### 1.1 Sign up

Go to [hetzner.com/cloud](https://www.hetzner.com/cloud) and click "Sign Up".

> **Why Hetzner?** The best price/performance ratio in Europe. €3.79 per month = 2 vCPU + 4GB
> RAM + 40GB SSD + 20TB traffic. Equivalent to an AWS t4g.medium at $25 per month.

### 1.2 Creating a project and billing

After verification:

1. Click **"+ New Project"** → give it a name (e.g. `wa-hub`)
2. In the left menu → **"Billing"** → enter your card details
3. In the left menu → **"Security"** → **"SSH Keys"** → **"Add SSH Key"**

### 1.3 Creating an SSH key (if you don't have one)

**Run a single command only:**

On **Mac / Linux / WSL**:

```bash
ssh-keygen -t ed25519 -C "my-laptop"
```

On **Windows PowerShell**:

```powershell
ssh-keygen -t ed25519 -C "my-laptop"
```

> **Important:** type the command **on its own**, without pasting additional lines after it. The command
> will ask you 3 interactive questions, and if you paste another line — it will accidentally be entered
> as the answer to one of them (this happens a lot).

The command will ask you 3 questions. **Press Enter for each one** (all the defaults are fine):

1. `Enter file in which to save the key` → Enter (default: `~/.ssh/id_ed25519`)
2. `Enter passphrase (empty for no passphrase)` → Enter (no passphrase for the key)
3. `Enter same passphrase again` → Enter (confirmation)

> **passphrase?** It encrypts the private key on disk (and you'll have to type it on every connection).
> If the computer is yours alone — Enter twice (no passphrase) is perfectly fine.

Now, **separately**, display the public key:

On **Mac / Linux / WSL**:

```bash
cat ~/.ssh/id_ed25519.pub
```

On **Windows PowerShell**:

```powershell
Get-Content $HOME\.ssh\id_ed25519.pub
```

Copy the entire line that was printed (it starts with `ssh-ed25519`) → paste it into Hetzner →
give it an identifying name (e.g. `laptop`) → save.

> **`-C` is just a label** for identifying the key — it's not mandatory and adds no security. Give it a name
> that helps you identify it (`my-laptop`, `office-mac`).

### 1.4 Ordering the server

1. In the left menu → **"Servers"** → **"+ Add Server"**
2. **Location:** Falkenstein (Germany — the closest to Israel in terms of ping, ~60ms). If it's not there — Nuremberg is also Germany and works at the same quality.
3. **Image:** Ubuntu **24.04** LTS (26.04 LTS works too, but it's new as of 2026/04 and less battle-tested. 24.04 is good for 5 years ahead and was tested in depth for this guide.)
4. **Type:** pick one of these two (both work identically — depends on what's available on the site at that moment):
   - **CX23** (x86 / Intel-AMD) — €3.99 per month · available in all locations
   - **CAX11** (ARM / Ampere) — €3.79 per month · available only in certain locations (currently Nuremberg / Helsinki). If the **"Arm64 (Ampere)"** tab exists — great, otherwise use CX23.
5. **Networking:** leave the default (IPv4 + IPv6)
6. **SSH keys:** select the key you added
7. **Volumes / Firewalls / Backups:** skip (not needed)
8. **Name:** `wa-hub-demo` (or whatever you like)
9. Click **"Create & Buy now"**

Within **30 seconds** the server will be ready. Note the IPv4 address — you'll need it.

> **CX23 vs CAX11 — what's the difference in practice?** Zero as far as our code is concerned. Both run Node 20
> with no difference. CAX11 is a little more energy-efficient and €0.20 cheaper. CX23 is a little more available
> and in more locations. **Take whatever is available in the location closest to you — it doesn't matter.** ARM
> availability changes from time to time because Hetzner manages inventory based on demand.

---

## Step 2 — First SSH Connection

This is the step a lot of people get stuck on the first time. We'll go slowly. **You won't need to paste your
key anywhere in this step** — we already pasted it into Hetzner in step 1.3, and that's
what's needed. The SSH client on your machine will find the private key on its own at `~/.ssh/id_ed25519`
and use it.

### 2.1 — Finding the server's IP

In the Hetzner Cloud panel → your server → under **"IPv4"** you'll see an address like
`203.0.113.42`. **Copy it** — you'll need it in a moment.

### 2.2 — Opening a terminal

- **Mac:** Cmd+Space → type `Terminal` → Enter
- **Linux:** Ctrl+Alt+T (depends on the distribution)
- **Windows:** Start → type `PowerShell` → Enter
  - Windows 10/11 includes `ssh` built in. No need to install anything.

### 2.3 — Connecting

Type (replace `203.0.113.42` with your IP):

```bash
ssh root@203.0.113.42
```

**The first time**, a message will appear:

```
The authenticity of host '203.0.113.42 (...)' can't be established.
ED25519 key fingerprint is SHA256:...
Are you sure you want to continue connecting (yes/no/[fingerprint])?
```

Type **`yes`** and Enter. This is just a one-time question — SSH is saying "I haven't seen this server
before, are you sure it's the right one?"

### 2.4 — You're in

If everything is fine, you'll see:

```
Welcome to Ubuntu 24.04 LTS (GNU/Linux 6.8.0-XX-generic x86_64)
root@wa-hub-demo:~#
```

The `#` at the end of the line means you're connected as root on the server. Everything you type from here will run
**on the server in Germany**, not on your machine.

### 2.5 — A quick check that the server is alive

```bash
lsb_release -d
```

```bash
free -h
```

```bash
curl -fsSL ifconfig.me; echo
```

The first tells you the Ubuntu version, the second how much memory, the third confirms there's internet (it prints your IP — the same one you pasted above).

### 2.6 — If you couldn't connect

<details>
<summary><b>Message: <code>Permission denied (publickey)</code></b></summary>

This means the SSH key wasn't found or is invalid:

- Make sure that in Hetzner you selected the SSH key when creating the server. If you forgot → you'll need to reset.
- Make sure you created the key with `ssh-keygen` (step 1.3) and that the key exists: `ls ~/.ssh/id_ed25519` (Mac/Linux) or `ls $HOME\.ssh\id_ed25519` (PowerShell).
- If the key exists and the failure persists — wait 30 seconds (sometimes Hetzner needs time to inject the key into the server) and try again.

</details>

<details>
<summary><b>You forgot to add an SSH key when creating the server</b></summary>

From the Hetzner panel:

1. Go into the server → **"Rescue"** → reset the root password
2. Log in with the password you received: `ssh root@<IP>` and type the password
3. Paste your public key into the file `~/.ssh/authorized_keys`:

```bash
mkdir -p ~/.ssh
echo "ssh-ed25519 AAAA... my-laptop" >> ~/.ssh/authorized_keys
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys
```

(Replace `ssh-ed25519 AAAA...` with the actual contents of your `~/.ssh/id_ed25519.pub`.)

From now on — you'll be able to log in with the key, without a password.

</details>

<details>
<summary><b>Message: <code>Connection refused</code> or <code>Connection timed out</code></b></summary>

- Make sure the server is actually running in the Hetzner panel (if its status is "starting" — wait a minute)
- Make sure you didn't copy the wrong IP (IPv6 looks different — you need IPv4)
- If you're on a restricted network (university, company) — port 22 is sometimes blocked there

</details>

---

## Step 3 — Choosing a Route

From here there are **three** ways to build the Hub:

| | **Route A** — Manual | **Route B** — Claude Code | **Route C** — Express |
|--|---|---|---|
| **Pace** | Slow, controlled | Fast | Instant (3 minutes) |
| **Learning** | You understand every line | You understand the flow | None — a black box |
| **Customization** | Easy | Easy (just ask Claude) | Edit manually afterward |
| **Recommended for** | First time / webinar | Third time onward | Production you trust |

> **Recommendation:** First time — go with Route A (manual) to understand every step. Once you're
> familiar with the process — Route C (one line) is the fast way to deploy.

### Route C — Express (the express option: a single line)

If you have a fresh Hetzner server (Ubuntu 24.04 as root) and the main thing is getting it working fast:

```bash
curl -fsSL https://raw.githubusercontent.com/Noam13-w/wa-hub-demo/main/deploy/install.sh | bash
```

The script does everything automatically:
- System updates + SSH hardening + ufw + fail2ban
- Node 20 + creating the `wahub` user + git clone + npm install
- Generating random secrets (`HUB_TOKEN`, `WEBHOOK_SECRET`)
- Installing `wa-hub.service` + a drop-in to fix Node 20's seccomp
- Cloudflare Tunnel + systemd unit
- Prints at the end: the **public URL**, **HUB_TOKEN**, **WEBHOOK_SECRET**, and ready-to-run commands for pairing + the first send

Execution time: **~3 minutes**. After it runs, jump to Step 5 (pairing).

> **Want to see what the script does before you run it?** The file is at [`deploy/install.sh` in the repo](https://github.com/Noam13-w/wa-hub-demo/blob/main/deploy/install.sh) — 130 readable lines, zero magic.

---

## Step 4 — Route A: Manual Installation

> All the commands below run **on the server** (after `ssh root@<IP>`).
> Instead of ten small steps, I split it into three large blocks, each of which stands on its own.

### A.1 — Hardening the server

Updates + locking down SSH + firewall + fail2ban in one run. ~3 minutes.

```bash
# updates
apt-get update && apt-get -y dist-upgrade && apt-get -y autoremove

# SSH — keys only, no passwords
sed -i 's/^#*PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#*PermitRootLogin .*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sshd -t && systemctl reload ssh

# Firewall — only SSH open to the internet
ufw allow 22/tcp comment 'SSH'
ufw default deny incoming && ufw default allow outgoing
yes | ufw enable

# fail2ban — blocks IPs that try to brute-force
apt-get install -y fail2ban
systemctl enable --now fail2ban
```

> **What we achieved:** a server you can't get into without your private key, and bots that try
> get locked out automatically after 3 attempts. The Hub itself isn't exposed — we'll handle that via the Tunnel
> in Step 6.

> **Don't be alarmed by the output:** this block prints a great many lines (`apt` logs every
> package it installs/upgrades). During fail2ban you'll see `SyntaxWarning: invalid escape
> sequence '\s'` — those are cosmetic Python warnings and don't affect anything.
> If at the end you have a `root@wa-hub-demo:~#` prompt — everything's fine. If you also saw
> `Pending kernel upgrade!` — it means there's a new kernel that will take effect at the next reboot, and there's
> no need to do anything about it now.

### A.2 — Installing Node, creating a service user, and cloning the code

```bash
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# service user (without --create-home, because git clone will create the directory afterward)
useradd --system --shell /usr/sbin/nologin --home-dir /srv/wa-hub-demo wahub

# clone the code as root (because /srv isn't writable by wahub), then transfer ownership
cd /srv
git clone https://github.com/Noam13-w/wa-hub-demo.git
chown -R wahub:wahub /srv/wa-hub-demo

# install packages (as wahub)
sudo -u wahub bash -c "cd /srv/wa-hub-demo && npm install --omit=dev"
```

> We used `npm install` because it's more forgiving with transitive dependencies (like
> `sharp`, which Baileys depends on). If you prefer the strict behavior of `npm ci`, make sure
> the `package-lock.json` is up to date: run `npm install` once locally, push, and then on the server
> you can use `npm ci`.

> **Why not `--create-home`?** The flag creates `/srv/wa-hub-demo` empty, and git
> then refuses to clone into a non-empty directory. The fix: create the user without
> a directory, git builds the directory during the clone as root, and then we assign it to wahub.

### A.3 — Secrets + running as an automatic service

```bash
# generate random secrets (256-bit)
HUB_TOKEN=$(openssl rand -hex 32)
WEBHOOK_SECRET=$(openssl rand -hex 32)

# show them once — save them in a password manager
echo "===== שמרו את הערכים האלה ====="
echo "HUB_TOKEN=$HUB_TOKEN"
echo "WEBHOOK_SECRET=$WEBHOOK_SECRET"
echo "================================"

# write .env
cat > /srv/wa-hub-demo/.env <<EOF
HUB_NAME=wa-hub
HUB_TOKEN=$HUB_TOKEN
WEBHOOK_SECRET=$WEBHOOK_SECRET
HUB_PORT=3060
WS_PORT=3061
RATE_LIMIT_PER_MIN=120
DATA_DIR=/srv/wa-hub-demo/data
LOG_LEVEL=info
EOF
chown wahub:wahub /srv/wa-hub-demo/.env
chmod 600 /srv/wa-hub-demo/.env

# create the data directory
mkdir -p /srv/wa-hub-demo/data
chown -R wahub:wahub /srv/wa-hub-demo/data

# install as a systemd service (always running, recovers automatically)
install -m 644 /srv/wa-hub-demo/deploy/wa-hub.service /etc/systemd/system/wa-hub.service
systemctl daemon-reload
systemctl enable --now wa-hub.service

# final check — should return JSON starting with {"ok":true,...}
# the "connection" field will be one of: disconnected / connecting / qr / connected (depending on timing)
sleep 6
curl -sS http://127.0.0.1:3060/healthz
```

> **The service is up!** systemd will bring it back within 5 seconds if it falls, runs with
> `MemoryMax=512M` to ensure that even a Baileys memory leak over time won't take down
> the server, and starts automatically on every boot.

---

## Step 4 Alternative — Route B: With Claude Code

If you want to skip all the hassle and let the AI do it:

### B.1 — Installing Claude Code on your machine

```bash
npm install -g @anthropic-ai/claude-code
claude login
```

### B.2 — Get into your server through Claude

Think of it as two terminals working in parallel: one SSH to the server, the other Claude Code on your machine.

On the local machine:

```bash
mkdir wa-hub-prep && cd wa-hub-prep
claude
```

And inside Claude, type:

```
המטרה שלי: על שרת Hetzner חדש (Ubuntu 24.04 — x86 או ARM, IP=<X.X.X.X>),
להתקין את הפרויקט https://github.com/Noam13-w/wa-hub-demo, להריץ אותו
כ-systemd service תחת משתמש wahub, ולהקים Cloudflare Quick Tunnel
שיחשוף אותו לאינטרנט.

תעבוד עם Bash דרך ssh root@<X.X.X.X>. תאשר איתי כל שלב לפני שאתה מבצע.
תתחיל באודיט מצב השרת.
```

Claude Code will go step by step, ask for confirmation on risky actions, and print the token
and the public URL at the end. About **10 minutes**.

> **How does Claude know what to do?** It reads the code and this guide. It doesn't guess —
> it sees the same steps you see, and carries them out.

---

## Step 5 — WhatsApp Pairing

The Hub is running, but it's not connected to any number yet. Now we'll connect it.

> **⏱ This is the tricky part:** the QR is valid for **60 seconds** and then it rotates. So you need to
> **prepare everything in advance** — phone open, PowerShell window ready — and then with one click on the server
> everything else runs quickly. The full sequence: ~10 seconds.

### 5.1 — Prepare everything in advance (before generating the QR!)

**(a) On the phone:** open WhatsApp → **Settings** → **Linked Devices** → **Link a Device**.
The camera will open and wait for something to scan. **Leave it open.**

**(b) On the local machine:** open a **new PowerShell window** (not on the server!). Type the
following command but **don't press Enter yet** — we'll run it at the right moment:

```powershell
scp root@<IP>:/tmp/qr.png $HOME\qr.png; Start-Process $HOME\qr.png
```

(Replace `<IP>` with your server's address. The Mac/Linux equivalent: `scp root@<IP>:/tmp/qr.png ~/qr.png && open ~/qr.png`.)

**(c) In the SSH window to the server**, also type here but **don't press Enter yet**:

```bash
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3060/api/instance/qr.png -o /tmp/qr.png
```

(Make sure you still have `$TOKEN` loaded. If you reopened SSH, first run:
`TOKEN=$(grep HUB_TOKEN /srv/wa-hub-demo/.env | cut -d= -f2)`)

> **Why `-f`?** If the QR isn't ready yet, the Hub returns 404. The `-f` flag makes curl
> fail loudly instead of saving an empty file (which would open as a broken image). If that happens — wait
> 3 seconds and run it again.

### 5.2 — The fast sequence

Now that everything's ready:

1. **In the SSH window** → **Enter** (curl saves the QR to `/tmp/qr.png`)
2. **In the PowerShell window** → **Enter** (scp downloads it, and Start-Process opens the image)
3. **On the phone** → scan the image that opened on the computer

Within 2-3 seconds you'll see `WhatsApp connected` in the server's log, and on the phone you'll see the device in the "Linked Devices" list.

> **If you missed the 60 seconds:** just run those 2 commands again (Enter in SSH → Enter in PowerShell).
> The Hub generates a new QR every 60 seconds automatically.

### 5.3 — Test: sending the first message

Send a test message **to your second number** (another phone you own, or a friend who agreed to receive it).
On the server — replace `972500000000` with the target number:

```bash
TOKEN=$(grep HUB_TOKEN /srv/wa-hub-demo/.env | cut -d= -f2)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"to":"972500000000","text":"שלום מה-WhatsApp Hub שבניתי! 🚀"}' \
     http://127.0.0.1:3060/api/messages/send/text
```

> **How do you know it worked?** The response from the API is the sign of success — you should get JSON like this:
>
> ```json
> {"ok":true,"id":"3EB0...","to":"972500000000@s.whatsapp.net","timestamp":1730000000000}
> ```
>
> `"ok":true` with an `id` = the message left the Hub. Within a second or two it'll also appear on the target phone.
>
> **Number format:** country code without `+` and without a leading `0`, then the number.
> Example — `0585802298` becomes `972585802298`.
>
> ⚠️ **Only send to numbers that agreed to receive messages from you.** Sending to random numbers is the
> fastest way to get your number banned (see the "Safe Sending: Avoiding a Ban" chapter).

### 5.4 — Resetting if you disconnected by accident (or on purpose)

If you disconnected the device from the phone (WhatsApp → Linked Devices → tap the device → Log Out),
the Hub will detect `loggedOut` and stop reconnecting (intentional behavior — we don't want it to try
coming back without your consent). You'll see in the log:

```
ERROR: Device was logged out from the phone. Clear /data/auth and re-pair.
```

**To reset and get a new QR:**

```bash
TOKEN=$(grep HUB_TOKEN /srv/wa-hub-demo/.env | cut -d= -f2)
curl -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3060/api/instance/logout
```

This deletes `data/auth`, restarts Baileys, and within 3-4 seconds there's a new QR. Afterward,
go back to step 5.1 to re-scan.

> **Why don't they reconnect automatically?** Intentionally. If the main phone decided it no longer wants this
> device, we want you to consciously confirm that it was an accident and not someone external who took over. The same
> thing happens with `connectionReplaced` (code 440) — so two sessions don't endlessly conflict
> with each other.

---

## Step 6 — Exposing to the Internet with Cloudflare Tunnel

Until now the API has been running only locally (`127.0.0.1`). Base44 / any external app
can't reach it. Let's route it outward — without opening a port at all.

### 6.1 — Installing cloudflared

```bash
ARCH=$(dpkg --print-architecture)  # returns automatically: amd64 for CX23, arm64 for CAX11
curl -fsSL -o cloudflared.deb \
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH.deb"
dpkg -i cloudflared.deb
cloudflared --version
```

### 6.2 — Quick Tunnel (random URL, no account)

Easiest for a demo:

```bash
cloudflared tunnel --url http://127.0.0.1:3060
```

Within 5 seconds you'll see:

```
Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):
https://soft-clouds-rapidly-eat.trycloudflare.com
```

That's your public URL. **Check it from another machine:**

```bash
curl https://soft-clouds-rapidly-eat.trycloudflare.com/healthz
```

> **Quick Tunnel downside:** the URL is random and changes on every restart. If the server
> falls and comes back up — you have to update the URL everywhere that uses it. **Great for a demo**,
> less so for production.

### 6.3 — Quick Tunnel as a systemd service (so it won't fall)

So that the Tunnel stays alive even after the terminal is closed:

```bash
cat > /etc/systemd/system/cloudflared-wahub.service <<'EOF'
[Unit]
Description=Cloudflare Quick Tunnel for wa-hub
After=network-online.target wa-hub.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3060
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
DynamicUser=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now cloudflared-wahub.service

# wait 6 seconds, then pull the URL from the log:
sleep 6
journalctl -u cloudflared-wahub.service -n 30 --no-pager | \
  grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1
```

### 6.4 — Named Tunnel (a permanent URL on your own domain)

For **production**, you want a stable URL like `https://api.yourdomain.com` instead of `hughes-random-words.trycloudflare.com`, which changes on every restart.

#### What you need before you start

- **A domain** (from Namecheap, GoDaddy, Cloudflare Registrar, or any other registrar). Even a cheap $10/year domain works.
- **The domain managed in Cloudflare DNS.** If you bought it at Cloudflare — automatic. If elsewhere — you need to add the domain to Cloudflare and update the nameservers. Guide: [developers.cloudflare.com/dns/zone-setups/full-setup](https://developers.cloudflare.com/dns/zone-setups/full-setup/).

#### What to choose: a subdomain or the root?

**Recommended: a dedicated subdomain**, e.g. `api.yourdomain.com` or `wa.yourdomain.com`.

| | subdomain (`api.example.com`) | root (`example.com`) |
|---|---|---|
| Isolation from the main site | ✅ | ❌ |
| Can coexist with a wordpress site / etc. on the main server | ✅ | ❌ (requires a redirect) |
| Industry standard | ✅ | only for API-only projects |

In the examples below I'll use `api.example.com`. **Replace it with your own domain.**

#### Step by step

**1. cloudflared's initial login to your account:**

```bash
cloudflared tunnel login
```

It outputs a URL for the browser. Open it on your main machine, log in to Cloudflare, and pick your domain from the list. After approval — `~/.cloudflared/cert.pem` is written on the server.

**2. Creating a named tunnel:**

```bash
cloudflared tunnel create wa-hub
```

The output will look something like:
```
Created tunnel wa-hub with id 4f7c9d3e-abcd-1234-5678-90abcdef1234
```

**Save this tunnel ID.** We call it `<TID>` throughout the instructions.

**3. DNS routing — connecting the subdomain to the tunnel:**

```bash
cloudflared tunnel route dns wa-hub api.example.com
```

(Replace `api.example.com` with your subdomain.) **This command automatically creates a CNAME record in Cloudflare** that points traffic into the tunnel — you **don't need** to open Cloudflare and do it manually.

> If you want more subdomains on the same tunnel (e.g. also `wa.example.com` or `api.example.co.il`), just run this command again for each one.

**4. Tunnel configuration — which traffic gets routed where:**

```bash
mkdir -p /etc/cloudflared
```

```bash
nano /etc/cloudflared/config.yml
```

Paste (replace `<TID>` with your tunnel ID, and `api.example.com` with your subdomain):

```yaml
tunnel: <TID>
credentials-file: /root/.cloudflared/<TID>.json

ingress:
  - hostname: api.example.com
    service: http://127.0.0.1:3060
  - service: http_status:404
```

Explanation of the `ingress` block:
- Every request to the address `api.example.com` goes to your Hub at `127.0.0.1:3060` ✓
- Every other request gets a 404 (the default fallback — mandatory!)

Save (`Ctrl+O`, `Enter`, `Ctrl+X` in nano).

**5. If you already have a Quick Tunnel running as systemd — stop it:**

```bash
systemctl disable --now cloudflared-wahub.service 2>/dev/null
```

(Otherwise you'll have 2 tunnels conflicting on the same port.)

**6. Installing the official cloudflared as a systemd service:**

```bash
cloudflared service install
```

The CLI installs itself as systemd under the name `cloudflared.service`. It will automatically read `/etc/cloudflared/config.yml`.

**7. Starting and checking:**

```bash
systemctl enable --now cloudflared
```

```bash
sleep 5 && systemctl status cloudflared --no-pager
```

You should see `active (running)`. Error log:

```bash
journalctl -u cloudflared -n 50 --no-pager
```

**8. Checking from an external machine:**

```bash
curl https://api.example.com/healthz
```

It should return `{"ok":true, ...}`. If it does — **you did it**! Your Hub is now available
at `https://api.example.com` permanently, behind Cloudflare (DDoS protection and SSL — all automatic, free).

#### Environment updates after switching to a Named Tunnel

- **If you registered a webhook with the Hub** (via `PUT /api/instance/webhook`) — the setting is already saved
  in `data/webhook.json` and survives a restart; there's no need to edit `.env`. To change it, run a new PUT.
- **Everywhere you used the temporary Tunnel URL** (Base44 secrets, Bubble API config, etc.) —
  replace it with `https://api.example.com`. This won't change anymore.

> **Tip:** the same tunnel can serve several apps in parallel — add more
> `hostname`/`service` pairs under `ingress` (each subdomain to its own port), and keep
> `- service: http_status:404` as the last line.

---

## Step 7 — Using It From Any System

Your API is **REST + JSON + Bearer auth** — the most boring standard in the world. And that's the advantage.
Any platform that knows how to make an HTTP request can talk to it.

> **In all the examples:**
> - `HUB_URL` = your Tunnel's public URL
> - `HUB_TOKEN` = the Bearer from `.env`
> - Keep them **only server-side / in secrets**, never in the browser's JS

### 7.1 — Bubble

In Bubble Plugins → **API Connector**:

1. **Add another API** → name it `WhatsApp Hub`
2. **Authentication:** `Private key in header`
3. **Key name:** `Authorization` · **Key value:** `Bearer <HUB_TOKEN>`
4. **Add call:**
   - Name: `Send Text`
   - Method: `POST`
   - URL: `<HUB_URL>/api/messages/send/text`
   - Body type: `JSON`
   - Body: `{"to":"<to>","text":"<text>"}`
   - Mark `to` and `text` as parameters

In a workflow: `When Button "Send" is clicked → API call WhatsApp Hub Send Text`.

### 7.2 — Firebase Cloud Functions

```javascript
// functions/index.js
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const HUB_TOKEN = defineSecret("HUB_TOKEN");
const HUB_URL = "https://your-tunnel.trycloudflare.com";

exports.sendWa = onRequest({ secrets: [HUB_TOKEN] }, async (req, res) => {
  const r = await fetch(`${HUB_URL}/api/messages/send/text`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HUB_TOKEN.value()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(req.body),
  });
  res.status(r.status).json(await r.json());
});
```

Inject the secret: `firebase functions:secrets:set HUB_TOKEN`.

### 7.3 — Make / n8n / Zapier

**Sending:**

1. Add an `HTTP Request` module (Make) / `HTTP Node` (n8n) / `Webhooks by Zapier`
2. **URL:** `<HUB_URL>/api/messages/send/text`
3. **Method:** `POST`
4. **Headers:** `Authorization: Bearer <HUB_TOKEN>` + `Content-Type: application/json`
5. **Body:** `{"to":"+972...","text":"hi"}`

**Receiving a webhook:**

1. Create a Webhook in Make/n8n/Zapier → you'll get a URL
2. Register it with the Hub:

```bash
curl -X PUT -H "Authorization: Bearer $HUB_TOKEN" \
     -H "Content-Type: application/json" \
     -d "{\"url\":\"<your make/n8n webhook url>\",\"events\":[\"message.incoming\"]}" \
     $HUB_URL/api/instance/webhook
```

Every incoming message appears inside Make/n8n as an automatic trigger.

### 7.4 — Node.js / Next.js

```javascript
// app/api/send-wa/route.js (Next.js App Router)
export async function POST(req) {
  const { to, text } = await req.json();
  const r = await fetch(`${process.env.HUB_URL}/api/messages/send/text`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.HUB_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ to, text }),
  });
  return Response.json(await r.json(), { status: r.status });
}
```

### 7.5 — Python (FastAPI / Flask / Django)

```python
import os, requests

HUB_URL   = os.environ["HUB_URL"]
HUB_TOKEN = os.environ["HUB_TOKEN"]

def send_whatsapp(to: str, text: str):
    r = requests.post(
        f"{HUB_URL}/api/messages/send/text",
        headers={"Authorization": f"Bearer {HUB_TOKEN}"},
        json={"to": to, "text": text},
        timeout=15,
    )
    r.raise_for_status()
    return r.json()
```

Receiving a webhook (FastAPI):

```python
import hmac, hashlib, os
from fastapi import FastAPI, Request, HTTPException

app = FastAPI()
SECRET = os.environ["HUB_WEBHOOK_SECRET"]

@app.post("/wa/incoming")
async def incoming(req: Request):
    body = await req.body()
    got  = req.headers.get("x-hub-signature", "")
    want = "sha256=" + hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(got, want):
        raise HTTPException(401)
    event = await req.json()
    # ... your logic ...
    return {"ok": True}
```

### 7.6 — PHP / Laravel

```php
use Illuminate\Support\Facades\Http;

$r = Http::withToken(env('HUB_TOKEN'))
    ->post(env('HUB_URL') . '/api/messages/send/text', [
        'to'   => $to,
        'text' => $text,
    ]);
return response()->json($r->json(), $r->status());
```

### 7.7 — Google Sheets / Apps Script

```javascript
function sendWhatsApp(to, text) {
  const HUB_URL = PropertiesService.getScriptProperties().getProperty('HUB_URL');
  const HUB_TOKEN = PropertiesService.getScriptProperties().getProperty('HUB_TOKEN');
  return UrlFetchApp.fetch(`${HUB_URL}/api/messages/send/text`, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${HUB_TOKEN}` },
    payload: JSON.stringify({ to, text }),
  }).getContentText();
}

// send a message to every row in the sheet:
function bulkSend() {
  const rows = SpreadsheetApp.getActiveSheet().getDataRange().getValues();
  // ⚠️ Send ONLY to recipients who gave prior opt-in consent. Blasting a bought/scraped list
  // violates anti-spam law (GDPR/CAN-SPAM/TCPA) and will almost certainly get your number banned.
  rows.slice(1).forEach(([phone, message]) => sendWhatsApp(phone, message));
}
```

### 7.8 — Shell / cron

```bash
# /etc/cron.daily/wa-summary.sh
TOKEN=$(cat /etc/hub.token)
curl -X POST -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"to":"+972501234567","text":"Daily summary ready"}' \
     https://your-tunnel.trycloudflare.com/api/messages/send/text
```

> **The insight:** almost every no-code/low-code platform today knows how to do HTTP.
> Your Hub instantly turns each of them into a "WhatsApp provider", without buying another plugin
> or paying per-message.

---

## Step 8 — Connecting Through a vibe-coding System

Every "build-from-a-prompt" platform (Base44, Bolt, Lovable, v0, Cursor, Claude Code…)
can build the connection to the Hub for you from a single description. You paste one prompt, and it builds: the secret
(token), a send function, a webhook endpoint that verifies the HMAC signature, and a message log table.

### 8.1 — The prompt (once, in any system)

> **Security tip:** don't paste real secret values into the chat. Most platforms detect secret names
> and ask for them in a secure dialog. If not — set them manually in the platform's secret manager.

```
Build a WhatsApp connector for this app — no UI yet, just the plumbing.

SECRETS (store in the platform's secret manager, never hard-code):
  WA_HUB_URL    = my Hub's public URL, e.g. https://api.example.com
  WA_HUB_TOKEN  = bearer token for the Hub
  WA_HUB_SECRET = HMAC secret for verifying incoming webhooks

BACKEND FUNCTION  sendWhatsApp(to, text):
  POST `${WA_HUB_URL}/api/messages/send/text`
  header: Authorization: Bearer ${WA_HUB_TOKEN}
  body:   { to, text }        // `to` = bare digits + country code, e.g. 972585802298

PUBLIC WEBHOOK ENDPOINT (the Hub calls it from the internet):
  1. read the RAW request body as bytes BEFORE parsing JSON
  2. verify header `x-hub-signature` equals
     "sha256=" + HMAC_SHA256(WA_HUB_SECRET, rawBody)   // constant-time compare
     On edge/Deno runtimes use Web Crypto (`crypto.subtle`), NOT Node's Buffer.
  3. if valid and event === "message.incoming":
       save { direction:"incoming", text, from, ts } to a `messages` table
  4. ALWAYS return HTTP 200.

Don't build any pages yet — just the secrets, the two functions, and the log table.
I'll register the webhook URL on the Hub once it's deployed.
```

### 8.2 — What to build with it (ideas, not prompts)

Now that you have a connection, ask the system to build whatever you want. A few ideas:

- **A CRM** with a "Send WhatsApp" button on every customer card
- **A chat page** in the WhatsApp Web style that reads from the messages table, filtered by number
- **A bot that replies automatically** — see Step 11 (connecting AI)
- **A dashboard**: how many sent/received this week + connection status in real time
- **An order parser**: a message starting with "order" → creates an Order record and tags the team

### 8.3 — Registering the webhook with the Hub

After the endpoint is up, take its public URL and register it with the Hub (this enables the incoming direction):

```bash
TOKEN=$(grep HUB_TOKEN /srv/wa-hub-demo/.env | cut -d= -f2)
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"url":"https://your-app.example/webhook","events":["message.incoming","message.outgoing"]}' \
     http://127.0.0.1:3060/api/instance/webhook
```

> The two events: `message.incoming` (messages that reach you) and `message.outgoing` (also what
> you send from the phone). The setting is saved in `data/webhook.json` and survives a restart (see Tip #4).

> **If your system is Base44 (Deno runtime)** — three common pitfalls:
> 1. Verify HMAC with Web Crypto (`crypto.subtle`), not with `Buffer`/`timingSafeEqual` (crashes with a 500).
> 2. Writing to the DB from an anonymous webhook goes through `asServiceRole.entities.X` (not `.entities.X`).
> 3. `functions.invoke()` returns an axios wrapper — read `r.data.X` and not `r.X`.
>
> A full, ready-made example (TypeScript/Deno): [`examples/base44/webhook-receiver.ts` in the repo](https://github.com/Noam13-w/wa-hub-demo/tree/main/examples/base44).

---

## Step 9 — Safe Sending: Avoiding a WhatsApp Ban

WhatsApp doesn't like automated senders. They use algorithms that detect non-human
behavior and **ban numbers**. Managed commercial services typically implement protections like
this (delays, typing simulation, rate-limit-per-recipient, etc.).

**This Hub doesn't include those protections out of the box.** But that's not a problem — you can implement them
in the code that calls our API. Here are the important recipes:

### 9.1 — A random delay between messages

**The danger:** sending 100 messages without a break will certainly be detected as spam.
**The fix:** wait a random 3-15 seconds between messages.

```python
import random, time, requests

def send_safe(to, text):
    requests.post(f"{HUB_URL}/api/messages/send/text",
        headers={"Authorization": f"Bearer {HUB_TOKEN}"},
        json={"to": to, "text": text})
    # random 3-15 seconds — to mimic a human typing pace
    time.sleep(random.uniform(3, 15))

# ⚠️ Send ONLY to recipients who gave prior opt-in consent. Blasting a bought/scraped list
# violates anti-spam law (GDPR/CAN-SPAM/TCPA) and will almost certainly get your number banned.
for recipient, message in customers:
    send_safe(recipient, message)
```

### 9.2 — Typing simulation (typing indicator)

Before sending a long message, show "typing..." for a few seconds. This makes the message
look human. Our Hub doesn't expose a typing endpoint directly (because baileys does
this automatically in normal operation), but you can add a delay on your side:

```python
# wait as if you're typing — ~1 character per 100ms
delay = min(len(text) * 0.1, 8)  # max 8 seconds
time.sleep(delay)
send_safe(to, text)
```

### 9.3 — Rate limit per recipient

Never send more than 1 message per 30 seconds **to the same number**, and don't exceed the daily
quota appropriate for the number's age (see the warmup table in 9.4). Keep a table of "when I last sent to each number":

```python
last_sent = {}  # number -> timestamp

def send_safe_per_user(to, text):
    now = time.time()
    if to in last_sent and now - last_sent[to] < 30:
        wait = 30 - (now - last_sent[to])
        time.sleep(wait)
    send_safe(to, text)
    last_sent[to] = time.time()
```

### 9.4 — Warmup for new numbers

**A number that was just created/connected** isn't accustomed to traffic. Send fewer messages from it in the
first days:

| Days since connecting | Max outgoing messages per day |
|---|---|
| 1-3 | 10 |
| 4-7 | 30 |
| 8-14 | 100 |
| 15+ | 300+ |

### 9.5 — When to stop

WhatsApp gives warnings before a ban — your messages **aren't delivered with the double green checkmark**
but stay with a single checkmark for hours. If that happens — **stop sending immediately**, wait 24 hours,
and send at a significantly lower pace.

### 9.6 — Summary: rules of thumb

| Rule | Why |
|---|---|
| **Don't send to 100 numbers within 10 minutes** | Immediate spam detection |
| **Leave at least 30 seconds between messages to the same number** | Human |
| **Don't send to people who didn't ask to receive messages** | Spam reports from users — the #1 reason for a ban |
| **No more than 300 outgoing messages per day from a number 1+ days old** | WhatsApp's unofficial limit |
| **If a single checkmark stays for hours — stop!** | A warning sign before a ban |

> **Want an implementation inside the Hub?** It's on the roadmap (`docs/ROADMAP.md` in the repo). Feel
> free to open a PR or an issue on GitHub. In the meantime — your code is the right place to add
> these protections (more flexible to tailor to your needs).

---

## Step 10 — Production Security

Before you release this to the world:

| Check | Action |
|---|---|
| **HTTPS only?** | If you're using the Tunnel — yes, automatically |
| **Strong token?** | `openssl rand -hex 32` gives 256 bits — enough |
| **Rate limit?** | In the `.env` file: `RATE_LIMIT_PER_MIN=120`. Adjust as needed |
| **Webhook signed?** | The code signs with HMAC-SHA256. The other side **must** verify |
| **Server gets updated?** | `apt-get install -y unattended-upgrades` |
| **Monitoring?** | `journalctl -u wa-hub -f` + Uptime Robot on `/healthz` |
| **Backup?** | The `/srv/wa-hub-demo/data/auth` directory holds the session. `rsync` to S3/R2 once a day |
| **Secrets not in git?** | `.gitignore` already blocks `.env`. Make sure you didn't add it by accident |
| **Memory cap?** | The systemd unit includes `MemoryMax=512M`. On OOM it'll bring the service back automatically |

### 10.1 — Token rotation

If the Token leaked or you suspect it did:

```bash
NEW=$(openssl rand -hex 32)
sed -i "s/^HUB_TOKEN=.*/HUB_TOKEN=$NEW/" /srv/wa-hub-demo/.env
systemctl restart wa-hub
echo "$NEW"
```

Update it in Base44 secrets (or wherever you use it) — and that's it. 30 seconds of downtime.

### 10.2 — Memory over the long term

Baileys keeps chat history in RAM. On an instance with little traffic (fewer than 100
messages/day) this isn't a problem. On a more active instance, memory can climb.

**Protections already in place:**

- `syncFullHistory: false` in `src/baileys/socket.js` — we don't download all the old history
- `markOnlineOnConnect: false` — we save the traffic of "online" notifications
- `MemoryMax=512M` in the systemd unit — if it nonetheless swells beyond that, systemd will bring the service back (Baileys will reconnect)

**If you have especially high volume** (thousands of messages a day): consider reducing the cache
in Baileys, or splitting into multiple instances.

---

## Step 11 — Connecting an AI Model

If in the past you built a Node bot with Baileys and embedded the Gemini/GPT API directly inside it —
note the conceptual shift. Here the architecture **splits into two layers**:

- **The Hub** = a WhatsApp ↔ HTTP pipe only. It **deliberately doesn't know what AI is**.
- **Your "brain"** = the code that receives a message, thinks (calls the AI), and returns a reply.

The AI **doesn't go inside the Hub** — it sits in the code that receives the webhook. That's exactly the place
where you used to embed Google's API, except that now it's decoupled from the communication layer.

### 11.1 — The flow: where the AI comes in

```
1. מישהו שולח הודעה בוואטסאפ
2. ה-Hub קולט ויורה webhook  →  event: "message.incoming"
3. ה-webhook מגיע לפונקציה שלכם   ←──── כאן יושב ה-AI
4. הפונקציה קוראת ל-Gemini/Claude/GPT עם הטקסט
5. הפונקציה שולחת את התשובה חזרה:  POST {HUB_URL}/api/messages/send/text
6. ה-Hub שולח את התשובה לוואטסאפ
```

### 11.2 — Three places to put the function

| Place | When | Note |
|---|---|---|
| **A platform server function** (Base44 / Firebase) | "a function in the site", without an extra server | The AI runs inside the backend function that receives the webhook |
| **Your own Node server** | Closest to what you've done so far | Instead of `import Baileys` — `fetch` to the Hub. The Hub replaces Baileys |
| **An automation tool** (Make / n8n) | No code | webhook node → AI node → HTTP node back to the Hub |

### 11.3 — Example: a Node server with Gemini

A full AI chatbot. Note — this code **doesn't know Baileys at all**, it just speaks HTTP to the Hub:

```js
import express from "express";
import { createHmac } from "node:crypto";

const app = express();
const SECRET     = process.env.WA_HUB_SECRET;   // = WEBHOOK_SECRET מה-.env של ה-Hub
const HUB_URL    = process.env.WA_HUB_URL;       // https://api.example.com
const HUB_TOKEN  = process.env.WA_HUB_TOKEN;     // = HUB_TOKEN מה-.env
const GEMINI_KEY = process.env.GEMINI_API_KEY;

app.use(express.raw({ type: "*/*" }));           // גוף גולמי — צריך אותו לאימות החתימה

app.post("/wa", async (req, res) => {
  const body = req.body.toString("utf8");
  const expected = "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
  if (req.get("x-hub-signature") !== expected) return res.status(401).send("bad sig");

  res.sendStatus(200);                           // עונים מיד ל-Hub (אחרת ינסה שוב), וממשיכים ברקע

  const { event, data } = JSON.parse(body);
  if (event !== "message.incoming" || data.type !== "text") return;

  const reply = await askGemini(data.text);      // ←── כאן ה-AI

  await fetch(`${HUB_URL}/api/messages/send/text`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${HUB_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ to: data.from, text: reply }),
  });
});

async function askGemini(userText) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: userText }] }] }) });
  const j = await r.json();
  return j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "סליחה, לא הצלחתי לענות כרגע.";
}

app.listen(8080, () => console.log("AI brain on :8080"));
```

Register the `/wa` as a webhook with the Hub (`PUT /api/instance/webhook`), exactly as in step 7.3.
Want Claude instead of Gemini? Just replace `askGemini` with a call to `api.anthropic.com/v1/messages` — everything else is identical.

### 11.4 — Example: a Base44 function (without an extra server)

You already have a ready-made skeleton at [`examples/base44/webhook-receiver.ts`](https://github.com/Noam13-w/wa-hub-demo/tree/main/examples/base44) that returns "echo". Replace the echo with a call to the AI:

```ts
if (event.event === "message.incoming" && event.data.type === "text") {
  const reply = await askGemini(event.data.text as string);   // אותה askGemini מ-11.3
  await fetch(`${Deno.env.get("WA_HUB_URL")}/api/messages/send/text`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${Deno.env.get("WA_HUB_TOKEN")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ to: event.data.from, text: reply }),
  });
}
```

> **Can you push the AI straight into the Hub?** Technically yes (it's open Node). But **not recommended** —
> it brings you back to the mixing we tried to take apart. Keep the Hub "dumb" and a pipe-only, and keep
> the smarts on your side. That way an update to the Hub doesn't touch the AI logic, and you can swap models without
> touching the WhatsApp layer.

---

## Tips From the Field — Things You Won't Find in the Docs

### #1 — Baileys 7 and LID numbers

As of 2025, WhatsApp introduces the **LID (Logical ID)** — a unique identifier for each user
that doesn't expose their phone number. It's meant to prevent the harvesting of numbers via
mass-scraping.

```
לפני:  fromNumber = "972501234567"    fromLid = false   ← phone
אחרי:  fromNumber = "8362502693023"   fromLid = true    ← LID, מספר 13 ספרות מוזר
```

**The Hub handles this automatically:** the `extractPhone()` code tries to extract a real phone number
via `senderPn` → `participantPn` → `remoteJidAlt`. If there isn't one — it falls back to the LID.
A `fromLid: true/false` field signals to you what the original identifier was.

**If you're filtering by `fromNumber`** and notice you're filtering out too much — check `fromLid` in the payload.

### #2 — Base44 functions.invoke returns an axios wrapper

```javascript
const r = await base44.functions.invoke("foo", {});
// r = { data: <actual response>, status: 200, headers: {...} }
```

Read `r.data.X` and not `r.X`. If your code behaves as though a function is failing but
the network tab shows 200 OK — this is the reason.

### #3 — Base44 entities default to owner-only

Without an `rls` block in the schema, only the creator sees the record. Webhooks that come in as anon won't be able
to read, even via `asServiceRole` in a certain mode. Set `rls: { read: true, create: true, ... }`
or route all the reads through functions with a service role.

### #4 — Webhook config is saved automatically (not deleted on restart)

`PUT /api/instance/webhook` is **saved to disk** in `data/webhook.json` and survives a restart —
and this file **takes precedence** over what's in `.env`. That is, after a single PUT, there's no need to edit `.env`.

The `WEBHOOK_URL` / `WEBHOOK_EVENTS` in `.env` are used only as a default if you've never done a
PUT (i.e. there's no `data/webhook.json` yet):

```bash
WEBHOOK_URL=https://your-receiver.com/wa
WEBHOOK_EVENTS=message.incoming
```

To change the webhook after a PUT: run a new PUT, or delete `data/webhook.json` to revert to the default from `.env`.

### #5 — The Quick Tunnel URL is renewed on every restart

Great for a demo, a disaster for production. Switch to a Named Tunnel with your own domain the moment you
go from experiment to production.

### #6 — Linked Device timeout — 14 days

If the main phone hasn't been online for 14 days, WhatsApp disconnects all the Linked
Devices. You'll need to re-pair with a QR. If you want it to last longer — make sure the main
phone is connected to the network at least once every 13 days.

### #7 — Node.js 24 + Windows + a Hebrew path = a bug in base44 0.0.52

On Windows with a Hebrew username (like "נעם ניסן"), the latest version of the `base44` package
on npm fails when it does `cp` of assets. The fix:

```bash
npm install --save-dev base44@0.0.51
```

It's common to install it globally too:

```bash
npm install -g base44@0.0.51
```

(This will go away once they fix the bug, but as of writing this guide the problem exists.)

### #8 — `apt-get` zombie on cloud servers

I saw a Hetzner server where `apt-get update` stayed running for **11 days**, blocking all
of unattended-upgrades' update attempts. If security updates aren't taking effect — check:

```bash
ps -ef | grep apt-get | grep -v grep
# if you see a process from 3+ days ago — kill it:
kill -9 <PID>
rm -f /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/cache/apt/archives/lock
apt-get update
```

---

## Common Troubleshooting

<details>
<summary><b>The service is up but no QR appears</b></summary>

```bash
journalctl -u wa-hub -n 50 --no-pager
```

Look for `QR generated`. If it doesn't appear — check that there's an internet connection:

```bash
curl -sS https://web.whatsapp.com | head -1
```

</details>

<details>
<summary><b>"already paired" but you don't see the device on the phone</b></summary>

The Hub thinks it's connected but actually isn't. Reset:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
     http://127.0.0.1:3060/api/instance/logout
```

And request a new QR.

</details>

<details>
<summary><b>Messages aren't sending — <code>not_connected</code></b></summary>

In 95% of cases this is because the phone wasn't connected to the internet for more than 14 days, and the session
expired. Run the pairing process again from Step 5.

</details>

<details>
<summary><b>Cloudflare Tunnel keeps falling</b></summary>

```bash
systemctl status cloudflared-wahub   # Quick tunnel
systemctl status cloudflared         # Named tunnel
journalctl -u cloudflared-wahub -n 50 --no-pager
```

Usually it's a change in the URL (with a Quick Tunnel) — a restart will create a new URL. Save the new URL
and update it everywhere you used it.

</details>

<details>
<summary><b>The service crashes with <code>core-dump</code> · <code>status=31/SYS</code></b></summary>

This is SIGSYS — the systemd seccomp filter is blocking a syscall that Node 20+ needs (`io_uring`,
`clone3`). The log will show something like:

```
wa-hub.service: Main process exited, code=dumped, status=31/SYS
wa-hub.service: Failed with result 'core-dump'.
```

**Fix:** remove the SystemCallFilter via a drop-in:

```bash
mkdir -p /etc/systemd/system/wa-hub.service.d
printf '[Service]\nSystemCallFilter=\n' > /etc/systemd/system/wa-hub.service.d/syscall-fix.conf
systemctl daemon-reload && systemctl restart wa-hub.service
```

The rest of the protections (`NoNewPrivileges`, `ProtectSystem=strict`, etc.) remain in effect.

</details>

<details>
<summary><b>The webhook isn't reaching Base44 (200 OK in the Hub's log, but the entity is empty)</b></summary>

1. Look at the function's logs: `npx base44 logs --function whatsappWebhook --limit 20`
2. If you see an RLS error — make sure `whatsappmessage.jsonc` has `rls: { create: true, read: true, ... }`
3. If you see a signature error — check that `WA_HUB_SECRET` in Base44 secrets is exactly identical to `WEBHOOK_SECRET` in the server's `.env`

</details>

<details>
<summary><b>Messages come in, but <code>fromNumber</code> is a LID</b></summary>

See "Tip #1" above. The `fromLid: true` field signals that it's a LID. If you want the real
phone number — there's no way, WhatsApp doesn't expose it. Identify customers by
`chat` (the conversation's JID), which is stable over time.

</details>

---

## Next Steps

- **Want multi-tenant?** Add a tenants table to the DB → each customer gets a separate `instance_id` and port.
  Another option: run `wa-hub-demo` several times in containers on the same server.
- **Want automatic AI?** See Step 11 — a full chatbot in ~30 lines.
- **Want team notifications?** In `/api/instance/webhook` you can set a Slack/Discord webhook
  instead of (or in addition to) Base44.
- **Want a dashboard?** The WebSocket at `:3061` broadcasts every event in real time — connect a
  React/Vue/Svelte app. ⚠️ The WS requires the token in the query (`?token=...`), and tokens in a URL
  leak into Cloudflare's logs and the browser history — use a dedicated/short-lived token
  for the dashboard (not the main `HUB_TOKEN`), and serve the WS only behind the encrypted Tunnel.
- **Want daily summaries?** cron + `curl` in `/etc/cron.daily/`.

---

## Tools Worth Knowing

- **[Baileys](https://github.com/WhiskeySockets/Baileys)** — the library that does the WhatsApp Web magic
- **[Cloudflared](https://github.com/cloudflare/cloudflared)** — Tunnel
- **[Express](https://expressjs.com/)** — REST framework
- **[Hetzner Cloud](https://www.hetzner.com/cloud)** — recommended VPS
- **[Uptime Robot](https://uptimerobot.com/)** — free for monitoring 50 endpoints
- **[Cloudflare R2](https://www.cloudflare.com/products/r2/)** — cheap storage for backing up `data/auth`

---

## FAQ

**Q: Is this legal?**
A: You need to separate two questions. *Legal under the law* — legitimate use of your own account for requested
communication isn't an offense. *Allowed under WhatsApp/Meta's terms of use?* — no: this is an unofficial method
(impersonating a Linked Device), and Meta reserves the right to ban numbers, especially ones
that behave like spam. For high-volume / commercial sending — use Meta's official WhatsApp Cloud API.
Here: only send messages someone asked for (see the "Safe Sending" chapter).

**Q: Will the server handle the load?**
A: CX23 / CAX11 (4GB RAM) are good up to ~50 messages per second. If you expect more — upgrade to CX33 / CAX21
(8GB), or run several instances.

**Q: What happens if Hetzner goes down?**
A: In the last 12 months — uptime ~99.95%. For serious production, consider multi-region or
a fallback to another cloud.

**Q: What's the risk that my number gets banned?**
A: Low if you use it like a normal person — replies, summaries, and only to those who asked. High if
you do cold outreach or high volume. Stick to the limits in the "Safe Sending" chapter (as a rough
ceiling: up to ~300 outgoing messages per day from an established number, and far fewer from a new number — see the warmup table).

**Q: Is there Web Crypto instead of node:crypto?**
A: Yes — see the prompt in step 8.1 and the full example in `examples/base44/webhook-receiver.ts`,
for environments that don't support Node modules (Cloudflare Workers, Vercel Edge, Base44 Deno, etc.). Both solutions work identically for the HMAC signature.

**Q: Can I use the code commercially?**
A: Yes. MIT license — take it apart, modify it, publish it, sell it. If you feel like it, give the original project a mention.

---

## Appendix — Quick Emergency Guide

The five most common failures — and the one command that fixes each. Keep this page within reach.

| Failure | Sign in the field | Immediate fix (one line on the server) |
|---|---|---|
| **The Hub isn't running** | `curl 127.0.0.1:3060/healthz` returns connection refused | `systemctl restart wa-hub && journalctl -u wa-hub -n 20 --no-pager` |
| **The Tunnel's URL changed** | External requests suddenly get 530/1033 | `journalctl -u cloudflared-wahub -n 50 --no-pager \| grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' \| head -1` |
| **The QR expired before you scanned it** | "invalid code" on the phone | Repeat the 2 commands in §5.2 (Enter in SSH → Enter in PowerShell). The Hub has already generated a new one. |
| **`Device was logged out`** | The log screams `loggedOut`, no new QR | `TOKEN=$(grep HUB_TOKEN /srv/wa-hub-demo/.env \| cut -d= -f2); curl -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3060/api/instance/logout` |
| **The service crashes with `status=31/SYS`** | systemd: `code=dumped, status=31/SYS` | `mkdir -p /etc/systemd/system/wa-hub.service.d && printf '[Service]\nSystemCallFilter=\n' > /etc/systemd/system/wa-hub.service.d/syscall-fix.conf && systemctl daemon-reload && systemctl restart wa-hub` |

### A 60-second health checklist

1. SSH open to the server in one terminal, local PowerShell in a second terminal.
2. `TOKEN=$(grep HUB_TOKEN /srv/wa-hub-demo/.env | cut -d= -f2)` already ran in SSH.
3. `curl -sS http://127.0.0.1:3060/healthz` returns `{"ok":true}`.
4. The Tunnel URL is copied to the clipboard (`journalctl -u cloudflared-wahub | grep trycloudflare | head -1`).
5. The phone is open in WhatsApp → Settings → Linked Devices, ready to scan.

If 1–5 are ✓ — you can start. If something's red — the relevant row in the table above will sort it out in under 30 seconds.

---

<div align="center">

**You now have a professional, self-hosted WhatsApp infrastructure.**

Open source: [github.com/Noam13-w/wa-hub-demo](https://github.com/Noam13-w/wa-hub-demo)

</div>
