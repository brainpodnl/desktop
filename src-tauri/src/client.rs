use std::collections::HashSet;
use std::fmt;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use reqwest::header::{ACCEPT, AUTHORIZATION, HeaderMap, HeaderValue};
use reqwest::{StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    endpoint: Url,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pod {
    pub name: String,
    pub display_name: Option<String>,
    pub status: Option<String>,
    pub version: Option<u64>,
    pub deployed: bool,
}

/// One entry in a pod's revision history. A revision is the unit the API
/// versions a pod by: the graph is always read at one of them, and `deployed`
/// is the one actually running.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub id: String,
    pub version: Option<u64>,
    pub state: Option<String>,
    pub deployed: bool,
    pub latest: bool,
    pub created_at: Option<String>,
    pub summary: Option<String>,
}

/// One node of a pod's resource graph. The API answers with a per-kind `spec`
/// union and names neighbours by reference; both are flattened here so the
/// webview reads one shape and never walks untyped JSON.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resource {
    pub urn: String,
    pub name: String,
    pub kind: String,
    pub engine: Option<String>,
    pub healthy: bool,
    pub phase: Option<String>,
    pub version: Option<String>,
    pub instance: Option<String>,
    pub size: Option<u32>,
    pub replicas: Option<u32>,
    pub ready_replicas: Option<u32>,
    pub image: Option<String>,
    pub hostname: Option<String>,
    pub domains: Vec<String>,
    pub depends_on: Vec<String>,
    /// The `apiVersion` the document was written under. A PUT replaces the
    /// whole document, so it has to travel back out with the rest of it.
    pub api_version: String,
    /// True while a console task — a restart, a backup, a restore — holds the
    /// resource. The API rejects a write against one that is held.
    pub locked: bool,
    /// Workload kinds only; the rest of the union runs no pods to report.
    pub replica_states: Vec<Replica>,
    /// Disk only: whether the claim found its volume.
    pub bound: Option<bool>,
    /// Disk and Route, which report readiness as a flag where a workload
    /// reports a phase.
    pub ready: Option<bool>,
    pub env: Vec<EnvVar>,
    pub mounts: Vec<Mount>,
    /// `lifecycle.init`, flattened to the command line it runs.
    pub init_command: Option<String>,
    pub ready_check: Option<ReadyCheck>,
    pub runtime: Option<RuntimeUser>,
    /// Git provenance of the running image, set when the app was built from a
    /// repository rather than pointed at a registry.
    pub artifact_repo: Option<String>,
    pub artifact_ref: Option<String>,
    pub rules: Vec<RouteRule>,
    /// Route request timeout, in seconds.
    pub timeout: Option<u32>,
    pub files: Vec<ConfigFile>,
    pub volume_handle: Option<String>,
    /// The disk a database stores on.
    pub disk_ref: Option<String>,
    /// MSSQL only.
    pub edition: Option<String>,
    pub variables: Vec<Variable>,
}

/// One replica of a workload as the control plane sees it now. `reason` is the
/// scheduler's own explanation and is there only while something is wrong.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Replica {
    pub name: String,
    pub phase: String,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvVar {
    pub name: String,
    pub value: String,
}

/// A mount names either a disk or a config, so `target` is whichever one it
/// named, reduced to the name the graph keys its nodes by. `file` is the one
/// field that tells the two apart: only a config mount names a file.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mount {
    pub path: String,
    pub target: String,
    pub file: Option<String>,
}

/// The probe that decides when a replica is ready. A check is either a command
/// or an HTTP request, never both, so nothing below is guaranteed.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyCheck {
    pub cmd: Vec<String>,
    pub port: Option<u32>,
    pub host: Option<String>,
    pub path: Option<String>,
}

