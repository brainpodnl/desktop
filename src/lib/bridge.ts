import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/**
 * The single boundary between the webview and Rust. Every type here mirrors a
 * `#[serde(rename_all = "camelCase")]` struct in `src-tauri/src`, so the shapes
 * are checked in one place instead of at each call site.
 */

export type AuthStatus = {
  signedIn: boolean;
  email: string | null;
  apiEndpoint: string;
  consoleEndpoint: string;
  configPath: string;
  /**
   * The default pod, resolved the way the CLI resolves it: `BRAINPOD_POD`
   * first, then the `pod` key of the shared config file.
   */
  pod: string | null;
  /**
   * That resolution came from the environment, so the config file's own value
   * is not what any command will use. The Settings window states the pod
   * instead of offering to change it.
   */
  podFromEnvironment: boolean;
};

export type LoginStarted = {
  url: string;
  expiresInSeconds: number;
};

export type Pod = {
  name: string;
  displayName: string | null;
  status: string | null;
  version: number | null;
  deployed: boolean;
};

/**
 * One entry in a pod's revision history. The graph is always read at exactly
 * one revision; `deployed` marks the one that is actually running, which is
 * what the window opens on.
 */
export type Revision = {
  id: string;
  version: number | null;
  state: string | null;
  deployed: boolean;
  latest: boolean;
  createdAt: string | null;
  summary: string | null;
};

export type DatabaseEngine = 'postgres' | 'mariadb' | 'valkey' | 'mssql';

/** The API's resource kinds, verbatim and case-sensitive. */
export type ResourceKind =
  | 'App'
  | 'Route'
  | 'Postgres'
  | 'MariaDB'
  | 'Valkey'
  | 'MSSQL'
  | 'Disk'
  | 'Config';

/** The four states the API reports for a workload and for each of its replicas. */
export type ReplicaPhase = 'Queued' | 'Starting' | 'Degraded' | 'Ready';

/** `reason` is set only when the control plane has something to say about a replica. */
export type Replica = { name: string; phase: ReplicaPhase; reason: string | null };

export type EnvVar = { name: string; value: string };

/** `target` is a resource name; `file` is set only for a config mount. */
export type Mount = { path: string; target: string; file: string | null };

/**
 * The app's readiness probe. Every field is optional in the API, so a check can
 * be a command line, an HTTP request, or both.
 */
export type ReadyCheck = { cmd: string[]; port: number | null; host: string | null; path: string | null };

/** The ids the container runs as; a null field leaves the image's own default standing. */
export type RuntimeUser = { uid: number | null; gid: number | null; fsGroup: number | null };

/** One rule of a route; `backend` is the name of the resource it forwards to. */
export type RouteRule = { name: string; path: string; port: number; backend: string };

/** A config file's body, which the API stores and returns in plaintext. */
export type ConfigFile = { name: string; contents: string };

/**
 * One entry of a resource's resolved variable set. A secret's `value` is always
 * null: the API withholds it here, so the only truthful thing to show for a
 * secret is the reference it resolves through.
 */
export type Variable = {
  name: string;
  ref: string;
  secret: boolean;
  resolved: boolean;
  value: string | null;
  description: string | null;
};

/**
 * One node of a pod's resource graph. Rust flattens the API's per-kind `spec`
 * union into this single shape and resolves the graph's edges, so the webview
 * never walks untyped JSON and the kind-to-engine mapping lives in one place.
 *
 * Every field is something the API actually returns. In particular there is no
 * CPU or memory here: `/v1/pods/{pod}/resources` does not report utilisation,
 * so the graph states replica and instance facts rather than drawing meters it
 * would have to invent.
 */
