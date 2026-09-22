use std::fs;
use std::io::Read;
use std::path::{MAIN_SEPARATOR, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tar::Archive;

/// The `brainpod` command-line tool, and how this window puts it on a machine
/// that does not have it.
///
/// The one rule the rest of this file exists to keep: **nothing in the user's
/// shell is edited.** The binary goes to a directory the platform itself
/// already puts on `PATH`, so a terminal opened after the install finds it
/// without a profile having been rewritten behind the user's back.
pub const REPO: &str = "https://github.com/brainpodnl/cli";

/// Releases, not the `latest/download` redirect the skill installer uses.
///
/// A release is public for the ten minutes its build matrix takes, so the
/// newest one regularly carries no binaries at all, and the redirect answers
/// that with a 404 the user cannot act on. The list says which release
/// actually has this platform's build, which is the only thing worth
/// offering. Unauthenticated, so it shares an hourly budget per address; the
/// webview holds the answer rather than asking again.
const RELEASES_URL: &str = "https://api.github.com/repos/brainpodnl/cli/releases?per_page=10";

/// How many of those releases are worth walking back through. A platform
/// missing from ten consecutive releases is not a release still publishing,
/// it is a platform the CLI stopped building.
const RELEASE_DEPTH: usize = 10;

/// The file every release publishes beside its archives, and the only reason
/// this window can claim the bytes it wrote are the bytes that were built.
const CHECKSUMS: &str = "SHA256SUMS";

const BINARY: &str = if cfg!(windows) {
    "brainpod.exe"
} else {
    "brainpod"
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// The archives run just over four megabytes. Anything approaching this is a
/// URL that stopped pointing at a release, and it is read into memory here.
const MAX_ARCHIVE: usize = 64 * 1024 * 1024;

/// How long the installed binary gets to answer `--version` before the row
/// gives up and says nothing. It is a local process start; a machine where
/// this expires has a bigger problem than an unknown version.
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

/// Directories worth looking in for a `brainpod` that is not ours, on top of
/// whatever `PATH` this process happens to have. A window launched from the
/// Finder inherits a `PATH` of four entries, so the places a developer
/// actually installs things have to be named.
const COMMON_BIN: [&str; 5] = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/opt/local/bin",
    "/snap/bin",
    "/usr/bin",
];

/// The same, relative to the home directory.
const COMMON_HOME_BIN: [&str; 2] = [".local/bin", "bin"];

/// What this window remembers about the binary it wrote, kept in the app's own
/// data directory rather than beside the binary: `/usr/local/bin` holds
/// executables, and a stray JSON file in it is litter in a directory shared
/// with every other tool on the machine.
const RECEIPT: &str = "cli-install.json";

/// Where the binary goes, per platform, and what it costs to write there.
///
/// macOS and Linux both put `/usr/local/bin` on the default `PATH` — it is the
/// first line of `/etc/paths` on a stock Mac — and it is where Zed, VS Code and
/// OrbStack put their own command-line tools. It is owned by root, so writing
/// into it takes one authorization prompt, which is the trade this window
/// makes rather than appending to a shell profile.
///
/// Windows has no root-owned equivalent worth using, and no elevation is
/// needed: `%LOCALAPPDATA%\Microsoft\WindowsApps` is user-writable and the OS
/// puts it on the user's own `Path`.
///
/// It is only the fallback: a `brainpod` already on this machine is updated
/// where it stands, and [`target`] is what decides.
#[cfg(not(windows))]
fn default_directory(_local_data: &Path) -> PathBuf {
    PathBuf::from("/usr/local/bin")
}

#[cfg(windows)]
fn default_directory(local_data: &Path) -> PathBuf {
    local_data.join("Microsoft").join("WindowsApps")
}

/// The release asset this machine takes. `None` is a platform the CLI does not
/// publish a build for, which the dialog states rather than working around.
fn asset() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("brainpod-arm64-macos.tar.gz"),
        ("macos", "x86_64") => Some("brainpod-amd64-macos.tar.gz"),
        ("linux", "aarch64") => Some("brainpod-arm64-linux.tar.gz"),
        ("linux", "x86_64") => Some("brainpod-amd64-linux.tar.gz"),
        ("windows", "x86_64") => Some("brainpod-amd64-windows.zip"),
        _ => None,
    }
}

/// The machine in the words its owner uses for it, which is what makes the row
/// legible as "this is the build you are getting".
fn platform() -> String {
    let system = match std::env::consts::OS {
        "macos" => "macOS",
        "linux" => "Linux",
        "windows" => "Windows",
        other => other,
    };

    let machine = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "Apple silicon",
        ("macos", "x86_64") => "Intel",
        (_, "aarch64") => "arm64",
        (_, arch) => arch,
    };

    format!("{system} · {machine}")
}

