use std::fs;
use std::io::Read;
use std::path::{Component, MAIN_SEPARATOR, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use tar::Archive;

/// The `brainpod` Agent Skill, and where the agents on this machine read one
/// from. Every harness resolves its user-scope skills directory relative to the
/// home directory on all three platforms, so the table is one set of
/// slash-separated suffixes and the only per-OS work is how a path is spelled
/// back to the user.
///
/// Sources, each the harness's own documentation:
/// Claude Code `~/.claude/skills`, Codex `$HOME/.agents/skills` (the Agent
/// Skills standard location), Cursor `~/.cursor/skills`, Gemini CLI
/// `~/.gemini/skills`.
struct Harness {
    id: &'static str,
    name: &'static str,
    /// Home-relative, slash separated; joined component by component so it is a
    /// native path on Windows too.
    skills: &'static str,
    /// The harness's own config directory. Its presence is what says this agent
    /// has run here, without asking the OS to execute anything.
    marker: &'static str,
    /// Its CLI, for the case where the agent is installed but has never run.
    command: &'static str,
    note: Option<&'static str>,
}

const HARNESSES: [Harness; 4] = [
    Harness {
        id: "claude",
        name: "Claude Code",
        skills: ".claude/skills",
        marker: ".claude",
        command: "claude",
        note: None,
    },
    Harness {
        id: "codex",
        name: "Codex",
        skills: ".agents/skills",
        marker: ".codex",
        command: "codex",
        note: Some("The shared Agent Skills directory. Gemini CLI reads it too."),
    },
    Harness {
        id: "cursor",
        name: "Cursor",
        skills: ".cursor/skills",
        marker: ".cursor",
        command: "cursor-agent",
        note: None,
    },
    Harness {
        id: "gemini",
        name: "Gemini CLI",
        skills: ".gemini/skills",
        marker: ".gemini",
        command: "gemini",
        note: None,
    },
];

/// The directory name the skill is written under, inside a harness's skills
/// directory. It is the skill's own `name`, which is what every harness matches
/// a `$skill` mention against.
const SKILL: &str = "brainpod";

pub const REPO: &str = "https://github.com/brainpodnl/skills";

/// The repository as an archive, straight from GitHub's archive host rather
/// than the REST API: no token, no rate limit that a desktop app shares with
/// everything else behind the same address, and no release channel to invent —
/// `brainpodnl/skills` publishes from its default branch.
const TARBALL: &str = "https://codeload.github.com/brainpodnl/skills/tar.gz/refs/heads/main";

/// The same version the archive carries, fetched on its own so the window can
/// say what is on offer without pulling a tarball nobody asked for.
const MANIFEST_URL: &str =
    "https://raw.githubusercontent.com/brainpodnl/skills/main/.claude-plugin/plugin.json";

/// Where the skill and the version live inside the archive, under its single
/// root directory.
const SKILL_PREFIX: &str = "skills/brainpod/";
const MANIFEST_PATH: &str = ".claude-plugin/plugin.json";

/// What this window leaves behind inside an installed skill, and the only thing
/// that lets it tell its own install from a clone the user symlinked there.
/// Dotted so it stays out of the way of an agent listing the skill's files.
const RECEIPT: &str = ".brainpod-desktop.json";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// A skill is prose: this one is 72 KB. Anything approaching a megabyte is a
/// URL that stopped pointing at a skill, and it is read into memory here.
const MAX_ARCHIVE: usize = 8 * 1024 * 1024;

/// One agent, as the installer row reads it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessStatus {
    pub id: String,
    pub name: String,
    pub note: Option<String>,
    /// Absolute, for the reveal-in-file-manager control.
    pub path: String,
    /// The same path in the host's own notation: `~/…` on macOS and Linux,
    /// `%USERPROFILE%\…` on Windows.
    pub display_path: String,
    /// This agent has run on this machine, or its CLI is on `PATH`.
    pub detected: bool,
    /// Something is at `path`. It is not necessarily ours.
    pub installed: bool,
    /// Written by this window, so its version is known and removing it is safe.
    pub managed: bool,
    pub version: Option<String>,
    /// Epoch milliseconds, formatted in the webview against the user's locale.
    pub installed_at: Option<u64>,
}

