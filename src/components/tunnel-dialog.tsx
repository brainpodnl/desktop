import { Check, Copy, Dices, Eye, EyeOff, TriangleAlert, X } from 'lucide-react';
import { motion } from 'motion/react';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import { Button } from '@/components/button';
import { Spinner } from '@/components/spinner';
import { portAvailable, randomPort, type Resource, type Tunnel } from '@/lib/bridge';
import { cx } from '@/lib/cx';
import { useReducedMotion } from '@/lib/motion';
import { isLocalPort, MAX_LOCAL_PORT, MIN_LOCAL_PORT } from '@/lib/port-preference';

const DIGITS = /^\d+$/;
/** Long enough that `5`, `54`, `543` on the way to `5432` are not four probes. */
const PROBE_DELAY = 250;

/**
 * A fixed row: the real length of a password is itself a hint worth not
 * leaking onto a screen that may be shared.
 *
 * Exported because the inspector states hidden values too, and two different
 * ways of drawing "there is a value here and you may not see it" in one window
 * is how a vocabulary drifts.
 */
export const MASK = '••••••••••••';

/**
 * Opening a tunnel is two questions with one answer between them — which local
 * port, then what to connect with — so it is one surface in two steps rather
 * than a dialog that vanishes at the moment the credentials become knowable.
 * The second step is also reachable on its own, because the credentials are
 * needed again long after the tunnel came up.
 */
export type TunnelDialogTarget =
  | { step: 'port'; pod: string; resource: Resource; enginePort: number; suggestedPort: number }
  | { step: 'connection'; pod: string; resourceName: string; tunnel: Tunnel };

export function TunnelDialog({
  target,
  busy,
  error,
  onOpen,
  onClose,
  onCloseTunnel,
}: {
  target: TunnelDialogTarget;
  busy: boolean;
  error: string | null;
  /** Always a real port: the dice fills the field rather than opening blind. */
  onOpen: (port: number) => void;
  onClose: () => void;
  onCloseTunnel: (tunnelId: string) => void;
}): ReactElement {
  const frame = useRef<HTMLDialogElement | null>(null);
  /**
   * Whatever had focus when this dialog appeared. Written once and never
   * overwritten: React's StrictMode runs a mount effect twice with a cleanup
   * between, and re-reading `document.activeElement` on the second pass would
   * record the dialog the first pass had already opened.
   */
  const opener = useRef<HTMLElement | null>(null);
  /*
   * Nothing inside a closed `<dialog>` is rendered, so nothing inside it can
   * take focus. A child's mount effect runs before this component's, so the
   * step waits on this rather than focusing into a display:none subtree.
   */
  const [opened, setOpened] = useState(false);
  const reduced = useReducedMotion() === true;
  const titleId = useId();

  // A tunnel outlives the revision its resource was read from, so the second
  // step is handed a name rather than a `Resource` that may no longer exist.
  const resourceName = target.step === 'port' ? target.resource.name : target.resourceName;

  useEffect(() => {
    if (opener.current === null && document.activeElement instanceof HTMLElement) {
      opener.current = document.activeElement;
    }

    const node = frame.current;
    if (node === null || node.open) return;

    // `showModal` is what buys the top layer, the focus trap and Escape. A
    // positioned div would be clipped by the graph canvas it is opened from.
    node.showModal();
    setOpened(true);

    /*
     * A modal `<dialog>` that React merely removes is popped off the top layer
     * WITHOUT the close algorithm running, so the UA never hands focus back and
     * the next Tab restarts at `<body>`, past the whole sidebar. `close()` puts
     * the element back in a sane state while it is still connected; the focus
     * is then placed by hand rather than left to the UA, whose own record of
     * the opener does not survive the StrictMode remount above.
     *
     * `close()` fires `close`, not `cancel`, and nothing here listens for it,
     * so this cannot re-enter `onClose`.
     */
    return () => {
      node.close();
      const previous = opener.current;
      if (previous !== null && previous.isConnected) previous.focus();
    };
  }, []);

  return (
    <dialog
      ref={frame}
      aria-labelledby={titleId}
      onCancel={(event) => {
        // React owns whether this dialog exists, so the native close is refused
        // and the parent unmounts it instead; otherwise Escape would leave a
        // closed element behind with the screen still believing it is open.
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === frame.current) onClose();
      }}
      /*
       * The element is the scrim. `::backdrop` does not reliably inherit the
       * theme's custom properties in WKWebView, and a scrim that silently
       * resolves to `transparent` is worse than one painted here.
       *
       * `hidden open:flex` because an author `display` outranks the UA's
       * `dialog:not([open])` rule, so a closed dialog would otherwise paint a
       * full-window wash over the app.
       *
       * The wash is a fixed black rather than `bg-foreground/25`: dark mode
       * flips foreground to near-white, and the same class would lay a white
       * veil over a dark app, which lightens instead of dims. A modal dims.
       */
      /* `text-foreground` because the UA resets `color` on `dialog` to a system
         colour, which every descendant without its own colour then inherits. */
      className="hidden fixed inset-0 m-0 size-full max-h-none max-w-none items-center justify-center bg-black/40 p-0 text-foreground backdrop-blur-[2px] backdrop:bg-transparent open:flex">
      <motion.div
        initial={reduced ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 320, damping: 34 }}
        className="flex w-[30rem] flex-col rounded-xl border border-border bg-popover shadow-dialog">
        <DialogHeader
          pod={target.pod}
          resourceName={resourceName}
          titleId={titleId}
          onClose={onClose}
        />

        {target.step === 'port' ? (
          <PortStep
            opened={opened}
            resource={target.resource}
            enginePort={target.enginePort}
            suggestedPort={target.suggestedPort}
            busy={busy}
            error={error}
            onOpen={onOpen}
          />
        ) : (
          <ConnectionStep
            opened={opened}
            tunnel={target.tunnel}
            onClose={onClose}
            onCloseTunnel={onCloseTunnel}
          />
        )}
      </motion.div>
    </dialog>
  );
}

