import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  listTunnels,
  onTunnelUpdate,
  startTunnel,
  stopTunnel,
  type Resource,
  type Tunnel,
} from '@/lib/bridge';
import { errorMessage } from '@/lib/queries';

type TunnelsContextValue = {
  tunnels: Tunnel[];
  /** Keyed by `tunnelKey`, so a card knows whether its own button is busy. */
  pending: Record<string, boolean>;
  error: string | null;
  open: (pod: string, resource: Resource, port: number) => Promise<void>;
  close: (id: string) => Promise<void>;
  dismissError: () => void;
};

/**
 * Which resource an in-flight open belongs to. A resource can hold several
 * tunnels at once, but only one of them can be in the middle of being asked
 * for — the dialog is modal — so this is enough to know whether the card's
 * button is busy.
 */
export const tunnelKey = (pod: string, resource: string) => `${pod}/${resource}`;

const TunnelsContext = createContext<TunnelsContextValue | null>(null);

export function useTunnels(): TunnelsContextValue {
  const value = use(TunnelsContext);
  if (!value) throw new Error('useTunnels must be used inside a TunnelsProvider');
  return value;
}

/** Local ports are unique and stable, so sorting by them keeps cards from jumping. */
const byPort = (tunnels: Tunnel[]) => [...tunnels].sort((a, b) => a.localPort - b.localPort);

/**
 * Rust emits a full snapshot on every state or counter change, so an update
 * replaces the tunnel outright rather than merging into it. A closed tunnel is
 * gone as far as the UI is concerned.
 */
function applyUpdate(current: Tunnel[], next: Tunnel): Tunnel[] {
  const others = current.filter((tunnel) => tunnel.id !== next.id);
  return next.state === 'closed' ? byPort(others) : byPort([...others, next]);
}

export function TunnelsProvider({ children }: { children: ReactNode }) {
  const [tunnels, setTunnels] = useState<Tunnel[]>([]);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  // Mirrors `tunnels` so event handlers and `close` never read a stale closure.
  const tunnelsRef = useRef<Tunnel[]>([]);

  /*
   * Sessions Rust has already reported gone. An update can land before the
   * invoke that asked for that session resolves, and Rust emits nothing more
   * for an id it has dropped, so a stale snapshot would never be corrected.
   */
  const terminated = useRef<Set<string>>(new Set());

  const commit = useCallback((update: (current: Tunnel[]) => Tunnel[]) => {
    tunnelsRef.current = update(tunnelsRef.current);
    setTunnels(tunnelsRef.current);
  }, []);

  const markPending = useCallback((key: string, busy: boolean) => {
    setPending((current) => {
      if (!busy) {
        const next = { ...current };
        delete next[key];
        return next;
      }

      return { ...current, [key]: true };
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    listTunnels()
      .then((existing) => {
        if (cancelled) return;
        // The snapshot predates any update that landed while the invoke was in
        // flight, so it is folded into the live list rather than replacing it,
        // and a session already reported gone is not brought back.
        commit((current) =>
          existing
            .filter((tunnel) => tunnel.state !== 'closed' && !terminated.current.has(tunnel.id))
            .reduce((merged, snapshot) => applyUpdate(merged, snapshot), current),
        );
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause, 'Could not read the open tunnels.'));
      });

    return () => {
      cancelled = true;
    };
  }, [commit]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;

    void onTunnelUpdate((tunnel) => {
      if (tunnel.state === 'closed') terminated.current.add(tunnel.id);
      commit((current) => applyUpdate(current, tunnel));
    }).then((off) => {
      // The subscription can resolve after unmount; drop it instead of leaking.
      if (active) unlisten = off;
      else off();
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, [commit]);

  const open = useCallback(
    async (pod: string, resource: Resource, port: number) => {
      const key = tunnelKey(pod, resource.urn);
      markPending(key, true);
      setError(null);

      try {
        // Resolves only once the tunnel is listening, so the card can show its
        // address the moment the button stops spinning. The API resolves the
        // readable database name to the canonical URN returned on the session.
        const tunnel = await startTunnel(pod, resource.name, port);
        /*
         * Rust publishes the session and emits its updates before this call
         * returns, so the resolved value can already describe a session that
         * has since died. Committing it would restore a row Rust will never
         * speak about again, and nothing could then take it away.
         */
        if (!terminated.current.has(tunnel.id)) commit((current) => applyUpdate(current, tunnel));
      } catch (cause) {
        setError(errorMessage(cause, `Could not open a tunnel to ${resource.name}.`));
      } finally {
        markPending(key, false);
      }
    },
    [commit, markPending],
  );

  const close = useCallback(
    async (id: string) => {
      const target = tunnelsRef.current.find((tunnel) => tunnel.id === id);
      const key = target ? tunnelKey(target.pod, target.urn) : id;
      markPending(key, true);

      try {
        await stopTunnel(id);
      } catch (cause) {
        setError(errorMessage(cause, 'Could not close the tunnel.'));
      } finally {
        /*
         * Rust has dropped its entry on every path where `stop` returns at
         * all, so a rejection means the session is already gone rather than
         * still listening: the row goes whatever the outcome was.
         */
        commit((current) => current.filter((tunnel) => tunnel.id !== id));
        markPending(key, false);
      }
    },
    [commit, markPending],
  );

  const dismissError = useCallback(() => setError(null), []);

  const value = useMemo<TunnelsContextValue>(
    () => ({ tunnels, pending, error, open, close, dismissError }),
    [tunnels, pending, error, open, close, dismissError],
  );

  return <TunnelsContext value={value}>{children}</TunnelsContext>;
}
