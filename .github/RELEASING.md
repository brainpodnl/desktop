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

### macOS signing and notarization (configured, currently off in CI)

All six secrets are loaded, but the macOS jobs only use them when the
`MACOS_SIGNING` repository variable is exactly `on`. It is `off`, so CI builds
macOS unsigned and signed bundles are produced locally instead.

The reason is Apple, not the configuration: `notarytool --wait` blocks until
the notary service returns a verdict and that service publishes no upper bound.
Submissions from this certificate sat in `In Progress` past 107 minutes with
`Developer ID Notary Service` reporting `operational`, which matches the
backlog other teams reported through September 2026 and Apple's own note that
a new signing identity is held for additional analysis until the service
learns to recognise it. A release must not be hostage to that.

```sh
gh variable set MACOS_SIGNING --repo brainpodnl/desktop --body on   # re-enable
```

With it `on`, each macOS job signs the `.app`, notarizes it, staples the
ticket, and builds the `.dmg` and updater tarball around the stapled bundle.
`release.yml` forwards only non-empty secrets, because an empty
`APPLE_CERTIFICATE` would make the bundler run `security import` on nothing
and fail.

| Secret                       | Value                                                            |
| ---------------------------- | ---------------------------------------------------------------- |
| `APPLE_CERTIFICATE`          | base64 of the Developer ID Application `.p12` (`openssl base64 -A -in cert.p12`) |
| `APPLE_CERTIFICATE_PASSWORD` | password used when exporting that `.p12`                          |
| `APPLE_SIGNING_IDENTITY`     | `Developer ID Application: CloudProud B.V. (97JW6XK5WV)`          |
| `APPLE_ID`                   | `jeroen@rinzema.dev`                                              |
| `APPLE_PASSWORD`             | an app-specific password, not the account password                |
| `APPLE_TEAM_ID`              | `97JW6XK5WV`                                                      |

It is all six or none. `tauri-bundler` only builds its temporary keychain when
`APPLE_CERTIFICATE` and `APPLE_CERTIFICATE_PASSWORD` are both present; with
only `APPLE_SIGNING_IDENTITY` set it looks for that identity in the runner's
empty keychain and `codesign` fails. `APPLE_SIGNING_IDENTITY` must also be a
substring of the certificate's own common name or the bundler refuses the pair
outright. Notarization prefers the Apple ID triple and falls back to
`APPLE_API_KEY`/`APPLE_API_ISSUER`/`APPLE_API_KEY_PATH`; missing credentials
only warn, wrong ones fail the job.

The certificate expires 2031-09-17. Bundles signed before then keep working
afterwards — the notarization ticket and the secure timestamp outlive it — but
no new build can be signed until the certificate is replaced.

To verify a published build:

```sh
codesign -dv --verbose=4 /Applications/Brainpod.app
xcrun stapler validate /Applications/Brainpod.app
spctl -a -vvv -t install /Applications/Brainpod.app
```

### Signing a macOS build locally

While `MACOS_SIGNING` is `off`, the macOS assets on a release come from a Mac
that holds the Developer ID certificate in its login keychain. Credentials live
in a `notarytool` keychain profile rather than in the shell:

```sh
xcrun notarytool store-credentials brainpod \
  --apple-id jeroen@rinzema.dev --team-id 97JW6XK5WV
```

Build one architecture at a time, from a checkout of the tag being released so
the bundled version matches:

```sh
export APPLE_SIGNING_IDENTITY='Developer ID Application: CloudProud B.V. (97JW6XK5WV)'
export APPLE_ID=jeroen@rinzema.dev APPLE_TEAM_ID=97JW6XK5WV
export APPLE_PASSWORD="$(security find-generic-password -s 'com.apple.gke.notary.tool' -a brainpod -w)"
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/brainpod-desktop-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=''
pnpm tauri build --target aarch64-apple-darwin
pnpm tauri build --target x86_64-apple-darwin
```

The certificate is already in the keychain, so `APPLE_CERTIFICATE` must stay
unset — setting it would make the bundler import a second copy into a throwaway
keychain for no reason. Each build blocks on notarization exactly as CI did; it
is merely a wait nobody is paying runner time for.

Then upload, replacing the unsigned assets the release already carries:

```sh
cd src-tauri/target/aarch64-apple-darwin/release/bundle
gh release upload v0.1.0 --repo brainpodnl/desktop --clobber \
  dmg/Brainpod_0.1.0_aarch64.dmg macos/Brainpod.app.tar.gz macos/Brainpod.app.tar.gz.sig
```

The updater artifacts are renamed per platform and `latest.json` carries the
`.sig` contents inline, so the two `darwin-*` signature fields in `latest.json`
have to be replaced by hand to match the locally built tarballs. Verify with
the three commands above before uploading; an unstapled bundle still passes
Gatekeeper on a networked Mac, but only a stapled one passes offline.

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