/// The identity an app's container runs as. Absent means the image's own user,
/// which is what an app that never asked for one gets.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeUser {
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub fs_group: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteRule {
    pub name: String,
    pub path: String,
    pub port: u32,
    pub backend: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFile {
    pub name: String,
    pub contents: String,
}

/// A variable the pod publishes to its apps. A secret's `value` is always null:
/// the API resolves it inside the cluster and never sends it back out, so the
/// panel can say that one exists but never what it holds.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Variable {
    pub name: String,
    #[serde(rename = "ref")]
    pub reference: String,
    pub secret: bool,
    pub resolved: bool,
    pub value: Option<String>,
    pub description: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceIdentity {
    pub urn: String,
    pub uuid: String,
}

/// One line of a resource's event stream. The API answers a union discriminated
/// by `kind` — app output, platform notices, HTTP access records — which is
/// flattened here so the rail draws a single list; every field from `level`
/// down belongs to exactly one kind and is null for the other two.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceEvent {
    pub id: String,
    pub kind: String,
    pub body: String,
    pub timestamp: String,
    pub level: Option<String>,
    pub reason: Option<String>,
    pub method: Option<String>,
    pub status: Option<u32>,
    pub host: Option<String>,
    pub path: Option<String>,
    pub duration_ms: Option<u32>,
}

/// What the API accepted a deploy or a redeploy as. `state` is the stage the
/// revision was in when it answered and not the outcome: the deployment runs
/// after the request returns, and the revision list is what reports its end.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Deployment {
    pub revision_id: String,
    pub state: String,
    pub error: Option<String>,
}

/// One resource a revision changed against its parent.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffEntry {
    pub kind: String,
    pub name: String,
    pub change_type: String,
}

/// A draft write: the revision it landed in, and the resources as they read
/// afterwards. Nothing running changes until that revision is deployed.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceMutation {
    pub revision_id: String,
    pub resources: Vec<Resource>,
}