/// The command line, as the installer row reads it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    /// `macOS · Apple silicon`.
    pub platform: String,
    /// False when the CLI publishes no build for this OS and architecture, in
    /// which case every other field is the honest nothing that follows.
    pub supported: bool,
    /// Absolute, for the reveal-in-file-manager control.
    pub path: String,
    /// The same path in the host's own notation.
    pub display_path: String,
    /// The directory `path` is in, in the host's own notation, which is how
    /// the note under the row names it. One notation, not two.
    pub directory: String,
    /// This is a `brainpod` that was already here, which this window updates
    /// where it stands rather than installing a second copy somewhere else.
    /// A machine with no CLI on it gets the platform's default location and
    /// this is false.
    pub adopted: bool,
    /// Whether the platform's own defaults put that directory on `PATH`. True
    /// is a fact worth stating; false is only "this window cannot tell", since
    /// a shell profile it never reads may well put it there.
    pub on_path: bool,
    /// Writing there raises a system authorization prompt.
    pub elevates: bool,
    /// A binary is at `path`. It is not necessarily ours.
    pub installed: bool,
    /// What the binary at `path` answers to `--version`.
    ///
    /// This is what is on disk, and it is not always the release's own name:
    /// `brainpodnl/cli` stamps its binaries from a `VERSION` file rather than
    /// from the tag, and v0.0.6 ships a binary that calls itself 0.1.0. So it
    /// is shown where nothing better is known, and never compared to a tag.
    pub version: Option<String>,
    /// The release this window installed, from its own receipt. This is the
    /// only version that can honestly be measured against what is published,
    /// because it is the only one that came from the same place.
    pub release_version: Option<String>,
    /// Written by this window and unchanged since, which is what makes
    /// removing it ours to offer.
    pub managed: bool,
    /// Epoch milliseconds, formatted in the webview against the user's locale.
    pub installed_at: Option<u64>,
    /// A `brainpod` somewhere else on this machine. Which one a shell runs
    /// depends on the order of its `PATH`, so the row states both and claims
    /// neither.
    pub other: Option<Elsewhere>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Elsewhere {
    pub display_path: String,
    pub version: Option<String>,
}

/// The release on offer.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliRelease {
    /// `0.0.5`, the tag without its `v`, which is what the binary reports.
    pub version: String,
    pub asset: String,
    pub url: String,
    pub size: u64,
    /// Set when a newer release exists whose binaries are not up yet: it is
    /// publishing, and this is the newest one this platform can actually
    /// install.
    pub publishing: Option<String>,
    pub repo: String,
}

/// What each step of an install is doing, so a four-megabyte download on a
/// slow link is a bar rather than a stalled button.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// `downloading`, `checking`, or `installing`.
    pub phase: &'static str,
    pub received: u64,
    /// The release's own size for the asset, so the bar is determinate from
    /// the first byte rather than after the response headers.
    pub total: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    path: String,
    version: String,
    /// The digest of the file as it was written. A binary that no longer
    /// matches was replaced by something else, and removing it would be this
    /// window throwing away another installer's work.
    sha256: String,
    installed_at: u64,
    /// This install replaced a `brainpod` that was already at `path`. It is
    /// what makes removal something this window refuses: taking away a binary
    /// another installer put there would leave that installer broken.
    adopted: bool,
}

/// One release, reduced to what picking an asset needs.
#[derive(Debug, Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Debug, Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

/// `~/.local/bin/brainpod`, or `%LOCALAPPDATA%\…`. A path outside the home
/// directory — which the install target itself is, on Unix — is shown whole.
fn display_path(home: &Path, path: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rest) => {
            let root = if cfg!(windows) { "%USERPROFILE%" } else { "~" };
            format!("{root}{MAIN_SEPARATOR}{}", rest.display())
        }
        Err(_) => path.display().to_string(),
    }
}

/// Whether the platform's own defaults put this directory on `PATH`.
///
/// On macOS the process `PATH` cannot answer this: a window launched from the
/// Finder is handed `/usr/bin:/bin:/usr/sbin:/sbin` by launchd, which never
/// includes `/usr/local/bin` however the user's terminal is set up. `/etc/paths`
/// is what every login shell is built from, so that is what is read. Everywhere
/// else the process does inherit the session's `PATH`, and it is the truth.
fn on_path(directory: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        let mut files = vec![PathBuf::from("/etc/paths")];
        if let Ok(entries) = fs::read_dir("/etc/paths.d") {
            files.extend(entries.flatten().map(|entry| entry.path()));
        }

        for file in files {
            let Ok(body) = fs::read_to_string(&file) else {
                continue;
            };

            if body
                .lines()
                .map(str::trim)
                .any(|line| !line.is_empty() && Path::new(line) == directory)
            {
                return true;
            }
        }

        false
    }

    #[cfg(not(target_os = "macos"))]
    {
        let Some(path) = std::env::var_os("PATH") else {
            return false;
        };

        std::env::split_paths(&path).any(|entry| entry == directory)
    }
}

