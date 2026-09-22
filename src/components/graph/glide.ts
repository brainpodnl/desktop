import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';

/**
 * Carrying a scroll container to a position instead of putting it there.
 *
 * `scrollTo({ behavior: 'smooth' })` cannot do this job. It is cancelled by
 * any other write to `scrollLeft`, and this canvas writes to `scrollLeft` for
 * reasons that have nothing to do with the animation: the overscroll padding
 * is re-measured whenever the pane changes size, and the pane changes size at
 * exactly the moment the graph is being carried somewhere — the details rail
 * opening is what asked for the move in the first place. The smooth scroll was
 * killed a frame after it started and the rest of the distance was covered in
 * a single frame, which is the jump this exists to remove.
 *
 * So the follow is a first-order lag rather than a tween: it asks where it
 * should be on every frame and closes a fixed fraction of whatever distance is
 * left. A tween has to know its endpoint when it starts, and the endpoint here
 * is still moving — the rail is animating open, the padding is being
 * re-measured behind it, and the browser is clamping the scroll to a maximum
 * that changes with both. A lag has no endpoint to be wrong about: it reads
 * the live position back out of the element each frame, so every one of those
 * corrections is simply where the next frame starts from.
 *
 * It is a lag and not a spring for the same reason. A spring carries velocity,
 * and velocity aimed at a target that is itself being animated overshoots and
 * then hunts; the window's springs move things whose destination is known.
 */

/**
 * The time constant: the follow closes 1 - 1/e of the remaining distance every
 * `TAU` seconds. ~63% in 110ms and ~95% inside a third of a second, with the
 * first frames the fastest — an ease-out, which is what a canvas being handed
 * to you should feel like.
 */
const TAU = 0.11;

/** Below half a pixel there is nothing left for a scroller to show. */
const EPSILON = 0.5;

/**
 * The longest one follow may run. The destination is re-read every frame, so
 * a geometry that never settles — a resize the user is still dragging — would
 * otherwise keep a rAF loop alive for as long as they held the pointer down.
 */
const LIMIT = 1.2;

/**
 * The largest slice of time one frame may be worth. A tab that was in the
 * background comes back with a gap of seconds between frames, and without this
 * the first frame after it would close the whole distance at once — a jump,
 * arrived at through the one path that exists to avoid jumps.
 */
const MAX_STEP = 1 / 30;

/** Where the view has to be, asked again on every frame. */
export type Destination = () => { left: number; top: number } | null;

export type Glide = {
  /** Carry the view to `destination`, or put it there outright if `instant`. */
  follow: (destination: Destination, instant: boolean) => void;
  /** Let go of the canvas, because the hand has taken it over. */
  stop: () => void;
  /** Whether a follow is in flight, and is therefore already tracking. */
  running: () => boolean;
};

export function useGlide(view: RefObject<HTMLElement | null>): Glide {
  const frame = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (frame.current === null) return;
    cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);

  // A frame left pending past the unmount would write to a detached element.
  useEffect(() => stop, [stop]);

  const follow = useCallback(
    (destination: Destination, instant: boolean) => {
      stop();

      const started = performance.now();
      let previous = started;

      const step = (now: number) => {
        frame.current = null;

        const element = view.current;
        const to = destination();
        if (element === null || to === null) return;

        const dx = to.left - element.scrollLeft;
        const dy = to.top - element.scrollTop;
        const arrived = Math.abs(dx) < EPSILON && Math.abs(dy) < EPSILON;

        if (instant || arrived || now - started >= LIMIT * 1000) {
          element.scrollLeft = to.left;
          element.scrollTop = to.top;
          return;
        }

        /*
         * Floored at zero as well as capped. `requestAnimationFrame` hands its
         * callback the time the frame began, and that instant can predate the
         * call that scheduled it: the first step of a follow started partway
         * through a frame is handed a `now` from before `started`. A negative
         * slice makes the exponential greater than one, which turns the step
         * into a push away from the destination — the canvas lurched a few
         * dozen pixels the wrong way before every reveal, which is the last
         * of the jumps.
         */
        const slice = Math.min(Math.max(now - previous, 0) / 1000, MAX_STEP);
        const closed = 1 - Math.exp(-slice / TAU);
        previous = now;
        /* Read back rather than accumulated: whatever else moved the scroller
           between two frames — a clamp, the padding compensation — is where
           this one starts, and is therefore never fought over. */
        element.scrollLeft += dx * closed;
        element.scrollTop += dy * closed;

        frame.current = requestAnimationFrame(step);
      };

      /*
       * A frame late, deliberately. The commit that asks for a follow is also
       * the commit that mounts the rail, and the geometry the destination is
       * measured against is the geometry once that has been laid out.
       */
      frame.current = requestAnimationFrame(step);
    },
    [stop, view],
  );

  const running = useCallback(() => frame.current !== null, []);

  return useMemo(() => ({ follow, stop, running }), [follow, stop, running]);
}