impl Client {
    pub fn new(endpoint: &str, api_token: &str) -> Result<Self> {
        let endpoint = Url::parse(endpoint).context("invalid Brainpod API endpoint")?;

        let mut authorization = HeaderValue::from_str(&format!("Bearer {api_token}"))
            .context("API token contains invalid header characters")?;
        authorization.set_sensitive(true);
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, authorization);
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));

        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .default_headers(headers)
            .build()
            .context("failed to create HTTP client")?;

        Ok(Self { http, endpoint })
    }

    pub async fn me(&self) -> Result<Value> {
        self.get(&["v1", "me"], &[]).await
    }

    pub async fn pods(&self) -> Result<Vec<Pod>> {
        let value = self.get(&["v1", "pods"], &[]).await?;
        Ok(entries(&value).iter().filter_map(parse_pod).collect())
    }

    /// The pod's revision history, newest first. The API paginates this; one
    /// page is what a picker can show without becoming a browser of its own,
    /// and the deployed revision is always on it because it is never old.
    pub async fn revisions(&self, pod: &str) -> Result<Vec<Revision>> {
        let value = self.get(&["v1", "pods", pod, "revisions"], &[]).await?;
        Ok(items(value.get("items"))
            .iter()
            .filter_map(parse_revision)
            .collect())
    }

    /// `revision` reads the graph as it was at that revision rather than at the
    /// pod's head, which is the same switch the CLI's `--revision` flag throws.
    pub async fn resources(&self, pod: &str, revision: Option<&str>) -> Result<Vec<Resource>> {
        let query: Vec<(&str, &str)> = revision
            .map(|revision| vec![("revision", revision)])
            .unwrap_or_default();
        let value = self.get(&["v1", "pods", pod, "resources"], &query).await?;
        let mut resources: Vec<Resource> =
            entries(&value).iter().filter_map(parse_resource).collect();
        resources.sort_by(|left, right| left.name.cmp(&right.name));

        // A spec can name a resource that no longer exists, and an edge to a node
        // the graph never draws would point at nothing.
        let drawn: HashSet<String> = resources
            .iter()
            .map(|resource| resource.name.clone())
            .collect();
        for resource in &mut resources {
            resource.depends_on.retain(|name| drawn.contains(name));
        }

        Ok(resources)
    }

    /// Accepts a resource name, a URN or a UUID, which is what the tunnel
    /// session needs before it can ask the control plane for a port.
    pub async fn resolve_resource(&self, pod: &str, identifier: &str) -> Result<ResourceIdentity> {
        let value = self
            .get(
                &["v1", "pods", pod, "resources", "resolve", identifier],
                &[],
            )
            .await
            .with_context(|| format!("failed to resolve resource `{identifier}` in pod `{pod}`"))?;
        serde_json::from_value(value).context("Brainpod API returned an invalid resource identity")
    }

    /// The API scopes events to one resource and rejects a request without a
    /// `resource` URN, so this takes the URN and not the name the rest of the
    /// panel is keyed by. Leaving `kind` open reads all three streams at once,
    /// and `range` is the API's own window vocabulary — `5m` through `7d` —
    /// which it validates far better than a guess here would.
    pub async fn events(
        &self,
        pod: &str,
        urn: &str,
        kind: Option<&str>,
        range: &str,
    ) -> Result<Vec<ResourceEvent>> {
        let mut query = vec![("resource", urn), ("range", range)];
        if let Some(kind) = kind {
            query.push(("kind", kind));
        }
        let value = self.get(&["v1", "pods", pod, "events"], &query).await?;
        // A paginated answer nests its page under `items`; a bare array is what
        // the same list without a cursor would be.
        let page = value.get("items").unwrap_or(&value);
        Ok(entries(page).iter().filter_map(parse_event).collect())
    }

    /// Deploys the pod's head revision. The API answers 412 unless that
    /// revision is still a draft, and that check is worth leaving to it: the
    /// head can move between the panel's last read and this call.
    pub async fn deploy(&self, pod: &str, summary: Option<&str>) -> Result<Deployment> {
        let body = match summary {
            Some(summary) => json!({ "summary": summary }),
            None => json!({}),
        };
        let value = self.post(&["v1", "pods", pod, "deploy"], &body).await?;
        parse_deployment(&value)
    }

    /// Retries a deployment that failed. Only the pod's latest revision
    /// qualifies and only while it is in `failed`; anything else is a 412,
    /// because redeploying an older revision would be a rollback and the API
    /// has no such endpoint.
    pub async fn redeploy(&self, pod: &str) -> Result<Deployment> {
        let value = self
            .post(&["v1", "pods", pod, "redeploy"], &json!({}))
            .await?;
        parse_deployment(&value)
    }

    /// Scales an app. `replicas` is the only field that moves; everything else
    /// the document holds is re-sent untouched.
    pub async fn set_replicas(
        &self,
        pod: &str,
        name: &str,
        replicas: u32,
    ) -> Result<ResourceMutation> {
        self.replace_spec_field(pod, "App", name, "replicas", Value::from(replicas))
            .await
    }

    /// Resizes a resource. `kind` is the title-cased wire kind — `App`,
    /// `Postgres`, `MSSQL` — because the API matches the path segment exactly.
    pub async fn set_instance(
        &self,
        pod: &str,
        kind: &str,
        name: &str,
        instance: &str,
    ) -> Result<ResourceMutation> {
        self.replace_spec_field(pod, kind, name, "instance", Value::from(instance))
            .await
    }

    /// One spec field, moved through the read-modify-write the API's PUT
    /// demands: there is no PATCH, and a PUT replaces the resource whole. The
    /// round trip lives here rather than in the webview because a UI that
    /// assembled the spec itself would silently drop every field it did not
    /// know to echo back. The result lands in the pod's mutable draft revision,
    /// so nothing running changes until the caller deploys it.
    async fn replace_spec_field(
        &self,
        pod: &str,
        kind: &str,
        name: &str,
        field: &str,
        replacement: Value,
    ) -> Result<ResourceMutation> {
        let path = ["v1", "pods", pod, "resources", kind, "default", name];
        let current = self.get(&path, &[]).await?;
        let mut content = current.get("content").cloned().ok_or_else(|| {
            anyhow!("Brainpod API returned `{name}` without a document to replace")
        })?;
        let spec = content
            .get_mut("spec")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("resource `{name}` has no spec to change"))?;
        spec.insert(field.to_owned(), replacement);

        let value = self.put(&path, &content).await?;
        parse_mutation(&value)
    }

    /// What a revision changed against its parent. Each entry also carries the
    /// unified `patch` that produced it, which is dropped here: a diff hunk is
    /// unreadable in a 360px rail, and carrying one across the bridge would
    /// make the payload mostly text nothing draws.
    pub async fn revision_diff(&self, pod: &str, revision: &str) -> Result<Vec<DiffEntry>> {
        let value = self
            .get(&["v1", "pods", pod, "revisions", revision, "diff"], &[])
            .await?;
        Ok(items(value.get("entries"))
            .iter()
            .filter_map(parse_diff_entry)
            .collect())
    }

    async fn get(&self, segments: &[&str], query: &[(&str, &str)]) -> Result<Value> {
        self.send(self.http.get(self.url(segments)?).query(query))
            .await
    }

    async fn post(&self, segments: &[&str], body: &Value) -> Result<Value> {
        self.send(self.http.post(self.url(segments)?).json(body))
            .await
    }

    async fn put(&self, segments: &[&str], body: &Value) -> Result<Value> {
        self.send(self.http.put(self.url(segments)?).json(body))
            .await
    }

    /// Every request lands here so that a write reports a rejected token, an
    /// API error message and an HTML gateway page exactly the way a read does.
    /// A successful write is entitled to answer with no body at all, which is
    /// `Value::Null` and not a failure; the callers that need a document say so
    /// themselves when they fail to find one in it.
    async fn send(&self, request: reqwest::RequestBuilder) -> Result<Value> {
        let response = request
            .send()
            .await
            .context("Brainpod API request failed")?;

        let status = response.status();
        let text = response
            .text()
            .await
            .context("failed to read Brainpod API response")?;
        let body = if text.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::String(text))
        };

        if !status.is_success() {
            return Err(ApiError::new(status, &body).into());
        }

        if body.is_string() {
            return Err(anyhow!("Brainpod API returned a non-JSON response"));
        }

        Ok(body)
    }

    fn url(&self, segments: &[&str]) -> Result<Url> {
        let mut url = self.endpoint.clone();
        {
            let mut path = url
                .path_segments_mut()
                .map_err(|_| anyhow!("Brainpod API endpoint cannot be a base URL"))?;
            path.pop_if_empty();
            path.extend(segments.iter().copied());
        }
        Ok(url)
    }
}

