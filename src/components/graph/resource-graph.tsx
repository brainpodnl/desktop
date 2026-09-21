import { Undo2 } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
} from 'react';

import { Button } from '@/components/button';
import {
  CANVAS_PADDING,
  layoutGraph,
  orthogonalPath,
  routeDirect,
  type GraphNode,
} from '@/components/graph/layout';
import { NodeCard } from '@/components/graph/node-card';
import {
  clearPositions,
  readPositions,
  writePositions,
  type NodePosition,
  type NodePositions,
} from '@/components/graph/positions';
import type { Resource } from '@/lib/bridge';
import { cx } from '@/lib/cx';

/** The console's canvas: one flat colour on a regular lattice, low contrast. */
const GRID = 20;
const CANVAS: CSSProperties = {
  backgroundImage: 'radial-gradient(circle at center, var(--color-dots) 1px, transparent 1px)',
  backgroundSize: `${GRID}px ${GRID}px`,
};

/*
 * Two graphs are never mounted at once — the window shows one pod — so the
 * marker needs a stable id rather than a generated one, and a stable id is
 * what keeps it out of React's escaping rules for `url(#…)`.
 */
const ARROW = 'resource-graph-arrow';

/*
 * Cards arrive in reading order, but a pod with thirty resources must not
 * become a load sequence: the stagger stops after a handful of cards and the
 * rest come in together. Operate surfaces load into a task.
 */
const STAGGER = 0.04;
const STAGGER_STEPS = 6;

/**
 * An edge waits for both of the cards it joins. A connector drawn to a card
 * that has not arrived is a line to nowhere, which is what made the opening
 * read as two unrelated animations rather than one.
 */
const EDGE_LAG = 0.09;
const EDGE_FADE = 0.22;

/**
 * How far the pointer travels before a press becomes a drag. Below it the
 * press is a click and still selects the node; above it the click that would
 * follow is swallowed, so a drag never also toggles the selection.
 */
const DRAG_THRESHOLD = 4;

/**
 * How far past the graph the canvas can be pushed, as a fraction of the pane.
 * A graph pinned to the exact bounds of its own cards cannot be brought to the
 * middle of the window to work on, and the corner nodes always sit in a corner.
 */
const OVERSCROLL = 0.9;

/** The keyboard's equivalent of a drag, in the units a card is laid out on. */
const NUDGE = 8;
const NUDGE_COARSE = 16;

/**
 * What one line of wheel delta is worth. Devices that report in notches send
 * `DOM_DELTA_LINE`, and the line is the page's own unit to define.
 */
const WHEEL_LINE = 16;

/** Which way each arrow key sends a focused card, as a unit vector. */
const NUDGES: Record<string, { x: number; y: number }> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/**
 * The positions of one pod's nodes, and whether they are worth writing down.
 * `persist` is false for the position a `pointermove` produced — a write per
 * move is IO nobody asked for — and true once the gesture has ended.
 */
type Arrangement = { pod: string; positions: NodePositions; persist: boolean };

/** The gesture in flight. A ref, because a drag must not re-render to track. */
type Grab = {
  name: string;
  pointerId: number;
  /** Pointer to the card's top-left, so the card tracks from where it was held. */
  grabX: number;
  grabY: number;
  startX: number;
  startY: number;
  moved: boolean;
};

/** A drag of the canvas itself, which scrolls rather than moving anything. */
type Pan = {
  pointerId: number;
  startX: number;
  startY: number;
  /** Where the scroller was when the press landed; the pan is relative to it. */
  scrollX: number;
  scrollY: number;
  moved: boolean;
};

/** How much room to leave around the graph, in pixels, for a pane this size. */
type Overscroll = { x: number; y: number };

