import { useEffect, useSyncExternalStore } from 'react';

import {
  cliStatus,
  installCli,
  latestCli,
  onCliProgress,
  removeCli,
  revealCli,
  type CliProgress,
  type CliRelease,
  type CliStatus,
} from '@/lib/bridge';
import { errorMessage } from '@/lib/queries';

/**
 * What this machine's `brainpod` is, and what is published for it.
 *
 * The same shape is read in two places that must never disagree — the notice
 * in the sidebar and the section in Settings — so the state, the staleness
 * rule and the install all live here rather than in whichever component
 * happened to need them first.
 *
 * Each window runs its own check: Settings is a second document, so this
 * module is instantiated twice and neither instance can see the other's. That
 * is the same arrangement `updates.ts` has, and it is cheap — one filesystem
 * read and one request per window, once per launch.
 */

export type CliState = {
  /** Null until the filesystem read answers. */
  status: CliStatus | null;
  /** Null while the release is unknown, which includes having no network. */
  release: CliRelease | null;
  /** Why the release is unknown. Never shown as a failure of the install. */
  offline: string | null;
  /** Non-null exactly while an install is running. */
  progress: CliProgress | null;
  /** The last write or reveal that failed. */
  error: string | null;
};

export type Cli = CliState & {
  /** What is on disk is behind what is published. */
  stale: boolean;
  /** The version the row states, which is not always what the binary reports. */
  version: string | null;
  install: () => Promise<void>;
  remove: () => Promise<void>;
  reveal: () => Promise<void>;
  /** Re-read the machine, for a Settings window opened long after launch. */
  refresh: () => Promise<void>;
};

const EMPTY: CliState = {
  status: null,
  release: null,
  offline: null,
  progress: null,
  error: null,
};

/*
 * The state lives in the module, not in a component, for the reason
 * `updates.ts` gives: a component that remounted mid-install would otherwise
 * start a second download of the same release, and StrictMode's double mount
 * would need a ref guard to be survivable.
 */
let state: CliState = EMPTY;
const listeners = new Set<() => void>();

function publish(next: Partial<CliState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = (): CliState => state;

/**
 * Whether what is on disk is behind what is published.
 *
 * A binary's own `--version` is not comparable to a release tag —
 * `brainpodnl/cli` stamps its binaries from a `VERSION` file, and v0.0.6 ships
 * one that calls itself 0.1.0 — so a copy this app has never written cannot be
 * measured, only replaced on request. Once it has been updated here the
 * receipt records which release it came from, and the comparison becomes one
 * between two things from the same place.
 */
export function isStale(status: CliStatus | null, release: CliRelease | null): boolean {
  if (status?.installed !== true || release === null) return false;
  return status.releaseVersion === null || status.releaseVersion !== release.version;
}

/**
 * The version to state: the release this app installed, or — for a binary it
 * did not write — whatever that binary calls itself, which is then the only
 * thing known about it.
 */
export function installedVersion(status: CliStatus | null): string | null {
  if (status === null) return null;
  return status.releaseVersion ?? status.version;
}

/** Null until the one automatic read of this launch has been started. */
let started: Promise<void> | null = null;

async function read(): Promise<void> {
  // Two independent answers, and the slow one must not hold up the fast one:
  // the filesystem read works offline and is most of what the UI needs.
  const machine = cliStatus()
    .then((status) => publish({ status }))
    .catch((cause) => publish({ error: errorMessage(cause, 'Could not read this machine.') }));

  const published = latestCli()
    .then((release) => publish({ release, offline: null }))
    .catch((cause) =>
      publish({
        offline: errorMessage(cause, 'Could not reach github.com for the release.'),
      }),
    );

  await Promise.all([machine, published]);
}

/*
 * Progress is subscribed once for the document rather than per component, so a
 * bar in the sidebar and a row in Settings watch the same install.
 */
let watching = false;
function watch(): void {
  if (watching) return;
  watching = true;
  void onCliProgress((progress) => publish({ progress }));
}

/**
 * Two installs at once would each end in a status read that lands whenever it
 * lands, and the UI would settle on whichever answered last rather than on
 * what is on disk.
 */
let writing = false;

async function write(): Promise<void> {
  const { release } = state;
  if (release === null || writing) return;

  writing = true;
  publish({ error: null, progress: { phase: 'downloading', received: 0, total: release.size } });

  try {
    // Rust answers with the state it just wrote, so nothing is re-read.
    publish({ status: await installCli(release) });
  } catch (cause) {
    publish({ error: errorMessage(cause, 'Could not install the Brainpod CLI.') });
  } finally {
    writing = false;
    publish({ progress: null });
  }
}

async function erase(): Promise<void> {
  if (writing) return;

  writing = true;
  publish({ error: null });

  try {
    publish({ status: await removeCli() });
  } catch (cause) {
    publish({ error: errorMessage(cause, 'Could not remove the Brainpod CLI.') });
  } finally {
    writing = false;
  }
}

/*
 * Revealing can fail — a Linux desktop may have no file manager to ask — and
 * it reports into the same slot the writes use rather than doing nothing
 * visible, which is what a silent catch would leave.
 */
async function show(): Promise<void> {
  try {
    await revealCli();
    publish({ error: null });
  } catch (cause) {
    publish({ error: errorMessage(cause, 'Could not open the install directory.') });
  }
}

export function useCli(): Cli {
  const current = useSyncExternalStore(subscribe, snapshot);

  useEffect(() => {
    watch();
    started ??= read();
  }, []);

  return {
    ...current,
    stale: isStale(current.status, current.release),
    version: installedVersion(current.status),
    install: write,
    remove: erase,
    reveal: show,
    refresh: read,
  };
}
