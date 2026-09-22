/**
 * Where the user put each node, remembered per pod.
 *
 * `layoutGraph` decides where a node starts; this decides where it stays. The
 * arrangement lives in `localStorage` for the same reason the last local port
 * does: `~/.config/brainpod/config.toml` is shared byte-for-byte with the
 * `brainpod` CLI, whose Rust struct denies unknown fields, so one extra key
 * there breaks the CLI.
 *
 * Entries are keyed by canonical resource URN, and an entry whose resource is
 * missing from the current revision is left alone rather than purged: a
 * resource can vanish in one deploy and come back in the next, and an
 * arrangement somebody made by hand should survive that round trip.
 */

export type NodePosition = { x: number; y: number };

export type NodePositions = Record<string, NodePosition>;

const KEY_PREFIX = 'brainpod.desktop.graph.v2.';
const LEGACY_KEY_PREFIX = 'brainpod.desktop.graph.';

/**
 * Two numbers do not earn a schema dependency, but they do earn a guard: what
 * is on disk is hand-editable JSON, and a coordinate that is not a finite
 * number — or is negative, which parks a card outside the canvas where no
 * scroll can reach it — is not a position. Such an entry is dropped and the
 * rest of the arrangement still stands.
 */
function narrow(value: unknown): NodePosition | null {
  if (typeof value !== 'object' || value === null) return null;
  if (!('x' in value) || !('y' in value)) return null;

  const { x, y } = value;
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return null;

  return { x, y };
}

export function readPositions(pod: string): NodePositions {
  try {
    window.localStorage.removeItem(`${LEGACY_KEY_PREFIX}${pod}`);
    const raw = window.localStorage.getItem(`${KEY_PREFIX}${pod}`);
    if (raw === null) return {};

    const stored: unknown = JSON.parse(raw);
    if (typeof stored !== 'object' || stored === null) return {};

    // `Object.entries` types its values loosely; the annotation is what forces
    // every stored coordinate through the guard rather than past it.
    const entries: [string, unknown][] = Object.entries(stored);
    const positions: NodePositions = {};
    for (const [urn, entry] of entries) {
      const position = narrow(entry);
      if (position !== null) positions[urn] = position;
    }

    return positions;
  } catch {
    // Malformed JSON, or a webview that denies storage outright. The computed
    // layout is always a usable answer, so the graph draws either way.
    return {};
  }
}

export function writePositions(pod: string, positions: NodePositions): void {
  try {
    window.localStorage.removeItem(`${LEGACY_KEY_PREFIX}${pod}`);
    window.localStorage.setItem(`${KEY_PREFIX}${pod}`, JSON.stringify(positions));
  } catch {
    // Remembering the arrangement is a convenience; the drag already happened.
  }
}

export function clearPositions(pod: string): void {
  try {
    window.localStorage.removeItem(`${KEY_PREFIX}${pod}`);
    window.localStorage.removeItem(`${LEGACY_KEY_PREFIX}${pod}`);
  } catch {
    // Nothing to report: the caller has already put the nodes back on screen.
  }
}