/// What `brainpodnl/skills` is publishing right now.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSkill {
    pub version: String,
    pub repo: String,
}

/// One target's outcome. A batch install writes each directory independently:
/// a denied `~/.cursor` must not cost the user the three that would have
/// worked, so failures travel per row instead of failing the call.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub id: String,
    pub error: Option<String>,
}

/// The answer to any write: what was attempted, and the full state afterwards,
/// so the dialog never has to re-derive what changed.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    pub version: String,
    pub results: Vec<InstallResult>,
    pub harnesses: Vec<HarnessStatus>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    skill: String,
    version: String,
    source: String,
    installed_at: u64,
}

/// The skill as it came out of the archive: every file, and the version the
/// repository stamped on it.
pub struct Package {
    pub version: String,
    files: Vec<(PathBuf, Vec<u8>)>,
}

fn harness(id: &str) -> Result<&'static Harness> {
    HARNESSES
        .iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| anyhow!("Unknown agent `{id}`"))
}

/// Home-relative and slash-separated in the table, native on disk.
fn under(home: &Path, suffix: &str) -> PathBuf {
    suffix
        .split('/')
        .fold(home.to_path_buf(), |path, part| path.join(part))
}

/// `~/.claude/skills/brainpod`, or `%USERPROFILE%\.claude\skills\brainpod`.
/// A path outside the home directory cannot be shortened, and is shown whole.
fn display_path(home: &Path, path: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rest) => {
            let root = if cfg!(windows) { "%USERPROFILE%" } else { "~" };
            format!("{root}{MAIN_SEPARATOR}{}", rest.display())
        }
        Err(_) => path.display().to_string(),
    }
}

/// Whether a command exists on `PATH`. `PATHEXT` is what makes this work on
/// Windows, where `codex` on disk is `codex.cmd`; no other platform sets it, so
/// the same loop covers all three without a `cfg`.
fn on_path(command: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };

    let extensions: Vec<String> = std::env::var("PATHEXT")
        .map(|value| {
            value
                .split(';')
                .filter(|extension| !extension.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();

    std::env::split_paths(&path).any(|directory| {
        // `split_paths` turns an empty entry into the working directory, and a
        // file named `codex` beside whatever the app was launched from is not
        // an installed agent.
        if directory.as_os_str().is_empty() {
            return false;
        }

        if directory.join(command).is_file() {
            return true;
        }

        extensions
            .iter()
            .any(|extension| directory.join(format!("{command}{extension}")).is_file())
    })
}

fn status(home: &Path, entry: &Harness) -> HarnessStatus {
    let path = under(home, entry.skills).join(SKILL);
    // `symlink_metadata`, not `exists`: a symlink into a clone of the repo is
    // one of the install routes the skill's README documents, and a broken one
    // still occupies the name this window would write to.
    let installed = fs::symlink_metadata(&path).is_ok();
    let receipt = if installed { read_receipt(&path) } else { None };

    HarnessStatus {
        id: entry.id.to_owned(),
        name: entry.name.to_owned(),
        note: entry.note.map(str::to_owned),
        display_path: display_path(home, &path),
        path: path.display().to_string(),
        detected: under(home, entry.marker).is_dir() || on_path(entry.command),
        installed,
        managed: receipt.is_some(),
        version: receipt.as_ref().map(|receipt| receipt.version.clone()),
        installed_at: receipt.as_ref().map(|receipt| receipt.installed_at),
    }
}

fn read_receipt(skill: &Path) -> Option<Receipt> {
    let body = fs::read_to_string(skill.join(RECEIPT)).ok()?;
    serde_json::from_str::<Receipt>(&body)
        .ok()
        .filter(|receipt| receipt.skill == SKILL)
}

pub fn scan(home: &Path) -> Vec<HarnessStatus> {
    HARNESSES.iter().map(|entry| status(home, entry)).collect()
}

/// The directory a reveal control should open for one agent: the installed
/// skill, or the skills directory it would be written into when nothing is
/// there yet.
pub fn installed_path(home: &Path, id: &str) -> Result<PathBuf> {
    let entry = harness(id)?;
    let directory = under(home, entry.skills);
    let skill = directory.join(SKILL);

    if fs::symlink_metadata(&skill).is_ok() {
        return Ok(skill);
    }
    if directory.is_dir() {
        return Ok(directory);
    }

    bail!(
        "Nothing is installed at `{}` yet",
        display_path(home, &skill)
    )
}

fn http() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(concat!("brainpod-desktop/", env!("CARGO_PKG_VERSION")))
        // Both endpoints answer directly. A redirect chain that leaves TLS, or
        // wanders off GitHub, is not a route this download has any use for.
        .https_only(true)
        .redirect(reqwest::redirect::Policy::limited(2))
        .build()
        .context("Could not start an HTTP client")
}

fn version_from_manifest(body: &str) -> Result<String> {
    let manifest: serde_json::Value =
        serde_json::from_str(body).context("The skill's manifest was not JSON")?;

    manifest
        .get("version")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("The skill's manifest carries no version"))
}

