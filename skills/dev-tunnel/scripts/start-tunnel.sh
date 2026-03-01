#!/usr/bin/env bash
# start-tunnel.sh — Start react-mind dev server + Cloudflare Quick Tunnel
# Usage: bash skills/dev-tunnel/scripts/start-tunnel.sh
#
# NOTE: This project uses Windows Node.js via WSL interop.
# Vite runs as a Windows process; cloudflared runs as a Linux process.
# --http-host-header rewrites the Host header so Vite's host-check passes.

set -euo pipefail

GOOGLE_PROJECT_ID="deemo-reborn-90033034"
OAUTH_CLIENT_ID="244200756201-im1ves0t29ldpc1sb28hb9aq1n2792bu.apps.googleusercontent.com"
OAUTH_CONSOLE_URL="https://console.cloud.google.com/apis/credentials/oauthclient/${OAUTH_CLIENT_ID}?project=${GOOGLE_PROJECT_ID}"
CLOUDFLARED="${HOME}/.local/bin/cloudflared"
DEV_LOG="/tmp/react-mind-dev.log"
TUNNEL_LOG="/tmp/cloudflared.log"
VITE_PORT=5173

# ── 1. Install cloudflared if missing ────────────────────────────────────────
if ! command -v cloudflared &>/dev/null && [[ ! -x "$CLOUDFLARED" ]]; then
  echo "► Installing cloudflared..."
  DEB="/tmp/cloudflared.deb"
  curl -sL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb" -o "$DEB"
  dpkg -x "$DEB" /tmp/cloudflared-pkg
  mkdir -p "${HOME}/.local/bin"
  install -m 755 /tmp/cloudflared-pkg/usr/bin/cloudflared "$CLOUDFLARED"
  rm -rf "$DEB" /tmp/cloudflared-pkg
  echo "  cloudflared installed at $CLOUDFLARED"
fi

CF="${CLOUDFLARED}"
if command -v cloudflared &>/dev/null; then CF="cloudflared"; fi

# ── 2. Kill any leftover processes from previous sessions ────────────────────
pkill -f "cloudflared tunnel" 2>/dev/null && echo "► Stopped previous tunnel" || true
# Kill Windows Vite processes occupying the port
for pid in $(cmd.exe /c "netstat -ano" 2>/dev/null | grep ":${VITE_PORT}.*LISTENING" | awk '{print $NF}' | sort -u); do
  cmd.exe /c "taskkill /F /PID $pid" 2>/dev/null && echo "► Killed Windows PID $pid on port $VITE_PORT" || true
done
sleep 1

# ── 3. Start dev server ──────────────────────────────────────────────────────
echo "► Starting dev server..."
PROJECT_DIR="$(cd "$(dirname "$0")/../../../" && pwd)"
cd "$PROJECT_DIR"
npm run dev >"$DEV_LOG" 2>&1 &
DEV_PID=$!
echo "  Dev server PID: $DEV_PID (log: $DEV_LOG)"

# Wait for Vite to be ready and detect actual port
ACTUAL_PORT=""
for i in {1..15}; do
  if grep -q "ready in" "$DEV_LOG" 2>/dev/null; then
    ACTUAL_PORT=$(grep -oE 'localhost:[0-9]+' "$DEV_LOG" | head -1 | cut -d: -f2)
    break
  fi
  sleep 1
done

if [[ -z "$ACTUAL_PORT" ]]; then
  echo "ERROR: Dev server did not start. Check $DEV_LOG"
  exit 1
fi
echo "  Dev server ready on port $ACTUAL_PORT"

# ── 4. Start Cloudflare tunnel ───────────────────────────────────────────────
# --http-host-header rewrites Host to localhost so Vite's host-check middleware
# doesn't reject the *.trycloudflare.com Host header (Vite 5.x config
# allowedHosts is ignored when running Windows Node from WSL).
echo "► Starting Cloudflare Quick Tunnel..."
"$CF" tunnel --url "http://localhost:${ACTUAL_PORT}" --http-host-header "localhost:${ACTUAL_PORT}" >"$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!
echo "  Tunnel PID: $TUNNEL_PID (log: $TUNNEL_LOG)"

# ── 5. Extract tunnel URL (retry up to 30s) ──────────────────────────────────
TUNNEL_URL=""
for i in {1..30}; do
  TUNNEL_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1)
  if [[ -n "$TUNNEL_URL" ]]; then break; fi
  sleep 1
done

if [[ -z "$TUNNEL_URL" ]]; then
  echo ""
  echo "ERROR: Tunnel URL not found. Check $TUNNEL_LOG for errors."
  echo "  Common fix: transient Cloudflare API error — just re-run this script."
  exit 1
fi

# ── 6. Verify tunnel returns 200 ─────────────────────────────────────────────
echo "► Verifying tunnel..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$TUNNEL_URL/" 2>/dev/null || echo "000")
if [[ "$HTTP_CODE" != "200" ]]; then
  echo "  WARNING: Tunnel returned HTTP $HTTP_CODE (expected 200)"
  echo "  Check $TUNNEL_LOG and $DEV_LOG for errors"
else
  echo "  Tunnel verified (HTTP 200)"
fi

# ── 7. Print instructions ────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║  Tunnel active!                                                  ║"
printf "║  %-64s║\n" "URL: $TUNNEL_URL"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""
echo "▶ Google OAuth — Authorized JavaScript Origins:"
echo "   1. Remove any old *.trycloudflare.com entry (legacy session URL)"
echo "   2. Add new URI: $TUNNEL_URL"
echo "   3. Save — wait ~2 min for changes to propagate"
echo ""
echo "OAuth Console: $OAUTH_CONSOLE_URL"
echo ""
echo "Press Ctrl+C to stop tunnel + dev server."
echo ""

# ── 8. Trap Ctrl+C to clean up ──────────────────────────────────────────────
cleanup() {
  echo ""
  echo "► Stopping tunnel and dev server..."
  kill "$TUNNEL_PID" 2>/dev/null || true
  kill "$DEV_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait "$TUNNEL_PID"
