import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Check, TriangleAlert, X } from 'lucide-react';
import { motion, type Transition } from 'motion/react';
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
import { AGENT_MARKS, AGENT_MARK_SCALE } from '@/components/marks/agents';
import { Tile } from '@/components/tile';
import {
  installSkill,
  openExternal,
  removeSkill,
  revealSkill,
  type Harness,
  type HarnessId,
} from '@/lib/bridge';
import { cx } from '@/lib/cx';
import { useReducedMotion } from '@/lib/motion';
import { errorMessage, harnessesQuery, latestSkillQuery, queryClient } from '@/lib/queries';
import { outdated } from '@/lib/skills';

/**
 * Each agent's own colour, tinting the tile its mark sits on exactly as the
 * sign-in hero tints the one it rotates through. Tokens rather than literals:
 * two of the four are drawn for a light ground and have to be restated on a
 * dark one.
 */
const BRAND: Record<HarnessId, string> = {
  claude: 'var(--mark-claude)',
  codex: 'var(--mark-codex)',
  cursor: 'var(--mark-cursor)',
  gemini: 'var(--mark-gemini)',
};

const FAN_SPRING: Transition = { type: 'spring', stiffness: 340, damping: 30 };
const INSTANT: Transition = { duration: 0 };
/**
 * The fan's geometry, in the terms a hand of cards actually has: one pivot
 * below the hand, every tile's centre on the same circle around it, and every
 * tile turned by its own angle on that circle. Stepping tiles sideways and
 * tilting them by eye — which is what a row of rotated squares is — leaves
 * four cards belonging to four different circles.
 *
 * The radius is held in tile widths so the arc is the same shape at 22px and
 * at 64px. Near enough that the hand curves visibly; far enough that the marks
 * stay upright and legible.
 */
const FAN_ANGLE = 14;
const FAN_RADIUS = 3.4;

/** How far a tile whose agent holds the skill stands out of the hand. */
const FAN_LIFT = 0.12;

/**
 * Every agent this window can write to, and the smallest hand the fan draws:
 * a machine with one agent on it still gets a fan rather than a lone chip.
 */
const AGENT_IDS: HarnessId[] = ['claude', 'codex', 'cursor', 'gemini'];
const FAN_MINIMUM = 3;

/**
 * The rail's tile, and how much of its hand the rail shows: the rest runs off
 * the bottom of the sidebar, so the cards rise out of the window's own edge
 * rather than sitting in a band of their own.
 */
const RAIL_TILE = 56;
const RAIL_CROP = 0.74;

const RADIANS = Math.PI / 180;

/**
 * Where each tile sits, and how big a box the whole hand needs.
 *
 * The box carries margins on both axes, because a turned square reaches past
 * its own side and a lit tile stands above its place on the arc: without them
 * the rail's crop takes the corners off the cards instead of their feet.
 */
function fanGeometry(count: number, size: number) {
  const middle = (count - 1) / 2;
  const radius = size * FAN_RADIUS;
  const edge = middle * FAN_ANGLE * RADIANS;
  const spread = radius * Math.sin(edge);
  /** How far a square turned by `edge` throws its corner past its own side. */
  const corner = (size * (Math.sin(edge) + Math.cos(edge) - 1)) / 2;
  const top = corner + size * FAN_LIFT;

  return {
    middle,
    radius,
    /** The left and top of the first tile's place, margins included. */
    originX: corner + spread,
    originY: top,
    width: spread * 2 + size + corner * 2,
    height: top + size + radius * (1 - Math.cos(edge)) + corner,
  };
}

/**
 * One agent on the shared hero chip: its own mark, at its own brand colour
 * where this machine holds the skill and in the surface's ink where it does
 * not, so a glance at the fan reads as marks that are lit and marks that are
 * not.
 */
