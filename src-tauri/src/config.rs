use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};

pub const DEFAULT_ENDPOINT: &str = "https://api.brainpod.io";
pub const DEFAULT_CONTROL_PLANE_ENDPOINT: &str = "https://control-plane.brainpod.io";
pub const DEFAULT_DASHBOARD_ENDPOINT: &str = "https://console.brainpod.io";
/// Never read here — the desktop app does not push images — but the defaults of
/// the shared config file belong together, next to the struct that carries them.
#[allow(dead_code)]
pub const DEFAULT_REGISTRY_ENDPOINT: &str = "https://registry.brainpod.io";

/// The on-disk format of `~/.config/brainpod/config.toml`, shared verbatim with
/// the `brainpod` CLI: signing in here signs the CLI in too. The CLI parses it
/// with `deny_unknown_fields`, so a field added here would make the CLI reject
/// the user's config outright.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub endpoint: Option<String>,
    pub control_plane_endpoint: Option<String>,
    pub registry_endpoint: Option<String>,
    pub api_token: Option<String>,
    pub pod: Option<String>,
    pub architecture: Option<String>,
}

impl Config {
    pub fn path() -> Result<PathBuf> {
        if let Some(path) = std::env::var_os("BRAINPOD_CONFIG") {
            return Ok(PathBuf::from(path));
        }

        if let Some(path) = std::env::var_os("XDG_CONFIG_HOME") {
            return Ok(PathBuf::from(path).join("brainpod/config.toml"));
        }

        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| anyhow!("cannot locate config directory: HOME is not set"))?;
        Ok(home.join(".config/brainpod/config.toml"))
    }

    pub fn load(path: &Path) -> Result<Self> {
        let contents = match fs::read_to_string(path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default());
            }
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("failed to read config {}", path.display()));
            }
        };

        toml::from_str(&contents)
            .with_context(|| format!("failed to parse config {}", path.display()))
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let parent = path
            .parent()
            .ok_or_else(|| anyhow!("config path has no parent: {}", path.display()))?;
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create config directory {}", parent.display()))?;

        let contents = toml::to_string_pretty(self).context("failed to serialize config")?;
        let temporary = path.with_extension("toml.tmp");

        /*
         * Created 0600, not created and then tightened: this file holds the API
         * token, and `fs::write` would create it at `0666 & !umask` — usually
         * 0644 — leaving it world-readable for the window before the chmod.
         */
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .with_context(|| format!("failed to create config {}", temporary.display()))?;
        file.write_all(contents.as_bytes())
            .with_context(|| format!("failed to write config {}", temporary.display()))?;
        drop(file);

        fs::rename(&temporary, path)
            .with_context(|| format!("failed to replace config {}", path.display()))?;
        Ok(())
    }
}

/// The config file plus environment overrides, resolved the way the CLI resolves
/// them so both see the same account, endpoints and default pod.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub api_endpoint: String,
    pub control_plane_endpoint: String,
    pub console_endpoint: String,
    pub config_path: String,
    /// The token stays in the Rust process: the webview never needs it, and
    /// anything it can read can leak.
    #[serde(skip)]
    pub api_token: Option<String>,
    pub pod: Option<String>,
    /// `BRAINPOD_POD` is set in this environment, so `pod` comes from it and
    /// the config file's own value — whatever the window writes there — is not
    /// what anything resolves. The window says so rather than offering a
    /// control that appears to do nothing.
    pub pod_from_environment: bool,
}