/**
 * The band both steps wear: which pod and kind this is about, the resource's
 * full path, and the one control that dismisses the whole dialog.
 *
 * The kind-tinted tile the graph paints is deliberately absent here. Beside
 * two lines that already name the pod, the kind and the resource, it identifies
 * nothing the words do not, and it pushes the title off the surface's edge.
 */
function DialogHeader({
  pod,
  resourceName,
  titleId,
  onClose,
}: {
  pod: string;
  resourceName: string;
  titleId: string;
  onClose: () => void;
}): ReactElement {
  return (
    <div className="flex items-center gap-2 border-b border-border px-4 py-3">
      {/* The pod and the resource, once. An eyebrow above this restating the
          pod and the kind said nothing the title and the graph behind it do
          not already say, and cost the band a line. */}
      <h2 id={titleId} className="min-w-0 flex-1 truncate text-ui-title font-semibold">
        {`${pod} / ${resourceName}`}
      </h2>

      {/* `-mr-1` trades the ghost's own padding for optical alignment with the
          band's inset, so the glyph sits where the eye expects the corner. */}
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Close"
        onClick={onClose}
        className="-mr-1 shrink-0 text-faint">
        <X />
      </Button>
    </div>
  );
}

/**
 * Which local port to listen on. It is asked before the bind because the port
 * is the one thing the user has to know afterwards — it is what their client
 * connects to — and changing it later means closing the session.
 */
