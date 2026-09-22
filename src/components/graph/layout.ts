import type { Resource } from '@/lib/bridge';

/**
 * The pod's resource graph, laid out the way the console draws it: layers
 * stacked top to bottom, an edge running down from a resource to the resource
 * it depends on, every node pulled toward the middle of what it connects to.
 *
 * This module is pure geometry and text — no React, no icons — because it is
 * also the measuring tape. `node-card.tsx` renders exactly the chip rows and
 * the height computed here, so the cards and the edge anchors can never
 * disagree about what a card occupies.
 */
export type GraphNode = {
  resource: Resource;
  /** The disks this card mounts, drawn on its own foot rather than as nodes. */
  attached: Resource[];
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Point = { x: number; y: number };

/**
 * Why one resource points at another, in the two parts a connector can state:
 * the mechanism that joins the pair, and the exact value it is joined on.
 *
 * This used to be a band in the details rail, which meant the graph drew the
 * arrow while a panel three hundred pixels away explained it. The reason
 * belongs on the line: `env · DATABASE_URL` is the whole content of an edge,
 * and a connector carrying it stops being a line between two boxes.
 */
export type EdgeLink = { via: string; detail: string | null };

/**
 * Ordered by how specific the answer is: a route's rule and a mount path name
 * an exact place, while an environment reference names the variable that
 * carries it. Every branch reads a field the API actually returned — an edge
 * the spec does not explain carries no label rather than an invented one.
 */
export function edgeLink(from: Resource, to: Resource): EdgeLink | null {
  const rule = from.rules.find((entry) => entry.backend === to.name);
  if (rule !== undefined) return { via: 'http', detail: `${rule.path} → :${rule.port}` };

  const mount = from.mounts.find(
    (entry) =>
      entry.target === to.name &&
      ((entry.file === null && to.kind === 'Disk') || (entry.file !== null && to.kind === 'Config')),
  );
  if (mount !== undefined) {
    return {
      via: 'mount',
      detail: mount.file === null ? mount.path : `${mount.file} → ${mount.path}`,
    };
  }

  if (to.kind === 'Disk' && from.diskRef === to.name) return { via: 'disk', detail: null };

  const variable = from.env.find((entry) =>
    to.variables.some((target) => entry.value.includes(target.ref)),
  );
  if (variable !== undefined) return { via: 'env', detail: variable.name };

  return null;
}

/**
 * Canonical URNs, not display names: names are only unique within the scope
 * each resource kind declares, while the URN identifies one resource across
 * the whole pod.
 *
 * `points` is the whole connector in canvas coordinates, source anchor first
 * and target anchor last. Every consecutive pair shares an x or a y, so the
 * renderer never has to decide where a line bends.
 */
export type GraphEdge = { from: string; to: string; points: Point[]; link: EdgeLink | null };

export type GraphLayout = { nodes: GraphNode[]; edges: GraphEdge[]; width: number; height: number };

/** Mirrors `node-card.tsx`'s `w-[260px]`. */
export const CARD_WIDTH = 260;
const GAP_X = 32;
/*
 * The row gap is the conduit's height. A thin line needed nothing of it; a
 * throat that flares out of one card and pinches at the waist needs the room
 * to do both, and at 64px the curve had no run to turn in and read as a
 * bracket rather than as a channel.
 */
export const ROW_GAP = 96;
const GAP_Y = ROW_GAP;
export const CANVAS_PADDING = 48;

/**
 * The conduit: how wide it leaves a card, and how far it pinches between them.
 *
 * A connector is not a wire between two ports — nothing in a pod is wired at a
 * point. It is the whole width over which one resource reaches another, so it
 * leaves the card as a mouth and narrows to a waist, which is also what gives
 * the packets inside it lanes to travel and the bar a place to sit across.
 */
export const CONDUIT_MOUTH = 60;
const WAIST_RATIO = 0.72;
/** How far a control point reaches along the run, as a fraction of its height. */
const CONDUIT_PULL = 0.34;

/**
 * The channel itself, as one closed path: the right wall down, the left wall
 * back up. It is a filled shape and never a stroked outline — what a resource
 * reaches another over is a field, not a pipe, so the renderer fades it out at
 * the sides rather than drawing an edge you could point at.
 */
export function conduitShape(from: Point, to: Point, mouth = CONDUIT_MOUTH): string {
  const half = mouth / 2;
  const waist = (mouth * WAIST_RATIO) / 2;
  const middle = (from.y + to.y) / 2;
  const pull = (to.y - from.y) * CONDUIT_PULL;

  return [
    `M ${from.x + half} ${from.y}`,
    `C ${from.x + half} ${from.y + pull} ${from.x + waist} ${middle - pull} ${from.x + waist} ${middle}`,
    `C ${from.x + waist} ${middle + pull} ${to.x + half} ${to.y - pull} ${to.x + half} ${to.y}`,
    `L ${to.x - half} ${to.y}`,
    `C ${to.x - half} ${to.y - pull} ${from.x - waist} ${middle + pull} ${from.x - waist} ${middle}`,
    `C ${from.x - waist} ${middle - pull} ${from.x - half} ${from.y + pull} ${from.x - half} ${from.y}`,
    'Z',
  ].join(' ');
}

/**
 * How far a connector with no room to run downward stands off a card before it
 * turns. Half a row gap, so a detour never reaches past the canvas padding.
 */
const DETOUR = GAP_Y / 2;

/**
 * A virtual bend claims a routing lane, not a box: it needs clearance from its
 * neighbours, but no width of its own.
 */
const VIRTUAL_WIDTH = 0;

/*
 * Every number below is a pixel value of something the card actually renders,
 * named after the utility that produces it. Change one there, change it here.
 */
const BORDER = 1;
const BODY_PADDING_X = 12; // `px-3`
const BODY_PADDING_Y = 12; // `py-3`
const HEADER_HEIGHT = 36; // the `size-9` icon tile, the tallest thing in the row
const CHIPS_OFFSET = 10; // `mt-2.5`, header to first chip row
const CHIP_HEIGHT = 20; // an 11.5/16 mono line box plus `py-0.5`
const CHIP_GAP = 6; // `gap-1.5`, between chips and between rows
const CHIP_PADDING_X = 12; // `px-1.5`, both sides
const CHIP_ICON = 11; // the 11px lucide glyph
const CHIP_ICON_GAP = 4; // `gap-1`
/** JetBrains Mono advances 0.6em per character, and the chips are 11.5px. */
const MONO_ADVANCE = 6.9;

/**
 * An attached disk, as a strip across the foot of the card that mounts it.
 * `h-[34px]` plus the hairline that separates it from the body above.
 */
const ATTACH_HEIGHT = 34;
const ATTACH_BORDER = 1;

/** What is left for chips once the card's border and padding are paid for. */
const CONTENT_WIDTH = CARD_WIDTH - 2 * BORDER - 2 * BODY_PADDING_X;

/**
 * Which disks are drawn *on* a resource rather than beside it.
 *
 * A disk with exactly one referrer is not a peer of the thing that mounts it:
 * it is that thing's storage, it cannot be reached without it, and drawing it
 * as its own card spends a whole row of the canvas and a connector on a fact
 * that belongs in the card's own footer.
 *
 * Exactly one, and never more. A disk two resources point at is shared
 * storage — a network disk — and shared storage is precisely the case an
 * attachment cannot draw: it would have to appear twice, and two copies of one
 * resource is two resources. Those stay nodes with connectors, which is also
 * why this reads the referrer count rather than the disk's own fields.
 */
export function attachedDisks(resources: Resource[]): Map<string, Resource[]> {
  const attached = new Map<string, Resource[]>();

  for (const disk of resources) {
    if (disk.kind !== 'Disk') continue;

    const hosts = resources.filter(
      (entry) => entry.urn !== disk.urn && entry.dependsOn.includes(disk.urn),
    );
    const host = hosts.length === 1 ? hosts[0] : undefined;
    // A disk nothing points at has no card to sit on and stays a node of its
    // own, which is also the only way an unreferenced disk stays visible.
    if (host === undefined || host.kind === 'Disk') continue;

    const list = attached.get(host.urn) ?? [];
    list.push(disk);
    attached.set(host.urn, list);
  }

  for (const list of attached.values()) list.sort(byName);
  return attached;
}

/**
 * Which glyph a chip carries. A key rather than the component itself, so the
 * measuring tape stays free of React and the icon table lives with the card.
 */
export type ChipIcon = 'instance' | 'replicas' | 'hostname' | 'domain' | 'version' | 'size';

export type Chip = { icon: ChipIcon; label: string };

/** A field the API answered with nothing is not a chip; it is simply absent. */
const stated = (value: string | null): string | null => {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * The address a route answers on, ready to hand to a browser. The spec states
 * hosts rather than URLs and Brainpod terminates TLS at the edge, so `https`
 * is the scheme. The provisioned hostname comes first: a custom domain is only
 * reachable once the user has pointed DNS at it, and the hostname always is.
 */
export function routeUrl(resource: Resource): string | null {
  if (resource.kind !== 'Route') return null;

  const host = stated(resource.hostname) ?? resource.domains.map(stated).find((one) => one !== null);
  return host === null || host === undefined ? null : `https://${host}`;
}

/**
 * The facts a resource states, drawn from populated fields only. There is
 * deliberately no CPU or memory here: `/v1/pods/{pod}/resources` reports no
 * utilisation, so a meter would be a number we invented.
 */
export function chipsFor(resource: Resource): Chip[] {
  const chips: Chip[] = [];

  switch (resource.kind) {
    case 'App': {
      const instance = stated(resource.instance);
      if (instance !== null) chips.push({ icon: 'instance', label: instance });
      if (resource.replicas !== null) {
        // `ready/total` is the useful reading while a revision rolls; with no
        // readiness reported, the count on its own is all there is to say.
        chips.push({
          icon: 'replicas',
          label:
            resource.readyReplicas === null
              ? `${resource.replicas}x`
              : `${resource.readyReplicas}/${resource.replicas}`,
        });
      }
      return chips;
    }
    case 'Route': {
      const hostname = stated(resource.hostname);
      if (hostname !== null) chips.push({ icon: 'hostname', label: hostname });
      for (const domain of resource.domains) {
        const custom = stated(domain);
        if (custom !== null) chips.push({ icon: 'domain', label: custom });
      }
      return chips;
    }
    case 'Postgres':
    case 'MariaDB':
    case 'Valkey':
    case 'MSSQL': {
      const version = stated(resource.version);
      if (version !== null) chips.push({ icon: 'version', label: version });
      const instance = stated(resource.instance);
      if (instance !== null) chips.push({ icon: 'instance', label: instance });
      return chips;
    }
    case 'Disk': {
      if (resource.size !== null) chips.push({ icon: 'size', label: `${resource.size}GB` });
      return chips;
    }
    case 'Config':
      return chips;
  }
}

/** A chip clamps to the card rather than pushing past its edge. */
const chipWidth = (chip: Chip): number =>
  Math.min(
    CHIP_PADDING_X + CHIP_ICON + CHIP_ICON_GAP + Math.ceil(chip.label.length * MONO_ADVANCE),
    CONTENT_WIDTH,
  );

/**
 * Chips packed into the rows the card renders. Wrapping is resolved here
 * instead of left to `flex-wrap` because the layout has to know the card's
 * height before the browser has measured anything — so the card renders one
 * explicit row per row returned, and the two can only agree.
 */
export function chipRows(chips: Chip[]): Chip[][] {
  const rows: Chip[][] = [];
  let row: Chip[] = [];
  let used = 0;

  for (const chip of chips) {
    const width = chipWidth(chip);
    if (row.length === 0) {
      row.push(chip);
      used = width;
      continue;
    }
    const extended = used + CHIP_GAP + width;
    if (extended > CONTENT_WIDTH) {
      rows.push(row);
      row = [chip];
      used = width;
      continue;
    }
    row.push(chip);
    used = extended;
  }

  if (row.length > 0) rows.push(row);
  return rows;
}

/**
 * What one card measures. The single source of truth: the card sets this as
 * its own height and the layout stacks rows by it — so `attached` is a
 * parameter rather than something the card works out for itself, because a
 * footer the layout did not count is a card that overlaps the row beneath it.
 */
export function cardHeight(resource: Resource, attached: Resource[] = []): number {
  let height = 2 * BORDER + 2 * BODY_PADDING_Y + HEADER_HEIGHT;

  const rows = chipRows(chipsFor(resource)).length;
  if (rows > 0) height += CHIPS_OFFSET + rows * CHIP_HEIGHT + (rows - 1) * CHIP_GAP;

  return height + attached.length * (ATTACH_BORDER + ATTACH_HEIGHT);
}

/** Byte order, not locale: the layout must not reshuffle between machines. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byName = (a: Resource, b: Resource): number =>
  byText(a.name, b.name) || byText(a.urn, b.urn);

/**
 * Sweeps are cheap but they do not converge: a graph can oscillate between two
 * equally good arrangements forever. A fixed handful is where the picture stops
 * changing, and it keeps a layout a bounded amount of work.
 */
const ORDER_PASSES = 4;
const PLACEMENT_PASSES = 4;

type Box = { x: number; y: number; width: number; height: number };

/**
 * One box in the layered graph. A slot without a `resource` is virtual: it is
 * ordered and placed exactly like a card but draws nothing. It exists so that an
 * edge skipping a layer is routed through the gaps between that layer's cards
 * instead of straight across them.
 *
 * `centre` rather than a left edge, because every placement decision below is
 * about where a box's middle wants to be.
 */
type Slot = {
  key: string;
  resource: Resource | null;
  layer: number;
  order: number;
  /** The sort key of the sweep in flight; meaningless between sweeps. */
  rank: number;
  width: number;
  height: number;
  centre: number;
  y: number;
  up: Slot[];
  down: Slot[];
};

/** One connector, plus the route the layout worked out for it. */
type Wire = {
  from: string;
  to: string;
  source: Slot;
  target: Slot;
  /**
   * False when layering could not put the target below the source — the members
   * of a cycle saturate on one layer — so there is no chain to follow and the
   * connector has to pass around the cards rather than between them.
   */
  descends: boolean;
  /** A virtual slot for each layer strictly between source and target. */
  chain: Slot[];
  /** The x the route holds in each layer it touches, source anchor to target. */
  stops: number[];
  /** Per crossed gap: the y to turn at, or `null` for a run already straight. */
  lanes: (number | null)[];
  startX: number;
  endX: number;
};

/** One wire's business in one vertical gap, as the lane assignment sees it. */
type Crossing = { wire: Wire; segment: number; left: number; right: number };

/** The closest two neighbours in a layer may stand, centre to centre. */
const minimumGap = (left: Slot, right: Slot): number => (left.width + right.width) / 2 + GAP_X;

/** The middle value, or the midpoint of the two middle ones. */
const medianOf = (values: number[]): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  const upper = sorted[sorted.length >> 1];
  if (upper === undefined) return null;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[(sorted.length >> 1) - 1];
  return lower === undefined ? upper : (lower + upper) / 2;
};

/**
 * The median, except that an even count splits the gap between the two middle
 * neighbours in favour of whichever side is packed more tightly. That is the
 * weighting in the weighted-median heuristic: a node follows the crowd it is
 * already closest to instead of splitting the difference with an outlier.
 */
const weightedMedianOf = (positions: number[]): number | null => {
  const sorted = [...positions].sort((a, b) => a - b);
  const right = sorted[sorted.length >> 1];
  const left = sorted[(sorted.length >> 1) - 1];
  if (right === undefined) return null;
  if (sorted.length % 2 === 1 || left === undefined) return right;
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) return (left + right) / 2;
  const toLeft = left - first;
  const toRight = last - right;
  if (toLeft + toRight === 0) return (left + right) / 2;
  return (left * toRight + right * toLeft) / (toLeft + toRight);
};

