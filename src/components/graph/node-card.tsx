import {
  Copy,
  Cpu,
  ExternalLink,
  Globe,
  HardDrive,
  Link,
  Tag,
  type LucideIcon,
} from 'lucide-react';
import type { ReactElement } from 'react';

import { Button } from '@/components/button';
import { KIND_STYLE, tint } from '@/components/graph/kinds';
import { readiness, TONE_FILL } from '@/components/graph/readiness';
import {
  cardHeight,
  chipRows,
  chipsFor,
  hasFooter,
  routeUrl,
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
 * The card's selectable surface and its footer action are siblings rather
 * than nested, because a button inside a button is not a thing the DOM has.
 */
export function NodeCard({
  resource,
  selected,
  busy,
  onSelect,
  onOpenTunnel,
  onOpenRoute,
}: {
  resource: Resource;
  selected: boolean;
  busy: boolean;
  onSelect: (name: string) => void;
  onOpenTunnel: (resource: Resource) => void;
  onOpenRoute: (resource: Resource) => void;
}): ReactElement {
  const kind = KIND_STYLE[resource.kind];
  const Glyph = kind.icon;
  const rows = chipRows(chipsFor(resource));
  const state = readiness(resource);
  const url = routeUrl(resource);

  return (
    <div
      className={cx(
        // The focus ring belongs to the card, not to the invisible surface
        // inside it; `>button` keeps the footer's own buttons from lighting it.
        'w-[260px] rounded-xl border bg-card transition-colors',
        'has-[>button:focus-visible]:border-ring has-[>button:focus-visible]:ring-3 has-[>button:focus-visible]:ring-ring/50',
        // Elevation is declared once, by selection. Hover only firms the edge.
        selected ? 'border-foreground/25 shadow-raised' : 'hover:border-foreground/20',
      )}
      style={{ height: cardHeight(resource) }}>
      {/* No `aria-label` on the surface: a label replaces the whole subtree in
          the accessible-name computation, which would silence the readiness
          dot and every chip. The name is built from the card's own content —
          name, kind, status, facts — so what is heard is what is shown. */}
      <button
        type="button"
        data-node-surface
        aria-pressed={selected}
        onClick={() => onSelect(resource.name)}
        className="block w-full rounded-xl px-3 py-3 text-left outline-none">
        <span className="flex items-start gap-2.5">
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg"
            style={{ backgroundColor: tint(kind.accent), color: kind.accent }}>
            <Glyph size={16} />
          </span>

          <span className="min-w-0 flex-1">
            <span className="block truncate text-ui-section font-semibold">{resource.name}</span>
            <span className="block truncate text-ui-sm text-muted-foreground">{kind.label}</span>
          </span>

          <span
            role="img"
            aria-label={`${resource.name} is ${state.label.toLowerCase()}`}
            className={cx('mt-1.5 size-2 shrink-0 rounded-full', TONE_FILL[state.tone])}
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

      {hasFooter(resource) && (
        /* `data-node-footer` is how the graph knows not to start a drag here:
           this control has to stay pressable.

           One action per card, and the kind decides which: a route is a thing
           to visit, a database a thing to connect to. Nothing else has one. */
        <div data-node-footer className="flex items-center justify-end border-t px-3 py-2">
          {url === null ? (
            /* A loading Button swaps its label for a spinner, so the accessible
               name has to come from `aria-label` rather than the text.
               `secondary`, not the default ink fill: on a dark card the filled
               variant is a near-white slab that outweighs the node it sits in.

               Opening is all the card does. A tunnel, once open, is managed in
               the sidebar — the card would otherwise have to grow a list,
               because a resource can carry several tunnels at once. So the
               button never changes into anything; it opens another one. */
            <Button
              variant="secondary"
              size="sm"
              title="Open tunnel"
              aria-label={`Open tunnel to ${resource.name}`}
              loading={busy}
              onClick={() => onOpenTunnel(resource)}
            />
          ) : (
            /* The URL is the tooltip rather than the label: a hostname is
               longer than the card and already sits in the chip above. */
            <Button
              variant="secondary"
              size="sm"
              icon={<ExternalLink />}
              title={url}
              aria-label={`Open ${url} in your browser`}
              onClick={() => onOpenRoute(resource)}>
              Open
            </Button>
          )}
        </div>
      )}
    </div>
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
