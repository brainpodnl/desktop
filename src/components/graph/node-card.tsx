import { Copy, Cpu, Globe, HardDrive, Link, Tag, type LucideIcon } from 'lucide-react';
import type { CSSProperties, ReactElement } from 'react';

import { KindTile } from '@/components/graph/kind-tile';
import { KIND_STYLE, tint } from '@/components/graph/kinds';
import { readiness, TONE_FILL, TONE_RING } from '@/components/graph/readiness';
import {
  cardHeight,
  chipRows,
  chipsFor,
  type Chip,
  type ChipIcon,
} from '@/components/graph/layout';
import type { Resource } from '@/lib/bridge';
import { cx } from '@/lib/cx';

const CHIP_ICONS: Record<ChipIcon, LucideIcon> = {
  instance: Cpu,
  replicas: Copy,
  hostname: Link,
  domain: Globe,
  version: Tag,
  size: HardDrive,
};

/*
 * Readiness is deliberately not computed here. The inspector states the same
 * resource's status in words a few pixels away, and a card that decided its
 * own colour drifted from it: a `Degraded` workload painted amber on the node
 * and red in the panel, because the local version answered `healthy` first and
 * treated every phase as a warning. One module, one verdict.
 */

/**
 * One node of the graph: the console's anatomy — tinted icon tile, name over
 * kind, readiness dot, a row of fact chips — in this window's tokens.
 *
 * The card carries no actions. Opening a tunnel or a route is offered once,
 * in the details rail, where the resource it acts on is already the subject
 * and where an open tunnel is managed afterwards — two copies of one control
 * only raise the question of whether they do the same thing.
 */
