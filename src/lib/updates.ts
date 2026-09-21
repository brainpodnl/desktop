import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { useEffect, useSyncExternalStore } from 'react';

/**
 * The boundary between the app and GitHub Releases, in the same spirit as
 * `bridge.ts`: one place that knows the plugin exists, and one shape for the
 * rest of the UI to read.
 *
 * Nothing here is ever an error the user has to deal with. The release
 * endpoint can be unreachable, `latest.json` can be missing, the build can be
 * unsigned — an app that cannot update itself still runs, so every failure
 * ends as a state nobody is shown.
 */

export type UpdateState =
  /** Before the check has been started; the first frame of every launch. */
  | { phase: 'idle' }
  | { phase: 'checking' }
  /** Up to date, or the check could not be made at all. Indistinguishable on purpose. */
  | { phase: 'none' }
  /**
   * Downloading and installing. `progress` is a 0..1 fraction, or null when
   * the server sent no `Content-Length` and there is no honest fraction to
   * report.
   */
  | { phase: 'installing'; version: string; progress: number | null }
  /** Installed on disk; the running process is still the old one. */
  | { phase: 'ready'; version: string }
  | { phase: 'failed' };

export type Updater = {
  state: UpdateState;
  /** Quits and reopens, so the version that was installed is the one running. */
  restart: () => Promise<void>;
};

/*
 * The state lives in the module, not in a component. The check runs once per
 * launch, and a component that remounted would otherwise restart it — which on
 * a half-finished download means downloading the same release twice. It also
 * makes StrictMode's double mount a non-issue without a ref guard.
 */
let state: UpdateState = { phase: 'idle' };
const listeners = new Set<() => void>();

function publish(next: UpdateState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = (): UpdateState => state;

/**
 * `check` throws under `tauri dev` and on any build the updater is not
 * configured for, which is most of them during development. That is not worth
 * a dialog, a toast or a red line anywhere: it is logged and the app carries
 * on as if it were up to date.
 */
function ignore(what: string, cause: unknown): void {
  console.warn(`[updates] ${what}`, cause);
}

async function install(update: Update): Promise<void> {
  const version = update.version;
  publish({ phase: 'installing', version, progress: null });

  let total: number | null = null;
  let received = 0;

  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case 'Started':
        // A server that sent no `Content-Length` leaves the download with no
        // denominator, so it stays indeterminate rather than being guessed at.
        total = event.data.contentLength ?? null;
        publish({ phase: 'installing', version, progress: total === null ? null : 0 });
        break;

      case 'Progress':
        received += event.data.chunkLength;
        // Clamped: the header is what the server claims, not what it sends.
        publish({
          phase: 'installing',
          version,
          progress: total === null ? null : Math.min(received / total, 1),
        });
        break;

      case 'Finished':
        publish({ phase: 'installing', version, progress: 1 });
        break;
    }
  });

  publish({ phase: 'ready', version });
}

async function run(): Promise<void> {
  publish({ phase: 'checking' });

  let update: Update | null;
  try {
    update = await check();
  } catch (cause) {
    // An unreachable endpoint and an unsupported build are the same non-event
    // here, so neither is distinguished from having nothing to install.
    ignore('could not check for updates', cause);
    publish({ phase: 'none' });
    return;
  }

  if (update === null) {
    publish({ phase: 'none' });
    return;
  }

  try {
    await install(update);
  } catch (cause) {
    // A failed download is worth its own state — the version was real and the
    // app knows it is behind — but still nothing the user has to answer.
    ignore('could not install the update', cause);
    publish({ phase: 'failed' });
  }
}

/** Null until the one automatic check of this launch has been started. */
let started: Promise<void> | null = null;

/**
 * Ask again, now. The launch check is deliberately once-only — a window that
 * is open for days must not poll GitHub — so Settings needs a way to run it a
 * second time.
 *
 * A check already in flight is returned rather than raced: two `check()` calls
 * against the same endpoint would publish over each other.
 */
export function checkNow(): Promise<void> {
  if (state.phase === 'checking' || state.phase === 'installing') return started ?? Promise.resolve();

  started = run();
  return started;
}

/**
 * The state of this launch's update check. Safe to call from more than one
 * component, and from more than one window: they all read the same run.
 */
export function useUpdate(): Updater {
  const current = useSyncExternalStore(subscribe, snapshot);

  useEffect(() => {
    started ??= run();
  }, []);

  return { state: current, restart: relaunch };
}
