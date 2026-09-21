import type { ReactElement, ReactNode } from 'react';

import { cx } from '@/lib/cx';

/**
 * The marketing hero's chip, at whatever size a surface needs it.
 *
 * It is the one device this window borrows from the site, and it carries the
 * same meaning everywhere it appears: a thing that can be on this machine or
 * not. Lit, it holds its subject's own colour; unlit, it drops to a tint of
 * the surrounding ink, so presence reads before any label does.
 *
 * Shared rather than copied: the agent fan deals four of these and the command
 * line stands on one, and a chip that drifted between the two would be two
 * chips.
 */
export function Tile({
  size,
  tint,
  tilt = 0,
  className,
  children,
}: {
  size: number;
  /** The subject's own colour, or null for a chip that holds nothing yet. */
  tint: string | null;
  /** The chip's own turn. Its contents cancel it, so a mark stays level. */
  tilt?: number;
  className?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <span
      className={cx(
        'flex items-center justify-center bg-gradient-to-br from-tile-from to-tile-to ring-1 shadow-tile ring-foreground/15 [&_svg]:text-current',
        tint === null ? 'text-foreground/35' : '',
        className,
      )}
      style={{
        width: size,
        height: size,
        // One radius ladder, held at every scale: a fixed class would be a pill
        // at 20px and a square at 64px. The share is the site's own: a chip
        // rounded far enough to read as a card, not a rounded square.
        borderRadius: size * 0.3,
        color: tint ?? undefined,
      }}>
      {/*
       * The chips fan; the logos do not. Cursor's mark is a drawn cube with its
       * own perspective and Gemini's is a four-pointed star — turned with the
       * card, a cube reads as a cube that fell over. A mark is an object in the
       * world, not ink printed on the card.
       */}
      <span className="block" style={{ transform: tilt === 0 ? undefined : `rotate(${-tilt}deg)` }}>
        {children}
      </span>
    </span>
  );
}
