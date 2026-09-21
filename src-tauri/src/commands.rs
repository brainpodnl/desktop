use reqwest::Url;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::auth::{Auth, AuthStatus, LoginStarted};
use crate::cli::{self, CliRelease, CliStatus};
use crate::client::{
    Client, Deployment, DiffEntry, Pod, Resource, ResourceEvent, ResourceMutation, Revision,
};
use crate::config::{self, Settings};
use crate::error::{Error, Result};
use crate::settings;
use crate::skills::{self, HarnessStatus, InstallReport, InstallResult, RemoteSkill};
use crate::tunnel::{Tunnel, Tunnels};

/// The home directory every agent resolves its skills directory against. Tauri
/// answers this per platform, so `%USERPROFILE%` and `$HOME` are one call.
fn home(app: &AppHandle) -> Result<std::path::PathBuf> {
    app.path()
        .home_dir()
        .map_err(|error| Error::message(format!("Could not find your home directory: {error}")))
}

/// The two directories the CLI installer resolves against: where the OS keeps
/// this app's own files, and — on Windows only — the per-user application
/// directory whose `WindowsApps` the OS puts on `PATH`.
fn app_dirs(app: &AppHandle) -> Result<(std::path::PathBuf, std::path::PathBuf)> {
    let local_data = app
        .path()
        .local_data_dir()
        .map_err(|error| Error::message(format!("Could not find your data directory: {error}")))?;
    let data_dir = app.path().app_data_dir().map_err(|error| {
        Error::message(format!("Could not find this app's data directory: {error}"))
    })?;

    Ok((local_data, data_dir))
}

/// Builds an API client from the persisted token, or fails with the message the
/// sign-in screen shows.
fn api_client() -> Result<Client> {
    let settings = Settings::resolve()?;
    let token = settings
        .api_token
        .ok_or_else(|| crate::error::Error::message("Not signed in to Brainpod"))?;
    Ok(Client::new(&settings.api_endpoint, &token)?)
}

#[tauri::command]
pub async fn auth_status() -> Result<AuthStatus> {
    Ok(Auth::status().await?)
}

#[tauri::command]
pub async fn auth_begin(app: AppHandle, auth: State<'_, Auth>) -> Result<LoginStarted> {
    Ok(auth.begin(app).await?)
}

#[tauri::command]
pub async fn auth_cancel(auth: State<'_, Auth>) -> Result<()> {
    auth.cancel();
    Ok(())
}

/// Signing out can be asked for from either window — the action lives in
/// Settings, the session lives in the pod window — so the new status is
/// broadcast rather than returned to the caller alone.
#[tauri::command]
pub async fn auth_sign_out(app: AppHandle, auth: State<'_, Auth>) -> Result<AuthStatus> {
    let status = auth.sign_out().await?;
    let _ = app.emit("auth://signed-out", &status);
    Ok(status)
}

/// Opens the Settings window, or brings it forward. The same thing the ⌘,
/// menu item does, for the places a pointer is the way in.
#[tauri::command]
pub fn open_settings(app: AppHandle) -> Result<()> {
    settings::open(&app)?;
    Ok(())
}

/// Writes the pod this window opens on into the shared config file — the same
/// key `brainpod config set pod` writes, so the CLI picks up the same default
/// with no second place to keep it.
///
/// It answers with the pod that now *resolves*, which is not always the one
/// that was written: `BRAINPOD_POD` outranks the file, and a window that
/// echoed the stored name back would claim a default the next command will not
/// use. The new value is broadcast for the same reason sign-out is — the
/// action lives in Settings and the pod window is the thing it changes.
#[tauri::command]
pub async fn set_default_pod(app: AppHandle, pod: Option<String>) -> Result<Option<String>> {
    config::store_pod(pod)?;

    let resolved = Settings::resolve()?.pod;
    let _ = app.emit("config://pod-changed", &resolved);
    Ok(resolved)
}

/// Pins every window to a palette, or hands them all back to the OS with
/// `null`. The stylesheet cannot do this: the sidebar is a real
/// `NSVisualEffectMaterial` and the traffic lights are drawn by AppKit, and
/// both follow the window's appearance rather than anything in the document.
#[tauri::command]
pub fn set_window_theme(app: AppHandle, theme: Option<String>) -> Result<()> {
    let theme = match theme.as_deref() {
        None => None,
        Some("light") => Some(tauri::Theme::Light),
        Some("dark") => Some(tauri::Theme::Dark),
        Some(other) => return Err(Error::message(format!("Unknown theme {other}"))),
    };

    for window in app.webview_windows().values() {
        window.set_theme(theme)?;
    }

    Ok(())
}

#[tauri::command]
pub async fn api_pods() -> Result<Vec<Pod>> {
    Ok(api_client()?.pods().await?)
}

