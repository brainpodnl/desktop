import { useQuery } from '@tanstack/react-query';
import { ExternalLink, TriangleAlert, X } from 'lucide-react';
import { motion } from 'motion/react';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import { AccountButton } from '@/components/account-button';
import { Button } from '@/components/button';
import { ConnectionsPanel } from '@/components/connections-panel';
import { routeUrl } from '@/components/graph/layout';
import {
  podReadiness,
  TONE_FILL,
  TONE_TEXT,
  type PodReadiness,
} from '@/components/graph/readiness';
import { ResourceGraph } from '@/components/graph/resource-graph';
import { Select } from '@/components/inspector/parts';
import { ResourceInspector } from '@/components/inspector/resource-inspector';
import { BrainpodMark } from '@/components/marks/brainpod';
import { RailHeading } from '@/components/rail-heading';
import { SkillInstaller } from '@/components/skill-installer';
import { Spinner } from '@/components/spinner';
import { CopyButton, TunnelDialog, type TunnelDialogTarget } from '@/components/tunnel-dialog';
import { UpdatesBar } from '@/components/updates-bar';
import { useAuth } from '@/lib/auth';
import {
  deployPod,
  onDefaultPodChanged,
  openExternal,
  redeployPod,
  type DatabaseEngine,
  type DiffEntry,
  type Pod,
  type Resource,
  type Revision,
  type Tunnel,
} from '@/lib/bridge';
import { cx } from '@/lib/cx';
import {
  readInspectorWidth,
  writeInspectorWidth,
} from '@/lib/inspector-width';
import { useReducedMotion } from '@/lib/motion';
import { isLocalPort, MAX_LOCAL_PORT, readLastPort, writeLastPort } from '@/lib/port-preference';
import {
  errorMessage,
  invalidatePod,
  podsQuery,
  resourcesQuery,
  revisionDiffQuery,
  revisionsQuery,
} from '@/lib/queries';
import { tunnelKey, useTunnels } from '@/lib/tunnels';

/** Remembers the pod this window was last working in, across restarts. */
const POD_KEY = 'brainpod.desktop.pod';

const SKELETON_ROWS = [0, 1, 2];

/**
 * The narrowest canvas worth calling a graph: one 260px card and the room to
 * see what it connects to. Under this the details rail stops taking a column
 * and starts lying over the canvas instead.
 */
const MIN_CANVAS = 320;

/**
 * Where the console keeps this pod. The endpoint comes from the shared CLI
 * config rather than a constant here, so a window pointed at a self-hosted
 * console links into that one instead of brainpod.io.
 */
const consoleUrl = (endpoint: string, pod: string): string =>
  `${endpoint.replace(/\/+$/, '')}/pods/${encodeURIComponent(pod)}`;

/**
 * The port each engine listens on by convention. It is both the port the
 * tunnel's far end connects to and the local port to suggest first, since a
 * client configured for this engine already expects it.
 */
const ENGINE_PORTS: Record<DatabaseEngine, number> = {
  postgres: 5432,
  mariadb: 3306,
  valkey: 6379,
  mssql: 1433,
};

/**
 * The first port at or above `wanted` that nothing in this window is already
 * listening on. A resource can carry several tunnels, and the second one
 * cannot have the first one's port — suggesting it anyway would prefill the
 * field with the one number guaranteed to be refused.
 *
 * Every listening tunnel counts, not just this pod's: a bound port is bound
 * for the whole machine. And only a listening one: a session that failed lost
 * its listener along with the proxy task, so it holds nothing, and counting it
 * would walk the suggestion one number further away after every failure.
 *
 * This cannot know about ports held outside the app, so the bind stays the
 * real answer; this only avoids the collisions it can see.
 */
function freePort(wanted: number, tunnels: Tunnel[]): number {
  const taken = new Set(
    tunnels.filter((tunnel) => tunnel.state === 'listening').map((tunnel) => tunnel.localPort),
  );

  let port = wanted;
  while (port <= MAX_LOCAL_PORT && taken.has(port)) port += 1;
  return port > MAX_LOCAL_PORT ? wanted : port;
}

/**
 * A port that has actually been sent to Rust, which is what separates the
 * dialog standing open with a suggestion in it from an attempt in flight —
 * and what decides whether an arriving session advances the dialog.
 *
 * `known` is the set of tunnel ids that already existed when the request went
 * out. A resource can carry several tunnels at once, so "a listening tunnel to
 * this resource" no longer identifies the one that was just asked for.
 */
type PortRequest = { resource: Resource; known: string[] };