export type Resource = {
  urn: string;
  name: string;
  kind: ResourceKind;
  /** Set only for the database kinds, and only they can carry a tunnel. */
  engine: DatabaseEngine | null;
  healthy: boolean;
  phase: string | null;
  version: string | null;
  instance: string | null;
  /** Disk size in GB. */
  size: number | null;
  replicas: number | null;
  readyReplicas: number | null;
  image: string | null;
  hostname: string | null;
  domains: string[];
  /**
   * Names of the resources this one points at, resolved from `backendRef`,
   * `diskRef`, `mounts[].disk`, `mounts[].config` and `${name.field}` env
   * templates. Drawn as an edge from this node down to each target.
   */
  dependsOn: string[];
  apiVersion: string;
  /** True while a console task (restart, backup, restore) holds this resource. */
  locked: boolean;
  /** Workload kinds only; empty for the rest. */
  replicaStates: Replica[];
  /** Disk only. */
  bound: boolean | null;
  /** Disk and Route; null where the kind reports a phase instead. */
  ready: boolean | null;
  env: EnvVar[];
  mounts: Mount[];
  /** `lifecycle.init`, flattened to the command line it runs. */
  initCommand: string | null;
  readyCheck: ReadyCheck | null;
  runtime: RuntimeUser | null;
  /** Git provenance of the running image, when the app was built from a repo. */
  artifactRepo: string | null;
  artifactRef: string | null;
  rules: RouteRule[];
  /** Route request timeout in seconds; the API's own default is 60. */
  timeout: number | null;
  files: ConfigFile[];
  volumeHandle: string | null;
  /** The disk a database is bound to. */
  diskRef: string | null;
  /** MSSQL only. */
  edition: string | null;
  variables: Variable[];
};

/** The three event streams the API keeps, each read separately and per resource. */
export type EventKind = 'app' | 'httpAccess' | 'platform';

export type EventLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/** The windows the API accepts, verbatim; it takes no arbitrary interval. */
export type EventRange = '5m' | '15m' | '30m' | '1h' | '24h' | '7d';

/**
 * A row from any of the three streams. The API answers with a union on `kind`,
 * and Rust widens it into this one shape so the window renders a single list:
 * `level` belongs to app logs, `reason` to platform events, and the request
 * fields to HTTP access logs, so each is null on the kinds that never carry it.
 */
export type ResourceEvent = {
  id: string;
  kind: EventKind;
  body: string;
  /** RFC 3339. */
  timestamp: string;
  level: EventLevel | null;
  reason: string | null;
  method: string | null;
  status: number | null;
  host: string | null;
  path: string | null;
  durationMs: number | null;
};

/** What a deploy or redeploy was accepted as. */
export type Deployment = { revisionId: string; state: string; error: string | null };

/** One entry of a revision's diff against its parent. */
export type DiffEntry = { kind: string; name: string; changeType: 'create' | 'update' | 'delete' };

/** A draft write: the revision it landed in, and the resources as they now read. */
export type ResourceMutation = { revisionId: string; resources: Resource[] };

export type TunnelState = 'starting' | 'listening' | 'closed' | 'failed';

export type Tunnel = {
  id: string;
  pod: string;
  resource: string;
  urn: string;
  engine: DatabaseEngine;
  state: TunnelState;
  address: string;
  host: string;
  localPort: number;
  remotePort: number;
  username: string | null;
  database: string | null;
  password: string | null;
  dsn: string | null;
  clientCommand: string | null;
  /** RFC 3339; the control plane closes the session at this instant. */
  expiresAt: string | null;
  activeConnections: number;
  totalConnections: number;
  error: string | null;
};

/** The coding agents this window can write the Brainpod skill into. */
export type HarnessId = 'claude' | 'codex' | 'cursor' | 'gemini';

/**
 * One agent's skills directory, as Rust found it on this machine. `installed`
 * only says something is there; `managed` says this window put it there, which
 * is what makes its version knowable and its removal ours to offer.
 */
export type Harness = {
  id: HarnessId;
  name: string;
  /** Set where the directory is shared with other agents, and worth saying. */
  note: string | null;
  path: string;
  /** `~/…`, or `%USERPROFILE%\…` on Windows. Rust spells it for its own OS. */
  displayPath: string;
  detected: boolean;
  installed: boolean;
  managed: boolean;
  version: string | null;
  /** Epoch milliseconds. */
  installedAt: number | null;
};

/** What `brainpodnl/skills` publishes right now. */
export type RemoteSkill = { version: string; repo: string };

/** Per target, because one denied directory must not fail the other three. */
export type InstallResult = { id: HarnessId; error: string | null };

export type InstallReport = {
  version: string;
  results: InstallResult[];
  harnesses: Harness[];
};