/// Whether this user can write into the directory without being elevated.
///
/// Asked by attempting the write rather than by reading a permission bit: on
/// macOS an ACL can grant or deny past the mode, and the only honest answer to
/// "can I create a file here" is a created file.
fn writable(directory: &Path) -> bool {
    if !directory.exists() {
        // Creating `/usr/local/bin` is itself a privileged act when
        // `/usr/local` is root-owned, so the parent is what gets tested.
        return match directory.parent() {
            Some(parent) if parent.exists() => writable(parent),
            _ => false,
        };
    }

    let probe = directory.join(format!(".brainpod-write-test-{}", uuid::Uuid::new_v4()));
    match fs::File::create(&probe) {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// What a `brainpod` on disk says it is. The binary is the only thing that
/// knows, and it is the same binary the user's shell would run.
async fn version_of(binary: &Path) -> Option<String> {
    let output = tokio::time::timeout(
        VERSION_TIMEOUT,
        tokio::process::Command::new(binary)
            .arg("--version")
            .output(),
    )
    .await
    .ok()?
    .ok()?;

    if !output.status.success() {
        return None;
    }

    // `brainpod 0.0.5`.
    let text = String::from_utf8_lossy(&output.stdout);
    text.split_whitespace().nth(1).map(str::to_owned)
}

fn read_receipt(data_dir: &Path) -> Option<Receipt> {
    serde_json::from_slice(&fs::read(data_dir.join(RECEIPT)).ok()?).ok()
}

fn digest(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .fold(String::with_capacity(64), |mut text, byte| {
            use std::fmt::Write as _;
            let _ = write!(text, "{byte:02x}");
            text
        })
}

/// The `brainpod` binaries in a list of directories, in that order and
/// without repeats.
///
/// Symlinks are deliberately refused: a link in `/opt/homebrew/bin` or
/// `~/.local/bin` points into a package manager's own store, and `install(1)`
/// writing through it would overwrite the file inside that store rather than
/// update this CLI. Such a copy is reported, never adopted.
fn present(directories: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = Vec::new();

    for directory in directories {
        let candidate = directory.join(BINARY);
        if found.contains(&candidate) {
            continue;
        }

        // `symlink_metadata`, so a link is not mistaken for the file it points
        // at and taken as somewhere this window may write.
        if fs::symlink_metadata(&candidate).is_ok_and(|meta| meta.is_file()) {
            found.push(candidate);
        }
    }

    found
}

/// Every regular-file `brainpod` this machine has, nearest first.
///
/// Both the process `PATH` and the directories developers actually install
/// into are searched, because the two barely overlap for a window launched
/// from the Finder.
fn installs(home: &Path, first: &Path) -> Vec<PathBuf> {
    let from_path = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();

    let common = COMMON_BIN
        .iter()
        .map(PathBuf::from)
        .chain(COMMON_HOME_BIN.iter().map(|suffix| {
            suffix
                .split('/')
                .fold(home.to_path_buf(), |path, part| path.join(part))
        }));

    present(
        std::iter::once(first.to_path_buf())
            .chain(from_path)
            .chain(common),
    )
}

/// Where this window would write, and whether that is a `brainpod` somebody
/// already put there.
///
/// An install that is already on this machine is updated where it stands: a
/// second copy in `/usr/local/bin` would shadow or be shadowed by the first
/// depending on the order of a `PATH` this window cannot read, and the user
/// would have two CLIs to keep current instead of one. The receipt wins over
/// a search so the target does not wander between reads.
fn target(home: &Path, local_data: &Path, data_dir: &Path) -> (PathBuf, bool) {
    let fallback = default_directory(local_data).join(BINARY);

    if let Some(receipt) = read_receipt(data_dir) {
        let recorded = PathBuf::from(&receipt.path);
        if fs::symlink_metadata(&recorded).is_ok_and(|meta| meta.is_file()) {
            return (recorded, receipt.adopted);
        }
    }

    match installs(home, fallback.parent().unwrap_or(&fallback))
        .into_iter()
        .next()
    {
        Some(found) => {
            let adopted = found != fallback;
            (found, adopted)
        }
        None => (fallback, false),
    }
}

pub async fn status(home: &Path, local_data: &Path, data_dir: &Path) -> CliStatus {
    let (target, adopted) = target(home, local_data, data_dir);
    let directory = target.parent().unwrap_or(&target).to_path_buf();
    let installed = fs::symlink_metadata(&target).is_ok_and(|meta| meta.is_file());

    let version = if installed {
        version_of(&target).await
    } else {
        None
    };

    // Ours only while the file is still the one that was written: anything
    // else at this path belongs to whatever replaced it.
    let receipt = read_receipt(data_dir).filter(|receipt| {
        Path::new(&receipt.path) == target
            && fs::read(&target).is_ok_and(|bytes| digest(&bytes) == receipt.sha256)
    });

    // Only copies other than the one being kept current. A machine with two
    // of them has a fact worth stating, and this window fixes neither.
    let other = match installs(home, &directory)
        .into_iter()
        .find(|found| *found != target)
    {
        Some(path) => Some(Elsewhere {
            version: version_of(&path).await,
            display_path: display_path(home, &path),
        }),
        None => None,
    };

    CliStatus {
        platform: platform(),
        supported: asset().is_some(),
        path: target.display().to_string(),
        display_path: display_path(home, &target),
        directory: display_path(home, &directory),
        adopted,
        on_path: on_path(&directory),
        elevates: !writable(&directory),
        installed,
        version,
        release_version: receipt.as_ref().map(|receipt| receipt.version.clone()),
        // An adopted binary is kept current but never deleted: it belongs to
        // whoever put it there.
        managed: receipt.as_ref().is_some_and(|receipt| !receipt.adopted),
        installed_at: receipt.map(|receipt| receipt.installed_at),
        other,
    }
}

/// The path a reveal control should open: the binary, or the directory it
/// would be written into when nothing is there yet.
pub fn reveal_path(home: &Path, local_data: &Path, data_dir: &Path) -> PathBuf {
    let (target, _) = target(home, local_data, data_dir);
    if target.exists() {
        target
    } else {
        target.parent().unwrap_or(&target).to_path_buf()
    }
}

fn http() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(concat!("brainpod-desktop/", env!("CARGO_PKG_VERSION")))
        .https_only(true)
        // Release assets are served from a different host than the API, so the
        // download is a redirect by design.
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .context("Could not start an HTTP client")
}

/// The tag without its `v`, which is the version the binary itself reports.
fn version_of_tag(tag: &str) -> String {
    tag.strip_prefix('v').unwrap_or(tag).to_owned()
}

/// The newest release carrying a build for this platform, and the name of any
/// newer one that is still publishing its binaries.
fn choose(releases: &[Release], want: &str) -> Result<CliRelease> {
    let published: Vec<&Release> = releases
        .iter()
        .filter(|release| !release.draft)
        .take(RELEASE_DEPTH)
        .collect();

    let newest = published
        .first()
        .ok_or_else(|| anyhow!("The Brainpod CLI has no published releases"))?;

    for release in &published {
        let Some(asset) = release.assets.iter().find(|asset| asset.name == want) else {
            continue;
        };

        // A release without its checksum file cannot be verified, and an
        // unverified binary is not one this window installs.
        if !release.assets.iter().any(|other| other.name == CHECKSUMS) {
            continue;
        }

        let version = version_of_tag(&release.tag_name);
        let newest_version = version_of_tag(&newest.tag_name);

        return Ok(CliRelease {
            publishing: (version != newest_version).then_some(newest_version),
            version,
            asset: asset.name.clone(),
            url: asset.browser_download_url.clone(),
            size: asset.size,
            repo: REPO.to_owned(),
        });
    }

    bail!(
        "No {want} has been published in the last {} releases of the Brainpod CLI",
        published.len()
    )
}

/// What the CLI is publishing for this machine right now.
pub async fn latest() -> Result<CliRelease> {
    let want =
        asset().ok_or_else(|| anyhow!("The Brainpod CLI publishes no build for {}", platform()))?;

    let response = http()?
        .get(RELEASES_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .context("Could not reach github.com")?
        .error_for_status()
        .context("github.com refused the request for the CLI's releases")?;

    let releases: Vec<Release> = response
        .json()
        .await
        .context("Could not read the CLI's releases")?;

    choose(&releases, want)
}

/// Downloads one URL, reporting progress against a size the caller already
/// knows from the release.
///
/// The body is accumulated chunk by chunk against the cap rather than buffered
/// and measured afterwards: `Content-Length` is absent under a chunked
/// response, so measuring what has already been allocated is not a limit.
async fn download(url: &str, total: u64, report: &impl Fn(Progress)) -> Result<Vec<u8>> {
    let mut response = http()?
        .get(url)
        .send()
        .await
        .context("Could not reach github.com")?
        .error_for_status()
        .context("github.com refused the download")?;

    if let Some(length) = response.content_length()
        && length > MAX_ARCHIVE as u64
    {
        bail!("The download from github.com is larger than a CLI release can be");
    }

    let mut body: Vec<u8> = Vec::with_capacity(total.min(MAX_ARCHIVE as u64) as usize);
    while let Some(chunk) = response
        .chunk()
        .await
        .context("The download from github.com was cut short")?
    {
        if body.len() + chunk.len() > MAX_ARCHIVE {
            bail!("The download from github.com is larger than a CLI release can be");
        }

        body.extend_from_slice(&chunk);
        report(Progress {
            phase: "downloading",
            received: body.len() as u64,
            total,
        });
    }

    Ok(body)
}

/// The digest one `SHA256SUMS` line records for one asset. The file is
/// `sha256sum` output: a digest, two spaces, a name.
fn expected_digest(sums: &str, asset: &str) -> Result<String> {
    for line in sums.lines() {
        let mut parts = line.split_whitespace();
        let (Some(digest), Some(name)) = (parts.next(), parts.next()) else {
            continue;
        };

        // `sha256sum` marks a binary-mode entry with a `*` before the name.
        if name.trim_start_matches('*') == asset {
            return Ok(digest.to_ascii_lowercase());
        }
    }

    bail!("`{CHECKSUMS}` records no checksum for `{asset}`")
}

/// The single `brainpod` binary inside a release archive.
///
/// Unix releases are a tarball of one file and Windows releases a zip of one
/// file, so both are read for exactly that name and anything else in there is
/// ignored rather than written.
fn unpack(archive: &[u8], asset: &str) -> Result<Vec<u8>> {
    if asset.ends_with(".zip") {
        return unpack_zip(archive);
    }

    let mut tar = Archive::new(GzDecoder::new(archive));
    let entries = tar
        .entries()
        .context("The CLI release is not a readable archive")?;

    for entry in entries {
        let mut entry = entry.context("The CLI release is not a readable archive")?;
        let path = entry
            .path()
            .context("The CLI release holds an unreadable path")?
            .into_owned();

        if path.file_name().is_some_and(|name| name == BINARY) {
            let mut binary = Vec::new();
            entry
                .read_to_end(&mut binary)
                .context("Could not read the CLI out of its archive")?;
            return Ok(binary);
        }
    }

    bail!("The CLI release holds no `{BINARY}`")
}

#[cfg(windows)]
fn unpack_zip(archive: &[u8]) -> Result<Vec<u8>> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive))
        .context("The CLI release is not a readable archive")?;

    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .context("The CLI release is not a readable archive")?;

        let is_binary = entry
            .enclosed_name()
            .is_some_and(|path| path.file_name().is_some_and(|name| name == BINARY));

        if is_binary {
            let mut binary = Vec::new();
            entry
                .read_to_end(&mut binary)
                .context("Could not read the CLI out of its archive")?;
            return Ok(binary);
        }
    }

    bail!("The CLI release holds no `{BINARY}`")
}

