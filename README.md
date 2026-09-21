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
the background, and then offers a restart. Updater payloads are signature-verified against the
public key baked into `src-tauri/tauri.conf.json`, so an unsigned or foreign build is never
accepted. A failed or unreachable check is silent.

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
