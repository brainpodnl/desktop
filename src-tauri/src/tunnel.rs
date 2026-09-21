use std::collections::HashMap;
use std::fmt;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result, anyhow};
use prost_types::Timestamp;
use serde::Serialize;
use tauri::{AppHandle, Emitter as _};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream, tcp};
use tokio::sync::{mpsc, oneshot};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::Instant;
use tokio_stream::wrappers::ReceiverStream;
use tonic::metadata::MetadataValue;
use tonic::transport::{Channel, ClientTlsConfig, Endpoint};
use tonic::{Request, Streaming};
use uuid::Uuid;

use crate::client::Client;
use crate::config::Settings;
use crate::proto::tunnel::v1::tunnel_broker_client::TunnelBrokerClient;
use crate::proto::tunnel::v1::tunnel_service_client::TunnelServiceClient;
use crate::proto::tunnel::v1::{
    Chunk, CloseSessionRequest, DatabaseEngine, OpenSessionRequest, OpenSessionResponse,
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_CHUNK_BYTES: usize = 64 * 1024;
const INCLUDE_CREDENTIALS_METADATA: &str = "brainpod-include-credentials";
const DATABASE_PASSWORD_METADATA: &str = "brainpod-database-password-bin";
const TUNNEL_UPDATE_EVENT: &str = "tunnel://update";
const STATE_LISTENING: &str = "listening";
const STATE_CLOSED: &str = "closed";
const STATE_FAILED: &str = "failed";
/// The accept loop always needs a concrete timer deadline. A session without a
/// usable expiry gets one far enough out that the broker's own deadline, or the
/// user, ends the tunnel first.
const NO_EXPIRY: Duration = Duration::from_secs(365 * 24 * 60 * 60);
/// Quitting must not hang on an unreachable control plane, so the shutdown
/// drain gives up well before the connect timeout would.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

/// A tunnel as the webview sees it. Every field is a full snapshot: the same
/// value is returned by `tunnel_start`, listed by `tunnel_list` and pushed on
/// `tunnel://update`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tunnel {
    pub id: String,
    pub pod: String,
    pub resource: String,
    pub urn: String,
    pub engine: String,
    pub state: String,
    pub address: String,
    pub host: String,
    pub local_port: u16,
    pub remote_port: u16,
    pub username: Option<String>,
    pub database: Option<String>,
    pub password: Option<String>,
    pub dsn: Option<String>,
    pub client_command: Option<String>,
    pub expires_at: Option<String>,
    pub active_connections: u32,
    pub total_connections: u64,
    pub error: Option<String>,
}

/// Everything the control plane needs to hand a session back, kept separate
/// from the live gRPC channel so the shutdown path can reconnect from scratch.
#[derive(Clone)]
struct Session {
    endpoint: String,
    session_id: String,
    api_token: String,
}

/// What the caller asked for, carried from `start` into `listen`.
struct Launch {
    app: AppHandle,
    pod: String,
    resource: String,
    urn: String,
    port: u16,
}

struct Entry {
    tunnel: Tunnel,
    task: JoinHandle<()>,
    broker: TunnelBrokerClient<Channel>,
    session: Session,
    app: AppHandle,
}

/// Every tunnel the app has open. Held as Tauri managed state for the lifetime
/// of the process.
pub struct Tunnels {
    entries: Arc<Mutex<HashMap<String, Entry>>>,
}

