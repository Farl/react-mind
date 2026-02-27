# Release Notes

This file is for product users and summarizes visible changes.

## 2026-02-28

### New
- Desktop-like top menu behavior:
  - only one menu stays open at a time
  - outside click closes menu
  - `Esc` closes menu and dialogs
- `File > Open...` dialog supports:
  - refreshing graph stores
  - selecting existing stores
  - opening by spreadsheet URL/ID
- Bottom sheet tabs with `+` button for quick graph sheet creation.
- Inline node rename on canvas (double-click node title, `Enter` to confirm, `Esc` to cancel).

### Improved
- Canvas interaction quality:
  - wheel zoom without modifier keys
  - zoom follows cursor position
  - zoom buttons focus around viewport center
  - smoother pan/zoom behavior
- Editing workflow:
  - autosave is default
  - clearer save/sync status chips
  - safer conflict handling and reload flow
- UI layout:
  - simplified status row
  - spreadsheet name shown in top bar
  - reduced visual clutter from side controls

### Fixed
- Resolved wheel passive event warning that could break `preventDefault` behavior.
- Reduced autosave race/conflict frequency in rapid edit scenarios.
- Fixed menu and dialog edge cases around close behavior.

---

## Notes
- Google sign-in must use a Web OAuth client ID.
- For setup details, see `README.md`.
