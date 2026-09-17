# Pi Web Box

[中文文档](./README.md)

Pi Web Box is an enhanced Windows desktop client for [Pi Web](https://github.com/agegr/pi-web), the local web UI of the [pi coding agent](https://pi.dev/). Built with Electron: instead of modifying Pi Web, it hosts it in a frameless window and layers multi-tab sessions, notification history, and desktop conveniences on top. Neither Node.js nor Pi Web is bundled — it always uses the versions you manage with npm.

## What it adds on top of Pi Web

- **Multi-tab sessions** — up to 6 tabs share one Pi Web service, with drag reordering, middle-click close, and Ctrl+T / Ctrl+W / Ctrl+Tab shortcuts. Each open tab gets a unique colored dot with a running indicator; closing a tab never aborts the underlying session.
- **Local notification history** — a message center with unread badge, newest-first pages of 30, lazy loading on scroll, and click-to-jump to the session. Stored locally in `%APPDATA%/Pi Web Box/notifications.sqlite`; only notifications the Box pages actually receive are recorded.
- **Window experience** — custom title bars that follow Pi Web's five themes (Light, Dark, Mist, Rose, Pine), minimize to tray, window position memory, high-contrast icons.
- **Tray badge and notifications** — a green tray badge while sessions are running; a desktop notification when a session goes idle.
- **Token statistics** — renders Pi's usage log as a GitHub-style heatmap with per-model breakdowns, via the bundled `pi-usage-log` extension.
- **Prompt enhancement** — an **Enhance** button that rewrites your draft through a model you configured in Pi (General / Coding / Image presets).
- **One-click updates** — checks npm for new pi & pi-web releases on launch and updates them in-app, no terminal required.

## How it works

On launch it detects (or starts) the local `pi-web` command, defaulting to `127.0.0.1:30141`. An already-running healthy Pi Web service is reused, never stopped. Pi Web Box shares pi's config, credentials, sessions, and project files and never modifies them.

## Install

Download the Windows x64 installer (`Pi Web Box Setup-<version>.exe`) from [Releases](https://github.com/passheep/pi-web-box/releases); release notes live in [release-notes](./release-notes/).

Requirements:

- Windows 10/11
- Node.js **22.19.0 or newer**
- pi and Pi Web installed globally:

```powershell
npm install -g @earendil-works/pi-coding-agent@latest
npm install -g @agegr/pi-web@latest
```

## Configuration

Pi Web launch options live in **Box settings** and apply after a restart: port (`--port`, default `30141`), hostname (`--hostname`, loopback only by default), password (`PI_WEB_PASSWORD`), and absolute `pi-web` / Node.js paths (empty = auto-detect from `PATH`).

Settings are stored in `%APPDATA%/Pi Web Box/settings.json` with a one-click reset on the startup page; logs at `%APPDATA%/Pi Web Box/logs/pi-web.log`.

## Development

```powershell
npm install
npm run typecheck
npm test
npm run dev      # run from source
npm run dist     # build the installer into dist/
```

> Close any running Pi Web Box before packaging — Windows locks the EXE and stalls the build.

## Troubleshooting

1. `node --version` must be 22.19.0+.
2. `where pi-web` must find `pi-web.cmd`.
3. Re-run `npm install -g @agegr/pi-web@latest`.
4. Use "Open log" on the error page.

Pi Web features that open a new tab (for example "Full history") are handed to your default browser.
