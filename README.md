# FieldLink Kiosk

The Windows app that runs a [Field Link Missions](https://fieldlinkmissions.com) lobby display. It is a small
Electron shell around the FieldLink kiosk web page (`/kiosk?key=…`) plus everything a church needs to set a
display up and keep it running without touching scripts or files:

- **Link by code on screen.** With no key configured the app shows a 6-character code. A Super Admin types it
  into FieldLink Admin → Kiosk → 🔗 Link kiosk and the map appears. No keyboard is needed at the display.
- **Kiosk mode from inside the app.** One button (behind a normal UAC prompt) creates a locked-down
  `FieldLinkKiosk` Windows account that boots straight into the app, disables sleep and switches on nightly
  self-updates. One button undoes it.
- **Self-healing.** The app checks its key with the server every 30 s and shows a clear screen, with a fresh
  link code, when the key is deleted, disabled or rotated. Network and maintenance outages retry on their own.

Church admins never clone this repo. FieldLink serves the installer built here at `/api/kiosk/installer`.

## Flow for a church

1. Admin → Kiosk → 💻 Windows Kiosk App → **Download installer**. Run it on the display PC (Windows 10/11,
   64-bit). It opens by itself when finished.
2. The app shows a code. In Admin → Kiosk click **🔗 Link kiosk** on the key for that display and type the code.
3. Press **Ctrl+Shift+K** on the display → **Turn this PC into a kiosk** → accept the UAC prompt → restart.

That's the whole setup. Later, the same Ctrl+Shift+K screen shows status, installs updates, or removes kiosk mode.

## What's in the app

| File | Role |
|------|------|
| `main.js` | Window, key health loop, recovery/setup screen state, on-screen pairing, bridge to the privileged helper, update check. |
| `preload.js` | Exposes the privileged bridge only to the local `recovery.html`; remote pages get a read-only marker (`window.fieldlinkKioskApp`). |
| `recovery.html` | The setup / recovery / settings screen (link code, kiosk mode, updates, status). Opens in a browser for layout work. |
| `resources/kiosk-admin.ps1` | Everything that needs administrator rights. Shipped as `resources\kiosk-admin.ps1` next to the exe. ASCII + BOM, see below. |
| `build/installer.nsh` | NSIS hook: a real uninstall runs `-Action Unlock` first so a PC is never left auto-logging into a shell that no longer exists. |

### Key health loop

Every 30 s the app calls `GET /api/kiosk/whoami` with the key (falls back to `/hash` on old servers).

| Result | What the app does |
|--------|-------------------|
| 200 | Nothing; if it had been showing a recovery screen it loads the map. |
| 401/403 twice in a row | Shows the recovery screen with a new link code. The service worker no longer masks 401 with cached data. |
| 5xx / network error | Leaves a working page alone (the page has its own offline handling). If the page never loaded, shows *Connecting…* and retries with 5 → 30 s backoff. |

Renderer crashes and hangs reload the page. `did-fail-load` at boot (Wi-Fi not up yet) is handled the same way.

### Pairing

Primary, **code on the display**: the app calls `POST /api/kiosk/pair/request` → `{ code, token, expires_at }`,
shows the code and polls `GET /api/kiosk/pair/poll` (header `x-pair-token`) every 3 s. When a superadmin has
claimed the code via `POST /api/kiosk/keys/:id/pair-claim`, the poll returns the kiosk URL and the app saves it.
Codes renew every 15 minutes by themselves.

Fallback, **code from Admin typed on the display** (needs a keyboard): Admin → Link kiosk → *Generate a code*
→ `POST /api/kiosk/pair` from the app. Pasting a full kiosk URL or key also works. Both live under
"Have a code from FieldLink Admin, or a kiosk URL?" on the screen.

### Privileged helper (`resources/kiosk-admin.ps1`)

Invoked by `main.js` through `Start-Process -Verb RunAs` (one UAC prompt). It reports progress by rewriting
`%ProgramData%\FieldLinkKiosk-Admin\last-action.json`, which the screen polls.

| Action | What it does |
|--------|--------------|
| `Status` | Read-only JSON: account, auto-login, profile, update task, last update, paths. No elevation. |
| `Lockdown` | Creates/repairs the `FieldLinkKiosk` account with a **random password**, not an administrator, cannot change its password; creates its profile (UserEnv `CreateProfile`); sets its shell to the exe and disables Task Manager/Run/context menu in its hive; configures auto-login with the password stored in the **LSA `DefaultPassword` secret** (never `DefaultPassword` in the registry — the old blank-password approach broke on machines that refuse blank-password logons); disables sleep/screensaver; installs the update task; verifies. |
| `Unlock` | Reverses all of that, removes the task, disables (does not delete) the account. |
| `Update` | Reads the server from `update.json`, asks `/api/kiosk/installer/version`, downloads from `/api/kiosk/installer` if newer, verifies size and sha256, runs the installer silently. Restarts the PC if the kiosk session was running (the app was its shell); with `-Relaunch` it relaunches the app de-elevated via `explorer.exe`. |
| `InstallUpdater` / `RemoveUpdater` | Manage the scheduled task alone. |

Two data folders, deliberately:

| Folder | ACL | Contents |
|--------|-----|----------|
| `%ProgramData%\FieldLinkKiosk` | kiosk account may **modify** | `config.json` (the kiosk URL) — so the kiosk account can re-link itself from the screen. |
| `%ProgramData%\FieldLinkKiosk-Admin` | Administrators + SYSTEM full, Users read | copy of the helper the SYSTEM task runs, `update.json` (https server only), `admin.log`, `last-action.json`, `update-status.json`, downloads. Nothing the kiosk account can edit is ever executed or trusted by the updater. |

The scheduled task **FieldLinkKiosk Update** runs as SYSTEM daily at 03:15 and 3 minutes after boot. It is
registered with a security descriptor that lets any signed-in account *start* it (not edit it), and
`updater.json` in the admin folder records that it exists, because a standard user cannot query a SYSTEM
task. `Get-TaskInfo` falls back to that marker.

How **Install update** on the screen works depends on who is signed in:

| Session | Path |
|---------|------|
| Kiosk account (`isKioskSession`) | `schtasks /Run "FieldLinkKiosk Update"` — the SYSTEM task downloads, verifies, installs and restarts the display; the screen follows `last-action.json`. |
| Anyone else | `installUpdateNative()` in `main.js` downloads the installer itself, checks size and sha256, then runs it silently after one UAC prompt via a tiny temp `.ps1` that also relaunches the app. No dependency on the helper. |

**Lockdown / Unlock** are started with `Start-Process -Verb RunAs -Wait`, so the app knows exactly when
they finish and with what exit code. The helper's output is appended (UTF-8) to
`%TEMP%\FieldLinkKiosk-admin\<Action>-<timestamp>.log`, which the screen tails live under a progress bar;
`last-action.json` supplies the step list and the final message. Both finish with a restart prompt.

Helper rules learned the hard way: keep the file **pure ASCII with a UTF-8 BOM** (PowerShell 5.1 reads a
BOM-less file as Windows-1252 and an em dash's last byte is a quote character); run native tools through
`Run-Native` (a redirected stderr line is a terminating error under `$ErrorActionPreference = 'Stop'`);
account descriptions are limited to 48 characters; `Test-Path` inside another user's profile throws for a
non-elevated caller.

### Config resolution

The most recently modified of these wins:

| Path | Written by |
|------|-----------|
| `%ProgramData%\FieldLinkKiosk\config.json` | The app (pairing / pasted URL). Survives upgrades. |
| `C:\Program Files\FieldLinkKiosk\config.json` | Old 1.0 setup packages. Still honoured. |
| `%APPDATA%\fieldlink-kiosk\config.json` | Fallback when ProgramData is not writable. |
| `./config.json` | Development only (`npm start`). |

Only `kioskUrl` matters. Display mode, theme, carousel and the rest live on the key in FieldLink Admin.

### Keyboard shortcuts

| Keys | Action |
|------|--------|
| Ctrl+Shift+K | Open / close the settings & recovery screen |
| Ctrl+Shift+R | Reload the kiosk page |
| Ctrl+Shift+Q | Quit the app |

Logs: `%APPDATA%\fieldlink-kiosk\kiosk.log` (app, per user) and `%ProgramData%\FieldLinkKiosk-Admin\admin.log`
(helper). Both paths are shown on the Ctrl+Shift+K screen.

## Development

```bash
npm install
npm start          # uses ./config.json — put a real kiosk URL in it, or leave it out to see the link screen
npm run build      # Windows x64 NSIS installer in dist/
```

`recovery.html` renders standalone in a browser with sample data. There is no Windows in CI beyond the build,
so **test `kiosk-admin.ps1` on a real PC** before releasing changes to it: `Lockdown`, reboot, `Ctrl+Shift+K`,
`Update`, `Unlock`.

## Release

Every push to `main` runs [`build.yml`](.github/workflows/build.yml): Windows runner, installer attached to the
GitHub release tagged **`latest`**, then `POST /api/kiosk/installer/invalidate` on the FieldLink server so its
cached copy is replaced immediately. Bump `version` in `package.json` with every behaviour change: the
updater compares it, the screen shows it, and requests carry a `FieldLinkKiosk/<version>` user-agent suffix.

Displays on 1.2+ in kiosk mode update themselves nightly, and anyone at the display can trigger it from the
Updates panel. Displays on 1.0/1.1 must run the new installer once (safe over an existing install).
Pushes that only touch `README.md` do not trigger a build.

The installer is not code-signed yet, so SmartScreen shows "Windows protected your PC" on first run
(More info → Run anyway). Signing needs a certificate issued to a person or a registered organisation;
once one exists it is a few lines in `build.yml` and the electron-builder `win` config.

## Server side

The server half lives in the FieldLink repo:

- `server/src/routes/kiosk.js` — key auth, `/whoami`, `/pair/request`, `/pair/poll`, `/keys/:id/pair-claim`,
  `/pair`, `/keys/:id/pair-code`, rotate/disable, installer proxy with `/installer/version` (size, sha256).
- `nginx/admin-app/src/pages/KioskSettings.jsx` — the admin page (Link kiosk, status, installer download).
- `nginx/client/kiosk.html` — the page this app displays.
- `nginx/docs/index.html` — the Kiosk chapter of the user documentation, including troubleshooting.