export function NodeCard({
  resource,
  attached,
  selected,
  onSelect,
}: {
  resource: Resource;
  /**
   * The disks mounted on this resource, drawn as strips across its foot. They
   * are resources in their own right — each one selects and inspects like any
   * node — they simply have no card of their own to stand on.
   */
  attached: Resource[];
  /** The selected resource's canonical URN. */
  selected: string | null;
  onSelect: (urn: string) => void;
}): ReactElement {
  const kind = KIND_STYLE[resource.kind];
  const rows = chipRows(chipsFor(resource));
  const state = readiness(resource);
  const isSelected = selected === resource.urn;

  return (
    <div
      className={cx(
        // The focus ring belongs to the card, not to the surface inside it.
        'w-[260px] overflow-hidden rounded-xl border transition-colors',
        'has-[>button:focus-visible]:border-ring has-[>button:focus-visible]:ring-3 has-[>button:focus-visible]:ring-ring/50',
        /*
         * A hairline of light along the top edge, the way a raised surface
         * catches the room. It is the card's material rather than its
         * elevation — the elevation is the border, declared once — and it is
         * what stops four flat rectangles on a dark well from reading as holes
         * punched in the canvas. On a light palette a white card has no
         * highlight to catch, so the token resolves to nothing there.
         */
        'shadow-[inset_0_1px_0_var(--color-card-sheen)]',
        /*
         * Selection is stated in the resource's own colour rather than in a
         * drop shadow: the card is a hairline object on a recessed canvas, and
         * lifting one node with a blur while its neighbours keep their edge is
         * two elevation systems in one picture. The ring is the same hue the
         * connectors into this node switch to, so what is selected and what it
         * is wired to are one gesture.
         *
         * `--node-accent` carries the kind's `var()` through to utilities that
         * cannot be written as tokens, which is what keeps the ring, the
         * border and the wash from being three inline box-shadows fighting the
         * focus ring for the same property.
         *
         * The wash belongs to selection and to hover only. A resting card
         * tinted by kind looked well on a dark palette and turned a light one
         * into four pastel rectangles — and a Route's accent is green, which
         * on a surface whose other green is the healthy dot is a state the
         * card is not in.
         */
        'ring-[color-mix(in_oklab,var(--node-accent)_26%,transparent)]',
        isSelected
          ? 'border-[color-mix(in_oklab,var(--node-accent)_45%,var(--border))] bg-[color-mix(in_oklab,var(--node-accent)_7%,var(--card))] ring-3'
          : 'border-border bg-card hover:border-[color-mix(in_oklab,var(--node-accent)_35%,var(--border))] hover:bg-[color-mix(in_oklab,var(--node-accent)_5%,var(--card))]',
      )}
      style={
        {
          height: cardHeight(resource, attached),
          '--node-accent': kind.accent,
        } as CSSProperties
      }>
      {/* No `aria-label` on the surface: a label replaces the whole subtree in
          the accessible-name computation, which would silence the readiness
          dot and every chip. The name is built from the card's own content —
          name, kind, status, facts — so what is heard is what is shown. */}
      <button
        type="button"
        data-node-surface
        aria-pressed={isSelected}
        onClick={() => onSelect(resource.urn)}
        className={cx(
          'block w-full px-3 py-3 text-left outline-none',
          attached.length > 0 ? 'rounded-t-xl' : 'rounded-xl',
        )}>
        <span className="flex items-start gap-2.5">
          <KindTile kind={resource.kind} />

          <span className="min-w-0 flex-1">
            <span className="block truncate text-ui-section font-semibold">{resource.name}</span>
            {/* The kind, in the kind's own colour. It was grey, which left the
                hue of a resource living in a 16px tile and a chip — and a
                Postgres and a Valkey two rows apart read as the same object
                until you got close enough to read the word. */}
            <span className="block truncate text-ui-sm font-medium" style={{ color: kind.accent }}>
              {kind.label}
            </span>
          </span>

          <span
            role="img"
            aria-label={`${resource.name} is ${state.label.toLowerCase()}`}
            /* The aura is what makes an 8px dot legible across a canvas at a
               glance. It is the tone's own colour at a tenth, so it reads as
               the dot's own light rather than as a second ring. */
            className={cx(
              'mt-1.5 size-2 shrink-0 rounded-full ring-4',
              TONE_FILL[state.tone],
              TONE_RING[state.tone],
            )}
          />
        </span>

        {rows.length > 0 && (
          <span className="mt-2.5 flex flex-col gap-1.5">
            {rows.map((row) => (
              <span
                key={row.map((chip) => `${chip.icon}:${chip.label}`).join('|')}
                className="flex gap-1.5">
                {row.map((chip) => (
                  <ChipTag key={`${chip.icon}:${chip.label}`} chip={chip} accent={kind.accent} />
                ))}
              </span>
            ))}
          </span>
        )}
      </button>

      {attached.map((disk) => (
        <AttachedDisk
          key={disk.urn}
          disk={disk}
          selected={selected === disk.urn}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

/**
 * A disk on the foot of the card that mounts it.
 *
 * Storage bolted to a machine, which is what a single-referrer disk actually
 * is: it has no address of its own, nothing else can reach it, and as a node
 * it cost a row of canvas and a connector to say "this database keeps its data
 * somewhere". A disk two resources share is the opposite — it is the thing
 * they have in common — and that one keeps its card. Network disks land in
 * that case, not this one.
 *
 * It stays a control, not an ornament: the strip selects the disk and the rail
 * opens on it, the same as clicking a node did.
 */
function AttachedDisk({
  disk,
  selected,
  onSelect,
}: {
  disk: Resource;
  selected: boolean;
  onSelect: (urn: string) => void;
}): ReactElement {
  const accent = KIND_STYLE.Disk.accent;
  const state = readiness(disk);

  return (
    <button
      type="button"
      data-node-surface
      aria-pressed={selected}
      onClick={() => onSelect(disk.urn)}
      /* The hairline is the card's own border colour rather than the kind's:
         the strip is part of the card, and a tinted rule across it would read
         as a second object stacked underneath. */
      className={cx(
        'flex h-[34px] w-full items-center gap-2 border-t border-border/80 px-3 text-left outline-none transition-colors',
        selected ? 'text-foreground' : 'hover:bg-[color-mix(in_oklab,var(--foreground)_4%,transparent)]',
      )}
      style={{ backgroundColor: selected ? tint(accent, 24) : undefined }}>
      <KindTile kind="Disk" size="sm" />

      <span className="min-w-0 flex-1 truncate text-ui font-medium">{disk.name}</span>

      {disk.size !== null && (
        <span className="shrink-0 font-mono text-ui-mono text-faint">{`${disk.size}GB`}</span>
      )}

      <span
        role="img"
        aria-label={`${disk.name} is ${state.label.toLowerCase()}`}
        className={cx('size-1.5 shrink-0 rounded-full', TONE_FILL[state.tone])}
      />
    </button>
  );
}

function ChipTag({ chip, accent }: { chip: Chip; accent: string }): ReactElement {
  const Glyph = CHIP_ICONS[chip.icon];

  return (
    <span
      className="inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-ui-mono"
      style={{ backgroundColor: tint(accent), color: accent }}>
      {/* Heavier stroke: at 11px the default weight thins out to nothing. */}
      <Glyph size={11} strokeWidth={2.5} className="shrink-0" />
      <span title={chip.label} className="truncate">
        {chip.label}
      </span>
    </span>
  );
}