function AgentTile({
  id,
  size,
  lit,
  tilt = 0,
  className,
}: {
  id: HarnessId;
  size: number;
  lit: boolean;
  /** The chip's own turn, which the mark cancels so it stays level. */
  tilt?: number;
  className?: string;
}): ReactElement {
  const Mark = AGENT_MARKS[id];
  const glyph = size * 0.54 * AGENT_MARK_SCALE[id];

  return (
    <Tile size={size} tint={lit ? BRAND[id] : null} tilt={tilt} className={className}>
      <Mark size={glyph} />
    </Tile>
  );
}

/**
 * The four agents, dealt out of a stack.
 *
 * It is the one picture this feature has, and it is drawn from the state
 * rather than beside it: a tile stands proud and in its own colour where the
 * skill is installed, and sits flat and pale where it is not. The lift is
 * never the only telling — every row below spells the same fact out — but it
 * is what makes the sidebar corner worth a glance.
 */
function AgentFan({
  agents,
  size,
  deal,
}: {
  agents: { id: HarnessId; lit: boolean }[];
  size: number;
  /** Whether the tiles arrive from a stack. Only the hero does; the rail is furniture. */
  deal: boolean;
}): ReactElement {
  const reduced = useReducedMotion() === true;
  const { middle, radius, originX, originY, width, height } = fanGeometry(agents.length, size);

  return (
    <span aria-hidden="true" className="relative block shrink-0" style={{ width, height }}>
      {agents.map((agent, index) => {
        const offset = index - middle;
        const angle = offset * FAN_ANGLE * RADIANS;

        return (
          <motion.span
            key={agent.id}
            className="absolute top-0 left-0 block"
            initial={
              reduced || !deal
                ? false
                : { x: originX, y: originY + size * 0.16, rotate: 0, scale: 0.92, opacity: 0 }
            }
            animate={{
              // One circle, one pivot: the tile rides the arc and turns with it.
              x: originX + radius * Math.sin(angle),
              y: originY + radius * (1 - Math.cos(angle)) - (agent.lit ? size * FAN_LIFT : 0),
              rotate: offset * FAN_ANGLE,
              scale: 1,
              opacity: agent.lit ? 1 : 0.68,
            }}
            transition={reduced ? INSTANT : { ...FAN_SPRING, delay: deal ? index * 0.045 : 0 }}
            style={{
              // The middle of the fan sits on top, as a dealt hand does.
              zIndex: agents.length - Math.round(Math.abs(offset)),
            }}>
            <AgentTile
              id={agent.id}
              size={size}
              lit={agent.lit}
              tilt={offset * FAN_ANGLE}
            />
          </motion.span>
        );
      })}
    </span>
  );
}

/**
 * The agents this machine actually has: the ones that have run here or whose
 * CLI is on `PATH`, plus any that already hold a skill. An agent nobody has
 * installed is not an offer worth making — a row for it is a button that
 * writes a directory into a home nothing will ever read.
 */
function present(list: Harness[]): Harness[] {
  return list.filter((harness) => harness.detected || harness.installed);
}

/**
 * The tiles the fan draws: every agent this machine has, lit where it holds
 * the skill, filled out with the others — unlit — until the hand holds at
 * least three. A fan is a hand of cards; one or two chips is a pair of icons
 * in a corner, and the rail's picture would change shape with the machine.
 */
function fanTiles(list: Harness[]): { id: HarnessId; lit: boolean }[] {
  const here = present(list);
  const tiles = here.map((harness) => ({ id: harness.id, lit: harness.installed }));

  for (const id of AGENT_IDS) {
    if (tiles.length >= FAN_MINIMUM) break;
    if (!tiles.some((tile) => tile.id === id)) tiles.push({ id, lit: false });
  }

  // Back into the table's order, so a machine with Cursor alone still reads
  // left to right the way every other machine does.
  return AGENT_IDS.flatMap((id) => tiles.filter((tile) => tile.id === id));
}