export function ResourceGraph({
  pod,
  resources,
  selected,
  onSelect,
  busy,
  onOpenTunnel,
  onOpenRoute,
  occluded,
}: {
  pod: string;
  resources: Resource[];
  selected: string | null;
  onSelect: (name: string | null) => void;
  busy: Record<string, boolean>;
  onOpenTunnel: (resource: Resource) => void;
  onOpenRoute: (resource: Resource) => void;
  /**
   * How many pixels of this canvas's right edge something else is covering.
   * The details rail takes a column of its own when the pane can afford one
   * and lies over the canvas when it cannot — and in that second case the
   * scroller still measures its full width, so a node hidden behind the rail
   * reads as perfectly in view.
   */
  occluded: number;
}): ReactElement {
  const reduced = useReducedMotion() === true;
  const layout = useMemo(() => layoutGraph(resources), [resources]);

  const [arrangement, setArrangement] = useState<Arrangement>(() => ({
    pod,
    positions: readPositions(pod),
    persist: false,
  }));
  /*
   * Another pod is another arrangement. Reading it here rather than in an
   * effect is what keeps the previous pod's positions from painting for a
   * frame over the new pod's cards.
   */
  if (arrangement.pod !== pod) {
    setArrangement({ pod, positions: readPositions(pod), persist: false });
  }

  useEffect(() => {
    if (!arrangement.persist) return;
    writePositions(arrangement.pod, arrangement.positions);
  }, [arrangement]);

  const viewRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const grab = useRef<Grab | null>(null);
  const pan = useRef<Pan | null>(null);
  /** A drag ends in a `click`; this is what stops that click from selecting. */
  const swallowClick = useRef(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const [over, setOver] = useState<Overscroll>({ x: 0, y: 0 });

  /*
   * The lattice belongs to the graph, not to the window. `local` attachment
   * ties the background to the scrollable area instead of the border box, so
   * the dots travel with the cards — the graph reads as something built on a
   * grid rather than a photograph of one hanging behind the pane.
   *
   * The offset re-phases that grid onto the canvas's own origin, which the
   * overscroll padding pushes an arbitrary number of pixels into the
   * scrollable area. Without it a resize changes the padding, and the cards
   * would slide across the lattice they were laid out on.
   */
  const canvas = useMemo<CSSProperties>(
    () => ({
      ...CANVAS,
      backgroundAttachment: 'local',
      backgroundPosition: `${over.x % GRID}px ${over.y % GRID}px`,
    }),
    [over],
  );

  const { positions } = arrangement;

  /*
   * The computed layout is the default; a node the user moved overrides its
   * own coordinates and nothing else. Edges read the same nodes, so they
   * re-route as the card travels.
   */
  const nodes = useMemo(
    () =>
      layout.nodes.map((node) => {
        const moved = positions[node.resource.name];
        return moved === undefined ? node : { ...node, x: moved.x, y: moved.y };
      }),
    [layout, positions],
  );

  const placed = useMemo(
    () => new Map(nodes.map((node) => [node.resource.name, node])),
    [nodes],
  );

  /** When each card arrives, so an edge can wait for the later of its two. */
  const arrival = useMemo(() => {
    const delays = new Map<string, number>();
    nodes.forEach((node, index) => {
      delays.set(node.resource.name, Math.min(index, STAGGER_STEPS) * STAGGER);
    });
    return delays;
  }, [nodes]);

  /*
   * The routed polylines, resolved against where the cards actually are. An
   * edge keeps the lane the layout gave it until the user moves one of its
   * ends — at which point the lane describes a graph that no longer exists,
   * and a plain two-turn connector is the honest answer.
   */
  const routes = useMemo(
    () =>
      layout.edges.flatMap((edge) => {
        const from = placed.get(edge.from);
        const to = placed.get(edge.to);
        if (from === undefined || to === undefined) return [];

        const disturbed =
          positions[edge.from] !== undefined || positions[edge.to] !== undefined;
        const points = disturbed ? routeDirect(from, to) : edge.points;

        return [
          {
            key: `${edge.from}\u0000${edge.to}`,
            d: orthogonalPath(points),
            delay: Math.max(arrival.get(edge.from) ?? 0, arrival.get(edge.to) ?? 0) + EDGE_LAG,
          },
        ];
      }),
    [layout, placed, positions, arrival],
  );

  /*
   * How far the graph reaches once nodes have been moved. It sizes the sheet
   * of edges rather than the canvas box: the box is what the scroll position
   * is measured against, so growing it mid-drag would slide the graph under
   * the pointer. An absolutely positioned sheet extends the scroll container's
   * reach without touching that, and the edges need the room anyway.
   */
  const reach = useMemo(() => {
    let width = layout.width;
    let height = layout.height;
    for (const node of nodes) {
      width = Math.max(width, node.x + node.width + CANVAS_PADDING);
      height = Math.max(height, node.y + node.height + CANVAS_PADDING);
    }
    return { width, height };
  }, [layout, nodes]);

  const [sheet, setSheet] = useState(reach);

  /*
   * What is drawn, which is allowed to trail `reach` in one direction only.
   * Growing is safe: enlarging the content never moves a scroll offset that
   * already exists. Shrinking is not — the browser clamps `scrollLeft` and
   * `scrollTop` to the smaller maximum, and because `trackDrag` re-measures
   * the canvas on every move, that clamp slides the origin out from under the
   * pointer and the held card jumps. Dragging a card back in from the edge is
   * exactly that case, so a shrink waits for the gesture to end.
   */
  useEffect(() => {
    const width = dragging === null ? reach.width : Math.max(sheet.width, reach.width);
    const height = dragging === null ? reach.height : Math.max(sheet.height, reach.height);
    // Both numbers compared before the setter: setting unconditionally would
    // schedule a render that schedules this effect that sets again.
    if (width === sheet.width && height === sheet.height) return;
    setSheet({ width, height });
  }, [reach, sheet, dragging]);

  /*
   * `empty` is a dependency of both canvas effects, not a cosmetic one: the
   * `<section>` these bind to only exists in the non-empty branch, and this
   * component is never remounted across pods. Landing on a pod with no
   * resources first would otherwise leave them bound to nothing for the rest
   * of the session — no overscroll room, no wheel panning, and the framing
   * effect never centring because it waits on a non-zero `over`.
   */
  const empty = resources.length === 0;

  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;

      const box = entry.contentRect;
      setOver({
        x: Math.round(box.width * OVERSCROLL),
        y: Math.round(box.height * OVERSCROLL),
      });
    });
    observer.observe(view);

    return () => observer.disconnect();
  }, [empty]);

  /*
   * Wheel panning is placed by hand rather than left to the scroller, and it
   * has to be a native listener: React registers wheel at the root as a
   * passive listener, so `preventDefault()` from an `onWheel` prop is dropped
   * on the floor and logs an intervention violation instead.
   *
   * The tradeoff. Driving both axes straight from the deltas removes WebKit's
   * directional axis lock — the snap-to-one-axis that makes the first frames
   * of a diagonal flick fight the hand — and keeps macOS momentum, since the
   * OS goes on dispatching wheel events through the momentum phase. What is
   * given up is the rubber-band at the extremes, which this canvas can afford:
   * it already carries 90% of a pane of overscroll padding on every side.
   */
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;

    const onWheel = (event: WheelEvent) => {
      // A ctrl-wheel is the pinch the OS synthesises for zoom. Preventing it
      // would take zoom away from the window, so it passes straight through.
      if (event.ctrlKey) return;

      event.preventDefault();

      const lines = event.deltaMode === WheelEvent.DOM_DELTA_LINE;
      const pages = event.deltaMode === WheelEvent.DOM_DELTA_PAGE;
      const stepX = lines ? WHEEL_LINE : pages ? view.clientWidth : 1;
      const stepY = lines ? WHEEL_LINE : pages ? view.clientHeight : 1;

      // Clamped here rather than left to the browser, so what this writes is
      // what the next event of the same flick reads back.
      const maxX = view.scrollWidth - view.clientWidth;
      const maxY = view.scrollHeight - view.clientHeight;
      view.scrollLeft = Math.max(0, Math.min(view.scrollLeft + event.deltaX * stepX, maxX));
      view.scrollTop = Math.max(0, Math.min(view.scrollTop + event.deltaY * stepY, maxY));
    };

    view.addEventListener('wheel', onWheel, { passive: false });
    return () => view.removeEventListener('wheel', onWheel);
  }, [empty]);

  /*
   * Which pod's graph has been brought into view, and with how much room
   * around it. Centring is a one-off per pod: doing it on every change would
   * undo the user's own scrolling every time the window is resized.
   */
  const framed = useRef<string | null>(null);
  const lastOver = useRef<Overscroll>({ x: 0, y: 0 });

  useLayoutEffect(() => {
    const view = viewRef.current;
    const box = canvasRef.current;
    if (view === null || box === null || over.x === 0) return;

    if (framed.current === pod) {
      // The pane was resized. The padding around the graph changed with it, so
      // the graph would drift sideways unless the scroll follows it.
      view.scrollLeft += over.x - lastOver.current.x;
      view.scrollTop += over.y - lastOver.current.y;
      lastOver.current = over;
      return;
    }

    framed.current = pod;
    lastOver.current = over;
    // Centred while the graph fits, pinned to the top-left once it does not:
    // a tall graph centred vertically opens halfway down, past its roots.
    view.scrollLeft = box.offsetLeft - Math.max(0, (view.clientWidth - box.offsetWidth) / 2);
    view.scrollTop = box.offsetTop - Math.max(0, (view.clientHeight - box.offsetHeight) / 2);
  }, [pod, over]);

  /*
   * Carrying the selected node to the middle of the canvas, which is what
   * makes the details rail feel like part of the graph rather than a second
   * window: choosing a node — on the canvas or in the panel's own wiring
   * lists — brings the graph to it, the way the pod's graph is centred when it
   * first opens.
   *
   * One rule, not two. An earlier pass centred a new selection and merely
   * nudged an off-screen node back in when the pane changed size, and the two
   * disagreed at exactly the moment both run: opening the rail narrows the
   * pane, so the first selection was centred against a width that stopped
   * existing one frame later and the nudge left it sitting off-centre. The
   * node is centred whenever anything about the geometry changes, and only the
   * deliberate choice animates — a smooth scroll restarted on every frame of a
   * rail drag is a canvas that never settles.
   *
   * It reads the node's position from a ref rather than from the dependency
   * list: `placed` changes on every pointermove of a drag, and a scroll
   * animation firing mid-drag would take the card out from under the pointer.
   */
  const placedRef = useRef(placed);
  placedRef.current = placed;
  const revealed = useRef<string | null>(null);

  useEffect(() => {
    if (selected === null) {
      revealed.current = null;
      return;
    }

    // After the commit that mounted the panel, so the viewport measured here
    // is the narrowed one rather than the width from before it opened.
    const frame = requestAnimationFrame(() => {
      const view = viewRef.current;
      const box = canvasRef.current;
      const node = placedRef.current.get(selected);
      if (view === null || box === null || node === undefined) return;

      const chosen = revealed.current !== selected;
      revealed.current = selected;

      /*
       * What is actually visible, which is not what the scroller measures: an
       * overlaid rail covers the right of it without narrowing it. Centring
       * against this rather than against `clientWidth` is what puts the card
       * in the middle of the strip the user can see.
       */
      const visible = view.clientWidth - occluded;
      // Never past the ends of the scrollable area: a node near the edge of
      // the graph would otherwise ask for a scroll the browser silently
      // refuses, and the result would read as the centring not happening.
      const clamp = (value: number, max: number) => Math.max(0, Math.min(value, max));

      const x = clamp(
        box.offsetLeft + node.x + node.width / 2 - visible / 2,
        view.scrollWidth - view.clientWidth,
      );
      const y = clamp(
        box.offsetTop + node.y + node.height / 2 - view.clientHeight / 2,
        view.scrollHeight - view.clientHeight,
      );

      if (Math.round(x) === Math.round(view.scrollLeft) && Math.round(y) === Math.round(view.scrollTop)) {
        return;
      }
      view.scrollTo({ left: x, top: y, behavior: reduced || !chosen ? 'auto' : 'smooth' });
    });

    return () => cancelAnimationFrame(frame);
  }, [selected, over, occluded, reduced]);

  const place = useCallback((name: string, position: NodePosition, persist: boolean) => {
    setArrangement((current) => ({
      pod: current.pod,
      positions: { ...current.positions, [name]: position },
      persist,
    }));
  }, []);

  const startDrag = useCallback((event: PointerEvent<HTMLDivElement>, node: GraphNode) => {
    if (!event.isPrimary || event.button !== 0) return;
    if (!(event.target instanceof Element)) return;
    // The footer's control is the card's action: a drag starting on it would
    // leave it unpressable. Any other button is somebody else's too.
    if (event.target.closest('[data-node-footer]') !== null) return;
    const control = event.target.closest('button');
    if (control !== null && !control.hasAttribute('data-node-surface')) return;

    const rect = canvasRef.current?.getBoundingClientRect();
    if (rect === undefined) return;

    swallowClick.current = false;
    grab.current = {
      name: node.resource.name,
      pointerId: event.pointerId,
      grabX: event.clientX - rect.left - node.x,
      grabY: event.clientY - rect.top - node.y,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
  }, []);

  const trackDrag = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const active = grab.current;
      if (active === null || active.pointerId !== event.pointerId) return;

      if (!active.moved) {
        const travelled =
          Math.abs(event.clientX - active.startX) >= DRAG_THRESHOLD ||
          Math.abs(event.clientY - active.startY) >= DRAG_THRESHOLD;
        if (!travelled) return;
        active.moved = true;
        setDragging(active.name);
        /*
         * Capture here rather than on `pointerdown`, so the card keeps
         * tracking a pointer that has outrun it. Capturing at the press would
         * retarget the compatibility mouse events with it, and the `click`
         * would land on this wrapper instead of the card's own button — a
         * press that never moved would then stop selecting the node.
         */
        event.currentTarget.setPointerCapture(event.pointerId);
      }

      /*
       * Measured on every move rather than once at the press: the canvas sits
       * in a scroller the user can still reach during the gesture, and a
       * stale origin would leave the card trailing the pointer by however far
       * the pane scrolled.
       */
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect === undefined) return;

      place(
        active.name,
        {
          x: Math.max(0, Math.round(event.clientX - rect.left - active.grabX)),
          y: Math.max(0, Math.round(event.clientY - rect.top - active.grabY)),
        },
        false,
      );
    },
    [place],
  );

  const endDrag = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const active = grab.current;
    if (active === null || active.pointerId !== event.pointerId) return;

    grab.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!active.moved) return;

    swallowClick.current = true;
    setDragging(null);
    setArrangement((current) => ({ ...current, persist: true }));
  }, []);

  const blockClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    // The gesture was a drag. Stopping it here keeps it from reaching both the
    // card's own selection and the canvas's deselection behind it.
    event.stopPropagation();
    event.preventDefault();
  }, []);

  const startPan = useCallback((event: PointerEvent<HTMLElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    if (!(event.target instanceof Element)) return;
    // A press that landed on a card is that card's drag, not the canvas's.
    if (event.target.closest('[data-resource]') !== null) return;

    const view = viewRef.current;
    if (view === null) return;

    pan.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollX: view.scrollLeft,
      scrollY: view.scrollTop,
      moved: false,
    };
  }, []);

  const trackPan = useCallback((event: PointerEvent<HTMLElement>) => {
    const active = pan.current;
    if (active === null || active.pointerId !== event.pointerId) return;

    const view = viewRef.current;
    if (view === null) return;

    const dx = event.clientX - active.startX;
    const dy = event.clientY - active.startY;

    if (!active.moved) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      active.moved = true;
      setPanning(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    }

    // The canvas follows the hand, so the scroll runs against it.
    view.scrollLeft = active.scrollX - dx;
    view.scrollTop = active.scrollY - dy;
  }, []);

  const endPan = useCallback((event: PointerEvent<HTMLElement>) => {
    const active = pan.current;
    if (active === null || active.pointerId !== event.pointerId) return;

    pan.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!active.moved) return;

    setPanning(false);
    // Moving the view is not choosing nothing; the selection outlives a pan.
    swallowClick.current = true;
  }, []);

  const nudge = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, node: GraphNode) => {
      const step = NUDGES[event.key];
      if (step === undefined) return;
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('[data-node-surface]') === null) return;

      // Without this the canvas scrolls instead, which is the arrow keys'
      // other job here and the wrong one while a card holds focus.
      event.preventDefault();
      const distance = event.shiftKey ? NUDGE_COARSE : NUDGE;
      place(
        node.resource.name,
        {
          x: Math.max(0, node.x + step.x * distance),
          y: Math.max(0, node.y + step.y * distance),
        },
        true,
      );
    },
    [place],
  );

  const reset = useCallback(() => {
    clearPositions(pod);
    setArrangement({ pod, positions: {}, persist: false });
  }, [pod]);

  const clear = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (swallowClick.current) {
        swallowClick.current = false;
        return;
      }
      // The canvas clears the selection; a click that landed on a card is the
      // card's own, and it has already selected itself.
      if (event.target instanceof Element && event.target.closest('[data-resource]') !== null) {
        return;
      }
      onSelect(null);
    },
    [onSelect],
  );

  const dismiss = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Escape') onSelect(null);
    },
    [onSelect],
  );

  if (empty) {
    return (
      <div
        style={CANVAS}
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-8 text-center">
        <p className="text-ui font-medium">This pod has no resources yet.</p>
        <p className="text-ui-sm text-muted-foreground">
          Add an app, a database or a route from the console or with the brainpod CLI.
        </p>
      </div>
    );
  }

  return (
    /* The wrapper exists for one reason: an absolute child of the scroller
       would scroll away with the graph, and the reset control has to stay
       where it was put. It passes the pane's height straight through. */
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {/* A labelled, focusable region: the canvas has to be reachable to be
          scrolled from the keyboard, and it holds no focus of its own. */}
      <section
        ref={viewRef}
        aria-label="Resource graph"
        tabIndex={0}
        onClick={clear}
        onKeyDown={dismiss}
        onPointerDown={startPan}
        onPointerMove={trackPan}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        style={canvas}
        /*
         * `no-scrollbar`, because this is a canvas and not a document. The
         * scrollable area is nine tenths overscroll padding on every side, so
         * a thumb here measures the padding rather than the graph and tells
         * the user nothing true about where they are. What it did do was
         * flash: macOS paints the overlay bar for any scroll, including the
         * programmatic one that brings a clicked node into view, so selecting
         * a node drew a grey strip across the bottom of the pane for a few
         * hundred milliseconds. Panning by drag, by wheel and by arrow key is
         * unaffected — none of them needed the bar to work.
         */
        className={cx(
          'no-scrollbar relative min-h-0 flex-1 overflow-auto overscroll-contain',
          panning ? 'cursor-grabbing' : 'cursor-grab',
        )}>
        {/* The room to push the graph around in. It is padding rather than a
            larger canvas so the coordinates a card is placed at stay the
            coordinates it was laid out at. */}
        <div className="w-max" style={{ padding: `${over.y}px ${over.x}px` }}>
          <div
            ref={canvasRef}
            className="relative"
            style={{ width: layout.width, height: layout.height }}>
            {/* Sized in CSS, not by the attributes alone: `inset-0` would pin
                the element to the canvas box, and an SVG clips at its own box,
                so the extra reach would be cut off rather than drawn. */}
            <svg
              width={sheet.width}
              height={sheet.height}
              aria-hidden="true"
              style={{ width: sheet.width, height: sheet.height }}
              className="pointer-events-none absolute top-0 left-0">
              <defs>
                <marker
                  id={ARROW}
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="8"
                  markerHeight="8"
                  markerUnits="userSpaceOnUse"
                  orient="auto">
                  <path d="M 1 1 L 7 4 L 1 7 Z" fill="var(--color-border)" />
                </marker>
              </defs>
              {routes.map((route) => (
                /* Opacity rather than a drawn-on stroke: the dash pattern is
                   the connector's whole visual identity, and `pathLength`
                   animates by taking the dash array over. */
                <motion.path
                  key={route.key}
                  d={route.d}
                  fill="none"
                  stroke="var(--color-border)"
                  strokeWidth={1.5}
                  strokeDasharray="4 5"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                  markerEnd={`url(#${ARROW})`}
                  initial={reduced ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{
                    duration: reduced ? 0 : EDGE_FADE,
                    delay: reduced ? 0 : route.delay,
                  }}
                />
              ))}
            </svg>

            {nodes.map((node, index) => (
              <motion.div
                key={node.resource.name}
                data-resource={node.resource.name}
                className={cx(
                  'absolute',
                  dragging === node.resource.name ? 'z-10 cursor-grabbing' : 'cursor-grab',
                )}
                style={{ left: node.x, top: node.y }}
                initial={reduced ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: reduced ? 0 : 0.3,
                  delay: reduced ? 0 : Math.min(index, STAGGER_STEPS) * STAGGER,
                }}
                onPointerDown={(event) => startDrag(event, node)}
                onPointerMove={trackDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onClickCapture={blockClick}
                onKeyDown={(event) => nudge(event, node)}>
                <NodeCard
                  resource={node.resource}
                  selected={selected === node.resource.name}
                  busy={busy[node.resource.name] === true}
                  onSelect={onSelect}
                  onOpenTunnel={onOpenTunnel}
                  onOpenRoute={onOpenRoute}
                />
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Only once something has been moved: a reset for an arrangement nobody
          made is a permanent control that never has anything to undo.

          Its offset follows whatever covers the canvas, so an overlaid rail
          does not park it underneath itself. */}
      {Object.keys(positions).length > 0 && (
        <Button
          variant="ghost"
          size="xs"
          title="Reset layout"
          icon={<Undo2 />}
          onClick={reset}
          style={{ right: occluded + 12 }}
          className="absolute top-3 text-muted-foreground"
        />
      )}
    </div>
  );
}