/// The API resource kinds that this app can tunnel into. Shared with the tunnel
/// module so a database listed on screen is exactly one it can open.
pub fn engine_for_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "Postgres" => Some("postgres"),
        "MariaDB" => Some("mariadb"),
        "Valkey" => Some("valkey"),
        "MSSQL" => Some("mssql"),
        _ => None,
    }
}

/// A stored token that the API has rejected is dead, unlike a request that
/// merely failed to reach it.
pub fn is_unauthorized(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<ApiError>()
            .is_some_and(|api| api.status == StatusCode::UNAUTHORIZED)
    })
}

/// The API answers list endpoints with a bare array; anything else means the
/// account has nothing to show.
fn entries(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}

fn items(value: Option<&Value>) -> &[Value] {
    value.map(entries).unwrap_or_default()
}

fn parse_pod(value: &Value) -> Option<Pod> {
    let name = value.get("name").and_then(Value::as_str)?;
    Some(Pod {
        name: name.to_owned(),
        display_name: text(value.get("displayName")),
        status: text(value.pointer("/head/status")),
        version: value.pointer("/head/version").and_then(Value::as_u64),
        deployed: value.get("deployed").is_some_and(|value| !value.is_null()),
    })
}

fn parse_revision(value: &Value) -> Option<Revision> {
    let id = value.get("id").and_then(Value::as_str)?;
    Some(Revision {
        id: id.to_owned(),
        version: value.get("version").and_then(Value::as_u64),
        state: text(value.get("state")),
        deployed: value
            .get("isDeployed")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        latest: value
            .get("isLatest")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        created_at: text(value.get("createdAt")),
        summary: text(value.get("summary")),
    })
}