/// The version on offer, without downloading the skill itself.
pub async fn latest() -> Result<RemoteSkill> {
    let response = http()?
        .get(MANIFEST_URL)
        .send()
        .await
        .context("Could not reach github.com")?;

    let response = response
        .error_for_status()
        .context("github.com refused the request for the skill's manifest")?;

    let body = response
        .text()
        .await
        .context("Could not read the skill's manifest")?;

    Ok(RemoteSkill {
        version: version_from_manifest(&body)?,
        repo: REPO.to_owned(),
    })
}

/// Downloads the repository archive and reads the skill out of it.
///
/// The body is accumulated chunk by chunk against the cap rather than buffered
/// and measured afterwards: `Content-Length` is absent under a chunked
/// response, so measuring what has already been allocated is not a limit.
pub async fn fetch() -> Result<Package> {
    let response = http()?
        .get(TARBALL)
        .send()
        .await
        .context("Could not reach github.com")?;

    let mut response = response
        .error_for_status()
        .context("github.com refused the request for the skill")?;

    if let Some(length) = response.content_length()
        && length > MAX_ARCHIVE as u64
    {
        bail!("The download from github.com is larger than a skill can be");
    }

    let mut archive: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .context("The download from github.com was cut short")?
    {
        if archive.len() + chunk.len() > MAX_ARCHIVE {
            bail!("The download from github.com is larger than a skill can be");
        }

        archive.extend_from_slice(&chunk);
    }

    unpack(&archive)
}