/**
 * The closest arrangement to `desired` that keeps a layer's left-to-right order
 * and its minimum gaps. Clamping left to right and then right to left in
 * sequence would be pointless — the first walk already satisfies every
 * constraint, so the second finds nothing to do and the whole layer ends up
 * shoved one way. Both walks therefore start from `desired`, and the answer is
 * their midpoint: a constraint here is a difference between two neighbours, so
 * it survives the average of two arrangements that each satisfy it.
 */
const settle = (column: Slot[], desired: number[]): number[] => {
  const forward: number[] = [];
  const backward: number[] = [];

  for (let i = 0; i < column.length; i += 1) {
    const slot = column[i];
    if (slot === undefined) break;
    const want = desired[i] ?? slot.centre;
    const before = column[i - 1];
    const bound = forward[i - 1];
    forward.push(
      before === undefined || bound === undefined
        ? want
        : Math.max(want, bound + minimumGap(before, slot)),
    );
  }
  for (let i = column.length - 1; i >= 0; i -= 1) {
    const slot = column[i];
    if (slot === undefined) break;
    const want = desired[i] ?? slot.centre;
    const after = column[i + 1];
    const bound = backward[i + 1];
    backward[i] =
      after === undefined || bound === undefined
        ? want
        : Math.min(want, bound - minimumGap(slot, after));
  }

  return column.map((slot, i) => {
    const low = forward[i];
    const high = backward[i];
    if (low === undefined || high === undefined) return desired[i] ?? slot.centre;
    return (low + high) / 2;
  });
};

