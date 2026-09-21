import type { ReactElement } from 'react';

/**
 * The Brainpod mark, transcribed from the marketing site (`components/Marks.tsx`),
 * which is upstream of this app. Path data from the owner's own artwork, never
 * redrawn.
 *
 * The site sizes its marks with `em` because its hero type is a viewport clamp;
 * a desktop window needs both, so these take a pixel `size` while a call site
 * that wants `em` overrides `width`/`height` in CSS — a CSS rule outranks the
 * svg's geometry presentation attributes.
 */

/** The Brainpod mark's viewBox is taller than it is wide: width over height. */
export const BRAINPOD_RATIO = 19.89 / 21.47;

export function BrainpodMark({
  size,
  mono = false,
}: {
  size: number;
  mono?: boolean;
}): ReactElement {
  return (
    <svg
      width={BRAINPOD_RATIO * size}
      height={size}
      viewBox="0 0 19.89 21.47"
      aria-hidden="true"
      focusable="false">
      <path
        fill="currentColor"
        d="M6.14451 14.0293C6.40601 10.6845 9.10699 7.98496 12.4518 7.72417C13.9056 7.61047 15.2721 7.95227 16.4275 8.6181C19.3971 3.77042 16.8525 0 11.8044 0H0.974935C0.436304 0 0 0.436305 0 0.974936V19.7588C0 20.2377 0.348192 20.6485 0.821449 20.7217C3.05485 21.0677 5.18734 20.5604 7.5785 18.8087C6.56306 17.5091 6.00382 15.8363 6.14451 14.0293Z"
      />
      {/*
        The lobe carries the EU blue, so the mark inverts with the OS. On an
        inverted surface the blue has nothing to sit against, so `mono` drops it
        to a tint of the surrounding ink instead.
      */}
      <path
        fill={mono ? 'currentColor' : 'var(--color-brand)'}
        opacity={mono ? '0.55' : undefined}
        d="M16.4282 8.61755C16.2939 8.83642 16.1497 9.05812 15.9926 9.28125C12.6742 13.9989 9.9938 17.0395 7.57849 18.8096C8.83767 20.422 10.7982 21.4601 13.0018 21.4601C16.8006 21.4601 19.8803 18.3804 19.8803 14.5816C19.8803 12.0305 18.4904 9.80567 16.4282 8.61755Z"
      />
    </svg>
  );
}
