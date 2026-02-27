# React Mind

XMind-like graph editor using React, with Google Sheets as data storage backend.

## Prerequisites

- Node.js 20+
- npm 10+

## Quick Start

1. Copy environment file:

   - Windows PowerShell: `Copy-Item .env.example .env`

2. Fill `.env` with your Google values.

3. Install and run:

   - `npm install`
   - `npm run dev`

## Environment Variables

- `VITE_APP_NAME`
- `VITE_GOOGLE_PROJECT_ID`
- `VITE_GOOGLE_CLIENT_ID`
- `VITE_GOOGLE_AUTHORIZED_ORIGINS_HINT` (comma-separated, for setup hint messages)
- `VITE_GOOGLE_API_KEY`
- `VITE_GOOGLE_SCOPES`
- `VITE_FEATURE_SHEETS_SYNC`
- `VITE_FEATURE_HISTORY_PANEL`
- `VITE_FEATURE_IMPORT_也是PORT`

## OAuth Setup (Important)

- This app is **frontend-only** and uses Google Identity `initTokenClient` popup flow.
- `VITE_GOOGLE_CLIENT_ID` must be a **Web application** OAuth client ID (`*.apps.googleusercontent.com`).
- In Google Cloud Console for this Web OAuth client, set **Authorized JavaScript origins** to:
   - `http://localhost:5173`
   - `http://127.0.0.1:5173`
   - `https://farl.github.io` (for GitHub Pages)
- If configuration is wrong you may see `redirect_uri_mismatch` or `origin_mismatch`.

## Testing

- Install Playwright browsers (first run only):
   - `npx playwright install --with-deps chromium`
- Run smoke tests:
   - `npm run e2e`
- Debug with UI runner:
   - `npm run e2e:ui`

## Documentation

- User-facing updates and feature highlights: `RELEASE_NOTES.md`