/// A relative path with nothing but plain names in it. Everything else — a
/// root, a drive letter, a `..` — is a path that could leave the directory it
/// is being written into, so it is refused rather than normalized.
fn safe_relative(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

/// Reads `skills/brainpod` and the version out of the repository archive.
///
/// GitHub wraps the tree in one directory named after the ref, so the first
/// component of every entry is dropped. Nothing is written here: the caller
/// gets the files in memory and decides where they land, which is what lets one
/// download serve four harnesses.
fn unpack(archive: &[u8]) -> Result<Package> {
    let mut tar = Archive::new(GzDecoder::new(archive));
    let mut files: Vec<(PathBuf, Vec<u8>)> = Vec::new();
    let mut version: Option<String> = None;
    let mut total = 0usize;

    for entry in tar
        .entries()
        .context("The download from github.com was not a readable archive")?
    {
        let mut entry = entry.context("The download from github.com was not a readable archive")?;
        let kind = entry.header().entry_type();
        let path = entry
            .path()
            .context("The archive holds an unreadable path")?
            .into_owned();

        // The root directory GitHub wraps the tree in.
        let Some(inside) = path
            .iter()
            .skip(1)
            .collect::<PathBuf>()
            .to_str()
            .map(str::to_owned)
        else {
            continue;
        };
        let inside = inside.replace('\\', "/");

        let wanted = inside == MANIFEST_PATH || inside.starts_with(SKILL_PREFIX);
        if !wanted {
            continue;
        }

        // A skill is files and directories. A link inside the part of the
        // archive being written to disk is not something this ever needs, and
        // following one is how an archive writes outside its own directory.
        if kind.is_symlink() || kind.is_hard_link() {
            bail!("The skill archive holds a link, which this window will not install");
        }
        if !kind.is_file() {
            continue;
        }

        /*
         * Bounded before the allocation, not audited after it. A tar entry
         * serves as much as its own header claims, and gzip will happily
         * expand a few megabytes into gigabytes, so reading first and
         * measuring second is how the cap becomes an out-of-memory abort.
         */
        let room = MAX_ARCHIVE - total;
        let mut body = Vec::new();
        entry
            .by_ref()
            .take(room as u64 + 1)
            .read_to_end(&mut body)
            .with_context(|| format!("Could not read `{inside}` from the archive"))?;

        if body.len() > room {
            bail!("The download from github.com is larger than a skill can be");
        }
        total += body.len();

        if inside == MANIFEST_PATH {
            version = Some(version_from_manifest(&String::from_utf8_lossy(&body))?);
            continue;
        }

        let relative = PathBuf::from(&inside[SKILL_PREFIX.len()..]);
        if !safe_relative(&relative) {
            bail!("The skill archive holds a path that would write outside the skill");
        }

        files.push((relative, body));
    }

    if !files.iter().any(|(path, _)| path == Path::new("SKILL.md")) {
        bail!("The download from github.com carries no `skills/{SKILL}/SKILL.md`");
    }

    let version = version.ok_or_else(|| anyhow!("The skill archive carries no version"))?;

    Ok(Package { version, files })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

/// Frees the name the skill is about to take.
///
/// A link, a file, or an install this window made is removed outright. A real
/// directory that carries no receipt is somebody else's work — a clone, a hand
/// written skill, another installer's copy — and `remove` refuses to delete
/// exactly that, so installing does not delete it either: it is moved aside
/// under a dated name the user can find and throw away themselves.
fn clear(path: &Path) -> Result<()> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok(());
    };

    let directory = metadata.is_dir() && !metadata.file_type().is_symlink();

    if directory && read_receipt(path).is_none() {
        let aside = path.with_file_name(format!("{SKILL}.replaced-{}", now_ms()));
        return fs::rename(path, &aside)
            .with_context(|| format!("Could not move `{}` aside", path.display()));
    }

    let result = if directory {
        fs::remove_dir_all(path)
    } else {
        // A directory symlink is removed as a directory on Windows and as a
        // file everywhere else, which is why both are tried.
        fs::remove_file(path).or_else(|_| fs::remove_dir_all(path))
    };

    result.with_context(|| format!("Could not replace `{}`", path.display()))
}

/// Clears staging trees an earlier run was killed halfway through. Each failure
/// arm below removes its own, but a crash or a power cut between the first
/// write and the rename has no arm to run.
fn sweep(directory: &Path) {
    let prefix = format!(".{SKILL}-install-");
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };

    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with(&prefix) {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// Writes the skill into one harness's skills directory.
///
/// It is staged in a sibling directory and moved into place, so a failure
/// halfway through a dozen files leaves the previous install standing instead
/// of a half-written skill an agent would happily read.
pub fn install(home: &Path, id: &str, package: &Package) -> Result<()> {
    let entry = harness(id)?;
    let directory = under(home, entry.skills);
    fs::create_dir_all(&directory)
        .with_context(|| format!("Could not create `{}`", directory.display()))?;
    sweep(&directory);

    let staging = directory.join(format!(".{SKILL}-install-{}", uuid::Uuid::new_v4()));
    let staged = write_staging(&staging, package);

    if let Err(error) = staged {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    let target = directory.join(SKILL);
    if let Err(error) = clear(&target) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    fs::rename(&staging, &target).or_else(|error| {
        let _ = fs::remove_dir_all(&staging);
        Err(error).with_context(|| format!("Could not write `{}`", target.display()))
    })
}

fn write_staging(staging: &Path, package: &Package) -> Result<()> {
    fs::create_dir_all(staging)
        .with_context(|| format!("Could not create `{}`", staging.display()))?;

    for (relative, body) in &package.files {
        let file = staging.join(relative);
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("Could not create `{}`", parent.display()))?;
        }

        fs::write(&file, body).with_context(|| format!("Could not write `{}`", file.display()))?;
    }

    let receipt = Receipt {
        skill: SKILL.to_owned(),
        version: package.version.clone(),
        source: REPO.to_owned(),
        installed_at: now_ms(),
    };

    fs::write(
        staging.join(RECEIPT),
        serde_json::to_vec_pretty(&receipt).context("Could not record the install")?,
    )
    .context("Could not record the install")
}