impl Tunnels {
    pub fn new() -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn start(
        &self,
        app: AppHandle,
        pod: String,
        resource: String,
        port: u16,
    ) -> Result<Tunnel> {
        let settings = Settings::resolve()?;
        let api_token = settings
            .api_token
            .clone()
            .ok_or_else(|| anyhow!("Not signed in to Brainpod"))?;
        let client = Client::new(&settings.api_endpoint, &api_token)?;
        let identity = client.resolve_resource(&pod, &resource).await?;
        let database_id = identity
            .uuid
            .parse::<Uuid>()
            .context("Brainpod API returned an invalid resource UUID")?;

        let channel = connect_channel(&settings.control_plane_endpoint)
            .await
            .context("failed to connect to the Brainpod tunnel broker")?;
        let mut broker = TunnelBrokerClient::new(channel);
        let mut open_request = Request::new(OpenSessionRequest {
            database_id: database_id.to_string(),
            request_id: Uuid::new_v4().to_string(),
        });
        open_request
            .metadata_mut()
            .insert("authorization", bearer_value(&api_token)?);
        let opened = broker
            .open_session(open_request)
            .await
            .map_err(|status| RemoteTunnelError::status("failed to create tunnel session", status))?
            .into_inner();

        let session = Session {
            endpoint: settings.control_plane_endpoint.clone(),
            session_id: opened.session_id.clone(),
            api_token: api_token.clone(),
        };
        let launch = Launch {
            app,
            pod,
            resource,
            urn: identity.urn,
            port,
        };
        // Bound as a statement so the future's borrow of `broker` ends before
        // the failure path needs it mutably.
        let started = self.listen(launch, &broker, &session, &opened).await;
        match started {
            Ok(tunnel) => Ok(tunnel),
            Err(error) => {
                // The broker is already metering this session; hand it back
                // instead of leaving it open until its deadline.
                let _ = close_session(&mut broker, &session.session_id, &api_token).await;
                Err(error)
            }
        }
    }

    /// Binds the listener, proves the credentials work and publishes the
    /// tunnel. Resolves only once the tunnel is usable.
    async fn listen(
        &self,
        launch: Launch,
        broker: &TunnelBrokerClient<Channel>,
        session: &Session,
        opened: &OpenSessionResponse,
    ) -> Result<Tunnel> {
        let Launch {
            app,
            pod,
            resource,
            urn,
            port,
        } = launch;
        let engine = DatabaseEngine::try_from(opened.engine)
            .ok()
            .filter(|engine| *engine != DatabaseEngine::Unspecified)
            .ok_or_else(|| anyhow!("Brainpod tunnel broker returned an unknown database engine"))?;

        let listener = bind_listener(port).await?;
        let address = listener
            .local_addr()
            .context("failed to determine tunnel listener address")?;

        let channel = connect_channel(&opened.endpoint)
            .await
            .context("failed to connect to the Brainpod tunnel service")?;
        let service = TunnelServiceClient::new(channel);
        let ticket = opened.ticket.clone();

        let mut preflight = open_remote(service.clone(), ticket.clone(), true).await?;
        let password = preflight
            .password
            .take()
            .ok_or_else(|| RemoteTunnelError::credentials("remote service omitted the password"))?;
        drop(preflight);

        let details = connection_details(address, engine, Some(&password));
        let expires = opened.expires_at.as_ref().and_then(system_time);
        let id = Uuid::new_v4().to_string();
        let tunnel = Tunnel {
            id: id.clone(),
            pod,
            resource,
            urn,
            engine: engine_name(engine).to_owned(),
            state: STATE_LISTENING.to_owned(),
            address: address.to_string(),
            host: address.ip().to_string(),
            local_port: address.port(),
            remote_port: details.remote_port,
            username: details.username.map(str::to_owned),
            database: details.database.map(str::to_owned),
            password: Some(password),
            dsn: details.dsn,
            client_command: Some(details.client_command),
            expires_at: expires.and_then(rfc3339_utc),
            active_connections: 0,
            total_connections: 0,
            error: None,
        };

        // The accept loop reports through the map, so it waits until the entry
        // holding its own join handle is published.
        let (ready, wait_for_ready) = oneshot::channel();
        let proxy = Proxy {
            shared: Shared {
                app: app.clone(),
                entries: Arc::clone(&self.entries),
                id: id.clone(),
            },
            listener,
            service,
            ticket,
            broker: broker.clone(),
            session: session.clone(),
            deadline: expires.and_then(deadline_from),
        };
        let task = tokio::spawn(proxy.run(wait_for_ready));
        lock(&self.entries).insert(
            id,
            Entry {
                tunnel: tunnel.clone(),
                task,
                broker: broker.clone(),
                session: session.clone(),
                app: app.clone(),
            },
        );
        let _ = ready.send(());
        let _ = app.emit(TUNNEL_UPDATE_EVENT, tunnel.clone());
        Ok(tunnel)
    }

