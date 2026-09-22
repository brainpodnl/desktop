import { ExternalLink, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useCallback, useRef, type PointerEvent, type ReactElement } from 'react';

import { Button } from '@/components/button';
import { routeUrl } from '@/components/graph/layout';
import { KindTile } from '@/components/graph/kind-tile';
import { KIND_STYLE } from '@/components/graph/kinds';
import { Activity } from '@/components/inspector/activity';
import { Configuration } from '@/components/inspector/configuration';
import { Fact, Section, ScrollingValue } from '@/components/inspector/parts';
import { readiness, TONE_FILL, TONE_TEXT } from '@/components/graph/readiness';
import { Scaling } from '@/components/inspector/scaling';
import { Variables } from '@/components/inspector/variables';
import type { Resource } from '@/lib/bridge';
import { cx } from '@/lib/cx';
import { useReducedMotion } from '@/lib/motion';
import {
  clampInspectorWidth,
  MAX_INSPECTOR_WIDTH,
  MIN_INSPECTOR_WIDTH,
} from '@/lib/inspector-width';

/**
 * Everything the API knows about one resource, beside the graph rather than on
 * top of it.
 *
 * A modal was the obvious answer and the wrong one: the reason a person clicks
 * a node is to understand how it sits in the pod, and a dialog covers the
 * evidence. So the panel takes its own column, the node stays selected and on
 * screen, and the two read as one object — the node, opened.
 *
 * The bands run in the order the questions arrive: what state is it in, how is
 * it configured, what can other resources reference about it, and what has it
 * been doing. How it is *wired* is not among them: the canvas states that on
 * the connectors themselves, where the line and its reason are one object.
 * Nothing is behind a tab.
 */

/** What the keyboard's grab on the divider is worth per press. */
const RESIZE_STEP = 16;

/** The gesture in flight. A ref, because a drag must not re-render to track. */
type Drag = { pointerId: number; startX: number; startWidth: number };

