---
name: dev-tunnel
description: Use this skill when the user wants to run the local dev server and expose it to WAN via Cloudflare Tunnel (trycloudflare.com), set the JavaScript origin in Google OAuth, or reset/replace the legacy trycloudflare URL. Trigger on phrases like "start tunnel", "expose to WAN", "cloudflare tunnel", "start dev server WAN", "update oauth origins for tunnel", "reset trycloudflare".
---

# dev-tunnel

Starts the Vite dev server and exposes it publicly via Cloudflare Quick Tunnel (no account needed).
Prints the tunnel URL and OAuth Console link so the user can register it as an Authorized JavaScript Origin.

## Project context

- Dev server: `npm run dev` (uses `--host` flag to bind 0.0.0.0) → `http://localhost:5173`
- Google Project ID: `deemo-reborn-90033034`
- OAuth Client ID: `244200756201-im1ves0t29ldpc1sb28hb9aq1n2792bu.apps.googleusercontent.com`
- OAuth Console URL: `https://console.cloud.google.com/apis/credentials/oauthclient/244200756201-im1ves0t29ldpc1sb28hb9aq1n2792bu?project=deemo-reborn-90033034`

## WSL2 + Windows Node.js notes

This project runs Windows Node.js via WSL interop. Key considerations:
- Vite runs as a Windows process; cloudflared runs as a Linux process
- `--host` CLI flag is needed (config `host` option is ignored by Windows Node from WSL)
- `--http-host-header localhost:PORT` on cloudflared rewrites the Host header so Vite's host-check passes (Vite 5.x `server.allowedHosts` config is also ignored in this setup)

## Steps to execute

Run the script at `skills/dev-tunnel/scripts/start-tunnel.sh`. It performs all steps automatically. If the user invokes this skill, execute the script directly rather than running steps manually.

```bash
bash skills/dev-tunnel/scripts/start-tunnel.sh
```

## What the script does

1. **Installs cloudflared** (Linux amd64) if not already present at `~/.local/bin/cloudflared`
2. **Kills leftover processes** from previous sessions (Linux cloudflared + Windows Vite via `taskkill`)
3. **Starts the dev server** (`npm run dev`) in the background, detects actual port
4. **Starts Cloudflare Quick Tunnel** with `--http-host-header` to bypass Vite's host check
5. **Verifies** the tunnel returns HTTP 200
6. **Prints instructions** with the exact URL to add, what legacy URL to remove, and the OAuth Console link

## Manual OAuth update instructions (after script runs)

In the Google Cloud Console OAuth client editor:
1. Under **Authorized JavaScript origins** — delete any existing `*.trycloudflare.com` entry (the legacy/old session URL)
2. Click **Add URI** → paste the new tunnel URL shown by the script
3. Click **Save** and wait ~2 minutes for changes to propagate

## Cleanup

To stop everything when done:
```bash
pkill -f "cloudflared tunnel" 2>/dev/null
pkill -f "vite" 2>/dev/null
```

## Troubleshooting

- **"failed to parse quick Tunnel ID"** — transient Cloudflare API error; just re-run the script
- **OAuth error "origin not allowed"** — wait 2 minutes after saving the Console, then reload the app
- **Tunnel URL not appearing** — check `/tmp/cloudflared.log` for errors
- **403 from tunnel** — the `--http-host-header` flag is missing; ensure cloudflared uses it
- **Port already in use** — the script auto-detects the actual Vite port from log output