    /// Idempotent. The accept loop removes its own entry when it ends, so an
    /// id that is already gone is a tunnel that reaped itself first — the
    /// caller's intent already holds, and reporting a failure here would leave
    /// the webview holding a row it can never get rid of.
    pub async fn stop(&self, id: &str) -> Result<()> {
        let Some(entry) = lock(&self.entries).remove(id) else {
            return Ok(());
        };
        let Entry {
            mut tunnel,
            task,
            mut broker,
            session,
            app,
        } = entry;
        // Dropping the loop's JoinSet with it aborts the in-flight relays.
        task.abort();
        let closed = close_session(&mut broker, &session.session_id, &session.api_token).await;
        tunnel.state = STATE_CLOSED.to_owned();
        tunnel.active_connections = 0;
        // Emitted after the release, not before it: the local listener is gone
        // either way, so the snapshot has to carry why the remote half is not.
        if let Err(error) = &closed {
            tunnel.error = Some(format!(
                "the local listener is closed, but the remote session could not be released: {error}"
            ));
        }
        let _ = app.emit(TUNNEL_UPDATE_EVENT, tunnel);
        closed
    }

    pub fn list(&self) -> Vec<Tunnel> {
        let mut tunnels: Vec<Tunnel> = lock(&self.entries)
            .values()
            .map(|entry| entry.tunnel.clone())
            .collect();
        tunnels.sort_by_key(|tunnel| tunnel.local_port);
        tunnels
    }

    pub fn shutdown_blocking(&self) {
        let sessions: Vec<Session> = lock(&self.entries)
            .drain()
            .map(|(_, entry)| {
                entry.task.abort();
                entry.session
            })
            .collect();
        if sessions.is_empty() {
            return;
        }

        // Window destruction runs on the UI thread, which may already be inside
        // a runtime context where `block_on` panics. A dedicated thread with its
        // own runtime is safe whether or not one is current.
        let drain = std::thread::spawn(move || {
            let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            else {
                return;
            };
            runtime.block_on(async move {
                let _ = tokio::time::timeout(SHUTDOWN_TIMEOUT, close_sessions(sessions)).await;
            });
        });
        let _ = drain.join();
    }
}

/// The handle the accept loop uses to keep the published snapshot and the
/// emitted events identical.
struct Shared {
    app: AppHandle,
    entries: Arc<Mutex<HashMap<String, Entry>>>,
    id: String,
}

impl Shared {
    fn update(&self, edit: impl FnOnce(&mut Tunnel)) {
        let snapshot = {
            let mut entries = lock(&self.entries);
            let Some(entry) = entries.get_mut(&self.id) else {
                return;
            };
            edit(&mut entry.tunnel);
            entry.tunnel.clone()
        };
        let _ = self.app.emit(TUNNEL_UPDATE_EVENT, snapshot);
    }

    fn finish(&self, state: &str, error: Option<String>) {
        let snapshot = {
            let mut entries = lock(&self.entries);
            // `stop` removes the entry itself and emits its own final update.
            let Some(mut entry) = entries.remove(&self.id) else {
                return;
            };
            entry.tunnel.state = state.to_owned();
            entry.tunnel.active_connections = 0;
            if error.is_some() {
                entry.tunnel.error = error;
            }
            entry.tunnel
        };
        let _ = self.app.emit(TUNNEL_UPDATE_EVENT, snapshot);
    }
}

struct Proxy {
    shared: Shared,
    listener: TcpListener,
    service: TunnelServiceClient<Channel>,
    ticket: String,
    broker: TunnelBrokerClient<Channel>,
    session: Session,
    deadline: Option<Instant>,
}

