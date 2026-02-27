# React Mind

XMind-like graph editor using React, with Google Sheets as data storage backend.

## Current Stage

This repository now includes a modular foundation:

- React + TypeScript + Vite scaffold
- Config-driven environment setup (no hardcoded API values)
- Mindmap domain model definitions
- Google OAuth + Graph Store service (Drive appProperties + Sheets)
- Graph store + graph sheet switching UI

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
- `VITE_FEATURE_IMPORT_EXPORT`

## Graph Store Workflow

- Click `Connect Google` to authorize.
- Click `Refresh Stores` to query all graph spreadsheets by Drive `appProperties`.
- Click `Create Store + Graph` to create a new spreadsheet and first graph sheet.
- Use `Select Store` and `Select Graph Sheet` to switch target graph.
- Click `Add Graph Sheet` to add a new graph in the same spreadsheet.
- Click `Load Graph` / `Save Graph` for the selected graph sheet.

## Auth and Session UX

- Initial login uses Google OAuth popup (`Sign In Google`).
- Session preference is remembered and app tries silent restore on next launch.
- Store list and selected store/sheet are auto-restored after successful session restore.
- `Sign Out` revokes token and clears remembered session state.
- Local-only graph editing is disabled; editing unlocks only when a remote graph sheet is active.

## OAuth Setup (Important)

- This app is **frontend-only** and uses Google Identity `initTokenClient` popup flow.
- `VITE_GOOGLE_CLIENT_ID` must be a **Web application** OAuth client ID (`*.apps.googleusercontent.com`).
- Do **not** use IAM OAuth client IDs (for example UUID-style IDs from `gcloud iam oauth-clients`).
- In Google Cloud Console for this Web OAuth client, set **Authorized JavaScript origins** to:
   - `http://localhost:5173`
   - `http://127.0.0.1:5173`
   - `https://farl.github.io` (for GitHub Pages)
- This flow does not need backend auth code exchange; if configuration is wrong you may see `redirect_uri_mismatch` or `origin_mismatch`.

## Next Implementation Slice

- Add branch drag-and-drop reorder within same parent
- Add collapse/expand branch state per node
- Add in-canvas inline title editing and keyboard navigation
- Add zoom/pan viewport controls and fit-to-screen
- Add share link with selected store/sheet encoded in URL
