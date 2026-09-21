import { getVersion } from '@tauri-apps/api/app';
import { LogicalSize } from '@tauri-apps/api/dpi';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { CircleUserRound, Download, SquareTerminal, SunMoon } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';

import { Button } from '@/components/button';
import { CliSection } from '@/components/cli-installer';
import { Select } from '@/components/inspector/parts';
import { Spinner } from '@/components/spinner';
import { ThemePicker } from '@/components/theme-picker';
import { Titlebar } from '@/components/titlebar';
import { AuthProvider, useAuth } from '@/lib/auth';
import { listPods, type Pod } from '@/lib/bridge';
import { errorMessage } from '@/lib/queries';
import { useTheme } from '@/lib/theme';
import { checkNow, useUpdate, type UpdateState } from '@/lib/updates';

/**
 * Settings, in its own window, the way every Mac app has done it since the
 * menu bar had a Preferences item. It is not a screen inside the app: opening
 * it must never cost the user the pod they were reading, and ⌘, has to do what
 * ⌘, does everywhere else on this machine.
 *
 * One column, not a toolbar of panes. Four short sections read faster stacked
 * than hidden behind four tabs that each hold a paragraph — nothing here is
 * long enough to be worth a click, and a preference the user cannot find is
 * the same as one that does not exist.
 */

/**
 * Matches `WIDTH` in `src-tauri/src/settings.rs`; the window never changes it.
 *
 * Wide enough that a setting's name, the sentence explaining it and the
 * control that changes it are one line of reading rather than three stacked
 * fragments — which is the whole difference between a preferences window and
 * a cramped one.
 */
const WINDOW_WIDTH = 660;

/**
 * Past this the window stops growing and the column scrolls instead. A
 * preferences window that fits its content is a Mac convention; one that grows
 * past the dock on a laptop screen is a bug wearing that convention.
 */
const MAX_WINDOW_HEIGHT = 720;

export function SettingsWindow(): ReactElement {
  return (
    <AuthProvider>
      <SettingsScreen />
    </AuthProvider>
  );
}

function SettingsScreen(): ReactElement {
  const body = useRef<HTMLDivElement | null>(null);
  const reduced = useReducedMotion() === true;

  useWindowFit(body, reduced);

  /*
   * Esc closes a utility window on macOS; ⌘W is the menu's own and needs
   * nothing here. Without it the only way out of a window with no Cancel
   * button is the mouse.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      void getCurrentWindow().close();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    // Opaque throughout. The pod window's sidebar is a real vibrancy material
    // and this window deliberately is not one: two blurred surfaces in one app
    // is where a Mac app starts looking like a theme.
    <div className="flex h-full flex-col bg-background">
      <Titlebar title="Settings" />

      {/* The fade covers the drag region rather than ruling a line under it,
          which is what macOS does where content scrolls under floating chrome:
          the divider exists only while there is something to divide. */}
      <div className="edge-fade-top min-h-0 flex-1 overflow-y-auto [--edge-fade-height:46px]">
        <div ref={body} className="flex flex-col gap-7 px-7 pt-[50px] pb-8">
          <Section title="Appearance" icon={<SunMoon size={14} />}>
            <AppearanceSection />
          </Section>

          <Section title="Account" icon={<CircleUserRound size={14} />}>
            <AccountSection />
          </Section>

          {/* Next to Updates rather than beside Account: both sections are
              about keeping a thing on this machine current, and the CLI is the
              one of the two the user installs rather than receives. */}
          <Section title="Command line" icon={<SquareTerminal size={14} />}>
            <CliSection />
          </Section>

          <Section title="Updates" icon={<Download size={14} />}>
            <UpdatesSection />
          </Section>
        </div>
      </div>
    </div>
  );
}

/**
 * One band of the column: a heading, a rule, and rows under it. The rule
 * belongs to the heading rather than sitting between sections, so a section
 * reads as one object instead of as the gap above the next one.
 */
function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactElement;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="flex flex-col">
      <h2 className="flex items-center gap-2 border-b border-border pb-2 text-ui-section font-semibold">
        <span className="text-muted-foreground">{icon}</span>
        {title}
      </h2>

      {children}
    </section>
  );
}

/**
 * One setting, in the shape the whole window uses: what it is and what it
 * means on the left, the control that changes it on the right, a hairline
 * under it. The description is not decoration — a preference whose
 * consequence has to be guessed is a preference nobody touches.
 */
function Row({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}): ReactElement {
  return (
    <div className="flex items-center justify-between gap-8 border-b border-border py-3.5 last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-ui font-medium">{title}</p>
        {description !== undefined && (
          <p className="text-ui-sm text-muted-foreground">{description}</p>
        )}
      </div>

      {/* Shrinkable, not fixed: a config path on a long username has to give
          way rather than run into the window's edge. Controls inside carry
          their own `shrink-0`, so only text ever yields. */}
      {children !== undefined && (
        <div className="flex min-w-0 items-center justify-end">{children}</div>
      )}
    </div>
  );
}

