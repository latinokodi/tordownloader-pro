# Auto-Update Design — TorDownloader PRO

## Understanding Summary

- **What**: In-app update via `electron-updater` + GitHub Releases. Checks on startup, prompts user, downloads full .exe, restarts.
- **Why**: Remove manual reinstall friction. Users currently download from GitHub and re-run NSIS installer.
- **Who**: Windows users (NSIS, per-user and per-machine installs).
- **Constraints**: Self-contained (no external server), public GitHub repo, NSIS installer.
- **Non-goals**: Silent/background updates, Linux/macOS, delta patches, private update channels.

## Assumptions

- App size (~80MB) is acceptable for full-download updates.
- GitHub rate limits won't be hit at this scale (60 req/hour unauthenticated).
- NSIS `allowToChangeInstallationDirectory` — electron-updater reads the NSIS registry key.
- CI will generate `latest.yml` + `.exe.blockmap` via `--publish always`.

## Decision Log

| # | Decision | Alternatives | Rationale |
|---|----------|-------------|-----------|
| 1 | `electron-updater` with generic GitHub provider | Squirrel.Windows, custom downloader, nsis-web | Least code, handles NSIS registry, blockmap verification, restart dance. Battle-tested (VS Code, Discord, Signal). |
| 2 | `autoDownload: false` (prompted) | Silent background download | User chose prompted UX ("B" model). |
| 3 | Circuit breaker cooldown (3 failures → 6h) | Retry every launch, no breaker | Prevents hammering GitHub API when offline, avoids rate limit ban. Manual check resets breaker. |
| 4 | Skip entirely in dev mode | Mock update flow in dev | Zero noise during development. |
| 5 | 2s startup delay before check | Check immediately | Window must be rendered before IPC events fire. |

## Failure Modes

| # | Failure | Recovery |
|---|---------|----------|
| 1 | No internet / GitHub down | 10s timeout, silent skip, app starts normally. |
| 2 | GitHub rate limit | Circuit breaker: 3 consecutive failures → skip for 6h. Manual check resets. |
| 3 | Dev mode | Skip ALL update logic. electron-updater never initializes. |
| 4 | Partial/corrupt download | Blockmap verification. Hash mismatch → delete cache, full re-download. |
| 5 | Install dir not writable | Catch ERR_UPDATER_OLD_DIR_NOT_EMPTY → dialog with GitHub release link. |
| 6 | User dismisses dialog | 24h cooldown stored in settings DB. |
| 7 | App quit during download | Downloads in temp dir. Next launch detects partial file, retries. |
| 8 | Multiple instances | `requestSingleInstanceLock()` already prevents second instance. |
| 9 | NSIS registry key missing | Falls back to `app.getAppPath()`. If both fail → manual-install dialog. |
| 10 | updateInfo.url null | Empty release → "No update available" toast, no crash. |
| 11 | Dialog during critical operation | Check runs 2s after startup, defers if search/download active. |
| 12 | CI forgot latest.yml | Empty response, logged warning, silent to user. |

## Files

| File | Change |
|------|--------|
| `electron/updater.ts` | **NEW** — all update logic |
| `electron/main.ts` | Import updater, init after createWindow, 2 IPC handlers |
| `electron/preload.ts` | `checkForUpdates()` and `downloadUpdate()` bridges |
| `electron-builder.yml` | `publish: { provider: github, owner, repo }` |
| `.github/workflows/build.yml` | `--publish always`, upload `latest.yml` + blockmap |
| `package.json` | `electron-updater` dependency |

## IPC

| Channel | Direction | Payload | When |
|---------|-----------|---------|------|
| `update-available` | main→renderer | `version: string` | New version found |
| `update-not-available` | main→renderer | — | Already latest |
| `update-download-progress` | main→renderer | `percent: number` | During download |
| `update-downloaded` | main→renderer | — | Ready to install |
| `update-error` | main→renderer | `message: string` | Any failure |
| `check-for-updates` | renderer→main | — | User clicked button |
| `download-update` | renderer→main | — | User accepted prompt |
