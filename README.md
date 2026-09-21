<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/hero-dark.gif">
  <img src=".github/hero.gif" alt="Brainpod — build it in Claude, Cursor or Codex, host it in Europe" width="900">
</picture>

# Brainpod Desktop

A desktop window onto your Brainpod pods: the resource graph at a chosen revision, its health, the
events a resource is emitting right now, and database tunnels bound to real ports on this machine.

## Install

Download the build for your platform from the
[latest release](https://github.com/brainpodnl/desktop/releases/latest):

| Platform       | Download                          |
| -------------- | --------------------------------- |
| macOS arm64    | `.dmg` (`aarch64`)                |
| macOS x86_64   | `.dmg` (`x64`)                    |
| Linux x86_64   | `.AppImage`, `.deb`, `.rpm`       |
| Linux arm64    | `.AppImage`, `.deb`, `.rpm`       |
| Windows x86_64 | `-setup.exe` (NSIS), `.msi` (WiX) |

macOS requires 11.0 or newer. The macOS builds are not notarized yet, so Gatekeeper refuses the
first launch; clear the quarantine attribute after dragging the app into `/Applications`:

```sh
xattr -dr com.apple.quarantine /Applications/Brainpod.app
```

Linux bundles are built on Ubuntu 24.04 and need glibc 2.39 or newer — Ubuntu 24.04, Debian 13,
Fedora 40 and up. Windows installers are unsigned, so SmartScreen warns on first run.

Launch it and sign in; the browser round trip writes the API token into the shared CLI config.

### Updates

The app checks `releases/latest/download/latest.json` once per launch, installs a newer version in
the background, and then offers a restart in the sidebar's **Updates** band — the same band the
CLI and the agent skill use, because they are one question: something on this machine is not the
current version. Each row is named for what it is (`Brainpod`, `Command line`, `Agent skill`)
rather than being told apart by a capital letter and a monospace font.
The band is absent until there is something to act on, and it stays until acted on rather than
being dismissible, since it occupies its own space in the rail instead of floating over the graph. Updater payloads are signature-verified against the
public key baked into `src-tauri/tauri.conf.json`, so an unsigned or foreign build is never
accepted. A failed or unreachable check is silent.

### Command line

Settings ▸ **Command line** installs the [`brainpod` CLI](https://github.com/brainpodnl/cli) —
the tool this window shares its config file and API token with, and the one the agent skill
drives.

A `brainpod` that is already on this machine is **updated where it stands**, so a developer ends
up with one CLI kept current rather than two competing on `PATH`. Only a real file is adopted: a
symlink in `/opt/homebrew/bin` or `~/.local/bin` points into a package manager's own store, and
writing through it would overwrite that store's file, so such a copy is reported and left alone.
A machine with no CLI on it gets one in a directory the platform already puts on `PATH` —
`/usr/local/bin` on macOS and Linux (the first line of `/etc/paths`, and where Zed, VS Code and
OrbStack put theirs), `%LOCALAPPDATA%\Microsoft\WindowsApps` on Windows. **Nothing in your shell
profile is ever edited.**

| OS      | Architecture      | Release asset                   |
| ------- | ----------------- | ------------------------------- |
| macOS   | Apple silicon     | `brainpod-arm64-macos.tar.gz`   |
| macOS   | Intel             | `brainpod-amd64-macos.tar.gz`   |
| Linux   | `arm64`           | `brainpod-arm64-linux.tar.gz`   |
| Linux   | `x86_64`          | `brainpod-amd64-linux.tar.gz`   |
| Windows | `x86_64`          | `brainpod-amd64-windows.zip`    |

The download is checked against the release's own `SHA256SUMS` before anything is written, and
the binary is staged in the app's data directory first — so on macOS and Linux the one
authorization prompt covers a single `install(1)` of a file that is already complete and
verified on disk. Windows needs no prompt at all.

An out-of-date CLI is offered in the sidebar's **Updates** band as well as here; both read one
store (`src/lib/cli.ts`), so the two can never disagree about what is installed or what is
published. The band offers an out-of-date agent skill the same way, updating every agent that
has fallen behind in one download; its staleness rule is `src/lib/skills.ts`, shared with the
fan at the foot of the sidebar. Only a skill this window installed can be called out of date —
a directory it did not write carries no receipt, so there is no version to compare.

A release is public for the ten minutes its build matrix takes, so the newest tag regularly
carries no binaries yet; the window says so and offers the newest release that does have this
platform's build. Staleness is judged from the install receipt — the release this window
actually fetched — because `brainpodnl/cli` stamps its binaries from a `VERSION` file rather
than from the tag, and a binary's own `--version` is therefore not comparable to a release name.
Removal is offered only for a binary this window itself wrote and that is still byte-for-byte
what it wrote; an adopted install is kept current but never deleted.

### Agent skill

The fan of marks at the foot of the sidebar installs the
[`brainpod` Agent Skill](https://github.com/brainpodnl/skills) into the coding agents on this
machine, so they can deploy, operate and debug a pod with the `brainpod` CLI. A tile stands lit
for an agent that already holds it.

| Agent       | Skills directory                                            |
| ----------- | ----------------------------------------------------------- |
| Claude Code | `~/.claude/skills/brainpod`                                  |
| Codex       | `~/.agents/skills/brainpod` (the shared Agent Skills path)   |
| Cursor      | `~/.cursor/skills/brainpod`                                  |
| Gemini CLI  | `~/.gemini/skills/brainpod`                                  |

Only agents this machine actually has are listed — one that has run here, or whose CLI is on
`PATH`, plus any directory that already holds the skill. Every path is home-relative, so Windows
resolves the same table under `%USERPROFILE%`. Installing
downloads `skills/brainpod` from the repository's default branch, writes it through a staging
directory next to the target, and leaves a `.brainpod-desktop.json` receipt carrying the version.
That receipt is what lets the window call an install current or out of date — and what makes it
refuse to delete a skill directory it did not write, such as a symlink into your own clone. An
agent reads its skills at startup, so restart one that is already running.

## Development

Needs Rust (stable), Node 24 and pnpm. On Linux also the WebKitGTK toolchain listed in
[`.github/workflows/release.yml`](.github/workflows/release.yml).

```sh
pnpm install
pnpm start       # tauri dev — the app window, with HMR on the webview
```

| Command          | What it does                              |
| ---------------- | ----------------------------------------- |
| `pnpm start`     | run the desktop app in development         |
| `pnpm typecheck` | `tsc --noEmit`                             |
| `pnpm build`     | build the webview bundle                   |
| `pnpm bundle`    | `tauri build` — installers for this host   |

There is no test runner: `pnpm typecheck` and `pnpm build` plus `cargo fmt`/`clippy`/`test` in
`src-tauri/` are the gates CI enforces.

The three version files — `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` —
must agree with each other, and CI refuses a build where they do not. They only affect local
builds: a release takes its version from its tag.

## Releasing

See [`.github/RELEASING.md`](.github/RELEASING.md). In short: draft a release on GitHub with a new
`v*` tag and publish it. Publishing creates the tag and starts the **Release** workflow, which
stamps that version into the checkout, builds all five targets, and uploads them together with the
signed `latest.json`.
