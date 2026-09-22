import { Undo2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
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
import { useGlide } from '@/components/graph/glide';
import { KIND_STYLE, tint } from '@/components/graph/kinds';
import {
  CANVAS_PADDING,
  conduitShape,
  CONDUIT_MOUTH,
  layoutGraph,
  orthogonalPath,
  routeDirect,
  ROW_GAP,
  type EdgeLink,
  type GraphNode,
  type Point,
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
import { useReducedMotion } from '@/lib/motion';

/**
 * The canvas: a recessed surface under a regular lattice, with the lattice
 * fading out toward the pane's edges so the graph sits in a well rather than
 * on a sheet of graph paper the window happened to crop.
 *
 * Two layers with two attachments, which is the whole trick. The vignette is
 * `scroll`, so on a scroll container it stays with the pane the way the light
 * on a well would; the dots are `local`, so they travel with the cards and the
 * graph reads as something built on a grid rather than a photograph of one
 * hanging behind the pane.
 */
const GRID = 20;
const DOTS = 'radial-gradient(circle at center, var(--color-dots) 1px, transparent 1px)';
const VIGNETTE =
  'radial-gradient(ellipse 150% 115% at 50% 40%, transparent 35%, color-mix(in oklab, var(--color-canvas) 70%, transparent) 100%)';
const CANVAS: CSSProperties = {
  backgroundColor: 'var(--color-canvas)',
  backgroundImage: `${VIGNETTE}, ${DOTS}`,
  backgroundSize: `auto, ${GRID}px ${GRID}px`,
  backgroundAttachment: 'scroll, local',
};

/**
 * Which connectors are drawn as a conduit rather than as a line.
 *
 * The throat exists between a card and the card in the layer below it: it is a
 * mouth on one edge easing into a mouth on the other, and it does not care
 * whether the two sit on the same centre — an S between fanned anchors is the
 * same curve. What it cannot do is cross a layer, because the cards in between
 * are in the way; those keep the line, and the packets still run along it,
 * which is what stops the two treatments from reading as two different kinds
 * of relationship.
 */
const CONDUIT_MIN_RUN = 56;
const ON_EDGE = 1.5;

function conduitRun(
  points: Point[],
  from: GraphNode,
  to: GraphNode,
): { from: Point; to: Point } | null {
  const start = points[0];
  const end = points[points.length - 1];
  if (start === undefined || end === undefined) return null;

  // It has to leave the source's own bottom edge and arrive on the target's
  // top edge: a connector that enters from the side is a detour around
  // something, and a throat drawn across that something would cover it.
  if (Math.abs(start.y - (from.y + from.height)) > ON_EDGE) return null;
  if (Math.abs(end.y - to.y) > ON_EDGE) return null;

  const run = end.y - start.y;
  if (run < CONDUIT_MIN_RUN || run > ROW_GAP + ON_EDGE) return null;

  return { from: start, to: end };
}

/**
 * The packets the conduit carries.
 *
 * They travel straight. A packet that followed the throat's own curve looked
 * like it was being steered through a funnel — every mark leaning the same way
 * at the same point, which reads as choreography rather than as traffic. Sent
 * straight down from mouth to mouth they cross the channel's waist and drift
 * outside it, and that is the right picture: the throat is the shape of the
 * reference, not a pipe with walls the contents have to respect.
 *
 * Nothing about them lines up. Fixed lanes at fixed intervals, however many,
 * are a grid: the eye finds the columns in about a second and the whole thing
 * goes from traffic to a marquee. So every packet gets its own position across
 * the mouth, its own pace and its own moment in the cycle — all of it derived
 * from the edge's name rather than from `Math.random`, because a re-render
 * must not teleport a packet that is halfway down. What none of them get is a
 * direction of its own: the scatter is in the start and the speed, never in
 * the heading.
 *
 * The field they spread over is two thirds of the mouth. The outer third is
 * where the channel's own paint has already faded to nothing, and a packet out
 * there reads as a speck on the canvas rather than as something being carried.
 */
const LANE_SPREAD = 0.67;
const PACKET_COUNT = 16;
/** A detour has no mouth to spread across, so its line carries a few. */
const PACKET_COUNT_LINE = 4;

/** Deterministic 0…1 noise from a string. */
function noise(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
  }

  return ((hash >>> 0) % 10000) / 10000;
}

/**
 * The point a fraction of the way along a polyline, by length. It exists for
 * the motionless case: a packet that is not travelling still has to stand
 * somewhere on the connector it belongs to, and on a detour that is a corner
 * or two away from a simple interpolation between the ends.
 */
function along(points: Point[], fraction: number): Point {
  const first = points[0];
  if (first === undefined) return { x: 0, y: 0 };

  const runs = points.slice(1).map((point, index) => {
    const previous = points[index] ?? point;
    return { from: previous, to: point, length: Math.hypot(point.x - previous.x, point.y - previous.y) };
  });
  const total = runs.reduce((sum, run) => sum + run.length, 0);

  let travelled = fraction * total;
  for (const run of runs) {
    if (travelled > run.length) {
      travelled -= run.length;
      continue;
    }

    const share = run.length === 0 ? 0 : travelled / run.length;
    return {
      x: run.from.x + (run.to.x - run.from.x) * share,
      y: run.from.y + (run.to.y - run.from.y) * share,
    };
  }

  return points[points.length - 1] ?? first;
}

/**
 * The blur the channel is painted through.
 *
 * A gradient across the shape's own box could not do this: the throat is a
 * quarter of its own width at the waist, so a fade tuned to reach nothing at
 * the mouths was still at full strength where the walls pinch in, and left a
 * hard vertical edge down the middle of the run. Blurring the whole shape
 * fades every edge it has — sides, waist and mouths — in the shape's own
 * terms, which is the only version of this that has no seam anywhere.
 */
const HAZE = 'resource-graph-haze';
const HAZE_BLUR = 5;

/**
 * The connection bar's geometry, and the clearance it keeps from anything it
 * is not part of.
 *
 * It is no longer a fixed rail. A bar sized to the widest value it could ever
 * hold left the short ones — `disk`, `mount` — as a long empty pill with two
 * words floating in it, and made every bar wider than the throat it clamps.
 * Sized to its own content it sits inside the mouth it belongs to, and the
 * numbers below are what `EdgeLabel` actually renders: `px-2.5` on both sides,
 * the divider with its two gaps, and JetBrains Mono's 0.6em advance at 11.5px.
 */
const BAR_HEIGHT = 22;
const BAR_CLEARANCE = 8;
const BAR_PADDING = 20;
const BAR_DIVIDER = 17;
const BAR_ADVANCE = 6.9;
/** Past this a value is clamped and ellipsised rather than widening the bar. */
const BAR_DETAIL_MAX = 132;

function barWidth(link: EdgeLink): number {
  const detail =
    link.detail === null
      ? 0
      : BAR_DIVIDER + Math.min(link.detail.length * BAR_ADVANCE, BAR_DETAIL_MAX);

  return Math.round(BAR_PADDING + link.via.length * BAR_ADVANCE + detail);
}

type Rect = { x: number; y: number; width: number; height: number };

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Where a bar could sit on a connector: the middle of each straight run,
 * longest first. A bar is 208px wide on a canvas whose lanes are 32px apart,
 * so which run it takes is not a detail — the longest one is the only
 * candidate on a straight connector, and on a detour that runs down the side
 * of a card it is the one that has to be rejected.
 */
function barAnchors(points: Point[]): Point[] {
  const runs: { point: Point; length: number }[] = [];

  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    if (from === undefined || to === undefined) continue;

    runs.push({
      point: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
      length: Math.hypot(to.x - from.x, to.y - from.y),
    });
  }

  return runs.sort((a, b) => b.length - a.length).map((run) => run.point);
}

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
 * The dotted connector, and how a throat opens out of it.
 *
 * Dots rather than dashes: a dash at this weight is a small line and reads as
 * the connector itself, where a row of dots reads as a connector held back —
 * which is what a reference nobody is asking about should look like.
 * `CLOSED_MOUTH` is the width the channel waits at: wide enough that the morph
 * has the same shape at both ends, narrow enough to be the line it grows from.
 */