/**
 * The same polyline with nothing in it that does not turn: a point equal to its
 * predecessor, and a point its neighbours already run straight through.
 */
const simplify = (points: Point[]): Point[] => {
  const kept: Point[] = [];
  for (const point of points) {
    const last = kept[kept.length - 1];
    if (last === undefined) {
      kept.push(point);
      continue;
    }
    if (last.x === point.x && last.y === point.y) continue;
    const before = kept[kept.length - 2];
    if (
      before !== undefined &&
      ((before.x === last.x && last.x === point.x) || (before.y === last.y && last.y === point.y))
    ) {
      kept[kept.length - 1] = point;
      if (before.x === point.x && before.y === point.y) kept.pop();
      continue;
    }
    kept.push(point);
  }
  return kept;
};

/** `distance` along the axis, from `from` toward `to`. */
const stepToward = (from: Point, to: Point, distance: number): Point => {
  const length = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
  if (length === 0) return { x: from.x, y: from.y };
  return {
    x: from.x + ((to.x - from.x) * distance) / length,
    y: from.y + ((to.y - from.y) * distance) / length,
  };
};

/**
 * SVG path data for an axis-aligned polyline, corners rounded to `radius`. A
 * corner never eats more than half of either segment it joins, so two corners
 * sharing a short segment meet in the middle of it rather than overrunning each
 * other and folding the line back on itself.
 */
