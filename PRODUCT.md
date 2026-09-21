# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Existing codebase: Tauri 2 (Rust) shell around a Vite + React 19 webview, Tailwind v4,
TanStack Query, Motion, lucide-react. Ships as a macOS desktop window (`pnpm start` runs
`tauri dev`). No test runner is configured; `pnpm typecheck` and `pnpm build` are the gates.

## Users

Developers who deploy applications to Brainpod and want a window that is already open while
they work: they glance at it to see whether a pod's resources are healthy, open a database
tunnel so a local client (psql, DBeaver, TablePlus) can reach a hosted database, and read what
an app is doing right now. The same people also use the `brainpod` CLI and the web console;
this window shares the CLI's config file (`~/.config/brainpod/config.toml`), including its API
token and default pod.

## Product Purpose

Brainpod hosts applications in Europe: a pod is a graph of resources — Apps, Routes, databases
(Postgres, MariaDB, Valkey, SQL Server), Disks and Configs — versioned by revision. The desktop
window is the ambient view onto that graph: what exists, how it is wired, whether it is healthy,
and the operations a developer needs between deploys. Success is that a developer can answer
"what is my pod doing, and why" without opening a browser or typing a CLI command.

## Positioning

The console is a website; the CLI is non-interactive text. The window is the only Brainpod
surface that is persistently open, native to the OS, and holds live local state the other two
cannot: TCP tunnels bound to real ports on this machine. It keeps the graph and the operations
in one place, at a glance, where the console needs navigation and the CLI needs commands.

## Operating Context

- One window, one pod at a time, chosen in a vibrancy sidebar; the content pane is opaque.
- The graph is always read **at one revision**. The window opens on the deployed revision and
  falls back to the newest one for a pod that was never deployed.
- Brainpod's central mental model is **mutable draft vs deployed revision**: every resource
  write lands in the pod's draft head and changes nothing that is running until a deploy
  promotes it. The CLI states this as "Changes the pod's mutable draft without deploying it."
- Resource kinds on the wire are title-cased: `App`, `Route`, `Postgres`, `MariaDB`, `Valkey`,
  `MSSQL`, `Disk`, `Config`. Namespace is always `default`. URNs are
  `urn:brain:<kind-lowercase>:default:<name>`.
- Health vocabulary: every resource carries `healthy: boolean`. Workload phases are `Queued`,
  `Starting`, `Degraded`, `Ready`. Disks report `phase` + `bound` + `ready`; Routes report
  `ready`; Configs have no status and are always healthy.
- Revision states: `draft`, `pending`, `ready`, `deployed`, `failed`, `canceled`.
- Instance sizes: App `.25x .5x 1x 2x 4x 8x`; Postgres/MariaDB/Valkey `.5x 1x 2x 4x 8x`;
  MSSQL from `2x`. Replicas are 1–10. Disk size is 5–500 GB and may never be decreased.

## Capabilities and Constraints

Confirmed against the control plane (`brainpod/web/api`) and the CLI.

**The API key this window holds can read:**

- `GET /v1/pods`, `/v1/pods/{pod}`, `/v1/pods/{pod}/revisions[/{id}[/diff]]`
- `GET /v1/pods/{pod}/resources[?revision=|at=]` — a bare array whose elements already carry
  `urn`, full `content.spec`, `status`, `healthy`, `locked`, resolved `variables[]` and `_links`.
- `GET /v1/pods/{pod}/events?resource=<urn>&kind=app|httpAccess|platform&range=5m..7d&level=&search=&cursor=`
  and an SSE `…/events/watch`. **Events are the only log surface; there is no logs endpoint.**
- `GET /v1/pods/{pod}/resources/resolve/{id}` — the only place a resource's stable UUID exists.

**The API key can write exactly four things:**

- `POST /v1/pods/{pod}/resources` (create, `?dryRun=true` validates)
- `PUT /v1/pods/{pod}/resources/{Kind}/default/{name}` — **full replace**, no PATCH. This is the
  only way to change `spec.replicas` (scale) or `spec.instance` (resize). Immutable fields
  (`Route.hostname`, `Disk.volumeHandle`, `MSSQL.version`/`edition`) are force-restored.
- `DELETE /v1/pods/{pod}/resources/{Kind}/default/{name}`
- `POST /v1/pods/{pod}/deploy` (head must be in state `draft`) and `POST /v1/pods/{pod}/redeploy`
  (only a `failed`, unchecksummed, latest revision).

**Does not exist for this window, and must never be implied:**

- **Restart.** There is no REST restart. `task.restartApp` is console tRPC behind a session
  cookie; an API key cannot call it.
- **CPU, memory, disk-usage or any utilisation metric.** Console-only, via Signoz tRPC.
- Rollback to an older revision, per-resource redeploy, pause/stop/start, cancel a deployment,
  backup/restore, pod rename or delete, resource-level timestamps or age, restart counts.
- `dependsOn` is not an API field: the window derives edges itself from `Route.rules[].backendRef`,
  `*.spec.diskRef`, `App.spec.mounts[].disk|.config` and `${name.field}` env templates.

**Secrets:** database passwords are never returned by the API (`variables[].value` is `null`
when `secret` is true); they exist only inside an authorized tunnel session. Config file bodies
and App `env` values **are** returned in plaintext and will be on screen.

## Brand Commitments

The design system is transcribed from the Brainpod marketing site's `globals.css` (shadcn token
semantics, warm neutral palette, Inter Variable + JetBrains Mono Variable, one radius ladder).
Per-kind accent colours are each engine's own brand hue, tuned per theme. macOS conventions are
binding: vibrancy sidebar, native `<select>` popups, AppKit type scale (22/15/13/11.5), a
38px drag region, no rubber-band, no drag-select.

## Evidence on Hand

Real API shapes, field names and error copy are confirmed in
`brainpod/web/api/{routes,representations,schemas.ts}`, `brainpod/web/shared/schemas.ts` and
`cli/src/{cmd,output,openapi.json}`. No screenshots, marketing copy, testimonials or usage
numbers exist for this window, and none may be invented.

## Product Principles

1. **State only what the API returns.** A field the API does not answer is absent, never
   estimated, never drawn as a meter.
2. **The draft is the unit of change.** Any write says that it changed the draft and that
   nothing runs until a deploy promotes it.
3. **The window reads; the console edits.** Writes are limited to the small set the API key can
   actually perform, and the console link is always one control away.
4. **Local state is first-class.** Tunnels are the one thing only this window owns, and they
   outlive whatever is on screen.
5. **A Mac app, not a website in a frame.** Native affordances, fixed UI type scale, and motion
   that stops at reduced-motion.

## Accessibility & Inclusion

Status is never colour alone — every dot carries a text label. Contrast floors are enforced in
tokens (`--warn-strong` exists because `--warn` is a dot fill, not a text colour). Reduced
motion, reduced transparency and increased contrast all have explicit rules in `global.css`.
