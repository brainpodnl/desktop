use std::net::Ipv4Addr;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use axum::Router;
use axum::extract::rejection::QueryRejection;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};

use crate::client::{self, Client};
use crate::config::{self, Settings};

const CALLBACK_PATH: &str = "/callback";
const AUTHENTICATION_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub signed_in: bool,
    pub email: Option<String>,
    pub api_endpoint: String,
    pub console_endpoint: String,
    pub config_path: String,
    pub pod: Option<String>,
    /// The default pod is pinned by `BRAINPOD_POD` in this environment, so the
    /// Settings window states it instead of offering to change it.
    pub pod_from_environment: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStarted {
    pub url: String,
    pub expires_in_seconds: u64,
}

/// Holds the cancel handle of the at most one sign-in flow in flight. The flow
/// itself lives in a spawned task so the command can return the moment the
/// browser is open.
pub struct Auth {
    cancel: Mutex<Option<oneshot::Sender<()>>>,
}

impl Auth {
    pub fn new() -> Self {
        Self {
            cancel: Mutex::new(None),
        }
    }

    pub async fn status() -> Result<AuthStatus> {
        let settings = Settings::resolve()?;
        let Some(token) = settings.api_token.clone() else {
            return Ok(status_of(&settings, false, None));
        };

        let client = Client::new(&settings.api_endpoint, &token)?;
        match client.me().await {
            Ok(identity) => Ok(status_of(&settings, true, email_of(&identity))),
            // Only the API can retire a token. Anything else — offline, DNS,
            // a 503 — leaves the token valid, and signing the user out over a
            // hiccup would lose them their session.
            Err(error) if client::is_unauthorized(&error) => Ok(status_of(&settings, false, None)),
            Err(_) => Ok(status_of(&settings, true, None)),
        }
    }

    pub async fn begin(&self, app: AppHandle) -> Result<LoginStarted> {
        self.cancel();

        let settings = Settings::resolve()?;
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .context("failed to start the sign-in callback server")?;
        let port = listener
            .local_addr()
            .context("failed to determine the sign-in callback address")?
            .port();
        let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
        let state = generate_state()?;
        let authorize_url = authorization_url(&settings.console_endpoint, &redirect_uri, &state)?;

        let (request_sender, mut requests) = mpsc::channel(1);
        let router = Router::new()
            .route(CALLBACK_PATH, get(handle_callback))
            .with_state(CallbackState {
                expected_state: state,
                requests: request_sender,
            });
        let (shutdown_sender, shutdown) = oneshot::channel();
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = shutdown.await;
                })
                .await;
        });

        let url = authorize_url.to_string();
        if let Err(error) = app.opener().open_url(url.clone(), None::<&str>) {
            // Not fatal: the URL travels back to the UI, which offers it for
            // the user to open by hand.
            eprintln!("failed to open the browser for sign-in: {error}");
        }

        let (cancel_sender, cancel) = oneshot::channel();
        *self.slot() = Some(cancel_sender);

        tokio::spawn(async move {
            let outcome = tokio::select! {
                request = requests.recv() => match request {
                    Some(request) => Outcome::Callback(request),
                    None => Outcome::ServerStopped,
                },
                _ = tokio::time::sleep(AUTHENTICATION_TIMEOUT) => Outcome::TimedOut,
                _ = cancel => Outcome::Cancelled,
            };

            settle(&app, outcome).await;

            let _ = shutdown_sender.send(());
            let _ = server.await;
        });

        Ok(LoginStarted {
            url,
            expires_in_seconds: AUTHENTICATION_TIMEOUT.as_secs(),
        })
    }

    pub fn cancel(&self) {
        if let Some(cancel) = self.slot().take() {
            let _ = cancel.send(());
        }
    }

    pub async fn sign_out(&self) -> Result<AuthStatus> {
        self.cancel();
        // Clearing the key rather than deleting the file keeps the endpoint
        // overrides and default pod the user shares with the CLI.
        config::store_token(None)?;
        Self::status().await
    }

    fn slot(&self) -> MutexGuard<'_, Option<oneshot::Sender<()>>> {
        self.cancel
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }
}

enum Outcome {
    Callback(CallbackRequest),
    TimedOut,
    Cancelled,
    ServerStopped,
}