const SPINE_DOTS = '0.5 5';
const CLOSED_MOUTH = 6;
const OPEN = 0.34;
/** Ease-out: quick off the line, settling into the channel. */
const EASE = [0.16, 0.84, 0.24, 1] as const;

/**
 * How the traffic arrives and leaves. Arriving waits for the channel to be
 * most of the way open, then runs the packets in one behind another; leaving
 * is quicker, unstaggered, and finishes before the channel has closed.
 */
const PACKET_ARRIVE = 0.26;
const PACKET_STAGGER = 0.018;
const PACKET_LEAVE = 0.16;

/**
 * How long one packet takes from mouth to mouth. Fast enough to read as
 * something being carried rather than as drift, slow enough that a window open
 * all day in the corner of the eye never pulls at it — the pace is what
 * separates a graph of a pod from the pod.
 */
const PACKET_TRAVEL = 2.1;

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
 * How much the visible strip has to change in one step before the change is
 * treated as having arrived whole rather than as a hand still moving. A window
 * edge or a rail divider being dragged reports a few pixels per frame; a rail
 * opening or closing reports its entire width at once.
 */
const WHOLE = 24;

/**
 * The positions of one pod's nodes, and whether they are worth writing down.
 * `persist` is false for the position a `pointermove` produced — a write per
 * move is IO nobody asked for — and true once the gesture has ended.
 */