/// Unix takes the tarball, so a zip here is a release whose assets were
/// renamed rather than an archive to teach every platform to read.
#[cfg(not(windows))]
fn unpack_zip(_archive: &[u8]) -> Result<Vec<u8>> {
    bail!("This platform takes the `.tar.gz` release, not the Windows `.zip`")
}

/// A `'`-quoted shell word. Everything inside single quotes is literal to
/// `/bin/sh` except a single quote itself, which is closed, escaped and
/// reopened.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// An AppleScript string literal, which is the second layer the elevated
/// command passes through: `osascript` parses the script, then `do shell
/// script` hands what it parsed to `/bin/sh`.
#[cfg(target_os = "macos")]
fn applescript_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The privileged half of an install, and the only part of it that is
/// privileged: the download, the checksum and the unpacking all happened
/// unprivileged, and this moves one already-written file into place.
#[cfg(target_os = "macos")]
fn elevated(script: &str) -> Result<()> {
    let output = std::process::Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(format!(
            "do shell script {} with administrator privileges",
            applescript_quote(script)
        ))
        .output()
        .context("Could not ask macOS for authorization")?;

    if output.status.success() {
        return Ok(());
    }

    let message = String::from_utf8_lossy(&output.stderr);
    // The user closing the authorization dialog is a decision, not a fault,
    // and it reads as one.
    if message.contains("-128") {
        bail!("Authorization was cancelled");
    }

    bail!(
        "{}",
        message
            .lines()
            .last()
            .unwrap_or("The authorized command failed")
            .trim()
    )
}

