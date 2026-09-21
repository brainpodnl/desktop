import { X } from 'lucide-react';
import type { MouseEvent, ReactElement } from 'react';

import { Button } from '@/components/button';
import { RailHeading } from '@/components/rail-heading';
import { CopyButton } from '@/components/tunnel-dialog';
import type { Tunnel } from '@/lib/bridge';

/**
 * Every open connection, at the bottom of the sidebar. It sits under the pods
 * list and over the account footer because a tunnel outlives whatever the user
 * is looking at in the graph: it has to stay on screen, and closing it has to
 * stay one click away, while they move around the pod.
 *
 * Nothing here paints a surface. The sidebar is a macOS vibrancy material and
 * a card stacked inside it would be a second translucent layer, which is where
 * legibility collapses — so the panel is separated by a hairline and nothing else.
 */
export function ConnectionsPanel({
  tunnels,
  onClose,
  onShowConnection,
}: {
  tunnels: Tunnel[];
  onClose: (id: string) => void;
  onShowConnection: (tunnel: Tunnel) => void;
}): ReactElement | null {
  // An empty panel holding a heading states nothing; the pods list takes the
  // space back instead.
  if (tunnels.length === 0) return null;

  return (
    /* `pb-3` answers the `pt-3` the heading brings, the same as `Updates`:
       the band owns its breathing room, and it sits outside the scrolling
       list so it is not something the user has to scroll to reach. */
    <div className="shrink-0 border-t border-border pb-3">
      <RailHeading>Connections</RailHeading>

      {/*
        Past four connections this scrolls rather than squeezing the pods list,
        which is the sidebar's primary content.

        The cap is deliberately not a whole number of rows. At exactly four the
        list ends on a row boundary and reads as complete, which is the one
        thing a scrolling list must not do; half a row showing under the fourth
        is what says there is more below.
      */}
      <ul className="max-h-[13rem] overflow-y-auto">
        {tunnels.map((tunnel) => (
          <ConnectionRow
            key={tunnel.id}
            tunnel={tunnel}
            onClose={onClose}
            onShowConnection={onShowConnection}
          />
        ))}
      </ul>
    </div>
  );
}

function ConnectionRow({
  tunnel,
  onClose,
  onShowConnection,
}: {
  tunnel: Tunnel;
  onClose: (id: string) => void;
  onShowConnection: (tunnel: Tunnel) => void;
}): ReactElement {
  // Valkey has no DSN, so the button copies the address the client needs
  // instead of sitting there dead.
  const copyable = tunnel.dsn ?? `${tunnel.host}:${tunnel.localPort}`;
  const copyLabel = tunnel.dsn === null ? 'address' : 'DSN';
  // A resource can hold several tunnels, so the name alone names two rows.
  // The port is what tells them apart, on screen and to a screen reader.
  const named = `${tunnel.resource} on ${tunnel.localPort}`;

  // Closing unmounts the row, so the × the keyboard is standing on disappears
  // and focus falls to <body>. The survivor is chosen while the row is still
  // in the document, and focused a frame later, after React has committed the
  // removal. A last row is left alone: there is nothing to move to, and
  // inventing a target would be worse than falling through.
  const closeTunnel = (event: MouseEvent<HTMLButtonElement>) => {
    const row = event.currentTarget.closest('li');
    const sibling = row?.nextElementSibling ?? row?.previousElementSibling ?? null;
    const survivor = sibling?.querySelector('[data-close-tunnel]') ?? null;

    onClose(tunnel.id);

    if (survivor instanceof HTMLElement) requestAnimationFrame(() => survivor.focus());
  };

  return (
    <li className="flex items-center gap-0.5 px-2">
      {/* The row's destination is the credentials, not the node: someone who
          comes back to an open tunnel wants the password or the DSN, which the
          graph does not hold. */}
      <button
        type="button"
        onClick={() => onShowConnection(tunnel)}
        title={`Show the connection to ${named}`}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset">
        <span className="size-1.5 shrink-0 animate-halo rounded-full bg-ok" />

        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui font-medium">{tunnel.resource}</span>

          {/*
            Never truncated. The port is the whole point of this row — it is
            what the user types into a client — and an ellipsis lands on it
            first because it is the tail of the string.
          */}
          <span data-selectable className="block font-mono text-ui-mono text-foreground/70">
            {`${tunnel.host}:${tunnel.localPort}`}
          </span>
        </span>
      </button>

      <CopyButton label={copyLabel} value={copyable} />

      <Button
        variant="ghost"
        size="icon-xs"
        data-close-tunnel
        aria-label={`Close the tunnel to ${named}`}
        onClick={closeTunnel}
        className="shrink-0 text-faint">
        <X />
      </Button>
    </li>
  );
}