/**
 * The agent skill, at the foot of the sidebar, under the connections and over
 * the account.
 *
 * Marks alone, with no label and no count. The fan is the state — a tile
 * stands lit and proud for an agent that holds the skill — and a corner of a
 * vibrancy rail is the one place in this window where a picture outreads a
 * line of type. The words live in the dialog it opens, and in the control's
 * own accessible name.
 */
export function SkillInstaller(): ReactElement {
  const harnesses = useQuery(harnessesQuery());
  const latest = useQuery(latestSkillQuery());
  const [open, setOpen] = useState(false);

  const list = harnesses.data ?? [];
  const version = latest.data?.version ?? null;

  /*
   * An install that has fallen behind is the one thing the fan cannot draw, so
   * the control's own name carries it. It reaches a screen reader and the
   * pointer's tooltip without putting a badge on a rail that is deliberately
   * wordless.
   */
  const label = list.some((harness) => outdated(harness, version))
    ? `Agent skill — update to ${version}`
    : 'Agent skill';

  /*
   * The rail's own hand: sized to the sidebar rather than to an icon slot, and
   * cropped by the rail's foot so the cards rise out of the bottom edge
   * instead of floating in a band of their own. It holds one card per agent
   * this machine has — a full unlit hand only while the scan has not answered,
   * because an empty box here is a tall focusable nothing.
   */
  const tiles = fanTiles(list);

  return (
    /* No rule of its own above it. The hand is cropped by the hairline of
       whatever section follows — connections, or the account — and a second
       line a few pixels over the cards would fence in the one thing here that
       is meant to run off an edge. */
    <div className="shrink-0">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        className={cx(
          'group relative flex w-full items-end justify-center px-3 pt-8',
          'focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset focus-visible:outline-none',
        )}>
        {/* Every other target in this rail is a small rounded strip, so a flat
            wash sits on it as a row. This one is a hundred pixels of mostly
            empty rail: the same wash reads as a lit panel with a hard edge
            across the sidebar. The light gathers at the foot instead, under
            the cards, and is gone before it reaches the section above. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-t from-foreground/[0.07] to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100"
        />

        <span
          className="relative block overflow-hidden"
          style={{ height: Math.round(fanGeometry(tiles.length, RAIL_TILE).height * RAIL_CROP) }}>
          {/* The hand rises further out of the edge under the pointer, which is
              the only thing a control with no label has to say that it is one. */}
          <span className="block transition-transform duration-200 ease-out group-hover:-translate-y-1">
            <AgentFan size={RAIL_TILE} deal={false} agents={tiles} />
          </span>
        </span>
      </button>

      {open && <SkillDialog onClose={() => setOpen(false)} />}
    </div>
  );
}

/**
 * What the skill is, where it would go, and one control per agent.
 *
 * A modal, which this window otherwise spends only on a tunnel: it writes into
 * directories outside the app, and the protected focus is the point — but it
 * is also the only shape that fits four paths, four states and four actions
 * without a second screen the window does not have.
 */