#[cfg(target_os = "linux")]
fn elevated(script: &str) -> Result<()> {
    let output = std::process::Command::new("pkexec")
        .arg("/bin/sh")
        .arg("-c")
        .arg(script)
        .output()
        .context("Could not ask for authorization: `pkexec` is not on this system")?;

    if output.status.success() {
        return Ok(());
    }

    // polkit reports a dismissed dialog as 126 and a refusal as 127.
    if output.status.code() == Some(126) {
        bail!("Authorization was cancelled");
    }

    let message = String::from_utf8_lossy(&output.stderr);
    bail!(
        "{}",
        message
            .lines()
            .last()
            .unwrap_or("The authorized command failed")
            .trim()
    )
}

#[cfg(windows)]
fn elevated(_script: &str) -> Result<()> {
    // Windows installs into a user-writable directory, so nothing here ever
    // needs elevation; reaching this is a bug rather than a permission.
    bail!("This platform installs without elevation")
}

/// A name beside the destination, on the filesystem the binary will live on,
/// so the last step of an install is a rename rather than a write into the
/// file a shell is about to run.
#[cfg(not(windows))]
fn staging(directory: &Path) -> PathBuf {
    directory.join(format!(".brainpod-install-{}", uuid::Uuid::new_v4()))
}

/// Moves the staged binary into place, as root where the directory needs it.
///
/// The binary is copied beside its destination and renamed over it, never
/// written through it. A `brainpod` already on disk is usually mode 555 — the
/// CLI's own installer, Homebrew and Nix all write read-only executables — so
/// opening it for writing fails with a permission error even in a directory
/// this user owns outright, and a copy that is currently running refuses to be
/// truncated at any mode. A rename replaces the directory entry, which asks
/// nothing of the old file, needs nothing but the directory, and leaves what
/// was there standing if any step fails.
#[cfg(not(windows))]
fn place(home: &Path, staged: &Path, directory: &Path, target: &Path) -> Result<()> {
    if writable(directory) {
        match place_as_user(staged, directory, target) {
            Ok(()) => return Ok(()),
            // A directory this user can create files in can still refuse the
            // replacement: an ACL, or a sticky directory holding a file
            // somebody else owns. That is what the prompt below is for, and
            // it is the only thing that raises one.
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {}
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("Could not write `{}`", target.display()));
            }
        }
    }

    place_elevated(home, staged, directory, target)
}

/// The unprivileged half, kept at `io::Result` so the caller can tell a
/// permission the system would grant on request from a failure no password
/// fixes.
#[cfg(not(windows))]
fn place_as_user(staged: &Path, directory: &Path, target: &Path) -> std::io::Result<()> {
    fs::create_dir_all(directory)?;
    // An earlier run killed between the copy and the rename left a dotfile in
    // a directory shared with every other tool on the machine.
    sweep(directory);

    let beside = staging(directory);
    let placed = fs::copy(staged, &beside)
        .and_then(|_| set_mode(&beside))
        .and_then(|()| fs::rename(&beside, target));

    if placed.is_err() {
        let _ = fs::remove_file(&beside);
    }

    placed
}

/// Who the binary belongs to once root has written it.
///
/// A directory inside the user's own home stays the user's: root's copy there
/// would turn a one-off authorization into a password for every future update
/// of a file in a home directory. Everywhere else the binary belongs to root,
/// like the directory holding it.
#[cfg(not(windows))]
fn ownership(home: &Path, directory: &Path) -> (String, String) {
    use std::os::unix::fs::MetadataExt;

    let root = (
        "root".to_owned(),
        if cfg!(target_os = "macos") {
            "wheel".to_owned()
        } else {
            "root".to_owned()
        },
    );

    if !directory.starts_with(home) {
        return root;
    }

    match fs::metadata(home) {
        Ok(owner) => (owner.uid().to_string(), owner.gid().to_string()),
        Err(_) => root,
    }
}