fn parse_resource(value: &Value) -> Option<Resource> {
    let kind = value.pointer("/content/kind").and_then(Value::as_str)?;
    // The kinds the graph draws. A kind the API grows later is skipped rather
    // than guessed into the wrong shape.
    if !matches!(
        kind,
        "App" | "Route" | "Postgres" | "MariaDB" | "Valkey" | "MSSQL" | "Disk" | "Config"
    ) {
        return None;
    }
    let urn = value.get("urn").and_then(Value::as_str)?;
    let name = value
        .pointer("/content/metadata/name")
        .and_then(Value::as_str)?;

    // Each kind declares its own spec fields, so a field is read only where it
    // exists instead of being hunted for across the union.
    let engine = engine_for_kind(kind);
    let database = engine.is_some();
    let app = kind == "App";
    let route = kind == "Route";
    let disk = kind == "Disk";
    // The kinds that run pods, and so the only ones whose status names any.
    let workload = app || database;

    Some(Resource {
        urn: urn.to_owned(),
        name: name.to_owned(),
        kind: kind.to_owned(),
        engine: engine.map(str::to_owned),
        healthy: flag(value.get("healthy")),
        // Only App and Disk report a phase; the rest carry a bare `ready`, and
        // `status` is absent until the pod has been deployed at all.
        phase: text(value.pointer("/status/phase")),
        version: database
            .then(|| scalar(value.pointer("/content/spec/version")))
            .flatten(),
        instance: (app || database)
            .then(|| text(value.pointer("/content/spec/instance")))
            .flatten(),
        size: disk
            .then(|| count(value.pointer("/content/spec/size")))
            .flatten(),
        replicas: app
            .then(|| count(value.pointer("/content/spec/replicas")))
            .flatten(),
        ready_replicas: app
            .then(|| count(value.pointer("/status/readyReplicas")))
            .flatten(),
        image: app
            .then(|| text(value.pointer("/content/spec/image")))
            .flatten(),
        hostname: route
            .then(|| text(value.pointer("/content/spec/hostname")))
            .flatten(),
        domains: if route {
            strings(value.pointer("/content/spec/domains"))
        } else {
            Vec::new()
        },
        depends_on: dependencies(kind, value.pointer("/content/spec")),
        api_version: text(value.pointer("/content/apiVersion")).unwrap_or_default(),
        locked: flag(value.get("locked")),
        replica_states: if workload {
            parse_replicas(value.pointer("/status/replicas"))
        } else {
            Vec::new()
        },
        bound: disk
            .then(|| value.pointer("/status/bound").and_then(Value::as_bool))
            .flatten(),
        ready: (disk || route)
            .then(|| value.pointer("/status/ready").and_then(Value::as_bool))
            .flatten(),
        env: if app {
            parse_env(value.pointer("/content/spec/env"))
        } else {
            Vec::new()
        },
        mounts: if app {
            parse_mounts(value.pointer("/content/spec/mounts"))
        } else {
            Vec::new()
        },
        init_command: app
            .then(|| parse_init_command(value.pointer("/content/spec/lifecycle/init")))
            .flatten(),
        ready_check: app
            .then(|| parse_ready_check(value.pointer("/content/spec/checks/ready")))
            .flatten(),
        runtime: app
            .then(|| parse_runtime(value.pointer("/content/spec/runtime")))
            .flatten(),
        artifact_repo: app
            .then(|| text(value.pointer("/content/spec/artifactSelector/githubRepo")))
            .flatten(),
        artifact_ref: app
            .then(|| text(value.pointer("/content/spec/artifactSelector/refName")))
            .flatten(),
        rules: if route {
            parse_rules(value.pointer("/content/spec/rules"))
        } else {
            Vec::new()
        },
        timeout: route
            .then(|| count(value.pointer("/content/spec/timeout")))
            .flatten(),
        files: if kind == "Config" {
            parse_files(value.pointer("/content/spec/files"))
        } else {
            Vec::new()
        },
        volume_handle: disk
            .then(|| text(value.pointer("/content/spec/volumeHandle")))
            .flatten(),
        disk_ref: database
            .then(|| name_ref(value.pointer("/content/spec/diskRef")))
            .flatten(),
        edition: (kind == "MSSQL")
            .then(|| text(value.pointer("/content/spec/edition")))
            .flatten(),
        variables: parse_variables(value.get("variables")),
    })
}