impl Proxy {
    async fn run(self, ready: oneshot::Receiver<()>) {
        if ready.await.is_err() {
            return;
        }
        let Self {
            shared,
            listener,
            service,
            ticket,
            mut broker,
            session,
            deadline,
        } = self;

        let mut connections: JoinSet<Result<()>> = JoinSet::new();
        let sleep =
            tokio::time::sleep_until(deadline.unwrap_or_else(|| Instant::now() + NO_EXPIRY));
        tokio::pin!(sleep);

        let (state, error) = loop {
            tokio::select! {
                () = &mut sleep => {
                    // Not `closed`: that state means the user stopped it, and
                    // the webview deletes the row on sight. A tunnel that died
                    // under a client has to stay on screen and say why.
                    break (STATE_FAILED, Some("tunnel session expired".to_owned()));
                }
                accepted = listener.accept() => {
                    match accepted {
                        Ok((stream, _)) => {
                            shared.update(|tunnel| {
                                tunnel.active_connections = tunnel.active_connections.saturating_add(1);
                                tunnel.total_connections = tunnel.total_connections.saturating_add(1);
                            });
                            let service = service.clone();
                            let ticket = ticket.clone();
                            connections.spawn(async move { relay(stream, service, ticket).await });
                        }
                        Err(error) => {
                            break (
                                STATE_FAILED,
                                Some(format!("failed to accept tunnel connection: {error}")),
                            );
                        }
                    }
                }
                joined = connections.join_next(), if !connections.is_empty() => {
                    match joined {
                        None => {}
                        Some(Ok(Ok(()))) => shared.update(|tunnel| {
                            tunnel.active_connections = tunnel.active_connections.saturating_sub(1);
                            // The latest connection worked, so an earlier
                            // failure is no longer what the user is looking at.
                            tunnel.error = None;
                        }),
                        Some(Ok(Err(error))) => {
                            let message = connection_error_message(&error);
                            let fatal = error
                                .downcast_ref::<RemoteTunnelError>()
                                .is_some_and(|error| error.ends_tunnel);
                            shared.update(|tunnel| {
                                tunnel.active_connections = tunnel.active_connections.saturating_sub(1);
                                tunnel.error = Some(message.clone());
                            });
                            if fatal {
                                break (STATE_FAILED, Some(message));
                            }
                        }
                        Some(Err(error)) => shared.update(|tunnel| {
                            tunnel.active_connections = tunnel.active_connections.saturating_sub(1);
                            tunnel.error = Some(format!("tunnel connection task failed: {error}"));
                        }),
                    }
                }
            }
        };

        connections.abort_all();
        while connections.join_next().await.is_some() {}
        let _ = close_session(&mut broker, &session.session_id, &session.api_token).await;
        shared.finish(state, error);
    }
}

fn lock(entries: &Mutex<HashMap<String, Entry>>) -> MutexGuard<'_, HashMap<String, Entry>> {
    // A panic while editing a snapshot must not take every other tunnel with it.
    entries.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The window now names a port for every tunnel — it probes for a free one and
/// shows it before the bind — so there is no longer a "pick something for me"
/// case here. Binding exactly what was asked for is what lets a refusal name
/// the port that was refused.
async fn bind_listener(port: u16) -> Result<TcpListener> {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    TcpListener::bind(address).await.with_context(|| {
        format!("port {port} is not available for the tunnel; choose a different one")
    })
}

async fn close_sessions(sessions: Vec<Session>) {
    let mut grouped: HashMap<String, Vec<Session>> = HashMap::new();
    for session in sessions {
        grouped
            .entry(session.endpoint.clone())
            .or_default()
            .push(session);
    }
    for (endpoint, sessions) in grouped {
        let Ok(channel) = connect_channel(&endpoint).await else {
            continue;
        };
        let mut broker = TunnelBrokerClient::new(channel);
        for session in sessions {
            let _ = close_session(&mut broker, &session.session_id, &session.api_token).await;
        }
    }
}

async fn close_session(
    broker: &mut TunnelBrokerClient<Channel>,
    session_id: &str,
    api_token: &str,
) -> Result<()> {
    let mut request = Request::new(CloseSessionRequest {
        session_id: session_id.to_owned(),
    });
    request
        .metadata_mut()
        .insert("authorization", bearer_value(api_token)?);
    broker
        .close_session(request)
        .await
        .map_err(|status| RemoteTunnelError::status("failed to close tunnel session", status))?;
    Ok(())
}

struct RemoteConnection {
    sender: mpsc::Sender<Chunk>,
    inbound: Streaming<Chunk>,
    password: Option<String>,
}

async fn relay(
    stream: TcpStream,
    client: TunnelServiceClient<Channel>,
    ticket: String,
) -> Result<()> {
    let remote = open_remote(client, ticket, false).await?;
    relay_open(stream, remote).await
}

