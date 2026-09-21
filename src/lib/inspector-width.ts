/**
 * How wide the user dragged the inspector, remembered across restarts.
 *
 * It lives in `localStorage` for the same reason the graph's arrangement and
 * the last local port do: `~/.config/brainpod/config.toml` is shared
 * byte-for-byte with the `brainpod` CLI, whose Rust struct denies unknown
 * fields, so one extra key there breaks the CLI.
 *
 * One width for the app rather than one per pod: the rail is furniture, and
 * furniture that moves when you switch pods is furniture you have to re-place.
 */

/**
 * Below this the fact rows stop being two columns and the mono values start
 * scrolling sideways at every row, which is a panel that states nothing.
 */
export const MIN_INSPECTOR_WIDTH = 300;
/** Past this the rail is the window and the graph is the sidebar. */
export const MAX_INSPECTOR_WIDTH = 560;
export const DEFAULT_INSPECTOR_WIDTH = 360;

const KEY = 'brainpod.desktop.inspector.width';

export const clampInspectorWidth = (value: number): number =>
  Math.min(Math.max(Math.round(value), MIN_INSPECTOR_WIDTH), MAX_INSPECTOR_WIDTH);

export function readInspectorWidth(): number {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return DEFAULT_INSPECTOR_WIDTH;

    const stored = Number(raw);
    // Hand-editable storage: anything that is not a finite number is not a
    // width, and the default is always a usable answer.
    return Number.isFinite(stored) ? clampInspectorWidth(stored) : DEFAULT_INSPECTOR_WIDTH;
  } catch {
    return DEFAULT_INSPECTOR_WIDTH;
  }
}

export function writeInspectorWidth(width: number): void {
  try {
    window.localStorage.setItem(KEY, String(clampInspectorWidth(width)));
  } catch {
    // Remembering the width is a convenience; the drag already happened.
  }
}