/// A replica without a name or a phase is one the panel could neither label nor
/// colour, so it is dropped rather than drawn as an unknown row.
fn parse_replicas(value: Option<&Value>) -> Vec<Replica> {
    items(value)
        .iter()
        .filter_map(|replica| {
            Some(Replica {
                name: text(replica.get("name"))?,
                phase: text(replica.get("phase"))?,
                reason: text(replica.get("reason")),
            })
        })
        .collect()
}

/// A hand-written pod file reaches the API with `PORT: 8080` as readily as
/// `"8080"`, so the value passes through `scalar` on the way out.
fn parse_env(value: Option<&Value>) -> Vec<EnvVar> {
    items(value)
        .iter()
        .filter_map(|variable| {
            Some(EnvVar {
                name: text(variable.get("name"))?,
                value: scalar(variable.get("value")).unwrap_or_default(),
            })
        })
        .collect()
}

/// A mount is a config file or a disk, never both, and it is the `config` key
/// that says which — the `file` it names has no counterpart on a disk mount.
fn parse_mounts(value: Option<&Value>) -> Vec<Mount> {
    items(value)
        .iter()
        .filter_map(|mount| {
            let (target, file) = match name_ref(mount.get("config")) {
                Some(config) => (config, text(mount.get("file"))),
                None => (name_ref(mount.get("disk"))?, None),
            };
            Some(Mount {
                path: text(mount.get("path"))?,
                target,
                file,
            })
        })
        .collect()
}

/// `lifecycle.init` is three shapes at once: a bare command line, `{cmd}`, and
/// an `{image, cmd[]}` that runs the command in a different image. All three
/// run one command, which is the only part the panel shows, so they collapse
/// here instead of making the webview branch on a union it cannot see.
fn parse_init_command(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(command) = value.as_str() {
        return Some(command.to_owned());
    }
    match value.get("cmd")? {
        Value::String(command) => Some(command.clone()),
        command @ Value::Array(_) => {
            let words = strings(Some(command));
            (!words.is_empty()).then(|| words.join(" "))
        }
        _ => None,
    }
}

fn parse_ready_check(value: Option<&Value>) -> Option<ReadyCheck> {
    let value = value?;
    Some(ReadyCheck {
        cmd: strings(value.get("cmd")),
        port: count(value.get("port")),
        host: text(value.get("host")),
        path: text(value.get("path")),
    })
}

/// A `runtime` block that sets nothing says nothing: the container still runs
/// as the image's own user, which is what an absent block already means.
fn parse_runtime(value: Option<&Value>) -> Option<RuntimeUser> {
    let value = value?;
    let runtime = RuntimeUser {
        uid: count(value.get("uid")),
        gid: count(value.get("gid")),
        fs_group: count(value.get("fsGroup")),
    };
    let declared = runtime.uid.is_some() || runtime.gid.is_some() || runtime.fs_group.is_some();
    declared.then_some(runtime)
}

/// A rule without a backend or a port routes nowhere, so it is dropped; a rule
/// may still go unnamed, which the API allows and the panel renders as blank.
fn parse_rules(value: Option<&Value>) -> Vec<RouteRule> {
    items(value)
        .iter()
        .filter_map(|rule| {
            Some(RouteRule {
                name: text(rule.get("name")).unwrap_or_default(),
                path: text(rule.get("path")).unwrap_or_default(),
                port: count(rule.get("port"))?,
                backend: name_ref(rule.get("backendRef"))?,
            })
        })
        .collect()
}