function SkillDialog({ onClose }: { onClose: () => void }): ReactElement {
  const frame = useRef<HTMLDialogElement | null>(null);
  /** Whatever had focus when this opened; written once, as in the tunnel dialog. */
  const opener = useRef<HTMLElement | null>(null);
  const reduced = useReducedMotion() === true;
  const titleId = useId();

  const harnesses = useQuery(harnessesQuery());
  const latest = useQuery(latestSkillQuery());

  /** The ids being written right now, so each row shows its own progress. */
  const [busy, setBusy] = useState<HarnessId[]>([]);
  /**
   * The same fact as `busy.length > 0`, held where a callback can read it
   * without waiting for a render. An install is a download: without this, the
   * second click during the first one starts a write whose own `scan` lands
   * whenever it lands, and the rows settle on whichever answer was last rather
   * than on what is on disk.
   */
  const writing = useRef(false);
  /** Per agent, because one denied directory is not the other three's failure. */
  const [errors, setErrors] = useState<Partial<Record<HarnessId, string>>>({});

  const note = useCallback((id: HarnessId, message: string | undefined) => {
    setErrors((current) => ({ ...current, [id]: message }));
  }, []);

  useEffect(() => {
    if (opener.current === null && document.activeElement instanceof HTMLElement) {
      opener.current = document.activeElement;
    }

    const node = frame.current;
    if (node === null || node.open) return;

    node.showModal();

    // Closed by hand while the element is still connected, and focus placed
    // back by hand: React removing a modal `<dialog>` never runs the close
    // algorithm, so the UA would leave focus on `<body>`.
    return () => {
      node.close();
      const previous = opener.current;
      if (previous !== null && previous.isConnected) previous.focus();
    };
  }, []);

  const list = harnesses.data ?? [];
  const version = latest.data?.version ?? null;

  const write = useCallback(async (ids: HarnessId[]) => {
    if (ids.length === 0 || writing.current) return;

    writing.current = true;
    setBusy(ids);
    setErrors((current) => {
      const next = { ...current };
      for (const id of ids) delete next[id];
      return next;
    });

    try {
      const report = await installSkill(ids);
      // Rust answers with the whole state it just wrote, so the list is
      // replaced rather than invalidated and re-read.
      queryClient.setQueryData(harnessesQuery().queryKey, report.harnesses);
      setErrors((current) => {
        const next = { ...current };
        for (const result of report.results) {
          if (result.error !== null) next[result.id] = result.error;
        }
        return next;
      });
    } catch (cause) {
      // The download failed, so nothing was written and every target failed
      // for the same reason.
      const message = errorMessage(cause, 'Could not download the skill.');
      setErrors((current) => {
        const next = { ...current };
        for (const id of ids) next[id] = message;
        return next;
      });
    } finally {
      writing.current = false;
      setBusy([]);
    }
  }, []);

  const erase = useCallback(async (harness: Harness) => {
    if (writing.current) return;

    writing.current = true;
    setBusy([harness.id]);
    note(harness.id, undefined);

    try {
      queryClient.setQueryData(harnessesQuery().queryKey, await removeSkill(harness.id));
    } catch (cause) {
      note(harness.id, errorMessage(cause, `Could not remove the skill from ${harness.name}.`));
    } finally {
      writing.current = false;
      setBusy([]);
    }
  }, [note]);

  /*
   * Revealing can fail — there is nothing to open for an agent that has no
   * skills directory yet, and a Linux desktop may have no file manager to ask.
   * It reports into the same row slot the writes use rather than doing nothing
   * visible, which is what a silent catch would leave.
   */
  const reveal = useCallback(
    async (harness: Harness) => {
      try {
        await revealSkill(harness.id);
        note(harness.id, undefined);
      } catch (cause) {
        note(harness.id, errorMessage(cause, `Could not open ${harness.displayPath}.`));
      }
    },
    [note],
  );

  /*
   * Only the agents this machine has get a row, and therefore a button: an
   * Install control for an agent nobody installed writes a directory into a
   * home that nothing will ever read.
   */
  const here = present(list);
  const stale = here.filter((harness) => outdated(harness, version));
  const missing = here.filter((harness) => !harness.installed);

  /*
   * One primary action, and only where it saves work: a single target already
   * has its own button in its own row, and a footer restating it is a second
   * control for the same click. Updates outrank agents that never asked — but
   * one stale install does not cancel a batch of three missing ones.
   */
  const batch =
    stale.length > 1
      ? { title: `Update all ${stale.length}`, ids: stale }
      : missing.length > 1
        ? { title: `Install in ${missing.length} agents`, ids: missing }
        : null;

  return (
    <dialog
      ref={frame}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === frame.current) onClose();
      }}
      /* The element is the scrim: `::backdrop` does not reliably inherit the
         theme's properties in WKWebView, and the wash is a fixed black because
         a foreground-tinted one lightens a dark app instead of dimming it. */
      className="hidden fixed inset-0 m-0 size-full max-h-none max-w-none items-center justify-center bg-black/40 p-0 text-foreground backdrop-blur-[2px] backdrop:bg-transparent open:flex">
      <motion.div
        initial={reduced ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 320, damping: 34 }}
        className="flex max-h-[calc(100vh-4rem)] w-[34rem] max-w-[calc(100vw-3rem)] flex-col rounded-xl border border-border bg-popover shadow-dialog">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-ui-title font-semibold">
            Agent skill
          </h2>

          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Close"
            onClick={onClose}
            className="-mr-1 shrink-0 text-faint">
            <X />
          </Button>
        </div>

        {/* The fan crowns the band rather than sitting beside the text: at the
            size it has to be to read as four cards, a column beside it is a
            17-character measure. */}
        <div className="flex flex-col items-center px-6 pt-5 pb-4 text-center">
          <AgentFan size={64} deal agents={fanTiles(list)} />

          <p className="mt-4 text-ui-section font-semibold">
            Teach your coding agent to ship to Brainpod.
          </p>
          <p className="mt-1.5 max-w-[34rem] text-ui text-muted-foreground">
            The <code className="font-mono text-ui-mono">brainpod</code> skill carries the CLI
            workflows for deploying a project, changing what a pod runs, and working out why one
            is unhealthy. It is written into the agent&rsquo;s own skills directory.
          </p>

          <p className="mt-2.5 flex items-center gap-1.5 text-ui-sm text-faint">
            <button
              type="button"
              onClick={() => void openExternal('https://github.com/brainpodnl/skills')}
              className="inline-flex items-center gap-0.5 rounded-sm underline decoration-border underline-offset-2 transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
              brainpodnl/skills
              <ArrowUpRight className="size-3" />
            </button>
            {version !== null && <span>·</span>}
            {version !== null && <span className="font-mono text-ui-mono">{version}</span>}
          </p>
        </div>

        <ul role="list" className="min-h-0 flex-1 overflow-y-auto border-t border-border">
          {harnesses.isError && (
            <li className="flex items-start gap-1.5 px-4 py-3 text-ui text-destructive">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              {errorMessage(harnesses.error, 'Could not read your agents’ skills directories.')}
            </li>
          )}

          {!harnesses.isPending && !harnesses.isError && here.length === 0 && (
            <li className="px-4 py-3">
              <p className="text-ui font-medium">No coding agent found on this machine.</p>
              <p className="mt-1 text-ui-sm text-muted-foreground">
                Claude Code, Codex, Cursor and Gemini CLI each read skills from their own
                directory in your home folder. Install one, reopen this window, and it appears
                here — or add the skill by hand from the repository above.
              </p>
            </li>
          )}

          {here.map((harness) => (
            <HarnessRow
              key={harness.id}
              harness={harness}
              latest={version}
              busy={busy.includes(harness.id)}
              /* Every write control waits for the one in flight: two installs
                 racing each other both end in a scan, and the rows would
                 settle on whichever answered last rather than on the disk. */
              blocked={busy.length > 0 && !busy.includes(harness.id)}
              error={errors[harness.id] ?? null}
              onInstall={() => void write([harness.id])}
              onRemove={() => void erase(harness)}
              onReveal={() => void reveal(harness)}
            />
          ))}
        </ul>

        <div className="flex items-center gap-3 border-t border-border px-4 py-3">
          <p className="min-w-0 flex-1 text-ui-sm text-faint">
            An agent reads its skills at startup, so restart one that is already running.
          </p>

          {batch !== null && (
            <Button
              title={batch.title}
              size="sm"
              loading={busy.length > 1}
              disabled={busy.length > 0}
              onClick={() => void write(batch.ids.map((harness) => harness.id))}
            />
          )}
        </div>
      </motion.div>
    </dialog>
  );
}