type Arrangement = { pod: string; positions: NodePositions; persist: boolean };

/** The gesture in flight. A ref, because a drag must not re-render to track. */
type Grab = {
  urn: string;
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
  occluded,
}: {
  pod: string;
  resources: Resource[];
  selected: string | null;
  onSelect: (urn: string | null) => void;
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
  /* The one thing allowed to write this canvas's scroll over time. Every
     gesture below takes it back the moment the hand arrives. */
  const glide = useGlide(viewRef);
  const grab = useRef<Grab | null>(null);
  const pan = useRef<Pan | null>(null);
  /** A drag ends in a `click`; this is what stops that click from selecting. */
  const swallowClick = useRef(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const [over, setOver] = useState<Overscroll>({ x: 0, y: 0 });

  /*
   * The offset re-phases the lattice onto the canvas's own origin, which the
   * overscroll padding pushes an arbitrary number of pixels into the
   * scrollable area. Without it a resize changes the padding, and the cards
   * would slide across the lattice they were laid out on. The vignette above
   * it is positioned against the pane and never moves.
   */
  const canvas = useMemo<CSSProperties>(
    () => ({
      ...CANVAS,
      backgroundPosition: `0 0, ${over.x % GRID}px ${over.y % GRID}px`,
      /*
       * The overscroll padding is this canvas's own to move, and it already
       * pays for every pixel it adds: the framing effect below shifts the
       * scroll by the same delta so the graph holds still. Chromium's scroll
       * anchoring pays for it a second time — it sees content grow ahead of
       * the anchor and corrects for it too — and the two together doubled
       * every correction, which threw the graph sideways on the first frames
       * of the rail opening before the follow could drag it back. WebKit,
       * which is what ships, has no anchoring at all; this is the line that
       * makes the two agree.
       */
      overflowAnchor: 'none',
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
        const moved = positions[node.resource.urn];
        return moved === undefined ? node : { ...node, x: moved.x, y: moved.y };
      }),
    [layout, positions],
  );

  const placed = useMemo(
    () => new Map(nodes.map((node) => [node.resource.urn, node])),
    [nodes],
  );

  /** When each card arrives, so an edge can wait for the later of its two. */
  const arrival = useMemo(() => {
    const delays = new Map<string, number>();
    nodes.forEach((node, index) => {
      delays.set(node.resource.urn, Math.min(index, STAGGER_STEPS) * STAGGER);
    });
    return delays;
  }, [nodes]);

  /*
   * The routed connectors, resolved against where the cards actually are. An
   * edge keeps the lane the layout gave it until the user moves one of its
   * ends — at which point the lane describes a graph that no longer exists,
   * and a plain two-turn connector is the honest answer.
   *
   * An edge that touches the selected node is drawn in that node's kind
   * accent. Selecting a resource is how a person asks what it is wired to,
   * and until now the answer was a panel: the lines on the canvas all stayed
   * the same grey, so the one fact the graph exists to show had to be read
   * off a list instead of seen.
   */
  const routes = useMemo(() => {
    const drawn = layout.edges.flatMap((edge) => {
      const from = placed.get(edge.from);
      const to = placed.get(edge.to);
      if (from === undefined || to === undefined) return [];

      const disturbed = positions[edge.from] !== undefined || positions[edge.to] !== undefined;
      const points = disturbed ? routeDirect(from, to) : edge.points;

      return [{ edge, source: from.resource.kind, points, run: conduitRun(points, from, to) }];
    });

    /*
     * How many conduits share each card edge. Two throats leaving one card at
     * full width would overlap into a single blur, so they split the width
     * between them — the same reason the layout fans the anchors they start
     * from in the first place.
     *
     * Leaving and arriving are counted apart, because they are opposite edges
     * of the card: a resource with one reference out and one in has two full
     * mouths, one on its bottom and one on its top, and nothing to share.
     */
    const leaving: Record<string, number> = {};
    const arriving: Record<string, number> = {};
    for (const entry of drawn) {
      if (entry.run === null) continue;
      leaving[entry.edge.from] = (leaving[entry.edge.from] ?? 0) + 1;
      arriving[entry.edge.to] = (arriving[entry.edge.to] ?? 0) + 1;
    }

    return drawn.map(({ edge, source, points, run }) => {
      const active = selected === edge.from || selected === edge.to;
      const shared = Math.max(leaving[edge.from] ?? 1, arriving[edge.to] ?? 1);

      return {
        key: `${edge.from}\u0000${edge.to}`,
        from: edge.from,
        to: edge.to,
        d: orthogonalPath(points),
        /* What the edge says it is, and the polyline a bar stating it has to
           be placed along. */
        link: edge.link,
        points,
        run,
        mouth: Math.max(CONDUIT_MOUTH / shared, CONDUIT_MOUTH / 2),
        active,
        /* The source's colour, not the target's: an edge belongs to the
           resource that declares the reference, and a route fanning out to
           three backends reads as one bundle that way. */
        accent: KIND_STYLE[source].accent,
        stroke: active ? KIND_STYLE[source].accent : 'var(--color-wire)',
        delay: Math.max(arrival.get(edge.from) ?? 0, arrival.get(edge.to) ?? 0) + EDGE_LAG,
      };
    });
  }, [layout, placed, positions, arrival, selected]);

  /*
   * Where each connection bar actually goes, resolved once for the whole
   * canvas rather than per edge.
   *
   * A bar is nearly as wide as a card, so it cannot simply be dropped on the
   * middle of its own connector: a detour running down the side of a card
   * would lay its bar across that card, and two edges crossing the same row
   * gap would lay their bars across each other. Each one takes the longest run
   * of its own line that is clear of every card and of every bar already
   * placed, and an edge with no clear run states nothing — the connector is
   * still drawn, and the mount or the variable behind it is still in the rail.
   */
  const bars = useMemo(() => {
    const obstacles: Rect[] = nodes.map((node) => ({
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    }));
    const placed: { key: string; x: number; y: number }[] = [];

    /*
     * Most constrained first. A short connector between two cards in adjacent
     * layers has exactly one place its bar can go; a detour that crosses two
     * layers has four, and letting it take the one gap it shares with a direct
     * neighbour is how the direct edge — the one whose reason is usually the
     * interesting one — ends up being the edge that says nothing.
     */
    const byConstraint = [...routes].sort((a, b) => a.points.length - b.points.length);

    for (const route of byConstraint) {
      if (route.link === null) continue;

      /* A conduit's bar belongs on the waist, which is the narrowest part of
         the run and the one place a label crosses it without burying it. The
         polyline's own midpoints are the fallback for a detour. */
      const candidates =
        route.run === null
          ? barAnchors(route.points)
          : [
              {
                x: (route.run.from.x + route.run.to.x) / 2,
                y: (route.run.from.y + route.run.to.y) / 2,
              },
            ];

      const width = barWidth(route.link);

      for (const candidate of candidates) {
        const rect: Rect = {
          x: candidate.x - width / 2 - BAR_CLEARANCE,
          y: candidate.y - BAR_HEIGHT / 2 - BAR_CLEARANCE,
          width: width + 2 * BAR_CLEARANCE,
          height: BAR_HEIGHT + 2 * BAR_CLEARANCE,
        };
        if (obstacles.some((box) => overlaps(rect, box))) continue;

        obstacles.push(rect);
        placed.push({ key: route.key, x: candidate.x, y: candidate.y });
        break;
      }
    }

    return new Map(placed.map((entry) => [entry.key, entry]));
  }, [routes, nodes]);

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
      // The flick is the user taking the canvas over, and two hands on it at
      // once is a scroll that fights whoever moved last.
      glide.stop();

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
  }, [empty, glide]);

  /*
   * Where the canvas has to be for a point of the graph to sit in the middle
   * of what can be seen, asked of the live geometry every time.
   *
   * The anchor is in the graph's own coordinates, never in the scroller's:
   * the overscroll padding moves the graph's origin inside the scrollable area
   * whenever the pane changes size, so a destination written down as a scroll
   * offset is a destination that means somewhere else one commit later. That
   * is precisely the commit every one of these moves runs across.
   *
   * `occluded` is read from a ref because this is called on frames, not on
   * renders: an overlaid rail covers the right of the scroller without
   * narrowing it, and centring against `clientWidth` would put the card under
   * the panel that asked for it.
   */
  const occludedRef = useRef(occluded);
  occludedRef.current = occluded;

  const anchored = useCallback((anchor: Point) => {
    const view = viewRef.current;
    const box = canvasRef.current;
    if (view === null || box === null) return null;

    const visible = view.clientWidth - occludedRef.current;

    // Never past the ends of the scrollable area: a point near the edge of the
    // graph would otherwise ask for a scroll the browser silently refuses, and
    // the result would read as the centring not happening.
    return {
      left: Math.max(
        0,
        Math.min(box.offsetLeft + anchor.x - visible / 2, view.scrollWidth - view.clientWidth),
      ),
      top: Math.max(
        0,
        Math.min(
          box.offsetTop + anchor.y - view.clientHeight / 2,
          view.scrollHeight - view.clientHeight,
        ),
      ),
    };
  }, []);

  /*
   * Which pod's graph has been brought into view, and with how much room
   * around it. Centring is a one-off per pod: doing it on every change would
   * undo the user's own scrolling every time the window is resized.
   *
   * Everything after that is about holding what the user is looking at still
   * while the frame around it changes shape. Two separate things move it:
   *
   * The padding. It is 90% of a pane on every side, so re-measuring it moves
   * the graph's origin within the scrollable area by hundreds of pixels; the
   * scroll follows it by the same delta and the graph does not budge. That is
   * a change of coordinates, not a movement, and it is never animated.
   *
   * The strip itself. When the rail takes 360px out of the canvas, the middle
   * of what can be seen moves 180px, and a graph that holds its distance from
   * the left edge has quietly slid half a rail off-centre — which is the
   * "everything moved" the rail closing used to read as, arrived at without
   * anything having animated. So the centre of the strip is what is held, and
   * a change that arrived whole is travelled rather than jumped.
   */
  const framed = useRef<string | null>(null);
  const lastOver = useRef<Overscroll>({ x: 0, y: 0 });
  const lastStrip = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  useLayoutEffect(() => {
    const view = viewRef.current;
    const box = canvasRef.current;
    if (view === null || box === null || over.x === 0) return;

    const strip = { x: view.clientWidth - occluded, y: view.clientHeight };

    if (framed.current === pod) {
      view.scrollLeft += over.x - lastOver.current.x;
      view.scrollTop += over.y - lastOver.current.y;
      lastOver.current = over;

      const was = lastStrip.current;
      const widened = strip.x - was.x;
      const heightened = strip.y - was.y;
      lastStrip.current = strip;
      if (widened === 0 && heightened === 0) return;

      /*
       * A selected node is a stronger statement about what the user is
       * looking at than the middle of the strip is, and the effect below
       * re-centres it against exactly this geometry. Two rules aimed at the
       * same scroll is one of them losing by half a rail.
       */
      if (selected !== null || glide.running()) return;

      /* The graph point that was in the middle of the strip before it changed
         size, which is the thing to still be looking at afterwards. Taken in
         the graph's coordinates, so the padding the next commit re-measures
         cannot turn it into a different point. */
      const anchor = {
        x: view.scrollLeft + was.x / 2 - box.offsetLeft,
        y: view.scrollTop + was.y / 2 - box.offsetTop,
      };

      /* A window edge under the pointer, or a rail divider being dragged,
         arrives a few pixels at a time and is followed exactly; only a change
         that appeared all at once is something to travel. */
      const whole = Math.abs(widened) >= WHOLE || Math.abs(heightened) >= WHOLE;
      glide.follow(() => anchored(anchor), reduced || !whole);
      return;
    }

    framed.current = pod;
    lastOver.current = over;
    lastStrip.current = strip;
    glide.stop();
    // Centred while the graph fits, pinned to the top-left once it does not:
    // a tall graph centred vertically opens halfway down, past its roots.
    view.scrollLeft = box.offsetLeft - Math.max(0, (view.clientWidth - box.offsetWidth) / 2);
    view.scrollTop = box.offsetTop - Math.max(0, (view.clientHeight - box.offsetHeight) / 2);
  }, [pod, over, occluded, selected, reduced, glide]);

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
   * deliberate choice is carried there over time.
   *
   * What the geometry change does while a follow is already in flight is
   * nothing: the follow re-reads its destination every frame, so the rail
   * arriving, the padding being re-measured behind it and the scroll being
   * clamped to a maximum that moves with both are all already in the answer.
   * Restating any of them as a second scroll is what used to throw the canvas
   * across the pane one frame after the first one had started — a deliberate
   * choice would begin to travel, and then teleport the rest of the way.
   *
   * It reads the node's position from a ref rather than from the dependency
   * list: `placed` changes on every pointermove of a drag, and a scroll
   * animation firing mid-drag would take the card out from under the pointer.
   */
  const placedRef = useRef(placed);
  placedRef.current = placed;
  const revealed = useRef<string | null>(null);

  const centre = useCallback(
    (urn: string) => {
      const node = placedRef.current.get(urn);
      if (node === undefined) return null;

      return anchored({ x: node.x + node.width / 2, y: node.y + node.height / 2 });
    },
    [anchored],
  );

  useEffect(() => {
    if (selected === null) {
      /*
       * Forgotten, not stopped. Clearing the selection is the same commit
       * that takes the rail out of the pane, and the layout effect above has
       * already aimed the canvas at what is left to look at — from a layout
       * effect, which runs first. Stopping the follow here would cancel that
       * move a moment after it started, which is the closing half of the jump
       * this all exists to remove.
       */
      revealed.current = null;
      return;
    }

    const chosen = revealed.current !== selected;
    revealed.current = selected;

    if (!chosen && glide.running()) return;

    /*
     * Instant for everything that is not the choice itself. A window being
     * resized, or a rail whose divider is under the user's thumb, is direct
     * manipulation: the node holds its place in the strip that is left, frame
     * by frame, and a follow started on each of those frames would be a canvas
     * that never settles.
     */
    glide.follow(() => centre(selected), reduced || !chosen);
  }, [selected, over, occluded, reduced, glide, centre]);

  const place = useCallback((urn: string, position: NodePosition, persist: boolean) => {
    setArrangement((current) => ({
      pod: current.pod,
      positions: { ...current.positions, [urn]: position },
      persist,
    }));
  }, []);

  const startDrag = useCallback((event: PointerEvent<HTMLDivElement>, node: GraphNode) => {
    if (!event.isPrimary || event.button !== 0) return;
    if (!(event.target instanceof Element)) return;
    // The card's own surface is the drag handle. Any other button inside it
    // belongs to somebody else, and a drag starting there would swallow it.
    const control = event.target.closest('button');
    if (control !== null && !control.hasAttribute('data-node-surface')) return;

    const rect = canvasRef.current?.getBoundingClientRect();
    if (rect === undefined) return;

    swallowClick.current = false;
    grab.current = {
      urn: node.resource.urn,
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
        setDragging(active.urn);
        // A card being carried by hand and a canvas being carried by the
        // window are two moves on the same pixels; the hand wins.
        glide.stop();
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
        active.urn,
        {
          x: Math.max(0, Math.round(event.clientX - rect.left - active.grabX)),
          y: Math.max(0, Math.round(event.clientY - rect.top - active.grabY)),
        },
        false,
      );
    },
    [place, glide],
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

    /* Before the origin is read, not after: the press is the takeover, and a
       scroll still moving under it would make the pan start from a position
       the canvas had already left. */
    glide.stop();

    pan.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollX: view.scrollLeft,
      scrollY: view.scrollTop,
      moved: false,
    };
  }, [glide]);

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
        node.resource.urn,
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
      if (event.key === 'Escape') {
        onSelect(null);
        return;
      }
      // An arrow key on the canvas itself is the browser scrolling it, which
      // is the user's hand by another name.
      if (NUDGES[event.key] !== undefined) glide.stop();
    },
    [onSelect, glide],
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
                {/* One filter for every channel: the blur is in user space, so
                    a conduit between two cards and a conduit between two
                    others are softened by the same number of pixels. */}
                <filter id={HAZE} x="-40%" y="-20%" width="180%" height="140%">
                  <feGaussianBlur stdDeviation={HAZE_BLUR} />
                </filter>
              </defs>

              {routes.map((route) => {
                const run = route.run;
                /*
                 * The channel's own light. Its hue is the edge's, so a live
                 * connector's interior warms with it.
                 *
                 * At rest it is not `wire` itself but `wire` sunk two thirds
                 * of the way back into the canvas. The connector colour was
                 * chosen to hold a 3:1 line against the ground; spread over a
                 * blurred field the size of a card it stopped being a hint and
                 * started being the brightest thing between two nodes, which
                 * is a graph whose gaps outshine its content.
                 */
                const channel = route.active
                  ? route.accent
                  : 'color-mix(in oklab, var(--color-wire) 34%, var(--color-canvas))';
                /*
                 * This connector's packets, each one scattered off its
                 * neighbours in position, pace and phase. A detour has no
                 * mouth to spread across, so its few ride the polyline.
                 *
                 * They run only on the selected node's own edges. A canvas
                 * where every channel is always moving is a canvas that is
                 * always asking for attention, and this window sits open on a
                 * second monitor all day; the motion is worth more as the
                 * answer to "what is this wired to" than as ambience.
                 */
                const packets = !route.active
                  ? []
                  : Array.from(
                      { length: run === null ? PACKET_COUNT_LINE : PACKET_COUNT },
                      (_, packet) => {
                        const seed = `${route.key}:${packet}`;
                        const travel = PACKET_TRAVEL * (0.72 + noise(`${seed}:pace`) * 0.62);
                        /* Where along its own path this packet is. It is the
                           phase of the loop when the packets move, and the
                           place each one stands when they do not. */
                        const at = noise(`${seed}:phase`);
                        const common = {
                          seed,
                          travel,
                          begin: at * travel,
                          size: 2.4 + noise(`${seed}:size`) * 1.6,
                        };
                        if (run === null) {
                          return { ...common, path: route.d, still: along(route.points, at) };
                        }

                        /* Straight down, and only down. A lean off the
                           vertical read as the packets sliding sideways
                           through the channel rather than falling through it;
                           the scatter that keeps them off a grid is in where
                           each one starts and how fast it goes, never in its
                           direction. Every packet holds the x it was given,
                           taken from the middle of the run so a connector
                           between two fanned anchors still drops plumb. */
                        const half = route.mouth / 2;
                        const lane = (noise(`${seed}:lane`) * 2 - 1) * LANE_SPREAD;
                        const x = (run.from.x + run.to.x) / 2 + lane * half;

                        return {
                          ...common,
                          path: `M ${x} ${run.from.y} L ${x} ${run.to.y}`,
                          still: { x, y: run.from.y + (run.to.y - run.from.y) * at },
                        };
                      },
                    );

                return (
                  <motion.g
                    key={route.key}
                    initial={reduced ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{
                      duration: reduced ? 0 : EDGE_FADE,
                      delay: reduced ? 0 : route.delay,
                    }}>
                    {run === null ? (
                      <path
                        d={route.d}
                        fill="none"
                        stroke={route.stroke}
                        strokeWidth={route.active ? 1.75 : 1.5}
                        strokeDasharray={SPINE_DOTS}
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                      />
                    ) : (
                      <>
                        {/*
                          At rest a connector is a thread: a dotted spine down
                          the middle of the throat, which is all a reference
                          needs to say while nobody is asking about it.
                        */}
                        <motion.path
                          d={`M ${run.from.x} ${run.from.y} L ${run.to.x} ${run.to.y}`}
                          fill="none"
                          stroke={route.stroke}
                          strokeWidth={1.5}
                          strokeDasharray={SPINE_DOTS}
                          strokeLinecap="round"
                          vectorEffect="non-scaling-stroke"
                          initial={false}
                          animate={{ opacity: route.active ? 0 : 1 }}
                          transition={{ duration: reduced ? 0 : OPEN, ease: EASE }}
                        />

                        {/*
                          Selecting opens that thread into the channel it was
                          standing in for. The morph is on `d` itself, between
                          the same shape at a sliver's width and at its own:
                          the commands match, so the throat grows out of the
                          line rather than crossfading over it, and the two
                          read as one object in two states rather than as two
                          drawings of the same edge.

                          The channel has no walls. A stroked outline made it a
                          drawn object with an edge you could point at, and a
                          reference has no edge — what a resource reaches
                          another over is a field, not a pipe. So it is paint
                          alone, one flat colour taken through the blur above,
                          which is what fades it out at the sides and at the
                          waist in the same breath.
                        */}
                        <motion.path
                          fill={channel}
                          filter={`url(#${HAZE})`}
                          initial={{
                            d: conduitShape(run.from, run.to, CLOSED_MOUTH),
                            fillOpacity: 0,
                          }}
                          animate={{
                            d: conduitShape(
                              run.from,
                              run.to,
                              route.active ? route.mouth : CLOSED_MOUTH,
                            ),
                            fillOpacity: route.active ? 0.62 : 0,
                          }}
                          transition={{ duration: reduced ? 0 : OPEN, ease: EASE }}
                        />
                      </>
                    )}

                    {/* The reference, in flight: what the connector carries,
                        downstream from the resource that declares the
                        reference toward the one it names.

                        It says direction, never rate: the packets are
                        scattered by a hash of the edge's name, and the API
                        reports no throughput for them to stand in for.

                        Reduced motion keeps them and stops them. A connection
                        that empties out the moment someone turns animation off
                        has made the fact conditional on the effect; the
                        scattered marks in the channel still say this edge is
                        the selected one and which way it runs. */}
                    <AnimatePresence>
                      {packets.map((packet, index) => (
                        /* A square, not a dash. The mark is a thing being
                           carried, and a dash reads as a piece of the line
                           that used to be drawn here — which is exactly what
                           the channel replaced.

                           They arrive one after another rather than all at
                           once: the channel opens, and then it has traffic in
                           it. Sixteen squares appearing on the same frame is a
                           layer being switched on, which is the one thing this
                           whole treatment is trying not to look like. Leaving
                           is quicker and unstaggered — a connection that has
                           stopped being the subject should not take a beat to
                           admit it. */
                        <motion.rect
                          key={packet.seed}
                          x={(reduced ? packet.still.x : 0) - packet.size / 2}
                          y={(reduced ? packet.still.y : 0) - packet.size / 2}
                          width={packet.size}
                          height={packet.size}
                          rx={0.75}
                          fill={route.stroke}
                          initial={{ opacity: 0, scale: 0.4 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, transition: { duration: reduced ? 0 : PACKET_LEAVE } }}
                          transition={{
                            duration: reduced ? 0 : PACKET_ARRIVE,
                            delay: reduced ? 0 : OPEN * 0.4 + index * PACKET_STAGGER,
                            ease: EASE,
                          }}>
                          {!reduced && (
                            <animateMotion
                              dur={`${packet.travel}s`}
                              begin={`-${packet.begin}s`}
                              repeatCount="indefinite"
                              path={packet.path}
                            />
                          )}
                        </motion.rect>
                      ))}
                    </AnimatePresence>
                  </motion.g>
                );
              })}
            </svg>

            {/* On the line, not beside it: the bar breaks the connector where
                it crosses, which is what makes the pair read as one statement
                rather than as a label that happens to be nearby. */}
            {routes.map((route) => {
              const bar = bars.get(route.key);
              if (route.link === null || bar === undefined) return null;

              return (
                <EdgeLabel
                  key={route.key}
                  link={route.link}
                  from={route.from}
                  to={route.to}
                  accent={route.accent}
                  active={route.active}
                  reduced={reduced}
                  delay={route.delay}
                  x={bar.x}
                  y={bar.y}
                />
              );
            })}

            {nodes.map((node, index) => (
              <motion.div
                key={node.resource.urn}
                data-resource={node.resource.urn}
                className={cx(
                  'absolute',
                  dragging === node.resource.urn ? 'z-10 cursor-grabbing' : 'cursor-grab',
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
                  attached={node.attached}
                  selected={selected}
                  onSelect={onSelect}
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

/**
 * What a connector is, stated on the connector: the mechanism that joins the
 * two resources and the exact value it is joined on — `http · / → :8081`,
 * `env · DATABASE_URL`, `mount · /data`.
 *
 * This is the band the details rail used to carry as "Depends on" and "Used
 * by". Both of them restated an arrow the canvas had already drawn, and the
 * one thing they added — the reason — sat three hundred pixels from the line
 * it described. On the line it needs no heading and no second copy of either
 * resource's name: the two cards it sits between are the heading.
 *
 * It is a label, never a control. The chip takes no pointer events, so the
 * canvas still pans from under it and a press through it lands on the canvas —
 * the node at either end is where a selection is made.
 */
function EdgeLabel({
  link,
  from,
  to,
  accent,
  active,
  reduced,
  delay,
  x,
  y,
}: {
  link: EdgeLink;
  from: string;
  to: string;
  /** The source kind's hue, which the chip takes once its edge is live. */
  accent: string;
  active: boolean;
  reduced: boolean;
  delay: number;
  x: number;
  y: number;
}): ReactElement {
  return (
    <motion.div
      /* One label, read as one sentence: the parts are a tag and a value, and
         a screen reader announcing them separately would say "env" and
         "DATABASE_URL" with nothing joining them to either resource. */
      role="img"
      aria-label={`${from} → ${to}: ${link.via}${link.detail === null ? '' : ` ${link.detail}`}`}
      /* A collar on the throat, sized to what it says. It sits on the waist
         rather than beside it, which is what makes the pair read as one
         statement rather than as a note that happens to be nearby.

         `transform-gpu` is not a performance hint here, it is the fix for the
         collar vanishing the moment its edge was selected. A running SMIL
         animation inside the connector's `<svg>`, over a filtered shape,
         promotes that SVG to its own compositing layer in WKWebView, and a
         composited layer paints over a plain positioned sibling whatever its
         `z-index` says. Promoting the label too puts both in the same
         comparison, where `z-2` decides it. */
      className="pointer-events-none absolute z-[2] flex h-[22px] -translate-x-1/2 -translate-y-1/2 transform-gpu items-center gap-2 rounded-full border px-2.5 font-mono text-ui-mono whitespace-nowrap transition-colors duration-300"
      style={{
        left: x,
        top: y,
        borderColor: active ? tint(accent, 45) : 'var(--color-border)',
        backgroundColor: active
          ? `color-mix(in oklab, ${accent} 12%, var(--color-card))`
          : 'var(--color-card)',
        color: active ? accent : 'var(--color-muted-foreground)',
      }}
      initial={reduced ? false : { opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: reduced ? 0 : EDGE_FADE, delay: reduced ? 0 : delay }}>
      <span className="shrink-0">{link.via}</span>

      {link.detail !== null && (
        <>
          <span
            aria-hidden="true"
            className="h-2.5 w-px shrink-0"
            style={{ backgroundColor: active ? tint(accent, 40) : 'var(--color-border)' }}
          />
          {/* The value can be a long mount path; the bar clamps it rather than
              growing past the gap it sits in. */}
          <span className="max-w-[132px] truncate">{link.detail}</span>
        </>
      )}
    </motion.div>
  );
}
