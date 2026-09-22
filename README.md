<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/hero-dark.gif">
  <img src=".github/hero.gif" alt="Brainpod: build it in Claude, Cursor or Codex, host it in Europe" width="900">
</picture>

# Brainpod Desktop

Your apps, hosted in Europe, on your desk.

[Brainpod](https://brainpod.io) runs what you build: your app, its routes and domains, its
Postgres, MariaDB, Valkey or SQL Server database, its disks and config. One pod holds all of it,
and nothing changes until you deploy.

Brainpod Desktop is the window you keep open while you work. No browser tab, no command to
remember: your pod is on screen, drawn as the graph it is, green when it's running.

## Download

These links always point at the newest build:

| Platform       | Download |
| -------------- | -------- |
| macOS arm64    | [`.dmg`](https://github.com/brainpodnl/desktop/releases/latest/download/Brainpod-arm64-macos.dmg) |
| macOS x86_64   | [`.dmg`](https://github.com/brainpodnl/desktop/releases/latest/download/Brainpod-amd64-macos.dmg) |
| Linux x86_64   | [`.AppImage`](https://github.com/brainpodnl/desktop/releases/latest/download/Brainpod-amd64-linux.AppImage) · [`.deb`](https://github.com/brainpodnl/desktop/releases/latest/download/Brainpod-amd64-linux.deb) · [`.rpm`](https://github.com/brainpodnl/desktop/releases/latest/download/Brainpod-amd64-linux.rpm) |
| Linux arm64    | [`.AppImage`](https://github.com/brainpodnl/desktop/releases/latest/download/Brainpod-arm64-linux.AppImage) · [`.deb`](https://github.com/brainpodnl/desktop/releases/latest/download/Brainpod-arm64-linux.deb) · [`.rpm`](https://github.com/brainpodnl/desktop/releases/latest/download/Brainpod-arm64-linux.rpm) |
| Windows x86_64 | [`-setup.exe`](https://github.com/brainpodnl/desktop/releases/latest/download/Brainpod-amd64-windows-setup.exe) · [`.msi`](https://github.com/brainpodnl/desktop/releases/latest/download/Brainpod-amd64-windows.msi) |

Older versions: [releases](https://github.com/brainpodnl/desktop/releases).

## What you can do with it

- **See the whole pod.** Every app, route, database, disk and config, with the links between them
  drawn for you.
- **Watch it live.** Application logs, HTTP access and platform events, next to the resource that
  emitted them.
- **Use your own database tools.** Open a tunnel and a hosted database gets a real port on this
  machine. Point `psql`, DBeaver, TablePlus or your dev server at `localhost`. Tunnels stay open
  in the sidebar while you move around.
- **Scale and resize.** Change replicas or instance size in place.
- **Deploy when ready.** Edits wait in the draft. What's running keeps running until you press
  Deploy.
- **Look back.** Read the graph at any earlier revision.

A real Mac app, not a website in a frame. It shares its sign-in with the `brainpod` CLI, so you
log in once.

## First launch

Launch it, sign in through your browser, and your pods are there.

**macOS 11+.** Not notarized yet, so the first launch is blocked. Drag Brainpod into
`/Applications`, then run:

```sh
xattr -dr com.apple.quarantine /Applications/Brainpod.app
```

**Linux** needs glibc 2.39 or newer (Ubuntu 24.04, Debian 13, Fedora 40 and up). **Windows**
installers are unsigned, so SmartScreen warns once: choose *More info ▸ Run anyway*.

The app updates itself. It checks on launch, downloads in the background, and asks for a restart
when it's ready. Only builds signed by us are accepted.

## Command line

Settings ▸ **Command line** installs the [`brainpod` CLI](https://github.com/brainpodnl/cli) and
keeps it current. It shares this app's sign-in, so there's nothing to configure.

An existing `brainpod` is updated where it is, so you never end up with two. Homebrew and other
package manager installs are left alone. A fresh install goes where your shell already looks
(`/usr/local/bin` on macOS and Linux, `%LOCALAPPDATA%\Microsoft\WindowsApps` on Windows). Your
shell profile is never touched, and every download is checksum-verified before it's written.

## Agent skill

The marks at the foot of the sidebar install the
[Brainpod Agent Skill](https://github.com/brainpodnl/skills) into your coding agents, so they can
deploy, operate and debug your pod for you. A tile lights up for every agent that has it.

| Agent       | Installs into                |
| ----------- | ---------------------------- |
| Claude Code | `~/.claude/skills/brainpod`  |
| Codex       | `~/.agents/skills/brainpod`  |
| Cursor      | `~/.cursor/skills/brainpod`  |
| Gemini CLI  | `~/.gemini/skills/brainpod`  |

Only agents found on this machine are offered. Agents read their skills at startup, so restart
one that's already running.

## Build it yourself

Needs Rust (stable), Node 24 and pnpm. On Linux, also the WebKitGTK packages listed in
[`.github/workflows/release.yml`](.github/workflows/release.yml).

```sh
pnpm install
pnpm start       # the app window, with hot reload
```

| Command          | What it does                       |
| ---------------- | ---------------------------------- |
| `pnpm start`     | run the desktop app in development |
| `pnpm typecheck` | type-check the webview             |
| `pnpm build`     | build the webview bundle           |
| `pnpm bundle`    | build installers for this machine  |

No test runner. CI enforces `pnpm typecheck` and `pnpm build`, plus `cargo fmt`, `clippy` and
`test` in `src-tauri/`, and checks that the version in `package.json`,
`src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` matches.

## Releasing

Draft a release on GitHub with a new `v*` tag and publish it. The workflow builds and uploads
every platform. Details in [`.github/RELEASING.md`](.github/RELEASING.md).