export function orthogonalPath(points: Point[], radius = 8): string {
  const route = simplify(points);
  const start = route[0];
  if (start === undefined) return '';

  let path = `M ${start.x} ${start.y}`;
  for (let i = 1; i < route.length - 1; i += 1) {
    const before = route[i - 1];
    const corner = route[i];
    const after = route[i + 1];
    if (before === undefined || corner === undefined || after === undefined) continue;
    const bite = Math.min(
      radius,
      (Math.abs(corner.x - before.x) + Math.abs(corner.y - before.y)) / 2,
      (Math.abs(after.x - corner.x) + Math.abs(after.y - corner.y)) / 2,
    );
    if (bite <= 0) {
      path += ` L ${corner.x} ${corner.y}`;
      continue;
    }
    const entry = stepToward(corner, before, bite);
    const exit = stepToward(corner, after, bite);
    path += ` L ${entry.x} ${entry.y} Q ${corner.x} ${corner.y} ${exit.x} ${exit.y}`;
  }

  const end = route[route.length - 1];
  if (end !== undefined && route.length > 1) path += ` L ${end.x} ${end.y}`;
  return path;
}

/**
 * Bottom of one box to the top of another, leaving through `startX` and arriving
 * at `endX`. Given room between them the connector turns once halfway down;
 * without it — dragging a card can leave a target level with or above its
 * source — it drops clear of the source, passes both boxes on whichever side is
 * nearer and comes back into the target's top. Every segment is vertical or
 * horizontal either way, and consecutive segments always change axis.
 */
