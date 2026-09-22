import { emit, listen } from '@tauri-apps/api/event';
import { useSyncExternalStore } from 'react';

/**
 * Whether this window animates, and who decides it.
 *
 * The OS setting is the default and not the whole story: macOS's Reduce Motion
 * is a blunt, system-wide switch, and a person can want a still window without
 * wanting a still Mac. So the preference is this app's own, `system` means
 * "whatever the OS says", and the resolved answer is what every surface reads.
 *
 * It replaces `motion/react`'s own `useReducedMotion` everywhere, because a
 * preference that half the window obeys is worse than not having one.
 *
 * Module state rather than context, for the reason the theme gives: two
 * windows, two React roots, and the OS itself can all move this, so the store
 * has to outlive any one tree.
 */

export type MotionPreference = 'system' | 'reduced';

const KEY = 'brainpod.desktop.motion';

/** Broadcast to every webview, so Settings and the pod window agree at once. */
const CHANGED = 'motion://changed';

const QUERY = '(prefers-reduced-motion: reduce)';

function isPreference(value: unknown): value is MotionPreference {
  return value === 'system' || value === 'reduced';
}

function stored(): MotionPreference {
  try {
    const value = window.localStorage.getItem(KEY);
    return isPreference(value) ? value : 'system';
  } catch {
    // A window with storage denied still has to render.
    return 'system';
  }
}

let preference: MotionPreference = stored();
let system = false;
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) listener();
}

/**
 * Both sources of change this window does not initiate: the OS, and the other
 * window. Started on the first subscription and never torn down — the setting
 * outlives every tree in the document.
 */
let watching = false;
function startWatching(): void {
  if (watching) return;
  watching = true;

  const media = window.matchMedia(QUERY);
  system = media.matches;
  media.addEventListener('change', (event) => {
    system = event.matches;
    if (preference === 'system') publish();
  });

  void listen<MotionPreference>(CHANGED, (event) => {
    if (!isPreference(event.payload) || event.payload === preference) return;
    // Only the window that was clicked in writes storage; this one follows.
    preference = event.payload;
    publish();
  });
}

function subscribe(listener: () => void): () => void {
  startWatching();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setMotionPreference(next: MotionPreference): void {
  if (next === preference) return;

  try {
    window.localStorage.setItem(KEY, next);
  } catch {
    // Storage is a convenience here; the session still honours the choice.
  }

  preference = next;
  publish();
  void emit(CHANGED, next);
}

/** The resolved answer: what every animated surface in the window asks. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => preference === 'reduced' || system,
    () => false,
  );
}

export type MotionControl = {
  preference: MotionPreference;
  /** What the preference resolves to right now, OS included. */
  reduced: boolean;
  setPreference: (next: MotionPreference) => void;
};

export function useMotion(): MotionControl {
  const current = useSyncExternalStore(
    subscribe,
    () => preference,
    () => preference,
  );
  const reduced = useReducedMotion();

  return { preference: current, reduced, setPreference: setMotionPreference };
}