export function ResourceInspector({
  pod,
  resource,
  width,
  overlay,
  busy,
  onWidth,
  onWidthCommit,
  onClose,
  onOpenTunnel,
  onOpenRoute,
  onFollow,
  atHead,
  onGoToHead,
  onSaved,
}: {
  pod: string;
  resource: Resource;
  width: number;
  /** True where the pane is too narrow to give the rail a column of its own. */
  overlay: boolean;
  /** Whether a tunnel to this resource is already being opened. */
  busy: boolean;
  onWidth: (width: number) => void;
  /** The gesture ended; this width is worth writing down. */
  onWidthCommit: (width: number) => void;
  onClose: () => void;
  onOpenTunnel: (resource: Resource) => void;
  onOpenRoute: (resource: Resource) => void;
  /** Any other address this panel offers; the pane owns how it is opened. */
  onFollow: (url: string) => void;
  /**
   * Whether the graph is being read at the pod's newest revision. A write
   * always lands on the head, so offering one while looking at an older
   * revision would take that revision's number and put it on a draft it does
   * not describe — a single-field rollback, in a product with no rollback.
   */
  atHead: boolean;
  /** Read the graph at the pod's newest revision, where a write is legal. */
  onGoToHead: () => void;
  onSaved: (revision: string) => void;
}): ReactElement {
  const reduced = useReducedMotion() === true;
  const kind = KIND_STYLE[resource.kind];
  const state = readiness(resource);
  const url = routeUrl(resource);

  /*
   * Which replicas the status block has anything left to say about. Derived
   * here rather than inline, because the list's own emptiness is what decides
   * whether it renders at all.
   */
  const unsettled = resource.replicaStates.filter((replica) => replica.phase !== 'Ready');
  const drag = useRef<Drag | null>(null);

  const startResize = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!event.isPrimary || event.button !== 0) return;

      drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [width],
  );

  /*
   * The width the last pointermove produced. The state setter above is what
   * paints, but a `pointerup` can land in the same frame as the move before
   * it — before React has committed a render whose handler closes over the
   * new number — so the gesture keeps its own copy to write down.
   */
  const latest = useRef(width);

  const trackResize = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const active = drag.current;
      if (active === null || active.pointerId !== event.pointerId) return;

      // The rail is anchored to the right edge, so dragging left widens it.
      const next = clampInspectorWidth(active.startWidth - (event.clientX - active.startX));
      latest.current = next;
      onWidth(next);
    },
    [onWidth],
  );

  const endResize = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const active = drag.current;
      if (active === null || active.pointerId !== event.pointerId) return;

      drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      // One write at the end of the gesture rather than one per pointermove.
      onWidthCommit(latest.current);
    },
    [onWidthCommit],
  );

  return (
    <aside
      aria-label={`${resource.name} details`}
      style={{ width }}
      className={cx(
        'flex shrink-0 flex-col border-l border-border bg-background',
        /*
         * Exclusive, never layered: this project has no `tailwind-merge`, so
         * two utilities from the same family are settled by Tailwind's own
         * emission order rather than by the order written here — and `relative`
         * is emitted after `absolute`, which silently left the overlay in flow
         * and squeezed the canvas it was supposed to float over.
         *
         * Over the canvas it also needs an edge the canvas cannot supply, and
         * a shadow is the one this window already uses for a floating surface.
         */
        overlay ? 'absolute inset-y-0 right-0 z-20 shadow-dialog' : 'relative',
      )}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the details panel"
        /* A focusable separator is a window splitter, and a splitter that does
           not say where it sits announces arrow keys that appear to do
           nothing — including at either bound. */
        aria-valuenow={width}
        aria-valuemin={MIN_INSPECTOR_WIDTH}
        aria-valuemax={MAX_INSPECTOR_WIDTH}
        tabIndex={0}
        onPointerDown={startResize}
        onPointerMove={trackResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

          event.preventDefault();
          const next = clampInspectorWidth(
            width + (event.key === 'ArrowLeft' ? RESIZE_STEP : -RESIZE_STEP),
          );
          latest.current = next;
          onWidth(next);
          onWidthCommit(next);
        }}
        /* Wider than the hairline it sits on, because a 1px target is a target
           nobody hits; it paints nothing until the pointer is on it. */
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize focus-visible:bg-ring/60 focus-visible:outline-none"
      />

      <header className="flex shrink-0 items-start gap-2.5 border-b border-border px-4 py-3.5">
        <KindTile kind={resource.kind} />

        <span className="min-w-0 flex-1">
          <h2 className="truncate text-ui-title font-semibold" title={resource.name}>
            {resource.name}
          </h2>
          {/* The kind in its own colour, the same way the node states it, so
              the panel reads as the card opened rather than as a second view
              of it. */}
          <p className="truncate text-ui-sm font-medium" style={{ color: kind.accent }}>
            {kind.label}
          </p>
        </span>

        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Close the details panel"
          onClick={onClose}
          className="-mr-1.5 shrink-0 text-faint">
          <X />
        </Button>
      </header>

      {/* Keyed by URN, not by name: a name is unique only within a kind, so an
          App and a Config may both be `api`, and keying by name would keep one
          mounted as the other — carrying an unsaved replica count across. The
          remount is also the entrance, which is the panel saying it followed
          the selection rather than sitting still while its contents silently
          changed underneath. */}
      <motion.div
        key={resource.urn}
        initial={reduced ? false : { opacity: 0, x: 6 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ type: 'spring', stiffness: 320, damping: 34 }}
        /*
         * The gutter is reserved rather than claimed when needed. This window
         * gives scrollbars a real 10px of width (`global.css` styles
         * `::-webkit-scrollbar`), so a column that only sometimes overflows
         * takes 10px away from its own content the moment it does — and this
         * column crosses that line twice while opening, once when the events
         * skeleton is replaced by rows and again if the resource has none.
         * Every fact row reflowed for a frame. `stable` pays the 10px once and
         * never moves.
         */
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
        <Section title="Status">
          <div className="flex items-center gap-2.5">
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span
                role="img"
                aria-label={`${resource.name} is ${state.label.toLowerCase()}`}
                className={cx('size-2 shrink-0 rounded-full', TONE_FILL[state.tone])}
              />
              <span className={cx('truncate text-ui-section font-medium', TONE_TEXT[state.tone])}>
                {state.label}
              </span>
              {state.detail !== null && (
                <span className="truncate text-ui text-muted-foreground">{state.detail}</span>
              )}
            </span>

            {/* One action, and the kind decides which: a route is a thing to
                visit, a database a thing to connect to. Nothing else has one. */}
            {resource.engine !== null ? (
              <Button
                variant="secondary"
                size="sm"
                title="Open tunnel"
                aria-label={`Open a tunnel to ${resource.name}`}
                loading={busy}
                onClick={() => onOpenTunnel(resource)}
                className="shrink-0"
              />
            ) : url !== null ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<ExternalLink />}
                title={url}
                aria-label={`Open ${url} in your browser`}
                onClick={() => onOpenRoute(resource)}
                className="shrink-0">
                Open
              </Button>
            ) : null}
          </div>

          {/* The exceptions only. A Ready replica restates the headline above
              it — same word, and the count is already in `state.detail` — so
              a row per replica turns a healthy workload into a wall of ids
              saying "Ready" twice. What is left is the replica that has not
              settled, which is also the one the API attaches a reason to. */}
          {unsettled.length > 0 && (
            <ul className="mt-1.5 flex flex-col gap-1">
              {unsettled.map((replica) => {
                const tone = replica.phase === 'Degraded' ? 'bad' : 'progress';

                return (
                  <li key={replica.name} className="flex items-baseline gap-2">
                    <span
                      aria-hidden="true"
                      className={cx(
                        'size-1.5 shrink-0 translate-y-[-1px] rounded-full',
                        TONE_FILL[tone],
                      )}
                    />
                    <span
                      data-selectable
                      title={replica.name}
                      className="min-w-0 max-w-[45%] truncate font-mono text-ui-mono text-muted-foreground">
                      {replica.name}
                    </span>
                    <span className={cx('shrink-0 text-ui-sm', TONE_TEXT[tone])}>
                      {replica.phase}
                    </span>
                    {replica.reason !== null && (
                      <span className="min-w-0 flex-1 truncate text-ui-sm text-faint" title={replica.reason}>
                        {replica.reason}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Scaling
          pod={pod}
          resource={resource}
          atHead={atHead}
          onGoToHead={onGoToHead}
          onSaved={onSaved}
        />

        <Configuration resource={resource} />

        <Variables resource={resource} />

        <Activity pod={pod} resource={resource} onFollow={onFollow} />

        <Section title="Identity">
          <Fact label="URN" align="start">
            <ScrollingValue value={resource.urn} copy label="URN" />
          </Fact>
          {/* Absent on a document this window could not read a version out of,
              and a labelled empty row states less than no row. */}
          {resource.apiVersion.length > 0 && (
            <Fact label="API version">
              <ScrollingValue value={resource.apiVersion} />
            </Fact>
          )}
        </Section>
      </motion.div>
    </aside>
  );
}
