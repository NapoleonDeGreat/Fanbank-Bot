---
name: Club theme system
description: How the non-invasive club identity theming layer is structured in index.js
---

## Rule
The theme system is a pure styling layer — it must never touch flow logic, state machines, or API calls.

**Why:** The requirement was explicit: theme as a non-invasive overlay. Any future additions to theming must follow the same constraint — only touch presentation functions.

## Architecture
- `CLUB_THEMES` object (after `CLUB_HEX` in index.js) — one entry per club with: `primary`, `secondary`, `badge`, `header`, `separator`, `accent`, `tagline`, `gradient: { from, to }`
- `DEFAULT_THEME` — fallback for users with no club selected
- `getTheme(user)` — pure function, resolves theme from `user.club`, no side effects; this is the "provider" equivalent for a bot
- `sendClubMessage(to, text, user)` — the presentation wrapper; uses `getTheme(user).badge` as prefix
- `generateWelcomeFlier(user)` — uses `theme.gradient` for SVG linear gradient background + club tagline

## What was NOT changed
All flow logic functions are untouched: `handleBVN`, `handleClubSelection`, `handleManualName`, `finishOnboarding`, `executeTransfer`, `executeAirtime`, `showBalance`, `handleMessage`, routes, DB helpers.

## How to apply for future theming additions
Always route through `getTheme(user)` — never read `user.club_data.colors` directly. Add new theme tokens to `CLUB_THEMES` / `DEFAULT_THEME` first, then consume via `getTheme`.
