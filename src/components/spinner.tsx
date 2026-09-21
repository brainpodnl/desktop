import { Loader2 } from 'lucide-react';
import type { ReactElement } from 'react';

import { cx } from '@/lib/cx';

/**
 * The site's running indicator: lucide's `Loader2` in `currentColor`, so it
 * inherits whatever it sits on — a brand fill, a row's muted text. The stroke
 * is heavier than lucide's default because the glyph is small.
 *
 * `prefers-reduced-motion` is handled globally in the token layer, which
 * neutralises every animation duration; no JS gate is needed.
 */
export function Spinner({
  size = 16,
  className,
}: {
  size?: number;
  className?: string;
}): ReactElement {
  return (
    <Loader2
      size={size}
      strokeWidth={2.2}
      aria-hidden="true"
      className={cx('animate-spin', className)}
    />
  );
}
