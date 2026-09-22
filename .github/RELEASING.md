# Releasing Brainpod Desktop

## The pipeline

| Workflow      | Trigger                               | What it does                                                                |
| ------------- | ------------------------------------- | --------------------------------------------------------------------------- |
| `ci.yml`      | PR, push to `main`, merge queue       | Version agreement, `tsc`, `vite build`, `cargo fmt`/`clippy`/`test`, and an unsigned bundle on macOS arm64, Linux x86_64 and Windows x86_64 |
| `release.yml` | Release published, or manual on a tag | Builds five targets at that tag and uploads them onto the release            |

## Cutting a release

Releases → **Draft a new release** → type a tag that does not exist yet
(`v0.2.0`; it is created on publish) → **Generate release notes** → **Publish**.

That is the whole process. Publishing creates the tag and starts **Release**,
which stamps `0.2.0` into `package.json`, `tauri.conf.json` and `Cargo.toml` in
its checkout, builds five targets, and uploads the bundles, `latest.json` and
one `.sig` per updater artifact onto the release.

Nothing is bumped beforehand and no commit is made: the tag is the version. The
version fields in the repository are a development placeholder that only affects
local builds — CI keeps those three consistent with each other, not with the
latest release.

The release is public while the matrix runs, so for those few minutes it has
notes and no downloads. Installed copies check
`releases/latest/download/latest.json`, which does not exist until the build
finishes; the app reads that as "no update" and says nothing.

If one platform flakes, re-run **Release** manually with the tag selected in the
ref dropdown. The action finds the same release and merges the new artifacts
into the existing `latest.json` rather than creating a second one.

## Artifacts per release

| Platform       | Installer                         | Updater artifact                |
| -------------- | --------------------------------- | ------------------------------- |
| macOS arm64    | `.dmg`                            | `.app.tar.gz`                   |
| macOS x86_64   | `.dmg`                            | `.app.tar.gz`                   |
| Linux x86_64   | `.AppImage`, `.deb`, `.rpm`       | the `.AppImage`                 |
| Linux arm64    | `.AppImage`, `.deb`, `.rpm`       | the `.AppImage`                 |
| Windows x86_64 | `-setup.exe` (NSIS), `.msi` (WiX) | the installers                  |

Every updater artifact is uploaded next to a detached `.sig`, and `latest.json`
carries the same signature inline. Tauri v2 hands the updater the payload
itself rather than a tarball of it, so on Linux and Windows the installer and
the update are one file. The manifest also lists per-bundle keys
(`linux-x86_64-deb`, `windows-x86_64-nsis`, …) beside the default one per
platform, which is what lets a `.deb` install update from a `.deb`.

The Linux arm64 job runs on a native `ubuntu-24.04-arm` runner because AppImage
tooling has no cross-architecture mode. Those runners are free for public
repositories; if this repository ever goes private, that matrix entry needs a
paid larger runner or it has to be dropped.

Linux bundles are built on Ubuntu 24.04, so `.deb`/`.rpm`/`.AppImage` require
glibc 2.39 or newer. That is Ubuntu 24.04, Debian 13, Fedora 40 and up.

### Version-less copies

`releases/latest/download/<name>` resolves the newest release but not the asset
inside it, and every bundler stamps the version into its filename, so a README
link built from one would break at the next tag. After the bundle step each job
runs `.github/scripts/stable-aliases.mjs`, which uploads a second copy of that
platform's installers under a name that never moves:

```
Brainpod-arm64-macos.dmg        Brainpod-amd64-macos.dmg
Brainpod-amd64-linux.AppImage   Brainpod-arm64-linux.AppImage
Brainpod-amd64-linux.deb        Brainpod-arm64-linux.deb
Brainpod-amd64-linux.rpm        Brainpod-arm64-linux.rpm
Brainpod-amd64-windows-setup.exe
Brainpod-amd64-windows.msi
```

They are plain copies, uploaded with `--clobber` so a re-run replaces its own
earlier attempt. Updater payloads deliberately keep their stamped names —
`latest.json` names them outright, and a signature belongs to one build. The
cost is storing each installer twice; the benefit is that the README's download
table never has to be edited again.

## Organization settings

The `brainpodnl` organization allows only selected actions, so every
third-party action either matches a pattern in that allowlist or the run dies
at startup — before a single step, with `startup_failure` and no logs. These
four are what the two workflows reach for:

```
dtolnay/rust-toolchain@stable
pnpm/action-setup@v6
Swatinem/rust-cache@v2
tauri-apps/tauri-action@v1
```

`actions/*` is covered separately by "allow actions created by GitHub". The
patterns are pinned to a major version, so a Dependabot bump of any of the four
fails at startup until an organization owner widens the entry — Organization
settings → Actions → General → Allow specified actions and reusable workflows.

`GITHUB_TOKEN` may stay on the organization default of read-only permissions:
the jobs that upload assets ask for `contents: write` themselves.

## Secrets

### `TAURI_SIGNING_PRIVATE_KEY` (required)

The updater refuses any payload that is not signed by the key whose public half
is baked into `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). The
release workflow fails fast when the secret is missing, because an unsigned
release is one that no installed copy can ever accept.

The keypair was generated with `tauri signer generate` and lives at
`~/.tauri/brainpod-desktop-updater.key` on the machine that set this up. Load it
into the repository once:

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo brainpodnl/desktop \
  < ~/.tauri/brainpod-desktop-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo brainpodnl/desktop --body ''
```

Back the private key up somewhere durable. Losing it means every installed copy
is stranded on its current version: a new key would produce signatures the
shipped `pubkey` rejects, and the only way out is asking every user to download
a fresh build by hand.

### macOS signing and notarization (optional, not yet configured)

Without these, macOS bundles still build and upload, but Gatekeeper refuses to
open them on a normal double-click. Set all six and the release workflow signs
and notarizes with no further edits — the Tauri CLI reads them directly and
skips both steps while they are empty.

| Secret                       | Value                                                            |
| ---------------------------- | ---------------------------------------------------------------- |
| `APPLE_CERTIFICATE`          | base64 of the Developer ID Application `.p12` (`base64 -i cert.p12`) |
| `APPLE_CERTIFICATE_PASSWORD` | password used when exporting that `.p12`                          |
| `APPLE_SIGNING_IDENTITY`     | e.g. `Developer ID Application: Brainpod B.V. (TEAMID)`           |
| `APPLE_ID`                   | Apple account email                                               |
| `APPLE_PASSWORD`             | an app-specific password, not the account password                |
| `APPLE_TEAM_ID`              | 10-character team identifier                                      |

### Windows signing (optional, not yet configured)

Unsigned Windows installers work, but SmartScreen warns on first run until the
binary builds reputation. Two supported routes, both of which need a change to
`release.yml` as well as secrets:

- **Azure Trusted Signing** — no certificate material in CI. Add
  `bundle.windows.signCommand` to `src-tauri/tauri.conf.json` invoking
  `trusted-signing-cli`, and give the job the Azure credentials it expects.
- **`.pfx` certificate** — add a Windows-only step that imports the base64 `.pfx`
  into `Cert:\CurrentUser\My`, then pass the resulting thumbprint through
  `--config '{"bundle":{"windows":{"certificateThumbprint":"..."}}}'`.

Both are documented at <https://v2.tauri.app/distribute/sign/windows/>. Neither
is wired up here, deliberately: a signing path nobody can run is a path nobody
can tell is broken.