function PortStep({
  opened,
  resource,
  enginePort,
  suggestedPort,
  busy,
  error,
  onOpen,
}: {
  /** Whether the dialog is showing, and its contents therefore focusable. */
  opened: boolean;
  resource: Resource;
  enginePort: number;
  suggestedPort: number;
  busy: boolean;
  error: string | null;
  onOpen: (port: number) => void;
}): ReactElement {
  const field = useRef<HTMLInputElement | null>(null);
  // Text, not a number: `6` on the way to `65432` is neither a valid port nor
  // a reason to rewrite what the user is halfway through typing.
  const [draft, setDraft] = useState(() => String(suggestedPort));
  const fieldId = useId();
  const problemId = useId();

  const typed = draft.trim();
  const parsed = DIGITS.test(typed) ? Number(typed) : null;
  // The one gate: `problem` only ever explains why this is null.
  const port = parsed !== null && isLocalPort(parsed) ? parsed : null;

  const problem =
    port !== null
      ? null
      : typed.length === 0
        ? 'Enter a port to listen on.'
        : parsed === null
          ? 'A port is digits only.'
          : parsed < MIN_LOCAL_PORT
            ? `Ports under ${MIN_LOCAL_PORT} are reserved for root on macOS.`
            : `${MAX_LOCAL_PORT} is the highest port there is.`;

  const takeField = useCallback(() => {
    const node = field.current;
    if (node === null) return;

    node.focus();
    // Selected, not merely focused: the suggestion is the answer most of the
    // time, and when it is not, the first keystroke replaces the whole of it.
    node.select();
  }, []);

  useEffect(() => {
    if (opened) takeField();
  }, [opened, takeField]);

  useEffect(() => {
    // The bind was refused, and the port is the thing to change, so the caret
    // goes back into the field with the rejected number selected.
    if (error !== null) takeField();
  }, [error, takeField]);

  const [free, setFree] = useState<boolean | null>(null);
  const [rolling, setRolling] = useState(false);

  useEffect(() => {
    if (port === null) {
      setFree(null);
      return;
    }

    /*
     * Unknown while the answer is in flight, rather than the previous port's
     * verdict held over: a stale "available" under a number the user has just
     * changed is worse than saying nothing.
     */
    setFree(null);
    let live = true;
    // Debounced, because every keystroke through `5`, `54`, `543` is a valid
    // port on the way to the one that was meant.
    const timer = window.setTimeout(() => {
      portAvailable(port)
        .then((answer) => {
          if (live) setFree(answer);
        })
        .catch(() => {
          // The probe is a courtesy; the bind still reports the truth.
        });
    }, PROBE_DELAY);

    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [port]);

  const roll = useCallback(async () => {
    setRolling(true);
    try {
      setDraft(String(await randomPort()));
      takeField();
    } catch {
      // Nothing to say: the field keeps the port it had, which is still usable.
    } finally {
      setRolling(false);
    }
  }, [takeField]);

  /*
   * Three states, not two. "In use" is a warning and not an error: the port
   * can free up between here and the bind, and a client already configured
   * for it is a good reason to try anyway.
   */
  const availability =
    port === null
      ? null
      : free === null
        ? { label: `Checking port ${port}…`, taken: false }
        : free
          ? { label: `Port ${port} is available.`, taken: false }
          : { label: `Port ${port} is already in use.`, taken: true };

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* The two ports side by side, because the pair is the whole sentence:
          one side is chosen, the other is given, and the arrow between them is
          the only thing that says which is which. */}
      <div className="grid grid-cols-[11rem_auto_minmax(0,1fr)] items-center gap-x-2.5 gap-y-1.5">
        <label
          htmlFor={fieldId}
          className="col-start-1 row-start-1 text-ui-sm text-muted-foreground">
          Local port
        </label>
        <p className="col-start-3 row-start-1 text-ui-sm text-muted-foreground">Container port</p>

        <div className="col-start-1 row-start-2 flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <input
              ref={field}
              id={fieldId}
              type="text"
              /* A stepper's arrows are the wrong affordance: ports are not a dial. */
              inputMode="numeric"
              maxLength={5}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              disabled={busy}
              value={draft}
              aria-invalid={problem !== null || undefined}
              aria-describedby={(problem ?? error) === null ? undefined : problemId}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || port === null) return;

                event.preventDefault();
                onOpen(port);
              }}
              className={cx(
                'h-8 w-full rounded-lg border bg-background pr-7 pl-2.5 font-mono text-ui tabular-nums outline-none transition-colors',
                // A restrained ring: in a small dark dialog the button's `ring-3`
                // turns the field into the loudest thing on screen.
                'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50',
                problem !== null
                  ? 'border-destructive/60'
                  : availability?.taken === true
                    ? 'border-warn/60'
                    : 'border-input',
              )}
            />

            {/* The verdict rides the field rather than a line of prose beneath
                it: the sentence repeated the number the user is looking at, and
                a validity mark is where the eye already is. */}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">
              {availability === null ? null : free === null ? (
                <Spinner size={12} className="text-faint" />
              ) : availability.taken ? (
                <TriangleAlert size={13} className="text-warn-strong" />
              ) : (
                <Check size={13} strokeWidth={2.6} className="text-ok" />
              )}
            </span>
          </div>

          {/* A bordered control the height of the field, not a glyph floating
              beside a sentence: it rerolls the port, and that has to look like
              something to press. */}
          <Button
            variant="outline"
            size="icon"
            aria-label="Pick a free port"
            title="Pick a free port"
            disabled={busy}
            loading={rolling}
            onClick={() => void roll()}
            className="shrink-0 text-muted-foreground">
            <Dices />
          </Button>
        </div>

        <span aria-hidden className="col-start-2 row-start-2 text-faint">
          →
        </span>

        {/* Stated, not chosen: a Brainpod database resource exposes exactly one
            port, so a dropdown with a single option would be a lie. `border-border`
            rather than `border-input`: only a field that takes a value should wear
            the control boundary. */}
        <div
          className="col-start-3 row-start-2 flex h-8 items-center rounded-lg border border-border bg-background/60 px-2.5">
          <span className="truncate font-mono text-ui text-muted-foreground">
            {`${resource.name}:${enginePort}`}
          </span>
        </div>

        {/*
          One element for every verdict, so a screen reader hears each one
          exactly once. Only the collision is worth ink: `available` is the
          expected answer and the tick on the field already says it, while
          `in use` is the exception and has to be readable as words.
        */}
        {availability !== null && (
          <p
            role="status"
            className={cx(
              'col-span-3 col-start-1 row-start-3',
              availability.taken ? 'text-ui-sm text-warn-strong' : 'sr-only',
            )}>
            {availability.label}
          </p>
        )}
      </div>

      {/* One message slot: while the field is invalid the confirm is disabled
          and this says why, and once it is valid the slot carries the bind
          failure the last attempt came back with. */}
      {(problem ?? error) !== null && (
        <p id={problemId} className="text-ui-sm text-destructive">
          {problem ?? error}
        </p>
      )}

      {/* Alone: the header's × is the way out, and a second dismissal beside
          the confirm only makes the pair a decision. */}
      <div className="flex justify-end">
        {/*
          Brand, not the ink fill: `default` resolves to near-white in dark
          mode, which in a small dark dialog outweighs everything it sits
          under. Blue is already the app's primary action on sign-in.
        */}
        <Button
          variant="brand"
          size="sm"
          title="Open tunnel"
          aria-label={`Open tunnel to ${resource.name}`}
          loading={busy}
          disabled={problem !== null}
          onClick={() => {
            if (port === null) return;
            onOpen(port);
          }}
        />
      </div>
    </div>
  );
}

