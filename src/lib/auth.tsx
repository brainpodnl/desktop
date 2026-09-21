import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  authBegin,
  authCancel,
  authSignOut,
  authStatus,
  onAuthCancelled,
  onAuthCompleted,
  onAuthFailed,
  onAuthSignedOut,
  onDefaultPodChanged,
  setDefaultPod as writeDefaultPod,
  type AuthStatus,
} from '@/lib/bridge';
import { errorMessage, queryClient } from '@/lib/queries';

type AuthContextValue = {
  /** Null only until the first `auth_status` call comes back. */
  status: AuthStatus | null;
  /** True while the shared CLI config is being read. */
  isRestoring: boolean;
  isSigningIn: boolean;
  error: string | null;
  /**
   * The authorize URL of the flow in progress. The system browser may have
   * failed to open, so the UI offers it as a fallback.
   */
  fallbackUrl: string | null;
  signIn: () => Promise<void>;
  cancelSignIn: () => Promise<void>;
  signOut: () => Promise<void>;
  /**
   * Writes the default pod to the shared CLI config; `null` clears it.
   * Resolves with the pod that now *reads* back, which is the environment's
   * wherever `BRAINPOD_POD` is set rather than the one asked for.
   */
  setDefaultPod: (pod: string | null) => Promise<string | null>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = use(AuthContext);
  if (!value) throw new Error('useAuth must be used inside an AuthProvider');
  return value;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [isRestoring, setIsRestoring] = useState(true);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    authStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause, 'Could not read the Brainpod config.'));
      })
      .finally(() => {
        if (!cancelled) setIsRestoring(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const unlisten: Array<() => void> = [];

    // Subscribing is async, so a listener can arrive after this effect is torn
    // down; drop those immediately instead of leaking them for the window's life.
    const track = async (pending: Promise<() => void>) => {
      const off = await pending;
      if (active) unlisten.push(off);
      else off();
    };

    void track(
      onAuthCompleted((next) => {
        setStatus(next);
        setIsSigningIn(false);
        setError(null);
        setFallbackUrl(null);
      }),
    );

    void track(
      onAuthFailed((message) => {
        setError(message);
        setIsSigningIn(false);
      }),
    );

    // A user who declined in the browser already knows why nothing happened.
    void track(
      onAuthCancelled(() => {
        setIsSigningIn(false);
        setFallbackUrl(null);
      }),
    );

    /*
     * Sign out is asked for in the Settings window and answered in this one.
     * The command broadcasts, so both roots land on the same status without
     * either having to know which one the user clicked in.
     */
    void track(
      onAuthSignedOut((next) => {
        setStatus(next);
        setError(null);
        setFallbackUrl(null);
        // Pods and databases belong to the account that just left.
        queryClient.clear();
      }),
    );

    /*
     * Same shape, same reason: the default pod is set in Settings and read in
     * the pod window. Only the one field is patched — the rest of the status
     * describes the session, which a config write did not touch.
     */
    void track(
      onDefaultPodChanged((pod) => {
        setStatus((current) => (current === null ? current : { ...current, pod }));
      }),
    );

    return () => {
      active = false;
      for (const off of unlisten) off();
      unlisten.length = 0;
    };
  }, []);

  const signIn = useCallback(async () => {
    setIsSigningIn(true);
    setError(null);
    setFallbackUrl(null);

    try {
      const started = await authBegin();
      setFallbackUrl(started.url);
    } catch (cause) {
      setError(errorMessage(cause, 'Could not start the sign in flow.'));
      setIsSigningIn(false);
    }
  }, []);

  const cancelSignIn = useCallback(async () => {
    try {
      await authCancel();
    } catch {
      // The loopback server is already gone, which is the state we wanted anyway.
    }

    setIsSigningIn(false);
    setFallbackUrl(null);
    setError(null);
  }, []);

  /**
   * Fire and forget: the status this resolves to arrives over
   * `auth://signed-out` anyway, and that is the path a sign out from the
   * Settings window takes, so there is only one way the state can move.
   */
  const signOut = useCallback(async () => {
    try {
      await authSignOut();
    } catch (cause) {
      setError(errorMessage(cause, 'Could not sign out.'));
    }
  }, []);

  /**
   * Awaited, unlike sign out: the control that calls this states the failure
   * beside itself, and the value it settles on is the one Rust resolved rather
   * than the one asked for. The status itself arrives over the broadcast,
   * which reaches this window too.
   */
  const setDefaultPod = useCallback((pod: string | null) => writeDefaultPod(pod), []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      isRestoring,
      isSigningIn,
      error,
      fallbackUrl,
      signIn,
      cancelSignIn,
      signOut,
      setDefaultPod,
    }),
    [
      status,
      isRestoring,
      isSigningIn,
      error,
      fallbackUrl,
      signIn,
      cancelSignIn,
      signOut,
      setDefaultPod,
    ],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}