/**
 * The command line on this machine. `path` is where this window installs to,
 * which is a directory the platform itself already puts on `PATH` — nothing in
 * the user's shell is ever edited — and `elevates` says whether writing there
 * raises a system authorization prompt.
 */
export type CliStatus = {
  /** `macOS · Apple silicon`, the build this machine takes. */
  platform: string;
  /** False where the CLI publishes no build for this OS and architecture. */
  supported: boolean;
  path: string;
  displayPath: string;
  directory: string;
  /**
   * The binary was already on this machine and is kept current where it
   * stands, rather than a second copy being written to the platform's default
   * location. Removal is never offered for one of these.
   */
  adopted: boolean;
  onPath: boolean;
  elevates: boolean;
  installed: boolean;
  /**
   * What the binary answers to `--version`. It is not always the release's
   * own name — `brainpodnl/cli` stamps binaries from a `VERSION` file rather
   * than from the tag — so it is shown, never compared.
   */
  version: string | null;
  /**
   * The release this window installed, from its own receipt: the only version
   * that can honestly be measured against what is published.
   */
  releaseVersion: string | null;
  /** Written by this window and unchanged since, so removing it is offered. */
  managed: boolean;
  installedAt: number | null;
  other: { displayPath: string; version: string | null } | null;
};

/**
 * The release this machine can install. `publishing` is set when a newer
 * release exists whose binaries are not up yet — a release is public for the
 * minutes its build matrix takes — and this is the newest one that can
 * actually be installed.
 */
export type CliRelease = {
  version: string;
  asset: string;
  url: string;
  size: number;
  publishing: string | null;
  repo: string;
};

/** One step of an install, as the row's bar and state line read it. */
export type CliProgress = {
  phase: 'downloading' | 'checking' | 'installing';
  received: number;
  total: number;
};

export const authStatus = () => invoke<AuthStatus>('auth_status');
export const authBegin = () => invoke<LoginStarted>('auth_begin');
export const authCancel = () => invoke<void>('auth_cancel');
export const authSignOut = () => invoke<AuthStatus>('auth_sign_out');

/**
 * Opens the Settings window, or brings it forward if it is already open. The
 * same thing ⌘, does from the app menu.
 */
export const openSettings = () => invoke<void>('open_settings');

/**
 * Writes the default pod into the config file the `brainpod` CLI shares, and
 * answers with the pod that now resolves — which is the environment's, not the
 * one just written, wherever `BRAINPOD_POD` is set. `null` clears the key.
 */
export const setDefaultPod = (pod: string | null) =>
  invoke<string | null>('set_default_pod', { pod });

export const listPods = () => invoke<Pod[]>('api_pods');
export const listRevisions = (pod: string) => invoke<Revision[]>('api_revisions', { pod });

/** `revision` omitted reads the pod's head rather than a point in its history. */
export const listResources = (pod: string, revision?: string) =>
  invoke<Resource[]>('api_resources', { pod, revision: revision ?? null });

/**
 * Events are the one read that is not taken at a revision: the API requires a
 * resource URN, and `kind` left null omits the parameter rather than asking for
 * all three streams at once.
 */
export const listEvents = (pod: string, urn: string, kind: EventKind | null, range: EventRange) =>
  invoke<ResourceEvent[]>('api_events', { pod, urn, kind, range });

/**
 * The four writes. A resource write lands in the pod's mutable draft and changes
 * nothing that is running until a deploy promotes that draft — and a deploy
 * promotes the whole draft, not just this change.
 */
export const deployPod = (pod: string, summary: string | null) => invoke<Deployment>('api_deploy', { pod, summary });
export const redeployPod = (pod: string) => invoke<Deployment>('api_redeploy', { pod });
export const setReplicas = (pod: string, name: string, replicas: number) =>
  invoke<ResourceMutation>('api_set_replicas', { pod, name, replicas });
export const setInstance = (pod: string, kind: ResourceKind, name: string, instance: string) =>
  invoke<ResourceMutation>('api_set_instance', { pod, kind, name, instance });

/** Diffed against the revision's own parent, which is what the API does with no base. */
export const revisionDiff = (pod: string, revision: string) =>
  invoke<DiffEntry[]>('api_revision_diff', { pod, revision });