impl Settings {
    pub fn resolve() -> Result<Self> {
        let config_path = Config::path()?;
        let config = Config::load(&config_path)?;

        let pod_environment = environment("BRAINPOD_POD");

        Ok(Self {
            api_endpoint: endpoint(
                environment("BRAINPOD_API_ENDPOINT").or(config.endpoint),
                DEFAULT_ENDPOINT,
            ),
            control_plane_endpoint: endpoint(
                environment("BRAINPOD_CONTROL_PLANE_ENDPOINT").or(config.control_plane_endpoint),
                DEFAULT_CONTROL_PLANE_ENDPOINT,
            ),
            // The CLI has no config key for the dashboard, only an override.
            console_endpoint: endpoint(
                environment("BRAINPOD_DASHBOARD_ENDPOINT"),
                DEFAULT_DASHBOARD_ENDPOINT,
            ),
            config_path: config_path.display().to_string(),
            api_token: environment("BRAINPOD_API_TOKEN").or(config.api_token),
            pod: pod_environment.clone().or(config.pod),
            pod_from_environment: pod_environment.is_some(),
        })
    }
}

/// Rewrites only the token, so the user's endpoint overrides, default pod and
/// build architecture survive a sign-in or sign-out.
pub fn store_token(token: Option<String>) -> Result<()> {
    let path = Config::path()?;
    let mut config = Config::load(&path)?;
    config.api_token = token;
    config.save(&path)
}

/// Rewrites only the default pod — the same key `brainpod config set pod`
/// writes — so the token and the endpoint overrides survive it.
///
/// A blank name clears the key rather than storing an empty string: the CLI
/// treats a missing `pod` as "no default" and an empty one as a pod named ``,
/// which every command would then fail on.
pub fn store_pod(pod: Option<String>) -> Result<()> {
    let path = Config::path()?;
    let mut config = Config::load(&path)?;
    config.pod = pod
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty());
    config.save(&path)
}

fn environment(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

/// Endpoints are joined with path segments everywhere downstream, so a stray
/// trailing slash would produce `//v1/pods`.
fn endpoint(configured: Option<String>, default: &str) -> String {
    let value = configured.unwrap_or_else(|| default.to_owned());
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        default.to_owned()
    } else {
        trimmed.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole contract of writing the default pod: the file is shared with
    /// the CLI, so a write that dropped the token would sign the user's command
    /// line out, and one that stored an empty name would leave every `brainpod`
    /// command acting on a pod called ``.
    ///
    /// One test, not four: `BRAINPOD_CONFIG` and `BRAINPOD_POD` are
    /// process-global, and a second test touching them would race this one.
    #[test]
    fn storing_a_pod_rewrites_only_the_pod() {
        let dir = std::env::temp_dir().join(format!("brainpod-config-test-{}", std::process::id()));
        let path = dir.join("config.toml");
        fs::create_dir_all(&dir).unwrap();
        unsafe { std::env::set_var("BRAINPOD_CONFIG", &path) };

        Config {
            endpoint: Some("https://api.example.test".to_owned()),
            api_token: Some("token".to_owned()),
            ..Config::default()
        }
        .save(&path)
        .unwrap();

        store_pod(Some("  foxes-vanish  ".to_owned())).unwrap();
        let written = Config::load(&path).unwrap();
        assert_eq!(written.pod.as_deref(), Some("foxes-vanish"));
        assert_eq!(written.api_token.as_deref(), Some("token"));
        assert_eq!(written.endpoint.as_deref(), Some("https://api.example.test"));

        store_pod(Some("   ".to_owned())).unwrap();
        assert_eq!(Config::load(&path).unwrap().pod, None);
        store_pod(Some("foxes-vanish".to_owned())).unwrap();

        let settings = Settings::resolve().unwrap();
        assert_eq!(settings.pod.as_deref(), Some("foxes-vanish"));
        assert!(!settings.pod_from_environment);

        unsafe { std::env::set_var("BRAINPOD_POD", "pinned-pod") };
        let settings = Settings::resolve().unwrap();
        assert_eq!(settings.pod.as_deref(), Some("pinned-pod"));
        assert!(settings.pod_from_environment);
        // The file still says what the window wrote; the environment merely
        // outranks it while it is set.
        assert_eq!(Config::load(&path).unwrap().pod.as_deref(), Some("foxes-vanish"));

        unsafe {
            std::env::remove_var("BRAINPOD_POD");
            std::env::remove_var("BRAINPOD_CONFIG");
        }
        fs::remove_dir_all(&dir).ok();
    }
}
