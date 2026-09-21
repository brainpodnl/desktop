import { useRef, type ReactElement } from 'react';

import { cx } from '@/lib/cx';
import { useTheme, type ThemePreference } from '@/lib/theme';

/**
 * The appearance control, drawn the way macOS draws it: not a dropdown and not
 * a segmented control, but three miniatures of the window itself. A palette is
 * the one setting whose result can be shown rather than named, and showing it
 * is what makes the choice take no reading at all.
 *
 * Each miniature is this app and not a generic window — sidebar, content pane,
 * and the three-node graph in the middle of it — so the preview answers "what
 * will Brainpod look like" rather than "what is dark mode".
 */

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

export function ThemePicker(): ReactElement {
  const { preference, setPreference } = useTheme();
  const group = useRef<HTMLDivElement | null>(null);

  /*
   * A radio group owns its arrow keys and holds exactly one tab stop, so Tab
   * moves past the whole control rather than through three copies of it. That
   * is the native behaviour of every picker this one is imitating.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;

    event.preventDefault();
    const index = OPTIONS.findIndex((option) => option.value === preference);
    const next = OPTIONS[(index + step + OPTIONS.length) % OPTIONS.length];
    if (next === undefined) return;
    setPreference(next.value);

    // The focused element moved out from under the roving tab stop.
    group.current?.querySelector<HTMLButtonElement>('[data-checked="true"]')?.focus();
  };

  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label="Appearance"
      onKeyDown={onKeyDown}
      className="grid w-[330px] grid-cols-3 gap-2.5">
      {OPTIONS.map((option) => {
        const checked = option.value === preference;

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            data-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => setPreference(option.value)}
            className="group flex flex-col items-center gap-2 rounded-lg outline-none">
            <span
              className={cx(
                'block w-full overflow-hidden rounded-[10px] transition-[box-shadow,opacity]',
                /*
                 * The ring is the selection and the border is the window edge,
                 * so they are the same thing at two weights rather than a ring
                 * stacked on a border: one elevation, one boundary.
                 */
                checked
                  ? 'shadow-[0_0_0_2px_var(--color-brand)]'
                  : 'opacity-85 shadow-[0_0_0_1px_var(--color-border)] group-hover:opacity-100 group-focus-visible:shadow-[0_0_0_2px_var(--color-ring)]',
              )}>
              {option.value === 'system' ? <SplitWindow /> : <MiniWindow theme={option.value} />}
            </span>

            <span
              className={cx(
                'text-ui transition-colors',
                checked ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}>
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * System, as macOS shows it: the two palettes in one frame, split down the
 * middle. The dark half is a whole second window laid over the light one and
 * clipped, rather than a half-window beside it, so the graph inside lines up
 * across the seam instead of being drawn twice at half scale.
 */
function SplitWindow(): ReactElement {
  return (
    <span className="relative block">
      <MiniWindow theme="light" />
      <span className="absolute inset-0 block [clip-path:inset(0_0_0_50%)]">
        <MiniWindow theme="dark" />
      </span>
    </span>
  );
}

/**
 * Brainpod at 1/9 scale. Everything here is the real composition: a vibrant
 * rail on the left, an opaque pane on the right, the traffic lights floating
 * over both, and a route above two backends — which is the shape of nearly
 * every pod.
 *
 * `theme` scopes the palette instead of hardcoding hexes, so this stays correct
 * the day a token moves.
 */
function MiniWindow({ theme }: { theme: 'light' | 'dark' }): ReactElement {
  return (
    <span className={cx('flex aspect-[8/5] w-full bg-background', theme)}>
      {/* The sidebar, at the same 30% of the width it occupies in the window. */}
      <span className="relative flex w-[30%] shrink-0 flex-col gap-[3px] border-r border-border bg-secondary pt-[11px] pr-1.5 pl-2">
        <span className="absolute top-[5px] left-[5px] flex gap-[2.5px]">
          <span className="size-[3px] rounded-full bg-destructive" />
          <span className="size-[3px] rounded-full bg-warn" />
          <span className="size-[3px] rounded-full bg-ok" />
        </span>

        <span className="h-[3px] w-full rounded-full bg-foreground/25" />
        <span className="h-[3px] w-3/4 rounded-full bg-foreground/12" />
        <span className="h-[3px] w-4/5 rounded-full bg-foreground/12" />
      </span>

      {/* The graph: one route over two backends, wired the way the canvas
          draws it — down out of the parent, across, and down into each child. */}
      <span className="relative flex-1">
        <svg
          viewBox="0 0 100 62"
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
          className="absolute inset-0 size-full">
          <path
            d="M50 24 V31 H27 V38 M50 31 H73 V38"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            className="text-border"
          />
          <rect x="36" y="14" width="28" height="10" rx="3" className="fill-kind-route/35" />
          <rect x="13" y="38" width="28" height="10" rx="3" className="fill-kind-app/35" />
          <rect x="59" y="38" width="28" height="10" rx="3" className="fill-kind-postgres/35" />
        </svg>
      </span>
    </span>
  );
}
