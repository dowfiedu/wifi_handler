# OpenWrt openNDS ⟷ Telegram Bot & Web Admin Captive Portal Bridge

A lightweight, production-ready serverless bridge deployed on **Vercel** to connect an **OpenWrt** router running the **openNDS** captive portal with a **Telegram Bot** and an **Admin Web Console** using **Upstash Redis** as a command queue.

---

## 🏗 System Architecture

```
                    ┌─────────────────────────┐
                    │      Client Device      │
                    │   (Connects to Wi-Fi)   │
                    └────────────┬────────────┘
                                 │ 1. Intercept & Redirect to Portal
                                 ▼
                    ┌─────────────────────────┐
                    │   OpenWrt Captive Portal│
                    │      (openNDS FAS)      │
                    └────────────┬────────────┘
                                 │ 2. Opens Portal URL with ?clientmac=...
                                 ▼
                    ┌─────────────────────────┐
                    │      Vercel App         │
                    │   public/index.html     │
                    └────────────┬────────────┘
                                 │ 3. POST /api/request { name, mac }
                                 ▼
           ┌───────────────────────────────────────┐
           │                                       │
           ▼                                       ▼
┌─────────────────────────┐             ┌─────────────────────────┐
│  Telegram Bot API       │             │   Admin Web Console     │
│  (Sends Admin Prompt)   │             │   /admin (public/admin) │
└────────────┬────────────┘             └────────────┬────────────┘
             │                                       │
     4a. Admin Clicks Button                 4b. Web Admin Clicks Accept
   [30m] [1h] [Unlimited] [Reject]         [30m] [1h] [3h] [Unlimited]
             │                                       │
             ▼                                       ▼
┌─────────────────────────┐             ┌─────────────────────────┐
│  Telegram Webhook       │             │   Admin API Handler     │
│  api/webhook (telegram) │             │      api/admin.js       │
└────────────┬────────────┘             └────────────┬────────────┘
             │ 5a. RPUSH ndsctl command              │ 5b. RPUSH ndsctl command
             └───────────────────┬───────────────────┘
                                 ▼
                    ┌─────────────────────────┐
                    │      Upstash Redis      │
                    │  [pending_commands]     │
                    └────────────▲────────────┘
                                 │
                 6. LPOP every 5s via /api/poll
                    (x-router-secret authenticated)
                                 │
                    ┌────────────┴────────────┐
                    │  OpenWrt Router Script  │
                    │     router/sync.sh      │
                    └────────────┬────────────┘
                                 │ 7. Executes:
                                 │    - 'ndsctl auth <MAC> <MINUTES>' (30 / 60 / 0)
                                 │    - 'ndsctl deauth <MAC>' (Instant Revoke)
                                 ▼
                    ┌─────────────────────────┐
                    │   Client Device State   │
                    │  INTERNET ACCESS GRANTED│
                    └─────────────────────────┘
```

---

## 📁 Project Structure

```
├── api/
│   ├── admin.js             # Admin endpoint (list requests, accept/reject, queue commands)
│   ├── poll.js              # Router polling endpoint (secret-authenticated, pops from Redis)
│   ├── request.js           # Client request endpoint (sends Telegram notification with buttons)
│   ├── telegram.js          # Telegram webhook alias (forwards to webhook.js)
│   └── webhook.js           # Telegram webhook receiver (processes buttons, queues ndsctl, updates buttons)
├── public/
│   ├── admin.html           # Admin Web Console (live requests, direct accept, manual auth)
│   └── index.html           # Standalone responsive captive portal landing page
├── router/
│   ├── opennds_sync.init    # OpenWrt procd service init script (/etc/init.d/opennds_sync)
│   ├── sync.conf.example    # Configuration file template for OpenWrt (/etc/opennds/sync.conf)
│   └── sync.sh              # POSIX /bin/sh polling daemon for OpenWrt
├── test/
│   ├── endpoints.test.js    # Node.js tests for HTTP endpoints and status codes
│   ├── test_router_sync.sh  # POSIX shell tests for router script security filter & JSON parsing
│   └── unit.test.js         # Unit tests for MAC normalization, parsing & crypto
├── .env.example             # Environment variable template
├── package.json             # ES Module configuration and dependencies
├── vercel.json              # Vercel deployment and caching headers configuration
└── README.md                # Documentation and setup guide
```

---

## 🚀 Quick Start & Deployment Guide

