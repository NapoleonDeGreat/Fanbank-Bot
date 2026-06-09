---
name: Replit lockfile proxy fix
description: Replit's system-level npm registry always bakes internal proxy URLs into package-lock.json; must be fixed before pushing to GitHub/Railway
---

## Rule
After every `npm install` inside Replit, run this before committing:
```
sed -i 's|http://package-firewall.replit.local/npm/|https://registry.npmjs.org/|g' package-lock.json
```

**Why:** Replit sets `registry = "http://package-firewall.replit.local/npm/"` at the OS/system level (not in any `.npmrc` file), so it cannot be overridden by a project `.npmrc`. Every lockfile generated in Replit has resolved URLs pointing to this internal proxy, which is unreachable by Railway (or any external CI). Railway's `npm ci` hangs downloading tarballs → SIGKILL → "Exit handler never called".

**How to apply:** After `npm install` or `npm update`, before `git push`. Also confirm with `grep -c 'package-firewall' package-lock.json` — should be 0.

## Git push pattern that works
```bash
echo "https://NapoleonDeGreate:${GITHUB_PERSONAL_ACCESS_TOKEN}@github.com" > /tmp/gc
GIT_ASKPASS=/bin/true git -c credential.helper="store --file=/tmp/gc" push origin main 2>&1
rm -f /tmp/gc
```
The stale `.git/refs/remotes/origin/main.lock` causes a cosmetic error but push always succeeds (confirmed by the `main -> main` line above it).