/// `spec.files` is an object keyed by filename, and an object's member order is
/// whatever encoded it. Sorting by name keeps the list from reshuffling under
/// the user between two refetches of an unchanged config.
fn parse_files(value: Option<&Value>) -> Vec<ConfigFile> {
    let Some(Value::Object(files)) = value else {
        return Vec::new();
    };
    let mut files: Vec<ConfigFile> = files
        .iter()
        .map(|(name, contents)| ConfigFile {
            name: name.clone(),
            contents: scalar(Some(contents)).unwrap_or_default(),
        })
        .collect();
    files.sort_by(|left, right| left.name.cmp(&right.name));
    files
}

/// A variable is addressed by its `ref`, so one without it names nothing an
/// app could interpolate.
fn parse_variables(value: Option<&Value>) -> Vec<Variable> {
    items(value)
        .iter()
        .filter_map(|variable| {
            Some(Variable {
                name: text(variable.get("name"))?,
                reference: text(variable.get("ref"))?,
                secret: flag(variable.get("secret")),
                resolved: flag(variable.get("resolved")),
                value: text(variable.get("value")),
                description: text(variable.get("description")),
            })
        })
        .collect()
}

/// The three event streams share only an id, a body and a timestamp; the rest
/// is a union on `kind`, read only for the kind that declares it. A kind this
/// build does not know carries a shape it would have to guess at, so it is
/// dropped the same way an unknown resource kind is.
fn parse_event(value: &Value) -> Option<ResourceEvent> {
    let kind = value.get("kind").and_then(Value::as_str)?;
    if !matches!(kind, "app" | "platform" | "httpAccess") {
        return None;
    }
    let access = kind == "httpAccess";

    Some(ResourceEvent {
        id: text(value.get("id"))?,
        kind: kind.to_owned(),
        body: text(value.get("body")).unwrap_or_default(),
        timestamp: text(value.get("timestamp"))?,
        level: (kind == "app").then(|| text(value.get("level"))).flatten(),
        reason: (kind == "platform")
            .then(|| text(value.get("reason")))
            .flatten(),
        method: access.then(|| text(value.get("method"))).flatten(),
        status: access.then(|| count(value.get("status"))).flatten(),
        host: access.then(|| text(value.get("host"))).flatten(),
        path: access.then(|| text(value.get("path"))).flatten(),
        duration_ms: access.then(|| count(value.get("durationMs"))).flatten(),
    })
}

/// A deploy is only ever reported by the revision it created, so a body without
/// one — an empty 2xx among them — is nothing the caller could follow up on.
fn parse_deployment(value: &Value) -> Result<Deployment> {
    let revision_id = text(value.get("revisionId"))
        .ok_or_else(|| anyhow!("Brainpod API accepted the deployment without naming a revision"))?;
    Ok(Deployment {
        revision_id,
        state: text(value.get("state")).unwrap_or_default(),
        error: text(value.get("error")),
    })
}

/// Same reasoning as a deployment: the revision the write landed in is what
/// makes the answer usable, and an empty body has none.
fn parse_mutation(value: &Value) -> Result<ResourceMutation> {
    let revision_id = text(value.get("revisionId"))
        .ok_or_else(|| anyhow!("Brainpod API accepted the write without naming a revision"))?;
    Ok(ResourceMutation {
        revision_id,
        resources: items(value.get("resources"))
            .iter()
            .filter_map(parse_resource)
            .collect(),
    })
}

fn parse_diff_entry(value: &Value) -> Option<DiffEntry> {
    Some(DiffEntry {
        kind: text(value.get("kind"))?,
        name: text(value.get("name"))?,
        change_type: text(value.get("changeType"))?,
    })
}

/// Every resource name this one points at, de-duplicated and in the order the
/// spec lists them. The caller drops names that are not resources of the pod.
fn dependencies(kind: &str, spec: Option<&Value>) -> Vec<String> {
    let mut names = Vec::new();
    let Some(spec) = spec else {
        return names;
    };

    match kind {
        "Route" => {
            for rule in items(spec.get("rules")) {
                push_ref(&mut names, rule.get("backendRef"));
            }
        }
        "Postgres" | "MariaDB" | "Valkey" | "MSSQL" => push_ref(&mut names, spec.get("diskRef")),
        "App" => {
            // A mount is either a config file or a disk, never both.
            for mount in items(spec.get("mounts")) {
                push_ref(&mut names, mount.get("disk"));
                push_ref(&mut names, mount.get("config"));
            }
            for variable in items(spec.get("env")) {
                if let Some(value) = variable.get("value").and_then(Value::as_str) {
                    push_templates(&mut names, value);
                }
            }
        }
        _ => {}
    }

    names
}