function HarnessRow({
  harness,
  latest,
  busy,
  blocked,
  error,
  onInstall,
  onRemove,
  onReveal,
}: {
  harness: Harness;
  latest: string | null;
  busy: boolean;
  /** Another agent is being written; this row's controls wait for it. */
  blocked: boolean;
  error: string | null;
  onInstall: () => void;
  onRemove: () => void;
  onReveal: () => void;
}): ReactElement {
  const stale = outdated(harness, latest);
  const problemId = useId();
  /*
   * What is on disk, in words. Every row is an agent this machine has, so the
   * only states left are what the directory holds: nothing, someone else's
   * copy, or ours with a version. A directory that exists without this
   * window's receipt was put there by something else — the skills CLI, a
   * Cursor plugin, a symlink into a clone — and saying so is what makes
   * `Replace` an honest label and removal something this window refuses.
   */
  const state: ReactNode = !harness.installed ? null : !harness.managed ? (
    <span className="text-ui-sm text-faint">Installed elsewhere</span>
  ) : (
    <span
      className={cx('flex items-center gap-1 text-ui-sm', stale ? 'text-warn-strong' : 'text-ok')}
      title={
        harness.installedAt === null
          ? undefined
          : `Installed ${new Date(harness.installedAt).toLocaleString()}`
      }>
      {!stale && <Check className="size-3" />}
      <span className="font-mono text-ui-mono">{harness.version}</span>
    </span>
  );

  const action = stale
    ? 'Update'
    : harness.installed
      ? harness.managed
        ? 'Remove'
        : 'Replace'
      : 'Install';

  /*
   * `Replace` asks nothing, because it destroys nothing: a skill directory
   * this window did not write is moved aside under a dated name rather than
   * deleted, so the click is undoable in the file manager the path above
   * opens.
   */
  const act = () => {
    if (action === 'Remove') onRemove();
    else onInstall();
  };

  return (
    <li className="border-b border-border/60 px-4 py-2.5 last:border-b-0">
      <div className="flex items-center gap-3">
        <AgentTile id={harness.id} size={22} lit={harness.installed} className="shrink-0" />

        <div className="min-w-0 flex-1">
          <p className="truncate text-ui font-medium">{harness.name}</p>

          {/* The path is the control: clicking it opens the directory in the
              OS's own file manager, which is the only question the row leaves
              open once it has named where the skill goes. */}
          <button
            type="button"
            title="Show in the file manager"
            onClick={onReveal}
            className="block max-w-full truncate rounded-sm text-left font-mono text-ui-mono text-faint transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
            {harness.displayPath}
          </button>
        </div>

        {state}

        <Button
          title={action}
          variant={action === 'Remove' ? 'ghost' : 'outline'}
          size="sm"
          loading={busy}
          disabled={blocked}
          className="shrink-0"
          aria-label={`${action} the Brainpod skill ${action === 'Remove' ? 'from' : 'in'} ${harness.name}`}
          aria-describedby={error === null ? undefined : problemId}
          onClick={act}
        />
      </div>

      {harness.note !== null && (
        <p className="mt-1 pl-[34px] text-ui-sm text-faint">{harness.note}</p>
      )}

      {/* The skill is here and its agent is not: the row exists because of
          what is on disk, so it says why it is listed at all. */}
      {!harness.detected && (
        <p className="mt-1 pl-[34px] text-ui-sm text-faint">
          {harness.name} is not on this machine; only its skill is.
        </p>
      )}

      {error !== null && (
        /* A write that failed has to reach the screen reader standing on the
           button that started it, not only the eye. */
        <p
          id={problemId}
          role="alert"
          className="mt-1 flex items-start gap-1.5 pl-[34px] text-ui-sm text-destructive">
          <TriangleAlert className="mt-px size-3 shrink-0" />
          {error}
        </p>
      )}
    </li>
  );
}
