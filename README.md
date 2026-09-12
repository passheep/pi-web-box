# Pi Web Box

[中文文档](./README.zh-CN.md)

A quiet Windows desktop window for [Pi Web](https://github.com/agegr/pi-web).

Double-click the portable EXE and it silently starts the `pi-web` command you already have installed, then shows the Pi Web interface in its own window — no console window, no native menu bar. Pi Web Box does not bundle Node.js or Pi Web, so it always uses the versions you manage with npm.

## Features

- **Portable single EXE** — no installer, no setup; run it from any folder.
- **No console window** — `pi-web` runs hidden and its output goes to a log file.
- **Reuses or owns the service** — if a healthy Pi Web already listens on the default port it is reused; otherwise Pi Web Box starts its own process tree and stops it on exit.
- **High-contrast icons** — the EXE, taskbar, tray, and desktop shortcut use a dark tile with a white Pi, visible in both light and dark Windows themes.
- **Startup page** — shows the current step, a progress bar, and live npm/pnpm output instead of a terminal.
- **Update check** — queries npm for `@earendil-works/pi-coding-agent` and `@agegr/pi-web` on every launch and offers to update them.
- **About panel** — the floating button in the bottom-right corner shows the Pi, Pi Web, and Pi Web Box versions, links each one to its website, and opens the Box settings window.
- **Automatic title bar theming** — Windows paints the native title bar with the current Pi Web theme background, so the frame blends into the page. Pi Web has five themes (Light, Dark, Mist, Rose, Pine); switching between them updates the title bar automatically.
- **Box settings** — a settings window styled like Pi Web's own settings, split into **Appearance & behavior** and **Pi Web configuration**.
- **Minimize to tray** — closing the window keeps Pi Web running in the notification area by default; it can be turned off in the settings.
- **Pi Web launch options** — configure port, hostname, allowed hosts, password, and the `pi-web` / Node.js paths from the settings window, then restart to apply them.
- **Config reset** — the startup page has a reset button that restores all Box settings and the launch command to automatic detection.
- **External links** — features that open a new tab (for example "Full history") are handed to your default browser.
- **Errors in the window** — failures are rendered inside the app with an "Open log" button.

## Dependencies

Pi Web Box is only a window around two external components. Both must be available on the machine; neither is bundled into the EXE.

| Component | Website | Role |
| --- | --- | --- |
| **Pi** | <https://pi.dev/> | The pi coding agent. Pi Web Box reads its version and can update the global `pi` package. |
| **Pi Web** | <https://github.com/agegr/pi-web> | The local browser UI that Pi Web Box displays. Its `pi-web.cmd` command must be on `PATH`. |

```powershell
npm install -g @earendil-works/pi-coding-agent@latest
npm install -g @agegr/pi-web@latest
```

## Requirements

- Windows 10/11 (current build target is Windows x64)
- Node.js **22.19.0 or newer**
- A global `pi-web` command on `PATH`

## Download and Install

Each release ships two artifacts:

| Artifact | Type | Notes |
| --- | --- | --- |
| `Pi Web Box Setup-<version>.exe` | Installer | Guided install, selectable install directory, Start Menu and desktop shortcuts, uninstall entry in Apps & Features |
| `Pi Web Box Portable-<version>.exe` | Portable | Single file, no installation, runs from a USB stick or any folder |

The installer installs per user by default and needs no administrator rights. Uninstalling keeps your Pi Web Box settings and logs.

## Quick Start

Download either artifact and run it. With the portable build, the app creates or updates a desktop shortcut named `Pi Web Box.lnk` that always points to the EXE you just started, so moving the portable file only requires starting it once from the new location. The installed build lets the installer manage its own shortcuts instead.

The app listens on `127.0.0.1` only and never exposes the service to the local network.

## Build from Source

```powershell
npm install
npm run typecheck
npm run dev      # build and run from source
npm run dist     # build the installer into dist/
```

`npm run dist` explicitly downloads Electron from `https://npmmirror.com/mirrors/electron/`, so an outdated global npm mirror configuration cannot break packaging.

Other targets are available when needed:

```powershell
npm run dist:nsis        # installer only
npm run dist:portable    # portable only
npm run dist:both        # installer and portable together
```

> Close any running Pi Web Box before packaging. Windows locks a running EXE, which makes the build stall at `building target=` without an error.

## Configuration

Environment variables, all optional:

| Variable | Purpose | Default |
| --- | --- | --- |
| `PI_WEB_BOX_COMMAND` | Absolute path to `pi-web.cmd` | Auto-detected from `PATH` |
| `PI_WEB_BOX_NODE` | Absolute path to `node.exe` | Auto-detected from `PATH` |
| `PI_WEB_BOX_PORT` | Preferred local port | `30141` |
| `PI_WEB_BOX_REGISTRY` | npm registry used for version checks and updates | `https://registry.npmjs.org` |
| `PI_WEB_BOX_SKIP_UPDATE_CHECK` | Set to `1` to skip the update check | Unset |

These variables only seed the initial settings file. After the first launch, Box settings are stored in `%APPDATA%/Pi Web Box/settings.json` and can be edited from the app. Logs are written to `%APPDATA%/Pi Web Box/logs/pi-web.log`.

### Pi Web launch options

The following Pi Web options are available in **Box settings → Pi Web configuration**:

| Option | Purpose |
| --- | --- |
| Port | `--port`, default `30141` |
| Hostname | `--hostname`, default `127.0.0.1` (local only) |
| Allowed hosts | `PI_WEB_ALLOWED_HOSTS` for reverse proxies or custom domains |
| Password | `PI_WEB_PASSWORD`, enables authentication |
| `pi-web` path | Absolute path to `pi-web.cmd`, empty means auto-detect |
| Node.js path | Absolute path to `node.exe`, empty means auto-detect |

## Notes

Pi Web Box uses the same pi configuration, credentials, sessions, and project files as pi itself and never modifies them. Closing the window quits the app and stops only the Pi Web service it started; a service it detected and reused is left running.

## Development Layout

```text
src/         Electron main process, preload, startup/error pages, version panel
scripts/     Asset generation and portable build verification
test/        node:test suites for process, version, and panel logic
assets/      Pi logos (SVG, PNG, ICO) generated by scripts/prepare-assets.mjs
```

Run the checks with:

```powershell
npm run typecheck
npm test
```