import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { useSyncExternalStore } from 'react';

/**
 * Which palette this window paints in, and who decides it.
 *
 * Three things have to agree or the window looks broken in a way no CSS can
 * fix: the document (`.dark` on `<html>`), the native window (the sidebar is a
 * real `NSVisualEffectMaterial` and the traffic lights are drawn by AppKit,
 * both of which follow the window's appearance rather than our stylesheet), and
 * the other window (Settings is its own `NSWindow`; a choice made there has to
 * land on the pod window in the same frame). This module is the one place that
 * knows all three.
 *
 * The preference lives in `localStorage` for the same reason the last tunnel
 * port does: `~/.config/brainpod/config.toml` is shared byte-for-byte with the
 * `brainpod` CLI, whose Rust struct denies unknown fields, so one extra key
 * there makes the CLI reject the user's whole config.
 */

export type ThemePreference = 'system' | 'light' | 'dark';

/** What `system` currently resolves to, and the only two the document can be in. */
export type Theme = 'light' | 'dark';

const KEY = 'brainpod.desktop.theme';

/** Broadcast to every webview, so both windows repaint from one click. */
const CHANGED = 'theme://changed';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function isPreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function readPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(KEY);
    return isPreference(stored) ? stored : 'system';
  } catch {
    // A webview that denies storage still has to render something, and
    // following the OS is the answer that is never wrong.
    return 'system';
  }
}

/**
 * The native half. `null` hands the window back to the OS; anything else pins
 * it, which is what keeps the vibrancy material and the traffic lights in step
 * with a palette the user chose against their Mac's.
 *
 * Failure is survivable and deliberately quiet: the document has already
 * repainted, so the worst case is a sidebar material one step behind.
 */
async function pushToNative(preference: ThemePreference): Promise<void> {
  try {
    await invoke('set_window_theme', { theme: preference === 'system' ? null : preference });
  } catch (cause) {
    console.warn('[theme] could not set the native window appearance', cause);
  }
}

/*
 * Module state rather than context: two windows, two React roots, and the OS
 * itself can all move this, so the store has to outlive any one tree.
 */
let preference: ThemePreference = 'system';
let theme: Theme = 'light';
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Adopt a preference that is already stored or already broadcast, and repaint
 * the document from it.
 *
 * `matchMedia` here is the window's appearance, not the Mac's: once a light or
 * dark preference has been pushed to the native window it answers with that
 * preference. Which is exactly why `system` is stored as the word `system` and
 * never flattened to a value on disk.
 */
function adopt(next: ThemePreference): void {
  preference = next;
  theme =
    next === 'system' ? (window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light') : next;
  // Idempotent, and cheap enough for every media change: `toggle` with a force
  // argument writes nothing when the class is already where it belongs.
  document.documentElement.classList.toggle('dark', theme === 'dark');
  publish();
}

/**
 * Called at the top of `main.tsx`, before the root is created: the window is
 * transparent until React paints, so applying the stored palette here is what
 * makes the first frame the right one rather than a light flash on a dark Mac.
 *
 * It also starts the listeners, which is not incidental. Only one window has a
 * picker in it, so a subscription that lived on a React mount would exist in
 * Settings and nowhere else: the pod window would keep its `.dark` class while
 * the native side — pushed to every window — flipped its vibrancy and traffic
 * lights underneath it. Every webview boots, so every webview listens.
 */
export function bootTheme(): void {
  adopt(readPreference());
  startWatching();

  // The stored preference may disagree with the window the OS just handed us,
  // and only the native side can settle that.
  void pushToNative(preference);
}

/**
 * Change it. Persists, repaints this window, tells the native window, and tells
 * the other one — in that order, so the pixels move before the IPC does.
 */
export function setPreference(next: ThemePreference): void {
  adopt(next);

  try {
    window.localStorage.setItem(KEY, next);
  } catch {
    // The choice still holds for this session; only its memory is lost.
    return;
  }

  void pushToNative(next).then(() => {
    // Handing the window back to the OS changes what `prefers-color-scheme`
    // answers, and the media listener does not fire for a window that was
    // already pinned to the same value. Re-resolving is what makes
    // dark → light → system land on the Mac's own setting rather than on the
    // last pinned one.
    if (preference === 'system') adopt('system');
  });

  void emit(CHANGED, next);
}

/**
 * Both sources of change this window does not initiate: the OS, and the other
 * window. Started once per webview, from `bootTheme`, and never torn down —
 * the palette outlives every tree in the document.
 */
let watching = false;
function startWatching(): void {
  if (watching) return;
  watching = true;

  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener('change', () => {
    if (preference === 'system') adopt('system');
  });

  void listen<ThemePreference>(CHANGED, (event) => {
    if (!isPreference(event.payload) || event.payload === preference) return;
    // Only the window that was clicked in writes storage and calls Rust; this
    // one just follows, or the two would race each other through the bridge.
    adopt(event.payload);
  });
}

export type ThemeControl = {
  preference: ThemePreference;
  /** What is actually on screen right now. */
  theme: Theme;
  setPreference: (next: ThemePreference) => void;
};

export function useTheme(): ThemeControl {
  const current = useSyncExternalStore(
    subscribe,
    () => preference,
    () => preference,
  );
  const resolved = useSyncExternalStore(
    subscribe,
    () => theme,
    () => theme,
  );

  return { preference: current, theme: resolved, setPreference };
}
