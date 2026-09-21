/**
 * The local port a database tunnel last listened on, remembered per database.
 *
 * It is remembered because a saved connection in TablePlus, a DataGrip data
 * source or a `psql` alias points at one fixed port: reopening the same
 * database has to land on the port it used last time, or every client has to be
 * re-pointed. And it is remembered *here*, in `localStorage`, rather than in
 * `~/.config/brainpod/config.toml`, because that file is shared byte-for-byte
 * with the `brainpod` CLI whose Rust struct denies unknown fields — one extra
 * key and the CLI rejects the whole config.
 */

/** Binding below 1024 needs root on macOS, so the UI refuses it before bind does. */
export const MIN_LOCAL_PORT = 1024;
export const MAX_LOCAL_PORT = 65535;

const KEY_PREFIX = 'brainpod.desktop.port.';

export function isLocalPort(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_LOCAL_PORT && value <= MAX_LOCAL_PORT;
}

/**
 * One field does not earn a schema dependency, but it does earn a guard: what
 * is on disk is hand-editable JSON, and a build before the port prompt wrote
 * `{mode, port}` here, where the port only meant anything in `custom` mode.
 * Anything that does not narrow is discarded — a forgotten preference is a far
 * smaller bug than throwing while reading one.
 */
function narrow(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  if (!('port' in value)) return null;
  if ('mode' in value && value.mode !== 'custom') return null;

  const { port } = value;
  return typeof port === 'number' && isLocalPort(port) ? port : null;
}

export function readLastPort(pod: string, resource: string): number | null {
  try {
    const raw = window.localStorage.getItem(`${KEY_PREFIX}${pod}/${resource}`);
    if (raw === null) return null;

    return narrow(JSON.parse(raw));
  } catch {
    // Malformed JSON, or a webview that denies storage outright. The engine's
    // own port is always a usable answer, so nothing here is worth surfacing.
    return null;
  }
}

export function writeLastPort(pod: string, resource: string, port: number | null): void {
  try {
    window.localStorage.setItem(`${KEY_PREFIX}${pod}/${resource}`, JSON.stringify({ port }));
  } catch {
    // Remembering the port is a convenience; the tunnel opens either way.
  }
}
