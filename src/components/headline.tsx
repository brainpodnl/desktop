import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { AnimatePresence, motion, useReducedMotion, type Transition } from 'motion/react';

import {
  MARKS,
  MARK_SCALE,
  type DestinationId,
} from '@/components/marks/agents';
import { BrainpodMark, BRAINPOD_RATIO } from '@/components/marks/brainpod';

/**
 * The "Build it in Claude. Host it on Brainpod." hero from the marketing site
 * (`components/Headline.tsx`): two lines, each ending in a tilted tile.
 *
 * Pocket stacked it over four lines and measured the container to pick a font
 * size, because a phone is narrow and React Native has no `clamp()`. A window is
 * wide, and `text-display` is a viewport clamp, so the type sizes itself and the
 * line springs to the width of whichever name is on screen.
 */

/**
 * The rotation order lives in the table as a ring, so advancing is a lookup
 * rather than index arithmetic against a list.
 */
const DESTINATIONS: Record<DestinationId, { name: string; brand: string; next: DestinationId }> = {
  claude: { name: 'Claude', brand: 'var(--mark-claude)', next: 'cursor' },
  cursor: { name: 'Cursor', brand: 'var(--mark-cursor)', next: 'codex' },
  codex: { name: 'Codex', brand: 'var(--mark-codex)', next: 'claude' },
};

/** How long each destination stays on screen, matching the site's hero. */
const ROTATION_INTERVAL = 2800;

/** The site's resize spring, for the word slot growing and shrinking. */
const WIDTH_SPRING: Transition = { type: 'spring', stiffness: 320, damping: 36 };

/** The site's enter spring, for the word itself sliding up through the slot. */
const SLIDE_SPRING: Transition = { type: 'spring', stiffness: 280, damping: 32 };

const INSTANT: Transition = { duration: 0 };

/**
 * The marks take a pixel size while the hero is sized in `em`, so the wrapper's
 * em box drives the glyph and the pixel argument is only the intrinsic fallback
 * a CSS width overrides.
 */
const GLYPH_FALLBACK = 24;

/** The Brainpod mark is the one glyph that is not square, and it sits smaller. */
const BRAINPOD_EM = 0.52;

export function Headline(): ReactElement {
  const reduced = useReducedMotion() === true;
  const [paused, setPaused] = useState(false);
  const [id, setId] = useState<DestinationId>('claude');

  useEffect(() => {
    // Frozen under reduced motion, and while the reader is pointing at it.
    if (reduced || paused) return;

    const timer = window.setInterval(
      () => setId((current) => DESTINATIONS[current].next),
      ROTATION_INTERVAL,
    );

    return () => window.clearInterval(timer);
  }, [reduced, paused]);

  const destination = DESTINATIONS[id];
  const Mark = MARKS[id];
  const markSize = 0.52 * MARK_SCALE[id];

  return (
    <h1
      className="text-center text-display font-light"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}>
      <span className="whitespace-nowrap">Build it in</span>
      {/* Only a phone-width window breaks before the destination. */}
      <br className="sm:hidden" />
      <span className="whitespace-nowrap">
        <Tile color={destination.brand}>
          <Glyph em={markSize}>
            <Mark size={GLYPH_FALLBACK} />
          </Glyph>
        </Tile>
        <span className="font-extrabold">
          <Teleprompter value={destination.name} reduced={reduced} />
        </span>
      </span>
      <br />
      <span className="whitespace-nowrap">
        <span className="font-extrabold">Host</span> it on
      </span>
      <span className="whitespace-nowrap">
        <Tile rotate="rotate-[3.5deg]">
          <Glyph em={BRAINPOD_EM} ratio={BRAINPOD_RATIO}>
            <BrainpodMark size={GLYPH_FALLBACK} />
          </Glyph>
        </Tile>
        <span className="font-extrabold">Brainpod.</span>
      </span>
    </h1>
  );
}

/**
 * A clipped slot the width of the current word, so the name can slide in from
 * below while the line re-centres around it. Pocket stacked every name in one
 * fixed column to avoid measuring; a window is wide enough that the line should
 * actually tighten around the short words instead.
 */
function Teleprompter({ value, reduced }: { value: string; reduced: boolean }): ReactElement {
  const sizer = useRef<HTMLSpanElement | null>(null);
  const [box, setBox] = useState<{ width: number | null; animate: boolean }>({
    width: null,
    animate: false,
  });

  const sync = useCallback((animate: boolean) => {
    const element = sizer.current;
    if (element === null) return;

    setBox({ width: Math.ceil(element.getBoundingClientRect().width), animate });
  }, []);

  useLayoutEffect(() => {
    const element = sizer.current;
    if (element === null) return;

    // The first measurement and every reflow land instantly: only a new word
    // is worth a spring, and the clamp resizes the text on every window drag.
    sync(false);

    const observer = new ResizeObserver(() => sync(false));
    observer.observe(element);

    return () => observer.disconnect();
  }, [sync]);

  useLayoutEffect(() => {
    sync(true);
  }, [value, sync]);

  return (
    <motion.span
      animate={box.width === null ? undefined : { width: box.width }}
      transition={box.animate && !reduced ? WIDTH_SPRING : INSTANT}
      className="relative inline-block h-[0.94em] overflow-hidden align-baseline">
      {/* An unclipped copy, purely to be measured. */}
      <span
        ref={sizer}
        aria-hidden="true"
        className="pointer-events-none absolute top-0 left-0 leading-[0.94] whitespace-nowrap opacity-0">
        {value}.
      </span>

      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={value}
          initial={reduced ? false : { y: '105%' }}
          animate={{ y: '0%' }}
          exit={{ y: '-105%' }}
          transition={reduced ? INSTANT : SLIDE_SPRING}
          className="block leading-[0.94] whitespace-nowrap">
          {value}.
        </motion.span>
      </AnimatePresence>
    </motion.span>
  );
}

/**
 * The tilted chip a mark sits in. It is lifted well above the baseline because
 * an inline box hangs from it, and it tints its contents through `color`, which
 * a descendant rule hands to the mark's `currentColor` fill. Left unset, the
 * mark inherits the headline's ink, which is what the Brainpod glyph wants.
 */
function Tile({
  children,
  rotate = '-rotate-[4.5deg]',
  color,
}: {
  children: ReactNode;
  rotate?: string;
  color?: string;
}): ReactElement {
  return (
    <span
      aria-hidden="true"
      className={`mx-[0.15em] inline-flex h-[0.95em] w-[0.95em] -translate-y-[0.21em] items-center justify-center overflow-hidden rounded-[0.16em] bg-gradient-to-br from-tile-from to-tile-to align-middle ring-1 shadow-tile ring-foreground/12 [&_svg]:text-current ${rotate}`}
      style={{ color }}>
      {children}
    </span>
  );
}

/**
 * An em box the mark fills. `ratio` is width over height, for the one glyph
 * that is not square; a square box would stretch it.
 */
function Glyph({
  em,
  ratio = 1,
  children,
}: {
  em: number;
  ratio?: number;
  children: ReactNode;
}): ReactElement {
  return (
    <span
      className="block [&>svg]:h-full [&>svg]:w-full"
      style={{ width: `${em * ratio}em`, height: `${em}em` }}>
      {children}
    </span>
  );
}