/// The privileged half: one authorization, spent on a file that is already
/// complete and verified on disk.
///
/// `install(1)` rather than a copy because it sets the mode and the owner in
/// one step, and it writes beside the target rather than onto it so the same
/// rename finishes the job — the binary a shell runs is replaced whole or not
/// at all.
#[cfg(not(windows))]
fn place_elevated(home: &Path, staged: &Path, directory: &Path, target: &Path) -> Result<()> {
    let (owner, group) = ownership(home, directory);
    let beside = shell_quote(&staging(directory).display().to_string());

    elevated(&format!(
        "/bin/mkdir -p {directory} \
         && /usr/bin/install -o {owner} -g {group} -m 755 {staged} {beside} \
         && /bin/mv -f {beside} {target} \
         || {{ /bin/rm -f {beside}; exit 1; }}",
        directory = shell_quote(&directory.display().to_string()),
        staged = shell_quote(&staged.display().to_string()),
        target = shell_quote(&target.display().to_string()),
    ))
}

#[cfg(windows)]
fn place(_home: &Path, staged: &Path, directory: &Path, target: &Path) -> Result<()> {
    fs::create_dir_all(directory)
        .with_context(|| format!("Could not create `{}`", directory.display()))?;
    fs::copy(staged, target).with_context(|| format!("Could not write `{}`", target.display()))?;
    Ok(())
}

#[cfg(not(windows))]
fn set_mode(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
}

#[cfg(not(windows))]
fn set_executable(path: &Path) -> Result<()> {
    set_mode(path).with_context(|| format!("Could not make `{}` executable", path.display()))
}

/// Downloads the release, checks it against the release's own `SHA256SUMS`,
/// and puts the binary where the shell will find it — over the `brainpod`
/// already on this machine when there is one, so a developer ends up with one
/// CLI kept current rather than two competing on `PATH`.
///
/// Nothing touches the install directory until the bytes have been verified,
/// so a failed or tampered download leaves whatever was there standing.
pub async fn install(
    home: &Path,
    local_data: &Path,
    data_dir: &Path,
    release: &CliRelease,
    report: impl Fn(Progress),
) -> Result<()> {
    let sums_url = release
        .url
        .rsplit_once('/')
        .map(|(base, _)| format!("{base}/{CHECKSUMS}"))
        .ok_or_else(|| anyhow!("The release's download address is not a URL"))?;

    let archive = download(&release.url, release.size, &report).await?;

    report(Progress {
        phase: "checking",
        received: release.size,
        total: release.size,
    });

    let sums = download(&sums_url, 0, &|_| {}).await?;
    let sums = String::from_utf8(sums).context("`SHA256SUMS` is not text")?;
    let expected = expected_digest(&sums, &release.asset)?;
    let actual = digest(&archive);

    if actual != expected {
        bail!(
            "The download does not match the checksum `{CHECKSUMS}` publishes for `{}`",
            release.asset
        );
    }

    let binary = unpack(&archive, &release.asset)?;

    report(Progress {
        phase: "installing",
        received: release.size,
        total: release.size,
    });

    // Staged inside the app's own data directory, which is writable without
    // asking anybody, so the authorization prompt covers one move of one file
    // that is already complete on disk.
    fs::create_dir_all(data_dir)
        .with_context(|| format!("Could not create `{}`", data_dir.display()))?;
    sweep(data_dir);

    let staged = data_dir.join(format!(".brainpod-install-{}", uuid::Uuid::new_v4()));
    fs::write(&staged, &binary)
        .with_context(|| format!("Could not write `{}`", staged.display()))?;
    #[cfg(not(windows))]
    set_executable(&staged)?;

    let (target, adopted) = target(home, local_data, data_dir);
    let directory = target.parent().unwrap_or(&target).to_path_buf();

    // A binary this window did not write is kept rather than destroyed: it
    // may be the one thing a broken update has to be rolled back from, and a
    // package manager's file is not this window's to discard. It goes to the
    // app's own data directory rather than beside the original, because
    // `/usr/local/bin` is shared with every other tool on the machine.
    let replaced = fs::read(&target).ok().filter(|bytes| {
        read_receipt(data_dir).is_none_or(|receipt| digest(bytes) != receipt.sha256)
    });
    if let Some(bytes) = replaced {
        let kept = data_dir.join(format!("replaced-{}-{BINARY}", now_ms()));
        fs::write(&kept, bytes)
            .with_context(|| format!("Could not keep a copy of `{}`", target.display()))?;
    }

    let placed = place(home, &staged, &directory, &target);
    let _ = fs::remove_file(&staged);
    placed?;

    let receipt = Receipt {
        path: target.display().to_string(),
        version: release.version.clone(),
        sha256: digest(&binary),
        installed_at: now_ms(),
        adopted,
    };

    fs::write(
        data_dir.join(RECEIPT),
        serde_json::to_vec_pretty(&receipt).context("Could not record the install")?,
    )
    .context("Could not record the install")
}