const routeOrthogonal = (from: Box, to: Box, startX: number, endX: number): Point[] => {
  const startY = from.y + from.height;
  const endY = to.y;

  if (endY - startY >= DETOUR) {
    const lane = Math.round((startY + endY) / 2);
    return simplify([
      { x: startX, y: startY },
      { x: startX, y: lane },
      { x: endX, y: lane },
      { x: endX, y: endY },
    ]);
  }

  const below = startY + DETOUR;
  const above = endY - DETOUR;
  const left = Math.min(from.x, to.x) - DETOUR;
  const right = Math.max(from.x + from.width, to.x + to.width) + DETOUR;
  const side = right - startX + (right - endX) < startX - left + (endX - left) ? right : left;
  return simplify([
    { x: startX, y: startY },
    { x: startX, y: below },
    { x: side, y: below },
    { x: side, y: above },
    { x: endX, y: above },
    { x: endX, y: endY },
  ]);
};

/**
 * The fallback the renderer draws with once a card has been dragged: the lanes
 * the layout reserved describe where the cards used to be, so an edge with a
 * moved endpoint is routed again from the two boxes alone, centre to centre.
 */
export function routeDirect(from: GraphNode, to: GraphNode): Point[] {
  return routeOrthogonal(from, to, from.x + from.width / 2, to.x + to.width / 2);
}

/**
 * Where one of `count` connectors meets a card's edge. Several connectors fan
 * across the middle half of the edge so they leave as distinct lines instead of
 * one thick one; a lone connector sits on the centre, where the eye expects it.
 */
const anchorAt = (slot: Slot, position: number, count: number): number => {
  if (count <= 1) return slot.centre;
  const span = slot.width / 2;
  return Math.round(slot.centre - span / 2 + (span * position) / (count - 1));
};

/**
 * A descending connector: out of the source's bottom, one turn per crossed gap,
 * through the centre of every virtual bend on the way, into the target's top.
 */
const routeChain = (wire: Wire): Point[] => {
  const points: Point[] = [{ x: wire.startX, y: wire.source.y + wire.source.height }];

  for (let segment = 0; segment + 1 < wire.stops.length; segment += 1) {
    const start = wire.stops[segment];
    const end = wire.stops[segment + 1];
    const lane = wire.lanes[segment];
    if (start !== undefined && end !== undefined && lane !== undefined && lane !== null) {
      points.push({ x: start, y: lane }, { x: end, y: lane });
    }
    const bend = wire.chain[segment];
    if (bend !== undefined) {
      points.push({ x: bend.centre, y: Math.round(bend.y + bend.height / 2) });
    }
  }

  points.push({ x: wire.endX, y: wire.target.y });
  return points;
};