/**
 * What to connect with, once the tunnel is up. This is the step people come
 * back to: the address goes into a client, the DSN into an app's config, and
 * neither is worth memorising.
 */
function ConnectionStep({
  opened,
  tunnel,
  onClose,
  onCloseTunnel,
}: {
  /** Whether the dialog is showing, and its contents therefore focusable. */
  opened: boolean;
  tunnel: Tunnel;
  onClose: () => void;
  onCloseTunnel: (tunnelId: string) => void;
}): ReactElement {
  const [revealed, setRevealed] = useState(false);
  const doneId = useId();

  /*
   * The same wait `PortStep` makes, for the same reason: this mounts while the
   * dialog is still closed, so `autoFocus` would call `.focus()` on a
   * display:none button and `showModal` would then settle on the header's ×.
   * `id` rather than a ref because `Button` takes no ref.
   */
  useEffect(() => {
    if (!opened) return;

    document.getElementById(doneId)?.focus();
  }, [opened, doneId]);

  const address = `${tunnel.host}:${tunnel.localPort}`;

  // Context, not credentials: these are read off the screen while filling in a
  // client, never copied, so they stay one quiet line instead of two rows.
  const facts: string[] = [];
  if (tunnel.username !== null) facts.push(`User ${tunnel.username}`);
  if (tunnel.database !== null) facts.push(`Database ${tunnel.database}`);

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-1">
        <CredentialRow label="Address" value={address} />

        {facts.length > 0 && (
          <p className="text-ui-sm text-muted-foreground">{facts.join(' · ')}</p>
        )}
      </div>

      {/* A session started without preflight has no credentials to state, and
          an empty row states less than no row. */}
      {tunnel.dsn !== null && <CredentialRow label="Connection string" value={tunnel.dsn} />}

      {tunnel.password !== null && (
        <CredentialRow
          label="Password"
          value={tunnel.password}
          display={revealed ? tunnel.password : MASK}
          control={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-pressed={revealed}
              aria-label={revealed ? 'Hide the password' : 'Show the password'}
              onClick={() => setRevealed(!revealed)}
              className="shrink-0 text-faint">
              {revealed ? <EyeOff /> : <Eye />}
            </Button>
          }
        />
      )}

      {tunnel.clientCommand !== null && (
        <CredentialRow label="Client command" value={tunnel.clientCommand} />
      )}

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="destructive"
          size="sm"
          title="Close tunnel"
          onClick={() => {
            onCloseTunnel(tunnel.id);
            // The thing this dialog describes no longer exists.
            onClose();
          }}
          className="mr-auto"
        />
        <Button id={doneId} variant="brand" size="sm" title="Done" onClick={onClose} />
      </div>
    </div>
  );
}

