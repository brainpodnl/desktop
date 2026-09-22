import type { ReactElement } from 'react';

import { KIND_STYLE, tint } from '@/components/graph/kinds';
import type { ResourceKind } from '@/lib/bridge';
import { cx } from '@/lib/cx';

/**
 * The mark a resource is recognised by: its engine's glyph on a chip of its own
 * hue. Two surfaces draw it — the node on the canvas and the header of the
 * details rail — and they were drawing it from two copies of the same four
 * lines, which is how a card and the panel it opens end up a shade apart.
 *
 * The chip is lit rather than flat. A single-value wash at 16% is what every
 * tinted square in every dashboard looks like; a two-stop ramp down its own
 * hue with a hairline of the accent around it gives the mark a surface to sit
 * on, which is most of what separates a graph node from a swatch.
 */
export function KindTile({
  kind,
  size = 'md',
  className,
}: {
  kind: ResourceKind;
  /** `sm` is the 24px version the wiring rows list relationships with. */
  size?: 'md' | 'sm';
  className?: string;
}): ReactElement {
  const style = KIND_STYLE[kind];
  const Glyph = style.icon;
  const small = size === 'sm';

  return (
    <span
      aria-hidden="true"
      className={cx(
        'flex shrink-0 items-center justify-center',
        small ? 'size-6 rounded-md' : 'size-9 rounded-lg',
        className,
      )}
      style={{
        backgroundImage: `linear-gradient(180deg, ${tint(style.accent, 22)}, ${tint(style.accent, 11)})`,
        boxShadow: `inset 0 0 0 1px ${tint(style.accent, 26)}`,
        color: style.accent,
      }}>
      <Glyph size={small ? 12 : 16} />
    </span>
  );
}