export function layoutGraph(resources: Resource[]): GraphLayout {
  /*
   * An attached disk is not a node. It leaves the index before anything else
   * runs, which is what takes its layer, its connector and its lane with it:
   * every later pass reads the index, so absorbing the disk here means no
   * other pass has to know that attachments exist.
   */
  const attached = attachedDisks(resources);
  const absorbed = new Set<string>();
  for (const disks of attached.values()) {
    for (const disk of disks) absorbed.add(disk.urn);
  }

  const index = new Map<string, Resource>();
  for (const resource of resources) {
    if (absorbed.has(resource.urn)) continue;
    index.set(resource.urn, resource);
  }
  if (index.size === 0) return { nodes: [], edges: [], width: 0, height: 0 };

  const links: { from: string; to: string }[] = [];
  const drawn = new Set<string>();
  for (const resource of index.values()) {
    for (const dependency of resource.dependsOn) {
      // A resource that names itself, or names something outside the pod's
      // resource list, has nothing to point at.
      if (dependency === resource.urn || !index.has(dependency)) continue;
      const key = `${resource.urn}\u0000${dependency}`;
      if (drawn.has(key)) continue;
      drawn.add(key);
      links.push({ from: resource.urn, to: dependency });
    }
  }
  links.sort((a, b) => byText(a.from, b.from) || byText(a.to, b.to));

  const depth = new Map<string, number>();
  for (const name of index.keys()) depth.set(name, 0);
  /*
   * A node sits one layer below the deepest node pointing at it, which is a
   * longest-path relaxation. `dependsOn` is not guaranteed acyclic — an
   * `${name.field}` env template can run in both directions — so this is
   * bounded twice rather than recursed: at most one pass per node, and no
   * depth past the last layer a DAG of this size could have. A cycle has no
   * longest path, so its members saturate at the bottom instead of pushing
   * each other down forever.
   */
  const floor = index.size - 1;
  for (let pass = 0; pass < index.size; pass += 1) {
    let moved = false;
    for (const link of links) {
      const below = Math.min((depth.get(link.from) ?? 0) + 1, floor);
      if (below > (depth.get(link.to) ?? 0)) {
        depth.set(link.to, below);
        moved = true;
      }
    }
    if (!moved) break;
  }

  // Keyed by depth rather than indexed by it: a saturated cycle leaves the
  // layers between it and the roots empty, and an empty layer is not a row.
  const rows = new Map<number, Resource[]>();
  for (const [name, resource] of index) {
    const level = depth.get(name) ?? 0;
    const row = rows.get(level) ?? [];
    row.push(resource);
    rows.set(level, row);
  }
  const layers = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
  for (const layer of layers) layer.sort(byName);

  const columns: Slot[][] = layers.map(() => []);
  const columnAt = (level: number): Slot[] => {
    const column = columns[level];
    if (column !== undefined) return column;
    const created: Slot[] = [];
    columns[level] = created;
    return created;
  };

  const slots = new Map<string, Slot>();
  layers.forEach((layer, level) => {
    const column = columnAt(level);
    for (const resource of layer) {
      const slot: Slot = {
        key: resource.urn,
        resource,
        layer: level,
        order: column.length,
        rank: 0,
        width: CARD_WIDTH,
        height: cardHeight(resource, attached.get(resource.urn) ?? []),
        centre: 0,
        y: 0,
        up: [],
        down: [],
      };
      column.push(slot);
      slots.set(resource.urn, slot);
    }
  });

  /*
   * An edge spanning more than one layer becomes a chain of virtual bends, one
   * per layer it would otherwise cut across. From here on every link joins
   * neighbouring layers, which is what lets the ordering and the placement
   * below reason about one gap at a time.
   */
  const wires: Wire[] = [];
  for (const link of links) {
    const source = slots.get(link.from);
    const target = slots.get(link.to);
    if (source === undefined || target === undefined) continue;

    const chain: Slot[] = [];
    const descends = target.layer > source.layer;
    if (descends) {
      let previous = source;
      for (let level = source.layer + 1; level < target.layer; level += 1) {
        const column = columnAt(level);
        const bend: Slot = {
          key: `${link.from}\u0000${link.to}\u0000${level}`,
          resource: null,
          layer: level,
          order: column.length,
          rank: 0,
          width: VIRTUAL_WIDTH,
          height: 0,
          centre: 0,
          y: 0,
          up: [],
          down: [],
        };
        column.push(bend);
        chain.push(bend);
        previous.down.push(bend);
        bend.up.push(previous);
        previous = bend;
      }
      previous.down.push(target);
      target.up.push(previous);
    }

    wires.push({
      from: link.from,
      to: link.to,
      source,
      target,
      descends,
      chain,
      stops: [],
      lanes: [],
      startX: 0,
      endX: 0,
    });
  }

  /*
   * Crossing reduction: a node wants to sit where the neighbours in the layer
   * the sweep just came from already sit, and the median of their positions is
   * that wish in one number. Down then up propagates it both ways; a node with
   * nothing to follow keeps its position rather than drifting to one end.
   */
  for (let pass = 0; pass < ORDER_PASSES; pass += 1) {
    const downward = pass % 2 === 0;
    for (let step = 1; step < columns.length; step += 1) {
      const column = columnAt(downward ? step : columns.length - 1 - step);
      for (const slot of column) {
        const neighbours = downward ? slot.up : slot.down;
        const median = weightedMedianOf(neighbours.map((neighbour) => neighbour.order));
        slot.rank = median === null ? slot.order : median;
      }
      column.sort((a, b) => a.rank - b.rank || a.order - b.order || byText(a.key, b.key));
      column.forEach((slot, position) => {
        slot.order = position;
      });
    }
  }

  for (const column of columns) {
    let span = 0;
    let previous: Slot | null = null;
    for (const slot of column) {
      if (previous !== null) span += minimumGap(previous, slot);
      previous = slot;
    }
    let cursor = -span / 2;
    previous = null;
    for (const slot of column) {
      if (previous !== null) cursor += minimumGap(previous, slot);
      slot.centre = cursor;
      previous = slot;
    }
  }

  /*
   * X placement: each node is pulled toward the middle of what it connects to,
   * and its layer pushes back only as far as its order and its gaps require. A
   * parent of two children therefore ends up centred over them, and a run of
   * single links comes out as one straight column.
   */
  for (let pass = 0; pass < PLACEMENT_PASSES; pass += 1) {
    const downward = pass % 2 === 0;
    for (let step = 0; step < columns.length; step += 1) {
      const column = columnAt(downward ? step : columns.length - 1 - step);
      const desired = column.map((slot) => {
        const neighbours = downward ? slot.up : slot.down;
        const middle = medianOf(neighbours.map((neighbour) => neighbour.centre));
        return middle === null ? slot.centre : middle;
      });
      const settled = settle(column, desired);
      column.forEach((slot, position) => {
        const centre = settled[position];
        if (centre !== undefined) slot.centre = centre;
      });
    }
  }

  const layerHeights = columns.map((column) =>
    column.reduce((tallest, slot) => Math.max(tallest, slot.height), 0),
  );
  const layerTops: number[] = [];
  let top = CANVAS_PADDING;
  columns.forEach((column, level) => {
    const height = layerHeights[level] ?? 0;
    layerTops.push(top);
    for (const slot of column) {
      slot.y = top;
      // A bend spans its whole layer, so a connector crosses the row in one
      // straight run instead of jinking about inside it.
      if (slot.resource === null) slot.height = height;
    }
    top += height + GAP_Y;
  });
  const contentBottom = top - GAP_Y;

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  for (const column of columns) {
    for (const slot of column) {
      // Whole pixels: the cards are DOM boxes and the connectors are strokes
      // between their edges, and both go soft on a half pixel.
      slot.centre = Math.round(slot.centre);
      // A bend has no width, so it claims canvas only as far as the connector
      // running through it actually reaches.
      minX = Math.min(minX, slot.centre - slot.width / 2);
      maxX = Math.max(maxX, slot.centre + slot.width / 2);
    }
  }
  const shift = CANVAS_PADDING - minX;
  for (const column of columns) {
    for (const slot of column) slot.centre += shift;
  }

  const nodes: GraphNode[] = [];
  for (const column of columns) {
    for (const slot of column) {
      const { resource } = slot;
      if (resource === null) continue;
      nodes.push({
        resource,
        attached: attached.get(resource.urn) ?? [],
        x: slot.centre - slot.width / 2,
        y: slot.y,
        width: slot.width,
        height: slot.height,
      });
    }
  }

  const outgoing = new Map<Slot, Wire[]>();
  const incoming = new Map<Slot, Wire[]>();
  for (const wire of wires) {
    const out = outgoing.get(wire.source) ?? [];
    out.push(wire);
    outgoing.set(wire.source, out);
    const into = incoming.get(wire.target) ?? [];
    into.push(wire);
    incoming.set(wire.target, into);
  }
  /*
   * Anchors are ordered by where each connector is heading — the centre of the
   * next box on its route — so a fan spreads in the direction its lines are
   * actually going and none of them cross before leaving the card.
   */
  for (const [slot, group] of outgoing) {
    group.sort((a, b) => {
      const left = a.chain[0]?.centre ?? a.target.centre;
      const right = b.chain[0]?.centre ?? b.target.centre;
      return left - right || byText(a.to, b.to);
    });
    group.forEach((wire, position) => {
      wire.startX = anchorAt(slot, position, group.length);
    });
  }
  for (const [slot, group] of incoming) {
    group.sort((a, b) => {
      const left = a.chain[a.chain.length - 1]?.centre ?? a.source.centre;
      const right = b.chain[b.chain.length - 1]?.centre ?? b.source.centre;
      return left - right || byText(a.from, b.from);
    });
    group.forEach((wire, position) => {
      wire.endX = anchorAt(slot, position, group.length);
    });
  }

  const crossings = new Map<number, Crossing[]>();
  for (const wire of wires) {
    if (!wire.descends) continue;
    wire.stops = [wire.startX, ...wire.chain.map((bend) => bend.centre), wire.endX];
    for (let segment = 0; segment + 1 < wire.stops.length; segment += 1) {
      const start = wire.stops[segment];
      const end = wire.stops[segment + 1];
      // One entry per segment whether or not it turns, so the two arrays stay
      // in step and the route can read them together.
      wire.lanes.push(null);
      if (start === undefined || end === undefined || start === end) continue;
      const gap = wire.source.layer + segment;
      const queue = crossings.get(gap) ?? [];
      queue.push({ wire, segment, left: Math.min(start, end), right: Math.max(start, end) });
      crossings.set(gap, queue);
    }
  }

  /*
   * Lanes. Two connectors crossing the same gap sideways must not turn at the
   * same height, or their horizontal runs merge into one line that belongs to
   * neither. Runs are therefore packed left to right into as few lanes as will
   * hold them: a lane takes another run only once its last one has finished to
   * the left, so overlap is impossible by construction while a symmetric fan
   * still turns at a single height instead of walking down a staircase. Fewer
   * lanes also means the ones in use are spread further apart in the gap.
   *
   * A run that is already straight claims no lane at all: it has no horizontal
   * part to collide with, and a lane spent on it would only crowd the rest.
   */
  for (const [gap, queue] of crossings) {
    queue.sort(
      (a, b) =>
        a.left - b.left ||
        a.right - b.right ||
        byText(a.wire.from, b.wire.from) ||
        byText(a.wire.to, b.wire.to),
    );

    const claimed: number[] = [];
    const assigned: number[] = [];
    for (const run of queue) {
      // Strictly clear, not merely touching: two runs that meet at a point read
      // as one line with a junction in it.
      const free = claimed.findIndex((reach) => reach < run.left);
      if (free === -1) {
        assigned.push(claimed.length);
        claimed.push(run.right);
        continue;
      }
      claimed[free] = run.right;
      assigned.push(free);
    }

    const gapTop = (layerTops[gap] ?? 0) + (layerHeights[gap] ?? 0);
    queue.forEach((run, position) => {
      const lane = assigned[position] ?? 0;
      const offset = Math.round((GAP_Y * (lane + 1)) / (claimed.length + 1));
      run.wire.lanes[run.segment] = gapTop + Math.min(Math.max(offset, 1), GAP_Y - 1);
    });
  }

  const edges: GraphEdge[] = wires.map((wire) => {
    /* The source resource is what explains the edge, because the reference is
       its own field: a Route's rule, an App's mount, a database's disk. */
    const declarer = index.get(wire.from);
    const dependency = index.get(wire.to);
    const link =
      declarer === undefined || dependency === undefined ? null : edgeLink(declarer, dependency);

    if (wire.descends) return { from: wire.from, to: wire.to, points: routeChain(wire), link };
    const { source, target } = wire;
    const sourceBox = {
      x: source.centre - source.width / 2,
      y: source.y,
      width: source.width,
      height: source.height,
    };
    const targetBox = {
      x: target.centre - target.width / 2,
      y: target.y,
      width: target.width,
      height: target.height,
    };
    return {
      from: wire.from,
      to: wire.to,
      points: routeOrthogonal(sourceBox, targetBox, wire.startX, wire.endX),
      link,
    };
  });

  return {
    nodes,
    edges,
    width: maxX - minX + 2 * CANVAS_PADDING,
    height: contentBottom + CANVAS_PADDING,
  };
}