#[tauri::command]
pub async fn api_revisions(pod: String) -> Result<Vec<Revision>> {
    Ok(api_client()?.revisions(&pod).await?)
}

#[tauri::command]
pub async fn api_resources(pod: String, revision: Option<String>) -> Result<Vec<Resource>> {
    Ok(api_client()?.resources(&pod, revision.as_deref()).await?)
}

#[tauri::command]
pub async fn api_events(
    pod: String,
    urn: String,
    kind: Option<String>,
    range: String,
) -> Result<Vec<ResourceEvent>> {
    Ok(api_client()?
        .events(&pod, &urn, kind.as_deref(), &range)
        .await?)
}

#[tauri::command]
pub async fn api_deploy(pod: String, summary: Option<String>) -> Result<Deployment> {
    Ok(api_client()?.deploy(&pod, summary.as_deref()).await?)
}

#[tauri::command]
pub async fn api_redeploy(pod: String) -> Result<Deployment> {
    Ok(api_client()?.redeploy(&pod).await?)
}

#[tauri::command]
pub async fn api_set_replicas(
    pod: String,
    name: String,
    replicas: u32,
) -> Result<ResourceMutation> {
    Ok(api_client()?.set_replicas(&pod, &name, replicas).await?)
}

#[tauri::command]
pub async fn api_set_instance(
    pod: String,
    kind: String,
    name: String,
    instance: String,
) -> Result<ResourceMutation> {
    Ok(api_client()?
        .set_instance(&pod, &kind, &name, &instance)
        .await?)
}

#[tauri::command]
pub async fn api_revision_diff(pod: String, revision: String) -> Result<Vec<DiffEntry>> {
    Ok(api_client()?.revision_diff(&pod, &revision).await?)
}

/// Hands a URL to whatever the user browses with. Only `http` and `https`
/// reach the OS: every caller passes a route's own address, and a command that
/// opened any scheme would be a way for the webview to launch things.
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<()> {
    let parsed =
        Url::parse(&url).map_err(|error| Error::message(format!("Invalid URL: {error}")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(Error::message(format!(
            "Refusing to open a {} URL",
            parsed.scheme()
        )));
    }

    // `parsed`, not `url`: `Url::parse` strips C0 controls and embedded tabs
    // and newlines, so the raw string is not necessarily the one that passed
    // the scheme check. What was validated is what gets executed.
    app.opener()
        .open_url(parsed.to_string(), None::<&str>)
        .map_err(|error| Error::message(format!("Could not open the browser: {error}")))
}

/// Whether the OS would hand this port over right now. It is a hint and not a
/// promise — anything can take the port between this answer and the bind — so
/// the bind stays the real gate; this only spares the user a round trip to
/// find out what was knowable up front.
#[tauri::command]
pub fn port_available(port: u16) -> bool {
    // Dropped immediately: holding it would make the answer false for the
    // tunnel that is about to ask for it.
    std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).is_ok()
}

/// A port the OS picked, which is the only way to name a free one without
/// guessing. Bound and released, so it is free at the moment it is reported.
#[tauri::command]
pub fn port_random() -> Result<u16> {
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| crate::error::Error::message(format!("No free port: {error}")))?;
    let port = listener
        .local_addr()
        .map_err(|error| crate::error::Error::message(format!("No free port: {error}")))?
        .port();
    Ok(port)
}

/// Which agents on this machine have the Brainpod skill. Filesystem only: it
/// answers while the window is offline, and it is the state the installer
/// opens on.
///
/// `async`, because a sync command runs inline on the IPC thread and this one
/// stats every directory on `PATH` for four agents: one stale network mount in
/// there would freeze the window rather than the scan.
#[tauri::command]
pub async fn skills_scan(app: AppHandle) -> Result<Vec<HarnessStatus>> {
    let home = home(&app)?;

    tauri::async_runtime::spawn_blocking(move || skills::scan(&home))
        .await
        .map_err(|error| Error::message(format!("Could not read your agents: {error}")))
}

/// The version `brainpodnl/skills` publishes right now, which is the only way
/// an install on disk can be called current or out of date.
#[tauri::command]
pub async fn skills_latest() -> Result<RemoteSkill> {
    Ok(skills::latest().await?)
}

/// One download, written into every agent named. A target that fails carries
/// its own message back rather than failing the batch: a denied directory for
/// one agent must not cost the user the three that would have worked.
#[tauri::command]
pub async fn skills_install(app: AppHandle, ids: Vec<String>) -> Result<InstallReport> {
    let home = home(&app)?;
    let package = skills::fetch().await?;

    tauri::async_runtime::spawn_blocking(move || {
        let results = ids
            .into_iter()
            .map(|id| {
                let error = skills::install(&home, &id, &package)
                    .err()
                    .map(|error| Error::from(error).to_string());
                InstallResult { id, error }
            })
            .collect();

        InstallReport {
            version: package.version,
            results,
            harnesses: skills::scan(&home),
        }
    })
    .await
    .map_err(|error| Error::message(format!("The install did not finish: {error}")))
}