async fn open_remote(
    mut client: TunnelServiceClient<Channel>,
    ticket: String,
    include_credentials: bool,
) -> Result<RemoteConnection> {
    let (sender, receiver) = mpsc::channel(16);
    let mut request = Request::new(ReceiverStream::new(receiver));
    request
        .metadata_mut()
        .insert("authorization", bearer_value(&ticket)?);
    if include_credentials {
        request
            .metadata_mut()
            .insert(INCLUDE_CREDENTIALS_METADATA, "true".parse()?);
    }
    let response = client.open(request).await.map_err(|status| {
        RemoteTunnelError::status("tunnel service rejected the connection", status)
    })?;
    let password = if include_credentials {
        let value = response
            .metadata()
            .get_bin(DATABASE_PASSWORD_METADATA)
            .ok_or_else(|| RemoteTunnelError::credentials("remote service omitted the password"))?;
        let bytes = value.to_bytes().map_err(|_| {
            RemoteTunnelError::credentials("remote service returned an invalid password")
        })?;
        Some(String::from_utf8(bytes.to_vec()).map_err(|_| {
            RemoteTunnelError::credentials("remote service returned an invalid password")
        })?)
    } else {
        None
    };
    Ok(RemoteConnection {
        sender,
        inbound: response.into_inner(),
        password,
    })
}

async fn relay_open(stream: TcpStream, remote: RemoteConnection) -> Result<()> {
    let (reader, writer) = stream.into_split();
    tokio::try_join!(
        upload(reader, remote.sender),
        download(writer, remote.inbound)
    )?;
    Ok(())
}

async fn upload(mut reader: tcp::OwnedReadHalf, sender: mpsc::Sender<Chunk>) -> Result<()> {
    let mut buffer = vec![0; MAX_CHUNK_BYTES];
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            return Ok(());
        }
        sender
            .send(Chunk {
                data: buffer[..read].to_vec(),
            })
            .await
            .map_err(|_| {
                RemoteTunnelError::message("tunnel upload failed", "remote stream closed")
            })?;
    }
}

async fn download(mut writer: tcp::OwnedWriteHalf, mut inbound: Streaming<Chunk>) -> Result<()> {
    while let Some(chunk) = inbound
        .message()
        .await
        .map_err(|status| RemoteTunnelError::status("tunnel download failed", status))?
    {
        if chunk.data.is_empty() {
            return Err(RemoteTunnelError::message(
                "tunnel download failed",
                "remote service returned an empty chunk",
            )
            .into());
        }
        writer.write_all(&chunk.data).await?;
    }
    writer.shutdown().await?;
    Ok(())
}

async fn connect_channel(endpoint: &str) -> Result<Channel> {
    let endpoint_builder = Endpoint::from_shared(endpoint.to_owned())?
        .connect_timeout(CONNECT_TIMEOUT)
        .tcp_keepalive(Some(Duration::from_secs(30)))
        .http2_keep_alive_interval(Duration::from_secs(30))
        .keep_alive_timeout(Duration::from_secs(20))
        .keep_alive_while_idle(true);
    let endpoint_builder = if endpoint.starts_with("https://") {
        endpoint_builder.tls_config(ClientTlsConfig::new().with_enabled_roots())?
    } else {
        endpoint_builder
    };
    Ok(endpoint_builder.connect().await?)
}

#[derive(Debug)]
struct RemoteTunnelError {
    operation: &'static str,
    code: Option<tonic::Code>,
    message: String,
    ends_tunnel: bool,
}

impl RemoteTunnelError {
    fn status(operation: &'static str, status: tonic::Status) -> Self {
        let code = status.code();
        Self {
            operation,
            code: Some(code),
            message: status.message().to_owned(),
            ends_tunnel: matches!(
                code,
                tonic::Code::Unauthenticated
                    | tonic::Code::PermissionDenied
                    | tonic::Code::NotFound
                    | tonic::Code::DeadlineExceeded
                    | tonic::Code::InvalidArgument
                    | tonic::Code::FailedPrecondition
            ),
        }
    }

    fn message(operation: &'static str, message: impl Into<String>) -> Self {
        Self {
            operation,
            code: None,
            message: message.into(),
            ends_tunnel: false,
        }
    }

    fn credentials(message: impl Into<String>) -> Self {
        Self {
            operation: "tunnel credentials unavailable",
            code: None,
            message: message.into(),
            ends_tunnel: true,
        }
    }
}

impl fmt::Display for RemoteTunnelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.operation, self.message)?;
        if let Some(code) = self.code {
            write!(formatter, " ({code:?})")?;
        }
        Ok(())
    }
}

impl std::error::Error for RemoteTunnelError {}

fn connection_error_message(error: &anyhow::Error) -> String {
    error
        .downcast_ref::<RemoteTunnelError>()
        .map_or_else(|| error.root_cause().to_string(), ToString::to_string)
}

struct ConnectionDetails {
    remote_port: u16,
    username: Option<&'static str>,
    database: Option<&'static str>,
    client_command: String,
    dsn: Option<String>,
}

