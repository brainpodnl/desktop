# Releasing Brainpod Desktop

## The pipeline

| Workflow      | Trigger                               | What it does                                                                |
| ------------- | ------------------------------------- | --------------------------------------------------------------------------- |
| `ci.yml`      | PR, push to `main`, merge queue       | Version agreement, `tsc`, `vite build`, `cargo fmt`/`clippy`/`test`, and an unsigned bundle on macOS arm64, Linux x86_64 and Windows x86_64 |
| `release.yml` | Release published, or manual on a tag | Builds five targets at that tag and uploads them onto the release            |
| `notarize.yml`| Every 30 minutes, or manual           | Staples disk images whose notarization Apple had not finished when the release ended |

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

### macOS signing and notarization

Signing is gated on the `MACOS_SIGNING` repository variable, which must be
exactly `on`. The six secrets stay loaded regardless, so the gate is the only
switch:

```sh
gh variable set MACOS_SIGNING --repo brainpodnl/desktop --body on
gh variable set MACOS_SIGNING --repo brainpodnl/desktop --body off
```

Signing and notarization are deliberately separate. `tauri build` notarizes
inline — it submits the app and blocks on `notarytool --wait`, which has no
upper bound — and Apple's notary service can hold a submission indefinitely.
Submissions from this certificate on its first day sat in `In Progress` past
107 minutes while `Developer ID Notary Service` reported `operational`, which
matches the backlog other teams reported through September 2026 and Apple's
own note that a new signing identity is held for additional analysis until the
service learns to recognise it. Two release runs were cancelled over it.

So the macOS jobs never receive `APPLE_ID`, `APPLE_PASSWORD` or
`APPLE_TEAM_ID`: with only the three signing values in the environment, the
bundler signs and skips notarization, which costs seconds. Notarization then
runs as its own step after the bundles are already on the release:

1. `release.yml` submits the `.dmg` and waits at most
   `MACOS_NOTARIZE_WAIT_MINUTES` (default 10). If Apple answers, the disk
   image is stapled and re-uploaded before the job ends, and the release is
   complete.
2. Otherwise the step writes a `notarization-<slug>.json` marker asset naming
   the submission and exits green. The release carries signed but unstapled
   disk images for the moment.
3. `notarize.yml` runs every 30 minutes. A Linux job checks whether any marker
   exists — seconds, and no macOS minutes — and only then does a macOS job
   staple the accepted submissions, replace both the stamped and version-less
   copies, and delete the marker.

A rejection fails loudly; a submission still queued just leaves the marker for
the next pass. No job ever waits on Apple for longer than the bound.

The ticket is stapled to the `.dmg`, not to the `.app` inside it, because
stapling the app would mean rebuilding and re-signing the disk image around it.
Apple supports stapling a disk image directly. The cost is that a Mac that is
offline on first launch cannot see the app's own ticket; every online Mac
resolves it against Apple.

`release.yml` forwards only non-empty secrets, because an empty
`APPLE_CERTIFICATE` would make the bundler run `security import` on nothing
and fail the bundle.

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

Needed when `MACOS_SIGNING` is `off`, or to reproduce a release by hand. The
Mac must hold the Developer ID certificate in its login keychain. Credentials
go in a `notarytool` profile rather than the shell:

```sh
xcrun notarytool store-credentials brainpod \
  --apple-id jeroen@rinzema.dev --team-id 97JW6XK5WV
```

That profile lives in the data-protection keychain, which the `security` tool
cannot read — there is no way to pull the password back out into an
environment variable, which is the point. `notarize-dmg.mjs` reads
`APPLE_KEYCHAIN_PROFILE` for exactly this case.

Build from a checkout of the tag being released so the stamped version
matches. `APPLE_CERTIFICATE` must stay unset: the identity is already in the
keychain, and setting it would import a second copy into a throwaway one.
Leaving the notary credentials unset is deliberate too — it makes the bundler
sign and skip notarization, the same split CI uses.

```sh
export APPLE_SIGNING_IDENTITY='Developer ID Application: CloudProud B.V. (97JW6XK5WV)'
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/brainpod-desktop-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=''
pnpm tauri build --target aarch64-apple-darwin
pnpm tauri build --target x86_64-apple-darwin
```

Then notarize and upload each architecture with the same script CI runs:

```sh
export APPLE_KEYCHAIN_PROFILE=brainpod
node .github/scripts/notarize-dmg.mjs submit v0.1.0 arm64-macos aarch64-apple-darwin 20
node .github/scripts/notarize-dmg.mjs submit v0.1.0 amd64-macos x86_64-apple-darwin 20
```

The updater tarballs are separate: `latest.json` names them by asset id and
carries their `.sig` inline, so replacing them by hand means uploading the new
`Brainpod_<version>_<arch>.app.tar.gz` and `.sig`, then patching both the
`url` and `signature` of the four `darwin-*` keys. The asset id changes on
every `--clobber`, so the url has to be re-read after the upload, not before.

Verify what a user actually downloads, quarantine included:

```sh
curl -fsSLo dl.dmg https://github.com/brainpodnl/desktop/releases/latest/download/Brainpod-arm64-macos.dmg
xattr -w com.apple.quarantine '0083;00000000;Safari;' dl.dmg
spctl -a -vvv -t open --context context:primary-signature dl.dmg   # accepted, Notarized Developer ID
```

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
