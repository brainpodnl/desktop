<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/hero-dark.gif">
  <img src=".github/hero.gif" alt="Brainpod — build it in Claude, Cursor or Codex, host it in Europe" width="900">
</picture>

# Brainpod Desktop

**Your apps, hosted in Europe — on your desk.**

[Brainpod](https://brainpod.io) runs the things you build: your app, its routes and domains, its
Postgres, MariaDB, Valkey or SQL Server database, its disks and config — all in one **pod**, all
hosted in Europe. You describe what you want, Brainpod runs it, and nothing changes until you
deploy.

Brainpod Desktop is the window you keep open while you work. Instead of tabbing to a browser or
remembering a command, you glance at it: there is your pod, drawn as the graph it actually is, in
the colours of the engines inside it — healthy or not, wired the way you wired it.

## What you can do with it

- **See the whole pod at a glance.** Every app, route, database, disk and config, with the links
  between them drawn for you. Green means running.
- **Watch what your app is doing right now.** Application logs, HTTP access and platform events,
  live, next to the resource that emitted them.
- **Connect your own tools to a hosted database.** Open a secure tunnel and your database gets a
  real port on this machine — point `psql`, DBeaver, TablePlus or your local dev server at
  `localhost` and work as if it were next door. Tunnels stay open in the sidebar while you move
  around.
- **Scale and resize without leaving the window.** Change replicas or instance size; it lands in
  the pod's draft.
- **Deploy when you're ready.** Edits sit safely in the draft until you press Deploy — what's
  running keeps running until you say otherwise.
- **Jump back in time.** Read the graph at any revision to see how the pod looked when it was
  deployed.

It's a real Mac-style app — a vibrancy sidebar, native menus, light and dark — not a website in a
frame. And it shares its sign-in with the `brainpod` CLI, so you log in once.

## Download

Every link below is always the newest build:

| Platform       | Download |
| -------------- | -------- |
| macOS arm64    | [`.dmg`](https://github.com/brainpodnl/desktop/releases/latest/download/Brainpod-arm64-macos.dmg) |
| macOS x86_64   | [`.dmg`](https://github.com/brainpodnl/desktop/releases/latest/download/Brainpod-amd64-macos.dmg) |
| Linux x86_64   | [`.AppImage`](https://github.com/brainpodnl/desktop/releases/latest/download/Brainpod-amd64-linux.AppImage) · [`.deb`](https://github.com/brainpodnl/desktop/releases/latest/download/Brainpod-amd64-linux.deb) · [`.rpm`](https://github.com/brainpodnl/desktop/releases/latest/download/Brainpod-amd64-linux.rpm) |
| Linux arm64    | [`.AppImage`](https://github.com/brainpodnl/desktop/releases/latest/download/Brainpod-arm64-linux.AppImage) · [`.deb`](https://github.com/brainpodnl/desktop/releases/latest/download/Brainpod-arm64-linux.deb) · [`.rpm`](https://github.com/brainpodnl/desktop/releases/latest/download/Brainpod-arm64-linux.rpm) |
| Windows x86_64 | [`-setup.exe`](https://github.com/brainpodnl/desktop/releases/latest/download/Brainpod-amd64-windows-setup.exe) · [`.msi`](https://github.com/brainpodnl/desktop/releases/latest/download/Brainpod-amd64-windows.msi) |

Older versions live on the [releases page](https://github.com/brainpodnl/desktop/releases).

Launch it, sign in through your browser, and your pods are there.

### Before the first launch

- **macOS 11 or newer.** The builds aren't notarized yet, so macOS blocks the first launch. Drag
  Brainpod into `/Applications`, then run once:

  ```sh
  xattr -dr com.apple.quarantine /Applications/Brainpod.app
  ```

- **Linux** builds need glibc 2.39 or newer — Ubuntu 24.04, Debian 13, Fedora 40 and up.
- **Windows** installers are unsigned, so SmartScreen warns the first time. Choose *More info ▸
  Run anyway*.

### Staying up to date

Brainpod Desktop updates itself. It checks on launch, downloads quietly in the background, and
asks for a restart when it's ready — only ever accepting builds signed by us. If anything else on
your machine has fallen behind, the sidebar's **Updates** band tells you in the same place.

## The command line, installed for you

Settings ▸ **Command line** installs the [`brainpod` CLI](https://github.com/brainpodnl/cli) —
the same tool, without the window — and keeps it current. It shares this app's sign-in, so
there's nothing else to configure.

If you already have `brainpod`, it's updated where it is, so you never end up with two of them.
Installs managed by Homebrew or another package manager are left to that package manager. A fresh
install goes somewhere your shell already looks (`/usr/local/bin` on macOS and Linux,
`%LOCALAPPDATA%\Microsoft\WindowsApps` on Windows). **Your shell profile is never touched**, and
every download is checksum-verified before anything is written.

## Let your coding agent deploy

The row of marks at the foot of the sidebar installs the
[Brainpod Agent Skill](https://github.com/brainpodnl/skills) into the coding agents you already
use, so they can deploy, operate and debug your pod for you. A tile lights up for every agent
that has it.

| Agent       | Installs into                |
| ----------- | ---------------------------- |
| Claude Code | `~/.claude/skills/brainpod`  |
| Codex       | `~/.agents/skills/brainpod`  |
| Cursor      | `~/.cursor/skills/brainpod`  |
| Gemini CLI  | `~/.gemini/skills/brainpod`  |

Only agents found on this machine are offered, and updates are handled the same way as the app
itself. Agents read their skills at startup, so restart one that's already running.

## Build it yourself

Needs Rust (stable), Node 24 and pnpm. On Linux, also the WebKitGTK packages listed in
[`.github/workflows/release.yml`](.github/workflows/release.yml).

```sh
pnpm install
pnpm start       # the app window, with hot reload
```

| Command          | What it does                            |
| ---------------- | --------------------------------------- |
| `pnpm start`     | run the desktop app in development      |
| `pnpm typecheck` | type-check the webview                  |
| `pnpm build`     | build the webview bundle                |
| `pnpm bundle`    | build installers for this machine       |

There's no test runner: `pnpm typecheck` and `pnpm build`, plus `cargo fmt`, `clippy` and `test`
in `src-tauri/`, are what CI enforces. The version in `package.json`,
`src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` must match — CI checks that too.

## Releasing

Draft a release on GitHub with a new `v*` tag and publish it; the workflow builds and uploads
every platform. Details in [`.github/RELEASING.md`](.github/RELEASING.md).