fn connection_details(
    address: SocketAddr,
    engine: DatabaseEngine,
    password: Option<&str>,
) -> ConnectionDetails {
    let host = address.ip();
    let dsn_host = dsn_host(host);
    let port = address.port();
    let password = password.map(percent_encode);
    match engine {
        DatabaseEngine::Postgres => ConnectionDetails {
            remote_port: 5432,
            username: Some("brainpod"),
            database: Some("brainpod"),
            client_command: format!(
                "psql \"host={host} port={port} user=brainpod dbname=brainpod sslmode=require\""
            ),
            dsn: password.map(|password| {
                format!("postgres://brainpod:{password}@{dsn_host}:{port}/brainpod?sslmode=require")
            }),
        },
        DatabaseEngine::Mariadb => ConnectionDetails {
            remote_port: 3306,
            username: Some("brainpod"),
            database: Some("brainpod"),
            client_command: format!(
                "mariadb --ssl --host {host} --port {port} --user brainpod --password brainpod"
            ),
            dsn: password
                .map(|password| format!("mysql://brainpod:{password}@{dsn_host}:{port}/brainpod")),
        },
        DatabaseEngine::Valkey => ConnectionDetails {
            remote_port: 6379,
            username: None,
            database: None,
            client_command: format!("valkey-cli --tls --insecure -h {host} -p {port}"),
            dsn: password.map(|password| format!("rediss://:{password}@{dsn_host}:{port}")),
        },
        DatabaseEngine::Mssql => ConnectionDetails {
            remote_port: 1433,
            username: Some("brainpod"),
            database: Some("brainpod"),
            client_command: format!("sqlcmd -S tcp:{host},{port} -U brainpod -d brainpod -C"),
            dsn: password.map(|password| {
                format!(
                    "sqlserver://brainpod:{password}@{dsn_host}:{port}?database=brainpod&encrypt=true&trustServerCertificate=true"
                )
            }),
        },
        DatabaseEngine::Unspecified => ConnectionDetails {
            remote_port: 0,
            username: None,
            database: None,
            client_command: address.to_string(),
            dsn: None,
        },
    }
}

fn dsn_host(host: IpAddr) -> String {
    match host {
        IpAddr::V4(host) => host.to_string(),
        IpAddr::V6(host) => format!("[{host}]"),
    }
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn bearer_value(token: &str) -> Result<MetadataValue<tonic::metadata::Ascii>> {
    format!("Bearer {token}")
        .parse()
        .context("API token contains invalid header characters")
}

const fn engine_name(engine: DatabaseEngine) -> &'static str {
    match engine {
        DatabaseEngine::Postgres => "postgres",
        DatabaseEngine::Mariadb => "mariadb",
        DatabaseEngine::Valkey => "valkey",
        DatabaseEngine::Mssql => "mssql",
        DatabaseEngine::Unspecified => "unspecified",
    }
}

fn system_time(timestamp: &Timestamp) -> Option<SystemTime> {
    let seconds = u64::try_from(timestamp.seconds).ok()?;
    let nanos = u32::try_from(timestamp.nanos).unwrap_or(0);
    UNIX_EPOCH.checked_add(Duration::new(seconds, nanos))
}

fn deadline_from(expires_at: SystemTime) -> Option<Instant> {
    // A deadline in the past means the local clock is skewed, not that the
    // session is dead: the broker enforces the real one, so keep serving.
    let remaining = expires_at.duration_since(SystemTime::now()).ok()?;
    Some(Instant::now() + remaining)
}

/// Formats an instant as RFC 3339 UTC to the second, which is all a two-hour
/// deadline needs and avoids a date-time dependency for one field.
fn rfc3339_utc(moment: SystemTime) -> Option<String> {
    let total = moment.duration_since(UNIX_EPOCH).ok()?.as_secs();
    let days = i64::try_from(total / 86_400).ok()?;
    let seconds_of_day = total % 86_400;
    let (year, month, day) = civil_from_days(days);
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        seconds_of_day / 3_600,
        (seconds_of_day % 3_600) / 60,
        seconds_of_day % 60
    ))
}

/// Days since the Unix epoch to a proleptic Gregorian date, after Howard
/// Hinnant's `civil_from_days`.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    (if month <= 2 { year + 1 } else { year }, month, day)
}