/**
 * Keeps the window exactly as tall as the column, up to the cap.
 *
 * The animation is the window's own frame rather than anything in the
 * document: a preferences window that grows into its content is a Mac
 * convention old enough to be invisible, and faking it by animating a box
 * inside a fixed window is the tell that it is not one. Each frame is an IPC
 * call, which is why it is 200ms of them and not a spring.
 */
function useWindowFit(body: React.RefObject<HTMLDivElement | null>, reduced: boolean): void {
  /** What was last asked for, which is what an animation has to start from. */
  const height = useRef<number | null>(null);
  const frame = useRef<number | null>(null);

  useLayoutEffect(() => {
    const node = body.current;
    if (!node) return;

    const apply = (): void => {
      const target = Math.min(Math.round(node.scrollHeight), MAX_WINDOW_HEIGHT);
      const from = height.current;
      height.current = target;

      const self = getCurrentWindow();
      const resize = (value: number) => {
        void self.setSize(new LogicalSize(WINDOW_WIDTH, Math.round(value)));
      };

      // The first measurement has no previous height to travel from, and a
      // difference of a pixel is not a transition.
      if (from === null || reduced || Math.abs(target - from) < 2) {
        resize(target);
        return;
      }

      const start = performance.now();
      const step = (now: number): void => {
        const t = Math.min((now - start) / 200, 1);
        // Exponential ease-out: the window arrives, it does not coast in.
        resize(from + (target - from) * (1 - (1 - t) ** 3));
        frame.current = t < 1 ? requestAnimationFrame(step) : null;
      };

      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(step);
    };

    apply();

    /*
     * The column changes height on its own, several times in a normal visit:
     * the session resolves, the update check lands, the CLI scan comes back
     * with what is on this machine. Each one moves the window rather than
     * leaving a band of empty ground at the bottom.
     */
    const observer = new ResizeObserver(apply);
    observer.observe(node);

    return () => {
      observer.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [body, reduced]);
}

function AppearanceSection(): ReactElement {
  const { preference } = useTheme();

  return (
    <Row
      title="Theme"
      description={
        preference === 'system'
          ? 'Brainpod follows your Mac’s appearance.'
          : `Brainpod stays ${preference}, whatever your Mac is set to.`
      }>
      <ThemePicker />
    </Row>
  );
}

function AccountSection(): ReactElement {
  const { status, signOut } = useAuth();

  if (status?.signedIn !== true) {
    return <Row title="Signed out" description="No account is signed in on this machine." />;
  }

  const email = status.email ?? 'Signed in';

  return (
    <>
      {/* The action sits on the account it ends, not in a row of its own:
          a whole labelled row for one button repeats the word `Sign out`
          three times and puts it as far from the identity as the section
          allows. Its consequence — the CLI shares this session — is in the
          tooltip rather than a sentence under a heading nobody needs. */}
      <div className="flex items-center gap-3 border-b border-border py-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand/15 text-ui-section font-semibold text-brand uppercase">
          {email.slice(0, 1)}
        </span>

        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-ui-section font-medium" data-selectable>
            {email}
          </span>
          <span className="truncate font-mono text-ui-mono text-faint" data-selectable>
            {host(status.apiEndpoint)}
          </span>
        </span>

        <Button
          variant="destructive"
          size="sm"
          title="Ends this session. The brainpod CLI reads the same config file, so it signs out too."
          className="shrink-0"
          onClick={() => {
            void signOut();
            // The pod window is about to return to its sign-in screen; a
            // Settings window left floating over it is about an account that
            // no longer exists.
            void getCurrentWindow().close();
          }}>
          Sign out
        </Button>
      </div>

      <DefaultPodRow />

      <Row title="Config file" description="Shared byte for byte with the brainpod CLI.">
        <span
          className="truncate font-mono text-ui-mono"
          data-selectable
          title={status.configPath}>
          {status.configPath}
        </span>
      </Row>
    </>
  );
}

/**
 * The default pod, as a control rather than a sentence.
 *
 * It writes the `pod` key of the config file the `brainpod` CLI shares, which
 * is the same thing `brainpod config set pod` writes — so this window and the
 * command line cannot disagree about which pod a command with no `--pod` acts
 * on. There is no second, app-only copy of this preference to drift from it.
 *
 * The list is the account's own pods rather than a text field: a default that
 * names a pod the user does not have is a default every CLI command then fails
 * on, and a typo is the likeliest way to write one.
 */
function DefaultPodRow(): ReactElement {
  const { status, setDefaultPod } = useAuth();
  const [pods, setPods] = useState<Pod[] | null>(null);
  const [unreadable, setUnreadable] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  /*
   * The value the user just picked, held until the status agrees with it.
   * Without it the native control snaps back to the old pod for the frames
   * the write takes, which reads as the click having been refused.
   */
  const [pending, setPending] = useState<{ pod: string | null } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  // `BRAINPOD_POD` outranks the file for this window and for every command run
  // from this environment, so there is nothing here to offer changing.
  const pinned = status?.podFromEnvironment === true;
  const signedIn = status?.signedIn === true;

  useEffect(() => {
    if (pinned || !signedIn) return;

    let cancelled = false;
    setUnreadable(null);

    listPods()
      .then((list) => {
        if (!cancelled) setPods(list);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setUnreadable(errorMessage(cause, 'Could not read your pods.'));
      });

    return () => {
      cancelled = true;
    };
  }, [pinned, signedIn, attempt]);

  useEffect(() => {
    if (pending === null) return;
    if ((status?.pod ?? null) === pending.pod) setPending(null);
  }, [pending, status?.pod]);

  const current = pending !== null ? pending.pod : (status?.pod ?? null);

  const names = pods?.map((pod) => pod.name) ?? [];
  const options = [
    { value: '', label: 'No default' },
    ...names.map((name) => ({ value: name, label: name })),
  ];

  /*
   * A stored pod the account does not have — renamed, deleted, or written for
   * another account — is still what resolves today, so it is shown rather than
   * silently replaced by a blank control. It is not a place to go back to,
   * which is what `disabled` says, and it is only called missing once the list
   * has actually answered.
   */
  if (current !== null && !names.includes(current)) {
    options.splice(1, 0, {
      value: current,
      label: pods === null ? current : `${current} · not in this account`,
      ...(pods === null ? {} : { disabled: true }),
    });
  }

  const choose = async (value: string): Promise<void> => {
    const pod = value.length > 0 ? value : null;
    setFailed(null);
    setPending({ pod });

    try {
      // What resolved, not what was asked for: those differ wherever the
      // environment has an opinion, and the control has to settle on the
      // value the next command will actually use.
      setPending({ pod: await setDefaultPod(pod) });
    } catch (cause) {
      setPending(null);
      setFailed(errorMessage(cause, 'Could not save the default pod.'));
    }
  };

  return (
    <Row
      title="Default pod"
      description={
        <>
          {pinned
            ? 'Pinned by BRAINPOD_POD in this environment, which outranks the config file.'
            : 'Where this window opens, and the pod the brainpod CLI falls back to.'}
          {unreadable !== null && (
            <span className="mt-1 block text-warn-strong">{unreadable}</span>
          )}
          {failed !== null && <span className="mt-1 block text-destructive">{failed}</span>}
        </>
      }>
      {pinned ? (
        <span className="font-mono text-ui-mono" data-selectable>
          {status?.pod}
        </span>
      ) : unreadable !== null ? (
        <div className="flex items-center gap-2">
          <span className={current === null ? 'text-ui text-muted-foreground' : 'font-mono text-ui-mono'}>
            {current ?? 'No default'}
          </span>
          <Button variant="outline" size="sm" title="Retry" onClick={() => setAttempt((n) => n + 1)} />
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {pods === null && <Spinner size={13} className="text-faint" />}
          <Select
            label="Default pod"
            mono
            value={current ?? ''}
            options={options}
            disabled={pods === null || pending !== null}
            onChange={(value) => void choose(value)}
          />
        </div>
      )}
    </Row>
  );
}

function UpdatesSection(): ReactElement {
  const { state, restart } = useUpdate();
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getVersion().then((value) => {
      if (active) setVersion(value);
    });
    return () => {
      active = false;
    };
  }, []);

  const busy = state.phase === 'checking' || state.phase === 'installing';

  return (
    <>
      <Row title="Installed version" description="The build of Brainpod running right now.">
        <span className="font-mono text-ui-mono" data-selectable>
          {version ?? '—'}
        </span>
      </Row>

      <Row
        title="Software update"
        description={
          <>
            <span className="flex items-center gap-1.5">
              {busy && <Spinner size={12} className="shrink-0" />}
              {describe(state)}
            </span>
            <span className="mt-1 block">
              Brainpod checks once each time it starts and installs what it finds; the new
              version runs after the next restart.
            </span>
          </>
        }>
        {state.phase === 'ready' ? (
          // `void`: relaunch resolves by never returning — the process is gone.
          <Button
            onClick={() => {
              void restart();
            }}>
            Restart
          </Button>
        ) : (
          <Button variant="outline" disabled={busy} onClick={() => void checkNow()}>
            Check again
          </Button>
        )}
      </Row>
    </>
  );
}

/**
 * One line of the updater's state, in its own words. `none` deliberately does
 * not claim the app is up to date: the updater reports an unreachable endpoint
 * and an empty answer identically, and only one of those means current.
 */
function describe(state: UpdateState): string {
  switch (state.phase) {
    case 'idle':
    case 'checking':
      return 'Checking for updates…';
    case 'none':
      return 'No update available.';
    case 'installing':
      return state.progress === null
        ? `Downloading ${state.version}…`
        : `Downloading ${state.version}… ${Math.round(state.progress * 100)}%`;
    case 'ready':
      return `Version ${state.version} is installed.`;
    case 'failed':
      return 'The update could not be installed.';
  }
}


/**
 * `https://api.brainpod.io/` reduced to what tells one deployment from another.
 * A malformed endpoint is shown as stored rather than hidden: it is the thing
 * to notice if the app is talking to the wrong place.
 */
function host(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}