export function PodScreen(): ReactElement {
  const { status } = useAuth();
  const pods = useQuery(podsQuery());
  const { tunnels, close } = useTunnels();
  const [chosen, setChosen] = useState<string | null>(() => window.localStorage.getItem(POD_KEY));
  const [selected, setSelected] = useState<string | null>(null);
  /*
   * A sidebar row asking for a connection's credentials. It is a request
   * rather than the dialog itself: the pane owns the dialog, and the row can
   * name a pod that is not on screen, so the request waits for that pod's
   * pane to come up and take it.
   */
  const [connect, setConnect] = useState<Tunnel | null>(null);

  const list = pods.data ?? [];

  // Prefer the pod picked in this window, then the default from the shared CLI
  // config, then the first one. A name that no longer exists falls through.
  const remembered = [chosen, status?.pod ?? null].find(
    (name) => name !== null && list.some((pod) => pod.name === name),
  );
  const current = remembered ?? list[0]?.name ?? null;
  const pod = list.find((entry) => entry.name === current) ?? null;

  /*
   * Only a listening session is a connection. A starting or failed one is
   * stated on its node in the graph, where the action was taken; the sidebar
   * lists addresses that can be connected to right now.
   */
  const live = useMemo(() => tunnels.filter((tunnel) => tunnel.state === 'listening'), [tunnels]);

  const choosePod = useCallback((name: string) => {
    setChosen(name);
    // Only an explicit choice is persisted, so `brainpod config set pod` keeps
    // deciding the landing pod until the user overrides it here.
    window.localStorage.setItem(POD_KEY, name);
  }, []);

  const switchPod = useCallback(
    (name: string) => {
      choosePod(name);
      // The selected node belonged to the pod that was on screen.
      setSelected(null);
    },
    [choosePod],
  );

  /*
   * The default pod was changed in Settings. The window follows it, the same
   * way a sidebar click does: the pod remembered here outranks the config's
   * default at startup, so a window that stayed put would make the setting
   * look like it had done nothing — and the user just named the pod they want
   * to be in. Clearing the default moves nothing; there is nowhere to move to.
   */
  useEffect(() => {
    let active = true;
    let off: (() => void) | null = null;

    void onDefaultPodChanged((name) => {
      if (name !== null) switchPod(name);
    }).then((unlisten) => {
      if (active) off = unlisten;
      else unlisten();
    });

    return () => {
      active = false;
      off?.();
    };
  }, [switchPod]);

  const showConnection = useCallback(
    (tunnel: Tunnel) => {
      // A connection can belong to a pod that is not on screen, so opening one
      // switches pods rather than pointing at a node that is not there.
      if (tunnel.pod !== current) choosePod(tunnel.pod);
      setSelected(tunnel.resource);
      setConnect(tunnel);
    },
    [current, choosePod],
  );

  const clearConnect = useCallback(() => setConnect(null), []);

  return (
    <div className="flex h-full">
      <PodRail
        pods={list}
        selected={current}
        loading={pods.isPending}
        error={pods.isError ? errorMessage(pods.error, 'Could not load your pods.') : null}
        email={status?.email ?? null}
        endpoint={status?.apiEndpoint ?? null}
        onSelect={switchPod}
        onRetry={() => void pods.refetch()}
        connections={
          <ConnectionsPanel
            tunnels={live}
            onClose={(id) => void close(id)}
            onShowConnection={showConnection}
          />
        }
      />

      {pod === null ? (
        <div className="min-w-0 flex-1 border-l border-border bg-background" />
      ) : (
        <PodPane
          pod={pod}
          selected={selected}
          onSelect={setSelected}
          connect={connect}
          onConnected={clearConnect}
        />
      )}
    </div>
  );
}