/** Opens an `http`/`https` URL in the user's own browser, outside this window. */
export const openExternal = (url: string) => invoke<void>('open_external', { url });

/** A hint, not a promise: the bind is still what decides. */
export const portAvailable = (port: number) => invoke<boolean>('port_available', { port });

/** A free port named by the OS, which is the only way to name one truthfully. */
export const randomPort = () => invoke<number>('port_random');

export const startTunnel = (pod: string, resource: string, port: number) =>
  invoke<Tunnel>('tunnel_start', { pod, resource, port });
export const stopTunnel = (id: string) => invoke<void>('tunnel_stop', { id });
export const listTunnels = () => invoke<Tunnel[]>('tunnel_list');

/** Filesystem only, so the installer opens on the truth while offline. */
export const scanHarnesses = () => invoke<Harness[]>('skills_scan');

/** The version on offer, without downloading the skill to find it out. */
export const latestSkill = () => invoke<RemoteSkill>('skills_latest');

/** One download, written into every agent named; answers with the new state. */
export const installSkill = (ids: HarnessId[]) => invoke<InstallReport>('skills_install', { ids });

/** Refused by Rust for a skill this window did not install. */
export const removeSkill = (id: HarnessId) => invoke<Harness[]>('skills_remove', { id });

/** Opens the agent's skills directory in Finder, Explorer or the file manager. */
export const revealSkill = (id: HarnessId) => invoke<void>('skills_reveal', { id });

/**
 * What `brainpod` this machine has, and where one would go. Filesystem and
 * local processes only, so the dialog opens on the truth while offline.
 */
export const cliStatus = () => invoke<CliStatus>('cli_status');

/** The release this platform can install, which is not always the newest one. */
export const latestCli = () => invoke<CliRelease>('cli_latest');

/**
 * Downloads, checks the release's own `SHA256SUMS`, and installs. The release
 * is passed back rather than re-resolved so the button installs exactly the
 * version the dialog offered. Answers with the state it just wrote.
 */
export const installCli = (release: CliRelease) => invoke<CliStatus>('cli_install', { release });

/** Refused by Rust for a binary this window did not write, or one since replaced. */
export const removeCli = () => invoke<CliStatus>('cli_remove');

/** Opens the install directory in Finder, Explorer or the file manager. */
export const revealCli = () => invoke<void>('cli_reveal');

/** Emitted when the browser hands back a token and it has been persisted. */
export const onAuthCompleted = (handler: (status: AuthStatus) => void): Promise<UnlistenFn> =>
  listen<AuthStatus>('auth://completed', (event) => handler(event.payload));

/** Emitted when the flow was rejected, timed out, or could not be persisted. */
export const onAuthFailed = (handler: (message: string) => void): Promise<UnlistenFn> =>
  listen<{ message: string }>('auth://failed', (event) => handler(event.payload.message));

/** Emitted when the user declined authorization in the browser. */
export const onAuthCancelled = (handler: () => void): Promise<UnlistenFn> =>
  listen('auth://cancelled', () => handler());

/**
 * Emitted when a session ends, whichever window asked for it: the action lives
 * in Settings and the screen it changes is in the pod window.
 */
export const onAuthSignedOut = (handler: (status: AuthStatus) => void): Promise<UnlistenFn> =>
  listen<AuthStatus>('auth://signed-out', (event) => handler(event.payload));

/**
 * Emitted when the default pod changes, with the pod that resolves after the
 * write. Both windows listen: the action lives in Settings and the pod window
 * is the one it moves.
 */
export const onDefaultPodChanged = (
  handler: (pod: string | null) => void,
): Promise<UnlistenFn> =>
  listen<string | null>('config://pod-changed', (event) => handler(event.payload));

/** Emitted while an install runs, so a download on a slow link has a bar. */
export const onCliProgress = (handler: (progress: CliProgress) => void): Promise<UnlistenFn> =>
  listen<CliProgress>('cli://progress', (event) => handler(event.payload));

/** Full snapshot of one tunnel, emitted on every state or counter change. */
export const onTunnelUpdate = (handler: (tunnel: Tunnel) => void): Promise<UnlistenFn> =>
  listen<Tunnel>('tunnel://update', (event) => handler(event.payload));