/// Deletes an install this window made.
///
/// A skill directory without this window's receipt was put there by something
/// else — the skills CLI, a Cursor plugin, a symlink into a clone of the repo —
/// and deleting it would be this window throwing away someone else's work.
pub fn remove(home: &Path, id: &str) -> Result<()> {
    let entry = harness(id)?;
    let path = under(home, entry.skills).join(SKILL);

    if fs::symlink_metadata(&path).is_err() {
        return Ok(());
    }

    if read_receipt(&path).is_none() {
        bail!(
            "`{}` was not installed from this window. Remove it where it came from.",
            display_path(home, &path)
        );
    }

    fs::remove_dir_all(&path).with_context(|| format!("Could not remove `{}`", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct TempHome(PathBuf);

    impl TempHome {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("brainpod-skills-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).expect("temp home");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// The shape codeload answers with: one root directory named after the ref.
    ///
    /// The name is written into the header by hand rather than through
    /// `append_data`, which refuses to emit a `..` path at all — and a
    /// traversal entry no well-behaved writer would produce is exactly what the
    /// reader has to be shown refusing.
    fn archive(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());

        for (path, body) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o644);

            let name = format!("skills-main/{path}");
            let bytes = name.as_bytes();
            assert!(bytes.len() < 100, "test paths stay in the old name field");
            header.as_old_mut().name[..bytes.len()].copy_from_slice(bytes);

            header.set_cksum();
            builder.append(&header, body.as_bytes()).expect("append");
        }

        let tar = builder.into_inner().expect("tar");
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(&tar).expect("gzip");
        encoder.finish().expect("gzip")
    }

    fn package() -> Package {
        unpack(&archive(&[
            (".claude-plugin/plugin.json", r#"{"version":"1.17.2"}"#),
            ("skills/brainpod/SKILL.md", "---\nname: brainpod\n---\n"),
            ("skills/brainpod/references/deploy.md", "deploy"),
            ("README.md", "not part of the skill"),
        ]))
        .expect("unpack")
    }

    #[test]
    fn unpack_takes_the_skill_and_the_version_and_nothing_else() {
        let package = package();

        assert_eq!(package.version, "1.17.2");
        let mut paths: Vec<String> = package
            .files
            .iter()
            .map(|(path, _)| path.to_string_lossy().replace('\\', "/"))
            .collect();
        paths.sort();
        assert_eq!(paths, ["SKILL.md", "references/deploy.md"]);
    }

    #[test]
    fn unpack_refuses_an_archive_without_the_skill() {
        let error = unpack(&archive(&[(
            ".claude-plugin/plugin.json",
            r#"{"version":"1.0.0"}"#,
        )]))
        .map(|_| ())
        .expect_err("no skill");

        assert!(error.to_string().contains("SKILL.md"), "{error}");
    }

    #[test]
    fn unpack_refuses_a_path_that_climbs_out_of_the_skill() {
        let error = unpack(&archive(&[
            (".claude-plugin/plugin.json", r#"{"version":"1.0.0"}"#),
            ("skills/brainpod/SKILL.md", "skill"),
            ("skills/brainpod/../../../.bashrc", "owned"),
        ]))
        .map(|_| ())
        .expect_err("traversal");

        assert!(error.to_string().contains("outside the skill"), "{error}");
    }

    #[test]
    fn install_writes_the_skill_and_scan_reads_it_back() {
        let home = TempHome::new();
        install(home.path(), "claude", &package()).expect("install");

        let skill = home.path().join(".claude").join("skills").join("brainpod");
        assert!(skill.join("SKILL.md").is_file());
        assert!(skill.join("references").join("deploy.md").is_file());

        let claude = scan(home.path())
            .into_iter()
            .find(|entry| entry.id == "claude")
            .expect("claude row");
        assert!(claude.installed && claude.managed);
        assert_eq!(claude.version.as_deref(), Some("1.17.2"));
        assert!(claude.installed_at.is_some());
    }

    #[test]
    fn install_replaces_an_earlier_install_without_leaving_its_files_behind() {
        let home = TempHome::new();
        install(home.path(), "codex", &package()).expect("first install");

        let skill = home.path().join(".agents").join("skills").join("brainpod");
        fs::write(skill.join("references").join("gone.md"), "stale").expect("stale file");

        install(home.path(), "codex", &package()).expect("second install");

        assert!(skill.join("SKILL.md").is_file());
        assert!(!skill.join("references").join("gone.md").exists());
        // The staging directory is moved, never left beside the skill.
        let leftovers = fs::read_dir(home.path().join(".agents").join("skills"))
            .expect("skills dir")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name() != SKILL)
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn install_moves_a_skill_this_window_did_not_write_aside_instead_of_deleting_it() {
        let home = TempHome::new();
        let directory = home.path().join(".cursor").join("skills");
        let skill = directory.join("brainpod");
        fs::create_dir_all(&skill).expect("foreign skill");
        fs::write(skill.join("SKILL.md"), "someone else's").expect("foreign skill");

        install(home.path(), "cursor", &package()).expect("install");

        assert_eq!(
            fs::read_to_string(skill.join("SKILL.md")).unwrap(),
            "---\nname: brainpod\n---\n"
        );

        // The work this window did not do is still on disk, under a name the
        // user can find — never deleted by an install, as `remove` is never
        // allowed to delete it either.
        let kept: Vec<String> = fs::read_dir(&directory)
            .expect("skills dir")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("brainpod.replaced-"))
            .collect();
        assert_eq!(
            kept.len(),
            1,
            "expected one directory moved aside, got {kept:?}"
        );
        assert_eq!(
            fs::read_to_string(directory.join(&kept[0]).join("SKILL.md")).unwrap(),
            "someone else's"
        );
    }

    #[test]
    fn remove_deletes_this_windows_install() {
        let home = TempHome::new();
        install(home.path(), "gemini", &package()).expect("install");
        remove(home.path(), "gemini").expect("remove");

        assert!(
            !home
                .path()
                .join(".gemini")
                .join("skills")
                .join("brainpod")
                .exists()
        );
    }

    #[test]
    fn remove_refuses_a_skill_this_window_did_not_install() {
        let home = TempHome::new();
        let skill = home.path().join(".cursor").join("skills").join("brainpod");
        fs::create_dir_all(&skill).expect("foreign skill");
        fs::write(skill.join("SKILL.md"), "someone else's").expect("foreign skill");

        let error = remove(home.path(), "cursor").expect_err("refusal");
        assert!(
            error.to_string().contains("not installed from this window"),
            "{error}"
        );
        assert!(skill.join("SKILL.md").is_file());

        let cursor = scan(home.path())
            .into_iter()
            .find(|entry| entry.id == "cursor")
            .expect("cursor row");
        assert!(cursor.installed && !cursor.managed && cursor.version.is_none());
    }

    #[test]
    fn a_path_under_home_is_shown_the_way_this_os_spells_it() {
        let home = PathBuf::from(if cfg!(windows) {
            r"C:\Users\dev"
        } else {
            "/Users/dev"
        });
        let shown = display_path(&home, &under(&home, ".claude/skills").join(SKILL));

        if cfg!(windows) {
            assert_eq!(shown, r"%USERPROFILE%\.claude\skills\brainpod");
        } else {
            assert_eq!(shown, "~/.claude/skills/brainpod");
        }
    }
}