/// Renders the browser page, then tells the UI how the flow ended. The page is
/// answered first: the browser is still waiting on that request.
async fn settle(app: &AppHandle, outcome: Outcome) {
    let request = match outcome {
        Outcome::Callback(request) => request,
        Outcome::TimedOut => return failed(app, "Sign in timed out. Try again."),
        Outcome::Cancelled => {
            let _ = app.emit("auth://cancelled", ());
            return;
        }
        Outcome::ServerStopped => {
            return failed(app, "The sign-in callback server stopped unexpectedly.");
        }
    };

    let token = match request.callback {
        Ok(Callback::Token(token)) => token,
        Ok(Callback::Cancelled) => {
            let _ = request.response.send(Page::Cancelled);
            let _ = app.emit("auth://cancelled", ());
            return;
        }
        Err(error) => {
            let _ = request.response.send(Page::Failed);
            return failed(app, format!("{error:#}"));
        }
    };

    if let Err(error) = config::store_token(Some(token)) {
        let _ = request.response.send(Page::Failed);
        return failed(app, format!("{error:#}"));
    }

    let _ = request.response.send(Page::Success);
    match Auth::status().await {
        Ok(status) => {
            let _ = app.emit("auth://completed", status);
        }
        Err(error) => failed(app, format!("{error:#}")),
    }
}

fn failed(app: &AppHandle, message: impl Into<String>) {
    let _ = app.emit(
        "auth://failed",
        serde_json::json!({ "message": message.into() }),
    );
}

fn status_of(settings: &Settings, signed_in: bool, email: Option<String>) -> AuthStatus {
    AuthStatus {
        signed_in,
        email,
        api_endpoint: settings.api_endpoint.clone(),
        console_endpoint: settings.console_endpoint.clone(),
        config_path: settings.config_path.clone(),
        pod: settings.pod.clone(),
        pod_from_environment: settings.pod_from_environment,
    }
}

fn email_of(identity: &Value) -> Option<String> {
    identity
        .get("email")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn generate_state() -> Result<String> {
    use std::fmt::Write as _;

    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| anyhow!("failed to generate authentication state: {error}"))?;

    let mut state = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(state, "{byte:02x}");
    }
    Ok(state)
}

fn authorization_url(console_endpoint: &str, redirect_uri: &str, state: &str) -> Result<Url> {
    let mut url = Url::parse(console_endpoint).context("invalid Brainpod console endpoint")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(anyhow!("Brainpod console endpoint must use http or https"));
    }
    if url.host_str().is_none() {
        return Err(anyhow!("Brainpod console endpoint has no host"));
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(anyhow!(
            "Brainpod console endpoint must not contain credentials, a query, or a fragment"
        ));
    }
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| anyhow!("Brainpod console endpoint cannot be a base URL"))?;
        segments.pop_if_empty();
        segments.extend(["cli", "authorize"]);
    }
    url.query_pairs_mut()
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("state", state);
    Ok(url)
}

#[derive(Clone)]
struct CallbackState {
    expected_state: String,
    requests: mpsc::Sender<CallbackRequest>,
}

struct CallbackRequest {
    callback: Result<Callback>,
    response: oneshot::Sender<Page>,
}