function PodRail({
  pods,
  selected,
  loading,
  error,
  email,
  endpoint,
  connections,
  onSelect,
  onRetry,
}: {
  pods: Pod[];
  selected: string | null;
  loading: boolean;
  error: string | null;
  email: string | null;
  endpoint: string | null;
  /** The open connections, between the pods list and the account footer. */
  connections: ReactNode;
  onSelect: (name: string) => void;
  onRetry: () => void;
}): ReactElement {
  const reduced = useReducedMotion() === true;

  /*
   * No background, no right border: the window's vibrancy is the sidebar's
   * surface, the way it is in Finder and Mail, and the divider belongs to the
   * opaque pane beside it. Secondary text carries a weight step more than it
   * would on that pane, because flat grey goes muddy over live blur.
   */
  return (
    <aside
      aria-label="Pods and connections"
      /*
       * The rail scrolls itself. Its lower bands — the skill installer, the
       * connections, the update notice, the account — are fixed-height and
       * together taller than a short window, and with nowhere to put that the
       * overflow escaped into the document and made the whole window scroll.
       * `overscroll-contain` keeps the gesture here once it does.
       */
      className="vibrant flex w-[248px] shrink-0 flex-col overflow-y-auto overscroll-contain pt-[38px]">
      {/* The window's own identity, under the drag region rather than in it:
          the traffic lights own the left of that 38px band, and a mark beside
          them would be a second thing competing for the same corner. */}
      <div className="flex shrink-0 items-center gap-2 px-4 pt-0.5 pb-1">
        <BrainpodMark size={21} />
        <span className="text-ui-title font-semibold">Brainpod</span>
      </div>

      {/* Every section heading in this rail is literally one component, so the
          rhythm cannot drift between them. */}
      <RailHeading>Pods</RailHeading>

      {/* The one band that gives way first, and the floor it stops at: a list
          squeezed to nothing is a sidebar with no pods in it, so past two rows
          the rail scrolls instead. */}
      <div className="min-h-[4.5rem] flex-1 overflow-y-auto">
        {loading ? (
          SKELETON_ROWS.map((row) => (
            <motion.div
              key={row}
              initial={reduced ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.25, delay: row * 0.1 }}
              className="flex items-center gap-2.5 px-4 py-2">
              <span className="size-1.5 shrink-0 rounded-full bg-foreground/20" />
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="h-2 w-2/3 rounded-full bg-foreground/15" />
                <span className="h-1.5 w-1/3 rounded-full bg-foreground/10" />
              </span>
            </motion.div>
          ))
        ) : error !== null ? (
          <div className="flex flex-col items-start gap-2.5 px-4">
            <p className="text-ui text-destructive">{error}</p>
            <Button variant="outline" size="sm" title="Retry" onClick={onRetry} />
          </div>
        ) : pods.length === 0 ? (
          <div className="px-4">
            <p className="text-ui font-medium">No pods yet.</p>
            <p className="mt-1 text-ui-sm font-medium text-foreground/70">
              Create one in the console, then reopen this window.
            </p>
          </div>
        ) : (
          /* Tailwind's reset strips the list marker, and WebKit drops the list
             semantics along with it, so the role is restated. */
          <ul role="list">
            {pods.map((pod) => (
              <PodRow
                key={pod.name}
                pod={pod}
                active={pod.name === selected}
                onSelect={() => onSelect(pod.name)}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Over the connections and under the pods: a tunnel is live state that
          comes and goes while the user works, so it keeps the position nearest
          the account it can be closed from; the skill is set once and then only
          glanced at. */}
      <SkillInstaller />

      {connections}

      {/* Last before the account, so it is the nearest thing to the control
          that opens Settings — where both of these are explained — and so a
          band that appears mid-session pushes nothing the user was reading. */}
      <UpdatesBar />

      <AccountButton email={email} endpoint={endpoint} />
    </aside>
  );
}

/** What the pod's head revision is doing right now, in one dot. */
function statusDot(pod: Pod): string {
  if (pod.deployed) return 'bg-ok';

  const status = pod.status?.toLowerCase() ?? '';
  if (status === 'draft' || status === 'pending') return 'bg-warn';
  if (status === 'failed') return 'bg-destructive';
  return 'bg-faint';
}

function podMeta(pod: Pod): string {
  const parts: string[] = [];
  if (pod.version !== null) parts.push(`v${pod.version}`);
  if (pod.status !== null && pod.status.length > 0) parts.push(pod.status);

  return parts.length > 0 ? parts.join(' · ') : 'no revisions';
}

function PodRow({
  pod,
  active,
  onSelect,
}: {
  pod: Pod;
  active: boolean;
  onSelect: () => void;
}): ReactElement {
  return (
    <li className="relative">
      {/* The wash is barely a step off the hover state, so selection also
          carries a rule at the row's leading edge. Out of flow, so nothing
          beside it moves when it appears. */}
      {active && (
        <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-brand" />
      )}

      <button
        type="button"
        onClick={onSelect}
        aria-current={active || undefined}
        className={cx(
          // An alpha wash rather than a fill, so the desktop keeps showing through.
          'flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors',
          // Inset, because the row runs the full width of the sidebar.
          'focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset',
          active ? 'bg-foreground/[0.10]' : 'hover:bg-foreground/[0.06]',
        )}>
        <span className={cx('size-1.5 shrink-0 rounded-full', statusDot(pod))} />

        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui font-medium">{pod.displayName ?? pod.name}</span>
          <span className="block truncate font-mono text-ui-mono font-medium text-foreground/70">
            {podMeta(pod)}
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * One revision, as a line short enough for a menu: the version it carries,
 * plus what makes it worth telling apart from its neighbours. A revision that
 * predates versions falls back to the head of its id, which is what the CLI
 * prints too.
 */
function revisionLabel(revision: Revision): string {
  const version = revision.version === null ? revision.id.slice(0, 7) : `v${revision.version}`;
  if (revision.deployed) return `${version} · deployed`;

  const state = revision.state?.toLowerCase() ?? '';
  return state.length > 0 ? `${version} · ${state}` : version;
}

/**
 * Which revision the graph is being read at. It shares the window's one
 * dropdown rather than styling a second: a control that looks different in two
 * places is how a vocabulary drifts.
 */
function RevisionPicker({
  revisions,
  value,
  fallback,
  onChange,
}: {
  revisions: Revision[];
  value: string | null;
  /** What to state while the history is loading, or when there is none. */
  fallback: string;
  onChange: (id: string) => void;
}): ReactElement {
  if (revisions.length === 0) {
    return <p className="shrink-0 pt-1 font-mono text-ui-mono text-faint">{fallback}</p>;
  }

  /*
   * A draft this window just created is selected before the history that
   * contains it has come back. Naming it here keeps the control from falling
   * blank for that one round trip, which would read as the picker losing its
   * place rather than as a write that has not landed yet.
   *
   * It is a label, never a destination: choosing it would set the revision to
   * an empty string, which is not a revision the API can be asked for and not
   * a value this control could ever match its way back out of.
   */
  const known = value !== null && revisions.some((revision) => revision.id === value);
  const options = revisions.map((revision) => ({
    value: revision.id,
    label: revisionLabel(revision),
  }));

  return (
    <Select
      label="Revision"
      mono
      tone="toolbar"
      value={known ? value : ''}
      options={known ? options : [{ value: '', label: 'new draft', disabled: true }, ...options]}
      onChange={onChange}
    />
  );
}

/**
 * The resource a dialog target is about. The port step carries the node it was
 * opened from; the connection step carries only a name, because a tunnel
 * outlives the revision its resource was read at.
 */
const targetResource = (target: TunnelDialogTarget): string =>
  target.step === 'port' ? target.resource.name : target.resourceName;

function PodPane({
  pod,
  selected,
  onSelect,
  connect,
  onConnected,
}: {
  pod: Pod;
  selected: string | null;
  onSelect: (name: string | null) => void;
  /** A sidebar row waiting for this pane to open its credentials. */
  connect: Tunnel | null;
  onConnected: () => void;
}): ReactElement {
  const revisions = useQuery({
    ...revisionsQuery(pod.name),
    /*
     * The one read in this window that has to chase itself: a deploy is
     * accepted long before it is finished, so while a revision is in flight
     * the history is asked again until it settles. Everything else here
     * describes a revision, which does not change underneath you.
     */
    refetchInterval: (query) =>
      query.state.data?.some((entry) => entry.latest && entry.state === 'pending') === true
        ? 3_000
        : false,
  });
  /*
   * Absent until the shared config has been read, and the header's console
   * link waits for it rather than guessing an endpoint.
   */
  const { status } = useAuth();
  /*
   * The revision the user picked, if they picked one. Held with the pod it
   * belongs to so that switching pods cannot carry a revision id across into
   * a history it does not appear in.
   */
  const [chosen, setChosen] = useState<{ pod: string; id: string } | null>(null);

  /*
   * What the pod is actually running, which is what the window opens on.
   * Falling back to the newest revision matters for a pod that has never been
   * deployed: it has a history but nothing live in it.
   */
  const active = useMemo(() => {
    const history = revisions.data ?? [];
    return (
      history.find((entry) => entry.deployed) ??
      history.find((entry) => entry.latest) ??
      history[0] ??
      null
    );
  }, [revisions.data]);

  const revision = (chosen?.pod === pod.name ? chosen.id : null) ?? active?.id ?? null;

  const resources = useQuery({
    ...resourcesQuery(pod.name, revision),
    // The graph is read AT a revision, so asking for it before the history has
    // answered would fetch the head and then immediately fetch it again.
    enabled: pod.name.length > 0 && !revisions.isPending,
  });
  const { tunnels, pending, error, open, close, dismissError } = useTunnels();
  const reduced = useReducedMotion() === true;
  /*
   * One dialog state for both views. The graph and the connections panel set
   * it from opposite sides of the window, so there is nothing for them to
   * disagree about.
   */
  const [target, setTarget] = useState<TunnelDialogTarget | null>(null);
  const [asked, setAsked] = useState<PortRequest | null>(null);
  /*
   * An action of this pane's own that did not happen — a browser that refused
   * to open a link, a deploy the API rejected. The tunnel context knows about
   * neither, and both share its banner rather than growing a second one: all
   * of them are "the thing you just did did not happen".
   */
  const [actionError, setActionError] = useState<string | null>(null);

  const list = useMemo(() => resources.data ?? [], [resources.data]);

  /*
   * What the header states under the pod's name. Absent until the graph has
   * actually been read: an empty list mid-fetch is not "no resources", and a
   * header that says so for a beat is a header that lies.
   */
  const health = useMemo(
    () => (resources.isSuccess ? podReadiness(list) : null),
    [resources.isSuccess, list],
  );

  // Another pod's session must not badge a node in this one.
  const mine = useMemo(
    () => tunnels.filter((tunnel) => tunnel.pod === pod.name),
    [tunnels, pod.name],
  );

  const busy = useMemo(() => {
    const map: Record<string, boolean> = {};

    for (const resource of list) {
      // A session restored from Rust can already be starting without this
      // window having asked for it, and that must not read as an idle button.
      const starting = mine.some(
        (tunnel) => tunnel.resource === resource.name && tunnel.state === 'starting',
      );

      if (starting || pending[tunnelKey(pod.name, resource.name)] === true) {
        map[resource.name] = true;
      }
    }

    return map;
  }, [list, mine, pending, pod.name]);

  /*
   * The session this dialog's attempt produced, which is the only one whose
   * failure belongs in it. A resource's other tunnels are already open and
   * have nothing to say about a port that was just refused.
   */
  const session =
    asked === null
      ? null
      : (mine.find(
          (tunnel) => tunnel.resource === asked.resource.name && !asked.known.includes(tunnel.id),
        ) ?? null);

  const showConnection = useCallback(
    (tunnel: Tunnel) => {
      dismissError();
      /*
       * Built from the session alone. A tunnel outlives the revision its
       * resource was read at, so the node behind it can be missing from the
       * graph on screen while its credentials are still worth showing.
       */
      setTarget({ step: 'connection', pod: pod.name, resourceName: tunnel.resource, tunnel });
    },
    [dismissError, pod.name],
  );

  useEffect(() => {
    // `open` resolves without telling the caller how it went — the tunnel
    // context owns the request — so a listening session is what says the port
    // was accepted. That is also the moment the credentials exist, so the
    // dialog moves on to them rather than closing and hiding them.
    if (asked === null) return;

    // Not merely "a tunnel to this resource": the ones that predate the
    // request are somebody else's, and advancing to one of them would show
    // the credentials of a session the user did not just open.
    const opened = mine.find(
      (tunnel) => tunnel.resource === asked.resource.name && !asked.known.includes(tunnel.id),
    );
    if (opened?.state !== 'listening') return;

    /*
     * The port the tunnel landed on, not the one that was asked for. A rolled
     * port is still a port a client gets configured against, so next time the
     * field opens on it rather than making the user roll again and re-point
     * everything that pointed at the old one.
     */
    const port = opened.localPort;
    writeLastPort(pod.name, asked.resource.name, isLocalPort(port) ? port : null);
    setAsked(null);
    setTarget({
      step: 'connection',
      pod: pod.name,
      resourceName: asked.resource.name,
      tunnel: opened,
    });
  }, [asked, mine, pod.name]);

  useEffect(() => {
    if (connect === null || connect.pod !== pod.name) return;

    showConnection(connect);
    onConnected();
  }, [connect, pod.name, showConnection, onConnected]);

  useEffect(() => {
    // The tunnel these credentials describe can be closed from the sidebar
    // while they are on screen, and then they are an address of nothing.
    if (target?.step !== 'connection') return;
    if (mine.some((tunnel) => tunnel.id === target.tunnel.id)) return;

    setTarget(null);
  }, [target, mine]);

  useEffect(() => {
    // The banner names something about this pod — a URL, a rejected deploy —
    // and the pane is not remounted on a pod switch, so leaving it up would
    // state a failure about a pod that is no longer on screen.
    setActionError(null);
  }, [pod.name]);

  const ask = useCallback(
    (resource: Resource) => {
      // Only a database can carry a tunnel, and `engine` is what says so.
      const engine = resource.engine;
      if (engine === null) return;

      const enginePort = ENGINE_PORTS[engine];
      // A failure left over from an earlier action would otherwise arrive
      // inside the fresh dialog as if this attempt had already failed.
      dismissError();
      setActionError(null);
      setAsked(null);
      setTarget({
        step: 'port',
        pod: pod.name,
        resource,
        enginePort,
        suggestedPort: freePort(readLastPort(pod.name, resource.name) ?? enginePort, tunnels),
      });
    },
    [dismissError, pod.name, tunnels],
  );

  /** Every outbound link in this pane, and the one place their failure lands. */
  const follow = useCallback((url: string) => {
    setActionError(null);
    void openExternal(url).catch((error: unknown) => {
      setActionError(errorMessage(error, `Could not open ${url} in your browser.`));
    });
  }, []);

  const visit = useCallback(
    (resource: Resource) => {
      const url = routeUrl(resource);
      // Only a route has an address, and only one that states a host has one
      // that resolves; the card offers this action for nothing else.
      if (url === null) return;

      follow(url);
    },
    [follow],
  );

  const send = useCallback(
    (port: number) => {
      if (target?.step !== 'port') return;

      const resource = target.resource;
      setAsked({ resource, known: mine.map((tunnel) => tunnel.id) });
      dismissError();

      void (async () => {
        // A failed session is dead weight that still holds a slot in Rust's
        // map and a row in the sidebar; opening another tunnel to the same
        // resource is the moment to let go of it.
        const stale = mine.filter(
          (tunnel) => tunnel.resource === resource.name && tunnel.state === 'failed',
        );
        for (const tunnel of stale) await close(tunnel.id);

        await open(pod.name, resource.name, port);
      })();
    },
    [target, mine, close, open, dismissError, pod.name],
  );

  const dismiss = useCallback(() => {
    // Abandoning the action abandons its failure too; carrying it over to the
    // pane's banner would restate something the user just walked away from.
    dismissError();
    setAsked(null);
    setTarget(null);
  }, [dismissError]);

  /* Both failures reach the user through one banner, and one dismissal has to
     clear whichever of them put it there. */
  const notice = error ?? actionError;
  const clearNotice = useCallback(() => {
    dismissError();
    setActionError(null);
  }, [dismissError]);

  /*
   * The resource the rail is open on. Derived from the selection rather than
   * held beside it, so a refetch that changes a resource changes what the
   * panel says without anything here having to notice.
   */
  const inspected = useMemo(
    () => list.find((entry) => entry.name === selected) ?? null,
    [list, selected],
  );

  /*
   * How wide the rail is, and whether the pane can afford to give it a column
   * of its own. The window's own minimum leaves this pane around 500px, and a
   * 360px rail beside that would leave a canvas narrower than a single card —
   * so under the threshold the rail lies over the graph, the way a macOS
   * inspector does in a window too narrow to split.
   */
  const [chosenRail, setRail] = useState(readInspectorWidth);
  const [pane, setPane] = useState<HTMLDivElement | null>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  /*
   * The pane is the other bound. Overlay mode positions the rail against the
   * pane's right edge with a fixed width, so a width wider than the pane —
   * dragged at one window size, or restored from a session at another —
   * resolves to a negative left and lays opaque paint over the vibrancy
   * sidebar, the one surface in this window that must never be covered.
   */
  const rail = paneWidth > 0 ? Math.min(chosenRail, paneWidth) : chosenRail;
  const overlay = paneWidth > 0 && paneWidth - rail < MIN_CANVAS;

  useEffect(() => {
    if (pane === null) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setPaneWidth(entry.contentRect.width);
    });
    observer.observe(pane);

    return () => observer.disconnect();
  }, [pane]);

  /*
   * The pod's newest revision, which is the only one a deploy can act on: the
   * API promotes the head and refuses anything else, so a draft that is not
   * the head is not a thing this window can offer to deploy.
   */
  const head = useMemo(
    () => (revisions.data ?? []).find((entry) => entry.latest) ?? null,
    [revisions.data],
  );

  /*
   * Whether the graph on screen is the head. A deploy ships what the graph is
   * drawn at only while that is true; read at an older revision, the same
   * button would promote a draft the user is not looking at.
   */
  const atHead = head === null || revision === head.id;
  const watchingHead = head !== null && revision === head.id;

  /*
   * Read the pod at its newest revision. Two things ask for it — the header's
   * draft notice and the inspector, which cannot save a scale change against
   * history — and both mean the same move.
   */
  const showHead = useCallback(() => {
    if (head !== null) setChosen({ pod: pod.name, id: head.id });
  }, [head, pod.name]);

  // What is actually in that draft, which is what the deploy control has to
  // name before it ships it. Asked for only while a draft is on screen,
  // because a deployed revision's diff describes a change that already
  // happened and history is not a thing this window deploys.
  const draftDiff = useQuery(
    revisionDiffQuery(pod.name, watchingHead && head.state === 'draft' ? head.id : null),
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col border-l border-border bg-background pt-[38px]">
      <PodHeader
        pod={pod}
        health={health}
        revisions={revisions.data ?? []}
        revision={revision}
        head={head}
        atHead={atHead}
        watchingHead={watchingHead}
        changes={draftDiff.data ?? []}
        consoleEndpoint={status?.consoleEndpoint ?? null}
        reduced={reduced}
        onRevision={(id) => setChosen({ pod: pod.name, id })}
        onShowHead={showHead}
        onFailed={setActionError}
        onFollow={follow}
      />

      {/* While the port step is open it carries the tunnel's failure itself,
          right beside the field that fixes it; here would be a second copy. */}
      {notice !== null && target?.step !== 'port' && (
        <div className="shrink-0 px-6 pt-4">
          <ErrorBanner message={notice} reduced={reduced} onDismiss={clearNotice} />
        </div>
      )}

      {resources.isPending ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Spinner size={22} className="text-faint" />
        </div>
      ) : resources.isError ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-ui text-destructive">
            {errorMessage(resources.error, 'Could not load the resources in this pod.')}
          </p>
          <Button
            variant="outline"
            size="sm"
            title="Retry"
            onClick={() => void resources.refetch()}
          />
        </div>
      ) : (
        /* The canvas and the details rail are siblings in one row, and the row
           is `relative` so that on a narrow window the rail can lie over the
           canvas instead of squeezing it into a column no graph fits in. */
        <div ref={setPane} className="relative flex min-h-0 min-w-0 flex-1">
          {/* A direct flex child: the graph owns its own scroll container, and
              a wrapper around it would collapse the canvas to content height. */}
          <ResourceGraph
            pod={pod.name}
            resources={list}
            selected={selected}
            onSelect={onSelect}
            /* Only what is actually covering the canvas: in a column the rail
               takes its own width out of the row and covers nothing. */
            occluded={inspected !== null && overlay ? rail : 0}
          />

          {inspected !== null && (
            <ResourceInspector
              pod={pod.name}
              resource={inspected}
              width={rail}
              overlay={overlay}
              busy={busy[inspected.name] === true}
              onWidth={setRail}
              onWidthCommit={writeInspectorWidth}
              onClose={() => onSelect(null)}
              onOpenTunnel={ask}
              onOpenRoute={visit}
              onFollow={follow}
              onGoToHead={showHead}
              atHead={atHead}
              onSaved={(id) => setChosen({ pod: pod.name, id })}
            />
          )}
        </div>
      )}

      {target !== null && (
        <TunnelDialog
          target={target}
          busy={
            pending[tunnelKey(pod.name, targetResource(target))] === true ||
            session?.state === 'starting'
          }
          error={error ?? (session?.state === 'failed' ? session.error : null)}
          onOpen={send}
          onClose={dismiss}
          onCloseTunnel={(id) => void close(id)}
        />
      )}
    </div>
  );
}

/**
 * The pane's toolbar: what pod is on screen, what state it is in, and the
 * three controls that read or change it.
 *
 * It is a component rather than a block inside the pane because it is the one
 * surface in this window that mixes two vocabularies — an identity lockup and
 * a row of chrome — and they have to be tuned against each other. The
 * controls are one language now: a native picker and a button on the same
 * raised surface, with the draft chip riding the picker it belongs to and a
 * hairline before the two controls that act rather than read. A bright input
 * rule beside a quiet outline button is what made three controls read as
 * three unrelated widgets that had landed in the same corner.
 */
function PodHeader({
  pod,
  health,
  revisions,
  revision,
  head,
  atHead,
  watchingHead,
  changes,
  consoleEndpoint,
  reduced,
  onRevision,
  onShowHead,
  onFailed,
  onFollow,
}: {
  pod: Pod;
  /** The graph's verdict, or null until the resources have actually been read. */
  health: PodReadiness | null;
  revisions: Revision[];
  /** The revision the graph is drawn at. */
  revision: string | null;
  /** The pod's newest revision, which is the only one a deploy can act on. */
  head: Revision | null;
  atHead: boolean;
  watchingHead: boolean;
  /** Everything the draft changes, which is what a deploy would promote. */
  changes: DiffEntry[];
  /** Absent until the shared config has been read; the link waits rather than guesses. */
  consoleEndpoint: string | null;
  reduced: boolean;
  onRevision: (id: string) => void;
  onShowHead: () => void;
  onFailed: (message: string | null) => void;
  onFollow: (url: string) => void;
}): ReactElement {
  /* Only when something stands on the other side of it. A rule at the end of
     a row is a line, not a separator. */
  const acts = watchingHead || consoleEndpoint !== null;

  return (
    <motion.header
      key={pod.name}
      initial={reduced ? false : { opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 320, damping: 34 }}
      /* `items-center`, not `items-start`: the controls are one row tall and
         the identity beside them is two, so aligning to the top hangs them
         off the title's line instead of the block as a whole. */
      className="@container flex shrink-0 items-center justify-between gap-4 border-b border-border px-6 py-4">
      {/* Name over state, which is the lockup every other object in this
          window uses — a node card, the inspector's header, a sidebar row.
          The pod is the one that was stating its identity twice instead: the
          display name and the slug are the same fact at two fidelities, and
          the question a glance at this window asks is not what the pod is
          called. */}
      <div className="group min-w-0">
        <h1 className="truncate text-ui-title font-semibold">{pod.displayName ?? pod.name}</h1>

        <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
          {/* The name the CLI and the API address this pod by, so it is a
              value to take away rather than only to read. The control rides
              the lockup on hover, the way every other copyable value in this
              window does, and its negative margin keeps a 24px button from
              setting the height of a 16px line.

              The whole group shrinks six times as fast as the status beside
              it, and leaves entirely under a 640px pane: at the window's
              760px minimum there is no room for both, and the one to give up
              is the one that is nearly the title again. A degraded pod reads
              its whole verdict; it never reads a whole slug and half a
              reason. */}
          <span className="flex min-w-0 shrink-[6] items-center gap-1.5 @max-[640px]:hidden">
            <span
              data-selectable
              title={pod.name}
              className="min-w-0 truncate font-mono text-ui-mono text-faint">
              {pod.name}
            </span>
            <span className="-my-1 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 has-[:focus-visible]:opacity-100">
              <CopyButton label="pod name" value={pod.name} />
            </span>

            {health !== null && <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />}
          </span>

          {health !== null && (
            <>
              {/* The dot is decoration here: unlike a card, this line already
                  says in words what the dot is tinted for. */}
              <span
                aria-hidden="true"
                className={cx('size-1.5 shrink-0 rounded-full', TONE_FILL[health.tone])}
              />
              <span
                title={health.label}
                className={cx(
                  'truncate text-ui-sm',
                  /* Healthy is the quiet default at this size — it is the
                     state the window is in nearly all the time, and ink
                     spent on it is ink the title loses. Only a resource in
                     trouble earns the foreground. */
                  health.tone === 'ok' ? 'text-muted-foreground' : TONE_TEXT[health.tone],
                )}>
                {health.label}
              </span>
            </>
          )}
        </div>
      </div>

      {/* All of these read the pod, so they sit together at the head's right:
          the revision the graph is drawn at, the one control that changes what
          is running, and the way out to the console. */}
      <div className="flex shrink-0 items-center gap-2">
        {/* One group, because they are one subject: which revision is on
            screen, and where the work actually is. */}
        <div className="flex shrink-0 items-center gap-1">
          <RevisionPicker
            revisions={revisions}
            value={revision}
            fallback={podMeta(pod)}
            onChange={onRevision}
          />

          {/* The pod's newest revision, when it is not the one on screen and
              is not running. Without it the pane is silent about the single
              fact this product is organised around — that a draft exists and
              nothing in it is live — because the deploy control is mounted
              only over the head, and the head is exactly what this state is
              not showing. */}
          {head !== null && !atHead && <DraftNotice head={head} onShow={onShowHead} />}
        </div>

        {acts && <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border" />}

        {/* Beside the revision it acts on, because that is its scope: the
            API deploys the pod's head and refuses anything else, so it is
            offered only while the graph on screen is that head. It is absent
            entirely while the head is already running, which is most of the
            time, and while the picker is reading history. */}
        {watchingHead && (
          <DeployControl pod={pod.name} head={head} changes={changes} onFailed={onFailed} />
        )}

        {consoleEndpoint !== null && (
          <Button
            /* `secondary`, not `outline`: on the toolbar's own surface an
               outline button is a rule around nothing, and this sits beside a
               raised picker. */
            variant="secondary"
            size="sm"
            icon={<ExternalLink />}
            title={consoleUrl(consoleEndpoint, pod.name)}
            aria-label={`Open ${pod.name} in the Brainpod console`}
            onClick={() => onFollow(consoleUrl(consoleEndpoint, pod.name))}>
            Console
          </Button>
        )}
      </div>
    </motion.header>
  );
}

function ErrorBanner({
  message,
  reduced,
  onDismiss,
}: {
  message: string;
  reduced: boolean;
  onDismiss: () => void;
}): ReactElement {
  return (
    <motion.div
      /* A failed action the user just took, so it interrupts rather than waits. */
      role="alert"
      initial={reduced ? false : { opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 320, damping: 34 }}
      className="flex items-start gap-2.5 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-ui text-destructive">
      <TriangleAlert size={15} className="mt-0.5 shrink-0" />
      <p className="min-w-0 flex-1">{message}</p>

      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="-mr-1.5 shrink-0">
        <X />
      </Button>
    </motion.div>
  );
}

/**
 * What the pod's newest revision is, while the graph is drawn at an older one.
 *
 * This is the state the pane used to say nothing about: the sidebar row reads
 * `v2 · draft`, the picker reads `v1 · deployed`, and the deploy control is
 * unmounted because it is only legal over the head — so the one fact Brainpod
 * is organised around, that work is sitting in a draft and nothing in it is
 * running, lived inside a closed `<select>`.
 *
 * It states the revision and offers exactly one thing: read the pod there.
 * Deploying stays on the other side of that move, where the graph on screen is
 * the thing that would ship.
 */
function DraftNotice({ head, onShow }: { head: Revision; onShow: () => void }): ReactElement | null {
  const state = head.state?.toLowerCase() ?? '';
  if (state !== 'draft' && state !== 'pending' && state !== 'failed') return null;

  const version = head.version === null ? head.id.slice(0, 7) : `v${head.version}`;

  const { label, title } =
    state === 'draft'
      ? {
          label: `draft ${version}`,
          title: `${version} is a draft: nothing in it is running until it is deployed. Read the pod at it.`,
        }
      : state === 'pending'
        ? {
            label: `deploying ${version}`,
            title: `${version} is deploying. Read the pod at it.`,
          }
        : {
            label: `${version} failed`,
            title: `${version} failed to deploy. Read the pod at it.`,
          };

  return (
    <Button
      /* Ghost, and never the outline the picker beside it wears. A pod's head
         is a draft nearly all the time — that is what the model is — so this
         is on screen most of the time and a second bordered pill would twin
         the control it sits next to and nag at the same volume as the state it
         reports. The word order differs from the picker's for the same reason:
         `v1 · deployed` is what you are reading, `draft v2` is where the work
         is. */
      variant="ghost"
      size="sm"
      title={title}
      aria-label={title}
      onClick={onShow}
      /* The size class is inline because `size="sm"` carries `text-[0.8rem]`
         and this project has no tailwind-merge: two text-size utilities in one
         class list are settled by Tailwind's emission order, not by the order
         written, and the arbitrary one wins — which rendered this chip at
         12.8px beside an 11.5px picker holding the same kind of string. */
      style={{ fontSize: 'var(--text-ui-mono)' }}
      className="gap-1.5 font-mono text-muted-foreground hover:text-foreground">
      {/* The word beside it carries the state; the dot only tints it. */}
      <span
        aria-hidden="true"
        className={cx(
          'size-1.5 shrink-0 rounded-full',
          state === 'failed' ? 'bg-destructive' : 'bg-warn',
        )}
      />
      {label}
    </Button>
  );
}

/**
 * The one control in this window that changes what is running.
 *
 * It is mounted only while the graph on screen is the pod's head, and it draws
 * itself only when that head is something other than the thing already
 * deployed — the two conditions a deploy is legal in: the API promotes the
 * head and returns `412` for anything else, and a button offered over a
 * revision the user is reading as history would ship something else entirely.
 * The rest of the time there is no control at all; a permanently lit Deploy
 * button would be a button that mostly fails.
 *
 * Deploying promotes the *whole* draft, including changes made in the console
 * or by a teammate since this window opened, so the control names what is in
 * it rather than presenting itself as shipping the last thing you touched.
 */
function DeployControl({
  pod,
  head,
  changes,
  onFailed,
}: {
  pod: string;
  /** The pod's newest revision; null while the history is still loading. */
  head: Revision | null;
  /** Everything the draft changes, which is what a deploy would promote. */
  changes: DiffEntry[];
  onFailed: (message: string | null) => void;
}): ReactElement | null {
  const [busy, setBusy] = useState(false);

  const state = head?.state?.toLowerCase() ?? '';
  if (head === null || (state !== 'draft' && state !== 'pending' && state !== 'failed')) {
    return null;
  }

  const version = head.version === null ? head.id.slice(0, 7) : `v${head.version}`;

  if (state === 'pending') {
    /* Not a disabled button: there is no action here to offer and take away
       again, only a deploy the user is waiting on. */
    return (
      <span
        role="status"
        className="flex shrink-0 items-center gap-1.5 pr-1 text-ui-sm text-muted-foreground">
        <Spinner size={12} className="text-faint" />
        {`Deploying ${version}`}
      </span>
    );
  }

  const failed = state === 'failed';
  const summary =
    changes.length === 0
      ? ''
      : ` — ${changes.length === 1 ? '1 change' : `${changes.length} changes`}: ${changes
          .map((entry) => `${entry.name} ${entry.changeType}d`)
          .join(', ')}`;

  const run = async () => {
    setBusy(true);
    onFailed(null);

    try {
      await (failed ? redeployPod(pod) : deployPod(pod, null));
      // The head changed state and the pod's status with it, and the graph is
      // about to be read at a different revision.
      invalidatePod(pod);
    } catch (cause) {
      onFailed(
        errorMessage(cause, failed ? 'Could not retry the deploy.' : 'Could not deploy the draft.'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      /* Brand, not the ink fill: this is the window's one consequential
         action, and `default` resolves to near-white in dark mode, which would
         outweigh the pod's own title beside it. */
      variant={failed ? 'outline' : 'brand'}
      size="sm"
      title={
        failed
          ? `Retry deploying ${version}`
          : `Deploy ${version}${summary}. This promotes the pod's whole draft.`
      }
      aria-label={failed ? `Retry deploying ${pod}` : `Deploy the draft of ${pod}`}
      loading={busy}
      onClick={() => void run()}
      className={cx('shrink-0', failed && 'text-destructive')}>
      {failed ? 'Retry' : 'Deploy'}
    </Button>
  );
}

