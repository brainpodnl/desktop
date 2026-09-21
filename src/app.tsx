import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, type ReactElement } from 'react';

import { Spinner } from '@/components/spinner';
import { Titlebar } from '@/components/titlebar';
import { AuthProvider, useAuth } from '@/lib/auth';
import { openSettings } from '@/lib/bridge';
import { isMac } from '@/lib/platform';
import { queryClient } from '@/lib/queries';
import { TunnelsProvider } from '@/lib/tunnels';
import { PodScreen } from '@/screens/pod';
import { SignInScreen } from '@/screens/sign-in';

export function App(): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TunnelsProvider>
          <Shell />
        </TunnelsProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

/**
 * One window, two states. There is no route stack to keep, so the session alone
 * decides what is on screen.
 *
 * The shell paints nothing. The window is transparent over a macOS vibrancy
 * material and each screen decides its own surface: the signed-in screen is a
 * vibrant sidebar beside an opaque pane, the sign-in screen is opaque
 * throughout. A background here would cover the material for both of them.
 */
function Shell(): ReactElement {
  const { status, isRestoring } = useAuth();

  /*
   * ⌘, is the app menu's own accelerator on macOS and never reaches the
   * document, which is exactly right: AppKit owns it. Windows and Linux have
   * no app menu to put Settings in, so Ctrl+, is answered here instead.
   */
  useEffect(() => {
    if (isMac) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== ',' || !event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      void openSettings();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="relative flex h-full flex-col">
      {/* An overlay, not a row: it floats over whichever screen is mounted. */}
      <Titlebar />

      {/* `min-h-0` is what lets a screen own its own scrolling instead of
          growing the window past the viewport. */}
      <div className="min-h-0 flex-1">
        {isRestoring ? (
          // The one state with no screen to paint a surface, so it paints its
          // own: without it the first frame is a transparent hole onto the
          // desktop with a spinner floating in it.
          <div className="flex h-full items-center justify-center bg-background">
            <Spinner size={22} className="text-faint" />
          </div>
        ) : status?.signedIn === true ? (
          <PodScreen />
        ) : (
          <SignInScreen />
        )}
      </div>

      {/* The update notice is no longer here: it lives at the foot of the
          sidebar, beside the connections and the account, because it is about
          this machine rather than about what is on screen. A signed-out window
          has no rail and therefore no notice — the offer returns the moment
          the session resolves, and the update is already installed either
          way. */}
    </div>
  );
}