/// Clears staged binaries an earlier run was killed halfway through. The
/// install path removes its own, but a crash between the write and the move
/// has no arm to run.
fn sweep(directory: &Path) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };

    for entry in entries.flatten() {
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(".brainpod-install-")
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Deletes a binary this window installed.
///
/// Refused in two cases, each for the same reason. A `brainpod` whose digest
/// no longer matches the receipt was replaced by something else — Homebrew,
/// Nix, the user's own build. And an install this window only *adopted* — a
/// CLI that was already on this machine and has been kept current since —
/// belongs to whoever put it there; removing it would leave that installer
/// pointing at nothing. Both are somebody else's work.
pub fn remove(home: &Path, local_data: &Path, data_dir: &Path) -> Result<()> {
    let (target, _) = target(home, local_data, data_dir);
    let directory = target.parent().unwrap_or(&target).to_path_buf();

    let receipt = read_receipt(data_dir)
        .filter(|receipt| Path::new(&receipt.path) == target)
        .ok_or_else(|| anyhow!("`{}` was not installed by Brainpod", target.display()))?;

    if receipt.adopted {
        bail!(
            "`{}` was already on this machine before Brainpod updated it, so Brainpod does not delete it",
            target.display()
        );
    }

    let bytes =
        fs::read(&target).with_context(|| format!("Could not read `{}`", target.display()))?;

    if digest(&bytes) != receipt.sha256 {
        bail!(
            "`{}` is no longer the binary this window installed",
            target.display()
        );
    }

    // Unlinking needs the directory, not the file, so a read-only binary in a
    // directory this user owns goes without a prompt. A sticky directory, or
    // one this user cannot write at all, is what raises one.
    let refused = match writable(&directory) {
        true => fs::remove_file(&target)
            .err()
            .filter(|error| error.kind() != std::io::ErrorKind::NotFound),
        false => Some(std::io::ErrorKind::PermissionDenied.into()),
    };

    match refused {
        Some(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            elevated(&format!(
                "/bin/rm -f {}",
                shell_quote(&target.display().to_string())
            ))?;
        }
        Some(error) => {
            return Err(error).with_context(|| format!("Could not remove `{}`", target.display()));
        }
        None => {}
    }

    let _ = fs::remove_file(data_dir.join(RECEIPT));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, assets: &[&str]) -> Release {
        Release {
            tag_name: tag.to_owned(),
            draft: false,
            assets: assets
                .iter()
                .map(|name| Asset {
                    name: (*name).to_owned(),
                    browser_download_url: format!("https://example.test/{tag}/{name}"),
                    size: 4_180_655,
                })
                .collect(),
        }
    }

    #[test]
    fn picks_the_newest_release_that_has_this_platforms_build() {
        let releases = [
            release("v0.0.6", &["brainpod-arm64-macos.tar.gz", "SHA256SUMS"]),
            release("v0.0.5", &["brainpod-arm64-macos.tar.gz", "SHA256SUMS"]),
        ];

        let chosen = choose(&releases, "brainpod-arm64-macos.tar.gz").unwrap();
        assert_eq!(chosen.version, "0.0.6");
        assert_eq!(chosen.publishing, None);
    }

    /// The state `brainpodnl/cli` is in for the ten minutes after a release is
    /// cut: the tag is public and its binaries are not up yet.
    #[test]
    fn falls_back_past_a_release_that_is_still_publishing() {
        let releases = [
            release("v0.0.6", &[]),
            release("v0.0.5", &["brainpod-arm64-macos.tar.gz", "SHA256SUMS"]),
        ];

        let chosen = choose(&releases, "brainpod-arm64-macos.tar.gz").unwrap();
        assert_eq!(chosen.version, "0.0.5");
        assert_eq!(chosen.publishing.as_deref(), Some("0.0.6"));
    }

    #[test]
    fn refuses_a_release_that_publishes_no_checksums() {
        let releases = [release("v0.0.6", &["brainpod-arm64-macos.tar.gz"])];

        assert!(choose(&releases, "brainpod-arm64-macos.tar.gz").is_err());
    }

    #[test]
    fn refuses_a_platform_no_release_builds() {
        let releases = [release(
            "v0.0.6",
            &["brainpod-amd64-linux.tar.gz", "SHA256SUMS"],
        )];

        assert!(choose(&releases, "brainpod-arm64-macos.tar.gz").is_err());
    }

    #[test]
    fn reads_the_digest_for_one_asset_out_of_sha256sums() {
        let sums = concat!(
            "1111111111111111111111111111111111111111111111111111111111111111  brainpod-amd64-linux.tar.gz\n",
            "2222222222222222222222222222222222222222222222222222222222222222 *brainpod-arm64-macos.tar.gz\n",
        );

        assert_eq!(
            expected_digest(sums, "brainpod-arm64-macos.tar.gz").unwrap(),
            "2222222222222222222222222222222222222222222222222222222222222222"
        );
        assert!(expected_digest(sums, "brainpod-amd64-windows.zip").is_err());
    }

    #[test]
    fn a_name_that_only_ends_the_same_way_is_not_a_match() {
        let sums = "3333333333333333333333333333333333333333333333333333333333333333  not-brainpod-arm64-macos.tar.gz\n";

        assert!(expected_digest(sums, "brainpod-arm64-macos.tar.gz").is_err());
    }

    #[test]
    fn digests_match_sha256() {
        // `printf 'brainpod' | shasum -a 256`
        assert_eq!(
            digest(b"brainpod"),
            "34969396f74cd6135e922d8fd5d0a76a1bf33d0678b9ec12b71c9b3bf5949f68"
        );
    }

    #[test]
    fn a_shell_word_survives_a_quote_in_a_home_directory_name() {
        assert_eq!(
            shell_quote("/Users/o'brien/bin"),
            "'/Users/o'\\''brien/bin'"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn an_applescript_literal_survives_backslashes_and_quotes() {
        assert_eq!(applescript_quote(r#"a "b" c\d"#), r#""a \"b\" c\\d""#);
    }

    #[test]
    fn the_tag_is_the_version_without_its_v() {
        assert_eq!(version_of_tag("v0.0.6"), "0.0.6");
        assert_eq!(version_of_tag("0.0.6"), "0.0.6");
    }

    #[test]
    fn reads_the_binary_out_of_a_release_tarball() {
        let mut tar = tar::Builder::new(Vec::new());
        let payload = b"#!/bin/sh\necho brainpod\n";
        let mut header = tar::Header::new_gnu();
        header.set_size(payload.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        tar.append_data(&mut header, "brainpod", &payload[..])
            .unwrap();

        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut gz, &tar.into_inner().unwrap()).unwrap();
        let archive = gz.finish().unwrap();

        assert_eq!(
            unpack(&archive, "brainpod-arm64-macos.tar.gz").unwrap(),
            payload
        );
    }

    #[test]
    fn an_archive_without_the_binary_is_refused() {
        let mut tar = tar::Builder::new(Vec::new());
        let payload = b"notes";
        let mut header = tar::Header::new_gnu();
        header.set_size(payload.len() as u64);
        header.set_cksum();
        tar.append_data(&mut header, "README", &payload[..])
            .unwrap();

        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut gz, &tar.into_inner().unwrap()).unwrap();
        let archive = gz.finish().unwrap();

        assert!(unpack(&archive, "brainpod-arm64-macos.tar.gz").is_err());
    }

    /// A developer who already has the CLI gets that copy kept current, not a
    /// second one somewhere else on their `PATH`.
    #[test]
    fn the_first_directory_holding_a_binary_is_the_one_adopted() {
        let root = std::env::temp_dir().join(format!("bp-present-{}", uuid::Uuid::new_v4()));
        let empty = root.join("empty");
        let local = root.join("local");
        let usr = root.join("usr");
        for directory in [&empty, &local, &usr] {
            fs::create_dir_all(directory).unwrap();
        }
        fs::write(local.join(BINARY), b"one").unwrap();
        fs::write(usr.join(BINARY), b"two").unwrap();

        let found = present([
            root.join("missing"),
            empty.clone(),
            local.clone(),
            usr.clone(),
            // A directory named twice must not yield the same binary twice.
            local.clone(),
        ]);

        assert_eq!(found, vec![local.join(BINARY), usr.join(BINARY)]);

        let _ = fs::remove_dir_all(&root);
    }

    /// A `brainpod` in `/opt/homebrew/bin` is usually a link into the Cellar.
    /// Installing through it would overwrite Homebrew's own file, so a link is
    /// never a place this window writes.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_binary_is_never_adopted() {
        let root = std::env::temp_dir().join(format!("bp-link-{}", uuid::Uuid::new_v4()));
        let store = root.join("store");
        let bin = root.join("bin");
        fs::create_dir_all(&store).unwrap();
        fs::create_dir_all(&bin).unwrap();

        let real = store.join(BINARY);
        fs::write(&real, b"cellar").unwrap();
        std::os::unix::fs::symlink(&real, bin.join(BINARY)).unwrap();

        assert_eq!(present([bin.clone()]), Vec::<PathBuf>::new());
        assert_eq!(present([store.clone()]), vec![real]);

        let _ = fs::remove_dir_all(&root);
    }

    /// The update that failed with `Permission denied (os error 13)` in a
    /// directory the user owns outright: the `brainpod` already there was mode
    /// 555 — what the CLI's own installer writes — so opening it for writing
    /// was refused even though replacing it needs no authorization at all.
    #[cfg(unix)]
    #[test]
    fn replaces_a_read_only_binary_without_authorization() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!("bp-readonly-{}", uuid::Uuid::new_v4()));
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();

        let target = bin.join(BINARY);
        fs::write(&target, b"old").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o555)).unwrap();

        let staged = root.join("staged");
        fs::write(&staged, b"new").unwrap();

        place_as_user(&staged, &bin, &target).unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o755
        );
        // Nothing of the replacement is left beside the binary.
        assert_eq!(fs::read_dir(&bin).unwrap().count(), 1);

        let _ = fs::remove_dir_all(&root);
    }

    /// A directory this user cannot write is the only thing that should reach
    /// the authorization prompt, and it has to be reported as a permission
    /// rather than as some other failure for the prompt to be offered.
    #[cfg(unix)]
    #[test]
    fn a_directory_this_user_cannot_write_reports_a_permission() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!("bp-denied-{}", uuid::Uuid::new_v4()));
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();

        let staged = root.join("staged");
        fs::write(&staged, b"new").unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o555)).unwrap();

        let error = place_as_user(&staged, &bin, &bin.join(BINARY)).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);

        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        let _ = fs::remove_dir_all(&root);
    }

    /// Root's copy in a home directory would make every later update ask for a
    /// password; outside the home the binary belongs to root like its
    /// directory.
    #[cfg(unix)]
    #[test]
    fn an_elevated_install_in_the_home_directory_stays_the_users() {
        use std::os::unix::fs::MetadataExt;

        let home = std::env::temp_dir().join(format!("bp-own-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(home.join(".local").join("bin")).unwrap();
        let owner = fs::metadata(&home).unwrap();

        assert_eq!(
            ownership(&home, &home.join(".local").join("bin")),
            (owner.uid().to_string(), owner.gid().to_string())
        );
        assert_eq!(
            ownership(&home, Path::new("/usr/local/bin")).0,
            "root".to_owned()
        );

        let _ = fs::remove_dir_all(&home);
    }
}