#[tauri::command]
pub async fn skills_remove(app: AppHandle, id: String) -> Result<Vec<HarnessStatus>> {
    let home = home(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        skills::remove(&home, &id)?;
        Ok(skills::scan(&home))
    })
    .await
    .map_err(|error| Error::message(format!("The removal did not finish: {error}")))?
}

/// Shows an installed skill in Finder, Explorer or the desktop's file manager.
/// It takes the agent's id and resolves the path here, so the webview can only
/// ever reveal one of the four directories this window writes to — the opener
/// plugin's own reveal command, which takes any path and checks no scope, is
/// deliberately not in this app's capabilities.
#[tauri::command]
pub async fn skills_reveal(app: AppHandle, id: String) -> Result<()> {
    let home = home(&app)?;
    let path = tauri::async_runtime::spawn_blocking(move || skills::installed_path(&home, &id))
        .await
        .map_err(|error| Error::message(format!("Could not find the skill: {error}")))??;

    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|error| Error::message(format!("Could not open `{}`: {error}", path.display())))
}

/// What `brainpod` this machine has, and where this window would put one.
///
/// `async` for the same reason the skill scan is: it stats every directory on
/// `PATH`, runs two binaries to ask their version, and creates a probe file to
/// find out whether the install directory needs an authorization prompt. None
/// of that belongs on the IPC thread.
#[tauri::command]
pub async fn cli_status(app: AppHandle) -> Result<CliStatus> {
    let home = home(&app)?;
    let (local_data, data_dir) = app_dirs(&app)?;

    Ok(cli::status(&home, &local_data, &data_dir).await)
}

/// The release this machine can install right now, which is not always the
/// newest one: a release is public for the minutes its build matrix takes.
#[tauri::command]
pub async fn cli_latest() -> Result<CliRelease> {
    Ok(cli::latest().await?)
}

/// Downloads the release, checks it against the release's own `SHA256SUMS`,
/// and moves the binary into place — the last step under an authorization
/// prompt where the directory is the system's.
///
/// Progress rides an event rather than the return value: the answer arrives
/// once, and a four-megabyte download over a hotel connection needs to say
/// something before then.
#[tauri::command]
pub async fn cli_install(app: AppHandle, release: CliRelease) -> Result<CliStatus> {
    let home = home(&app)?;
    let (local_data, data_dir) = app_dirs(&app)?;

    let window = app.clone();
    cli::install(&home, &local_data, &data_dir, &release, move |progress| {
        // A dropped listener is not a reason to abandon an install.
        let _ = window.emit("cli://progress", progress);
    })
    .await?;

    Ok(cli::status(&home, &local_data, &data_dir).await)
}

/// Refused by Rust for a binary this window did not write, or one that has
/// been replaced since it did.
#[tauri::command]
pub async fn cli_remove(app: AppHandle) -> Result<CliStatus> {
    let home = home(&app)?;
    let (local_data, data_dir) = app_dirs(&app)?;

    let removing = (home.clone(), local_data.clone(), data_dir.clone());
    tauri::async_runtime::spawn_blocking(move || cli::remove(&removing.0, &removing.1, &removing.2))
        .await
        .map_err(|error| Error::message(format!("The removal did not finish: {error}")))??;

    Ok(cli::status(&home, &local_data, &data_dir).await)
}

/// Shows the installed CLI in Finder, Explorer or the desktop's file manager.
/// The path is resolved here for the same reason the skill's is: the webview
/// never names a directory this window reveals.
#[tauri::command]
pub async fn cli_reveal(app: AppHandle) -> Result<()> {
    let home = home(&app)?;
    let (local_data, data_dir) = app_dirs(&app)?;
    let path = cli::reveal_path(&home, &local_data, &data_dir);

    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|error| Error::message(format!("Could not open `{}`: {error}", path.display())))
}

#[tauri::command]
pub async fn tunnel_start(
    app: AppHandle,
    tunnels: State<'_, Tunnels>,
    pod: String,
    resource: String,
    port: u16,
) -> Result<Tunnel> {
    Ok(tunnels.start(app, pod, resource, port).await?)
}

#[tauri::command]
pub async fn tunnel_stop(tunnels: State<'_, Tunnels>, id: String) -> Result<()> {
    Ok(tunnels.stop(&id).await?)
}

#[tauri::command]
pub async fn tunnel_list(tunnels: State<'_, Tunnels>) -> Result<Vec<Tunnel>> {
    Ok(tunnels.list())
}