### 1. Telegram Bot Setup
1. Open Telegram and search for [@BotFather](https://t.me/BotFather).
2. Send `/newbot`, name your bot, and copy the **HTTP API Bot Token** (`TELEGRAM_BOT_TOKEN`).
3. Get your Telegram Chat ID:
   - Message your new bot or [@userinfobot](https://t.me/userinfobot) to find your numeric ID.
   - For a group/channel, add the bot as administrator and retrieve the group ID (starts with `-100`).

### 2. Upstash Redis Setup
1. Sign up for free at [Upstash](https://console.upstash.com/).
2. Create a new Redis Database.
3. In the database dashboard under **REST API**, copy:
   - `UPSTASH_REDIS_REST_URL` (e.g. `https://xxx.upstash.io`)
   - `UPSTASH_REDIS_REST_TOKEN` (e.g. `AXxx...`)

### 3. Generate a Router Secret Key
Generate a cryptographically secure random token to protect the `/api/poll` endpoint:
```bash
openssl rand -hex 24
```
Keep this key handy as `ROUTER_SECRET_KEY`.

---

### 4. Deploy to Vercel

#### Option A: Using Vercel CLI
```bash
# Install Vercel CLI if needed
npm i -g vercel

# Deploy and configure environment variables
vercel
```

#### Option B: Deploy via GitHub / Vercel Web Dashboard
1. Push this repository to GitHub or GitLab.
2. Import the project into [Vercel](https://vercel.com/new).
3. In **Settings -> Environment Variables**, add:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   - `ROUTER_SECRET_KEY`
   - `ADMIN_PASSWORD` *(optional; defaults to `ROUTER_SECRET_KEY` if not set)*
4. Deploy the project. Note your deployment domain (e.g., `https://your-domain.vercel.app`).

---

### 5. Access the Web Admin Console (`/admin`)

You can directly manage and authorize Wi-Fi access requests from your browser without opening Telegram!

- **URL:** `https://<your-domain>.vercel.app/admin` (or `http://localhost:3000/admin` in local dev)
- **Login Password:** Your configured `ADMIN_PASSWORD` (or `ROUTER_SECRET_KEY`).
- **Features:**
  - **Live Request Feed:** Real-time stream of incoming captive portal requests with user name, MAC address, IP, and status.
  - **1-Click Direct Accept:** Accept pending users instantly with preset durations (**1 Hour**, **3 Hours**, **Unlimited**, or **Custom Minutes**).
  - **1-Click Reject / Deauth:** Revoke access or reject requests with one click.
  - **Manual Device Whitelist:** Directly authorize or deauthorize any MAC address without waiting for a captive portal form submission.
  - **Auto-Sync:** Actions taken in the Web Console automatically log to Telegram to keep all admins informed.

---

### 6. Register the Telegram Webhook

Point your Telegram bot to the deployed `/api/webhook` endpoint:
```bash
curl -X POST "https://api.telegram.org/bot<YOUR_TELEGRAM_BOT_TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{"url": "https://<your-domain>.vercel.app/api/webhook"}'
```

Verify status anytime:
```bash
curl "https://api.telegram.org/bot<YOUR_TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

---

## 📡 OpenWrt Router Configuration

### 1. Configure openNDS FAS (Forwarding Authentication Service)
Edit `/etc/config/opennds` on your router:

```uci
config opennds
    option enabled '1'
    option faskey 'none'
    option fasport '443'
    option fasremoteurl 'https://your-domain.vercel.app/'
    option faspath '/'
    option preauth 'https://your-domain.vercel.app/'
```
*(Or specify `preauth` if using openNDS preauth redirect mode. openNDS will automatically redirect captive clients to `https://your-domain.vercel.app/?clientmac=<MAC>&clientip=<IP>`)*.

Reload openNDS:
```sh
/etc/init.d/opennds restart
```

---

### 2. Install Dependencies on OpenWrt
SSH into your router:
```sh
opkg update
opkg install curl
```
*(Note: `jsonfilter` is already built into OpenWrt by default).*

---

### 3. Install the Sync Script on OpenWrt

1. Copy `router/sync.sh` to `/usr/bin/opennds_sync.sh` on the router:
   ```sh
   chmod +x /usr/bin/opennds_sync.sh
   ```

2. Create `/etc/opennds/sync.conf`:
   ```sh
   mkdir -p /etc/opennds
   cat << 'EOF' > /etc/opennds/sync.conf
   API_URL="https://your-domain.vercel.app/api/poll"
   ROUTER_SECRET_KEY="your_shared_secret_key_matching_vercel"
   POLL_INTERVAL=5
   LOG_TAG="opennds-sync"
   EOF
   ```

3. Test manually first:
   ```sh
   /usr/bin/opennds_sync.sh
   ```

4. Install as a background service managed by `procd`:
   Copy `router/opennds_sync.init` to `/etc/init.d/opennds_sync`:
   ```sh
   chmod +x /etc/init.d/opennds_sync
   /etc/init.d/opennds_sync enable
   /etc/init.d/opennds_sync start
   ```

Check router system logs:
```sh
logread -e opennds-sync
```

---

## 🔒 Security Best Practices Implemented

1. **Strict Command Whitelist:**
   `router/sync.sh` validates incoming commands against strict POSIX pattern matching (`ndsctl auth <MAC> <minutes>` or `ndsctl deauth <MAC>`). Arbitrary commands or shell injections (`rm -rf`, `;`, `&&`, etc.) are actively rejected and logged.
2. **Timing-Safe Secret Comparison:**
   `/api/poll` compares `x-router-secret` using Node.js `crypto.timingSafeEqual` to eliminate timing attack vectors.
3. **Markdown Format Escaping:**
   `/api/request` escapes all Markdown delimiters from user-supplied names to prevent Telegram format injection.
4. **Input Normalization:**
   MAC addresses are strictly validated against `^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$` and normalized before passing to Telegram or Redis.
5. **No-Cache Directives:**
   `/api/poll` sends `Cache-Control: no-store` headers to ensure Vercel edge caches never store queue polling results.

---

## 🧪 Local Testing

Run all unit tests and shell script validation tests:
```bash
npm test
```

### Manual Endpoint Testing with `curl`

#### 1. Simulate portal form submission:
```bash
curl -X POST http://localhost:3000/api/request \
     -H "Content-Type: application/json" \
     -d '{"name": "John Doe", "mac": "aa:bb:cc:dd:ee:ff"}'
```

#### 2. Simulate router polling:
```bash
curl -X GET http://localhost:3000/api/poll \
     -H "x-router-secret: your_secret_key"
```
Response:
```json
{"command": "ndsctl auth aa:bb:cc:dd:ee:ff 60"}
```
*(or `{"command": null}` if no commands are pending).*

---

## 📜 License
MIT License.