function CredentialRow({
  label,
  value,
  display,
  control,
}: {
  label: string;
  value: string;
  /** What is shown, when that differs from what is copied. */
  display?: string;
  control?: ReactNode;
}): ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-ui-sm text-muted-foreground">{label}</p>

      <div className="flex items-center gap-1">
        {/* A credential is one unbreakable token the user reads or copies whole, so it
            scrolls sideways: a wrap would put a false line break in the middle of it. */}
        <p
          data-selectable
          className="min-w-0 flex-1 overflow-x-auto font-mono text-ui-mono whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{
            maskImage: 'linear-gradient(to right, #000 calc(100% - 28px), transparent)',
            WebkitMaskImage: 'linear-gradient(to right, #000 calc(100% - 28px), transparent)',
          }}>
          {display ?? value}
        </p>

        {control}
        <CopyButton label={label.toLowerCase()} value={value} />
      </div>
    </div>
  );
}

/**
 * Lives here, beside the four credentials that need it, and is imported by the
 * sidebar's connections panel rather than reimplemented there: two copy
 * buttons in one app that confirm differently is how a control drifts.
 */
export function CopyButton({ label, value }: { label: string; value: string }): ReactElement {
  const [copied, setCopied] = useState(false);

  // The confirmation is a timeout rather than a transition, so reduced motion
  // cannot leave a permanent check on screen.
  useEffect(() => {
    if (!copied) return;

    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard access can be denied; the value stays selectable on screen.
    }
  }, [value]);

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={copied ? `${label} copied` : `Copy the ${label}`}
      onClick={() => void copy()}
      className="shrink-0 text-faint">
      {copied ? <Check strokeWidth={2.4} /> : <Copy />}
    </Button>
  );
}