#[derive(Deserialize)]
struct CallbackQuery {
    token: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

enum Callback {
    Token(String),
    Cancelled,
}

async fn handle_callback(
    State(state): State<CallbackState>,
    query: std::result::Result<Query<CallbackQuery>, QueryRejection>,
) -> Response {
    /*
     * A request whose `state` is not this flow's is not this flow's callback.
     * It is answered and dropped rather than passed on, because the channel
     * holds exactly one outcome: letting a stranger consume it would end a
     * sign-in that is still live in the user's browser. The listener is
     * loopback-only, but every other local process can still reach it.
     */
    let callback = match query {
        Ok(Query(query)) if query.state.as_deref() != Some(state.expected_state.as_str()) => {
            return Page::Failed.into_response();
        }
        Ok(Query(query)) => parse_callback_query(query, &state.expected_state),
        Err(_) => return Page::Failed.into_response(),
    };

    let (response, page) = oneshot::channel();
    if state
        .requests
        .send(CallbackRequest { callback, response })
        .await
        .is_err()
    {
        return Page::Unavailable.into_response();
    }

    match page.await {
        Ok(page) => page.into_response(),
        Err(_) => Page::Unavailable.into_response(),
    }
}

fn parse_callback_query(query: CallbackQuery, expected_state: &str) -> Result<Callback> {
    if query.state.as_deref() != Some(expected_state) {
        return Err(anyhow!("authentication callback state did not match"));
    }

    match (query.token, query.error) {
        (Some(token), None) if token.starts_with("brain_") && token.len() > "brain_".len() => {
            Ok(Callback::Token(token))
        }
        (None, Some(error)) if error == "access_denied" => Ok(Callback::Cancelled),
        (None, Some(error)) => Err(anyhow!("dashboard returned authentication error `{error}`")),
        _ => Err(anyhow!("authentication callback had an invalid result")),
    }
}

/// What the browser tab is left showing. It is the only confirmation the user
/// gets in the browser, so each outcome says plainly where to go next.
///
/// The page is the CLI's: same card, same mark, same confetti, same wording
/// where the wording still holds. A user signs in from both products against
/// the same console, and a second, lesser page would read as a different
/// company. What differs is only what is true here — the thing carrying on is
/// an app window, not a terminal.
enum Page {
    Success,
    Cancelled,
    Failed,
    Unavailable,
}

/// The one outcome worth confetti. Everything else is a dead end the user has
/// to act on, and celebrating those would be noise over an apology.
impl Page {
    fn celebrates(&self) -> bool {
        matches!(self, Self::Success)
    }
}

const STYLE: &str = include_str!("callback.css");
const CONFETTI: &str = include_str!("callback-confetti.html");

const MARK: &str = concat!(
    r#"<svg viewBox="0 0 19.89 21.47" aria-hidden><path fill="currentColor" d="M6.14451 14.0293C6.40601 10.6845 9.10699 7.98496 12.4518 7.72417C13.9056 7.61047 15.2721 7.95227 16.4275 8.6181C19.3971 3.77042 16.8525 0 11.8044 0H0.974935C0.436304 0 0 0.436305 0 0.974936V19.7588C0 20.2377 0.348192 20.6485 0.821449 20.7217C3.05485 21.0677 5.18734 20.5604 7.5785 18.8087C6.56306 17.5091 6.00382 15.8363 6.14451 14.0293Z"/>"#,
    r##"<path fill="#003399" d="M16.4282 8.61755C16.2939 8.83642 16.1497 9.05812 15.9926 9.28125C12.6742 13.9989 9.9938 17.0395 7.57849 18.8096C8.83767 20.422 10.7982 21.4601 13.0018 21.4601C16.8006 21.4601 19.8803 18.3804 19.8803 14.5816C19.8803 12.0305 18.4904 9.80567 16.4282 8.61755Z"/></svg>"##
);

impl IntoResponse for Page {
    fn into_response(self) -> Response {
        let celebrate = self.celebrates();
        let (status, title, headline, lead, badge, badge_tone, note, foot) = match self {
            Self::Success => (
                StatusCode::OK,
                "Signed in",
                "Signed in.",
                "The token is stored. The Brainpod app you started this from is already carrying on.",
                "signed in",
                "",
                "Nothing else to do here — this tab can be closed.",
                "Token stored in your Brainpod config",
            ),
            Self::Cancelled => (
                StatusCode::OK,
                "Sign-in cancelled",
                "Sign-in was cancelled.",
                "Nothing changed, and no token was stored. The app is still waiting, so you can start again from there.",
                "not signed in",
                " is-warn",
                "",
                "You can close this tab.",
            ),
            Self::Failed => (
                StatusCode::BAD_REQUEST,
                "Sign-in failed",
                "Sign-in failed.",
                "That authorization could not be completed, so no token was stored. Start again from the Brainpod app.",
                "not signed in",
                " is-fail",
                "",
                "You can close this tab.",
            ),
            Self::Unavailable => (
                StatusCode::GONE,
                "Sign-in expired",
                "This link has expired.",
                "The Brainpod app stopped waiting for this authorization. Start again from the app.",
                "not signed in",
                " is-fail",
                "",
                "You can close this tab.",
            ),
        };

        let burst = if celebrate {
            format!(r#"<div class="confetti" aria-hidden>{CONFETTI}</div>"#)
        } else {
            String::new()
        };
        let note = if note.is_empty() {
            String::new()
        } else {
            format!(r#"<p class="section-label">{note}</p>"#)
        };

        let body = format!(
            concat!(
                r#"<!doctype html><html lang="en"><head><meta charset="utf-8">"#,
                r#"<meta name="viewport" content="width=device-width,initial-scale=1">"#,
                "<title>{title} — Brainpod</title><style>{style}</style></head><body>",
                "{burst}",
                r#"<main class="card"><div class="chrome">{mark}<span class="wordmark">Brainpod</span>"#,
                r#"<span class="badge{badge_tone}"><span class="dot"></span>{badge}</span></div>"#,
                r#"<div class="body"><h1>{headline}</h1><p class="lead">{lead}</p>{note}</div>"#,
                r#"<div class="foot"><span>{foot}</span>"#,
                r#"<a class="sep" href="https://brainpod.io">brainpod.io &rarr;</a></div></main>"#,
                "</body></html>"
            ),
            title = title,
            style = STYLE,
            burst = burst,
            mark = MARK,
            badge_tone = badge_tone,
            badge = badge,
            headline = headline,
            lead = lead,
            note = note,
            foot = foot,
        );

        (
            status,
            [
                ("cache-control", "no-store"),
                (
                    "content-security-policy",
                    "default-src 'none'; style-src 'unsafe-inline'",
                ),
                ("x-content-type-options", "nosniff"),
            ],
            Html(body),
        )
            .into_response()
    }
}