fn push_ref(names: &mut Vec<String>, value: Option<&Value>) {
    if let Some(reference) = value.and_then(Value::as_str) {
        push_name(names, resource_name(reference));
    }
}

/// Cross-resource references travel as URNs — `urn:brain:<kind>:default:<name>`
/// with a lowercase kind — while an environment template names the resource
/// directly. Both reduce to the name, which is what a node is keyed by, so
/// every reference passes through here rather than each call site guessing
/// which form it holds.
fn resource_name(reference: &str) -> &str {
    let reference = reference.trim();
    // The whole five-segment shape, not merely a `urn:` prefix and a colon
    // somewhere: a truncated `urn:brain:disk` would otherwise yield `disk`,
    // naming the kind as if it were a resource.
    match reference.strip_prefix("urn:") {
        Some(rest) if rest.split(':').count() == 4 => rest.rsplit(':').next().unwrap_or(reference),
        _ => reference,
    }
}

/// A reference as the panel wants it: the name alone, or nothing where the
/// spec left the reference out.
fn name_ref(value: Option<&Value>) -> Option<String> {
    Some(resource_name(value.and_then(Value::as_str)?).to_owned())
}

fn push_name(names: &mut Vec<String>, name: &str) {
    let name = name.trim();
    if name.is_empty() || names.iter().any(|existing| existing == name) {
        return;
    }
    names.push(name.to_owned());
}

/// `PGWEB_DATABASE_URL = ${postgres.uri}` is how an app names the resource it
/// talks to, so the segment before the first dot is an edge. A `${…}` without a
/// dot interpolates something else and names no resource.
fn push_templates(names: &mut Vec<String>, value: &str) {
    let mut rest = value;
    while let Some(open) = rest.find("${") {
        rest = &rest[open + 2..];
        let Some(close) = rest.find('}') else {
            return;
        };
        let (body, tail) = rest.split_at(close);
        rest = &tail[1..];
        if let Some((name, _)) = body.split_once('.') {
            push_name(names, name);
        }
    }
}

fn text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

/// An absent flag reads as false: the API omits `locked` and `secret` where
/// they do not apply, and neither has a third state.
fn flag(value: Option<&Value>) -> bool {
    value.and_then(Value::as_bool).unwrap_or(false)
}

/// Resource specs are hand-written JSON: a version is `16` as often as `"16"`.
fn scalar(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// Sizes and counts share the schema's string-or-number laxity, which is what a
/// hand-written pod file reaches the API with.
fn count(value: Option<&Value>) -> Option<u32> {
    match value? {
        Value::Number(number) => u32::try_from(number.as_u64()?).ok(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

fn strings(value: Option<&Value>) -> Vec<String> {
    items(value)
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

/// Carries the HTTP status so callers can tell a rejected token from an
/// unreachable API, while displaying only the message the API wrote.
#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, body: &Value) -> Self {
        let error = body.get("error");
        let mut message = error
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("Brainpod API returned {status}"));

        let details: Vec<String> = error
            .and_then(|error| error.get("details"))
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .filter_map(detail)
            .collect();
        if !details.is_empty() {
            message.push_str(" (");
            message.push_str(&details.join("; "));
            message.push(')');
        }

        Self { status, message }
    }
}

fn detail(value: &Value) -> Option<String> {
    let message = value.get("message").and_then(Value::as_str)?;
    match value.get("path").and_then(Value::as_str) {
        Some(path) if !path.is_empty() => Some(format!("{path}: {message}")),
        _ => Some(message.to_owned()),
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ApiError {}
