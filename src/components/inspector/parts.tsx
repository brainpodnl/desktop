import { ChevronDown } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

import { CopyButton } from '@/components/tunnel-dialog';
import { cx } from '@/lib/cx';

/**
 * The inspector's grammar, in one file so every section states a fact the same
 * way: a hairline-separated band with a quiet heading, and inside it rows of
 * label over value — the label in the UI face, the value in mono wherever it is
 * something the user may copy into a client, a config file or a shell.
 *
 * The rail is one continuous column rather than a tab strip. A pod's resource
 * has few enough facts to read in one scroll, and tabs would hide the one fact
 * the panel was opened for behind a guess about which tab it is on.
 */

export function Section({
  title,
  note,
  action,
  children,
}: {
  title: string;
  /** One line that teaches the band, where the facts alone would not. */
  note?: string;
  /** A control that belongs to the whole band, aligned to its heading. */
  action?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    /* The rule belongs to the top of a band, never the bottom: the last band
       in the column would otherwise draw a line under the panel's own end. */
    <section className="border-t border-border px-4 pt-3.5 pb-4 first:border-t-0">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 className="text-ui-sm font-medium text-muted-foreground">{title}</h3>
        {action}
      </div>

      {note !== undefined && <p className="mt-0.5 text-ui-sm text-faint">{note}</p>}

      <div className="mt-2 flex flex-col gap-1.5">{children}</div>
    </section>
  );
}

/**
 * The window's one dropdown. A native `<select>`: in a WKWebView it opens the
 * real macOS popup menu, with the keyboard handling and the type-ahead that
 * come with it, which is a great deal more than a hand-built listbox would get
 * right. Only the closed state is restyled, so the control matches the window
 * while the menu stays the system's.
 *
 * It is shared rather than re-styled per call site: three copies of the same
 * control in one window is how a control drifts.
 */
export function Select({
  label,
  value,
  options,
  size = 'sm',
  tone = 'field',
  mono = false,
  disabled = false,
  onChange,
}: {
  /** The accessible name; these appear beside their own label or alone. */
  label: string;
  value: string;
  /** A disabled option labels a state the control is in without being a place to go. */
  options: { value: string; label: string; disabled?: boolean }[];
  size?: 'xs' | 'sm';
  /**
   * Which surface the control is standing on. A `field` wears the input
   * boundary, because in a fact row it is the only thing saying a value can be
   * edited. A `toolbar` control has no row to distinguish itself from and
   * every neighbour is a button, so it takes the button's own surface — the
   * bright input rule beside a quiet outline button is two control languages
   * in one 28px row.
   */
  tone?: 'field' | 'toolbar';
  mono?: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
}): ReactElement {
  const compact = size === 'xs';
  const toolbar = tone === 'toolbar';

  return (
    /* `w-fit`, not `w-full`: dropped into a fact row the value cell would
       stretch it to the full column, and a 212px control holding the word
       `1x` outweighs everything it sits under. The menu is the system's, so
       the closed control only ever has to fit its own widest option. */
    <div className="relative w-fit shrink-0">
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={cx(
          'w-full appearance-none border py-0 outline-none transition-colors',
          'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40',
          'disabled:pointer-events-none disabled:opacity-50',
          /* The button ladder's radius, so a picker and a button standing in
             the same row are cut from the same corner. */
          toolbar
            ? 'rounded-[min(var(--radius-md),12px)] border-border bg-secondary hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]'
            : 'rounded-lg border-input bg-background hover:border-foreground/25',
          mono ? 'font-mono text-ui-mono' : 'text-ui',
          compact ? 'h-6 pr-6 pl-2' : 'h-7 pr-7 pl-2.5',
        )}>
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>

      <ChevronDown
        size={compact ? 11 : 13}
        aria-hidden="true"
        className={cx(
          'pointer-events-none absolute top-1/2 -translate-y-1/2',
          toolbar ? 'text-muted-foreground' : 'text-faint',
          compact ? 'right-1.5' : 'right-2',
        )}
      />
    </div>
  );
}

/**
 * One labelled fact. The label column is fixed so that every value in the panel
 * starts on the same x — a ragged left edge down a column of thirty facts is
 * what makes a dense panel read as a dump rather than a table.
 */
export function Fact({
  label,
  children,
  align = 'center',
}: {
  label: string;
  children: ReactNode;
  /** `start` for a value that wraps to several lines, so the label stays with its first. */
  align?: 'center' | 'start';
}): ReactElement {
  return (
    <div
      className={cx(
        'group grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-0.5',
        align === 'center' ? 'items-center' : 'items-start',
      )}>
      <span
        className={cx(
          'truncate text-ui-sm text-muted-foreground',
          align === 'start' && 'pt-px',
        )}
        title={label}>
        {label}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * A value the user reads, and — when `copy` is set — one they take away. The
 * copy control rides the row on hover and on keyboard focus rather than sitting
 * there permanently: at twenty facts, twenty always-lit buttons are the loudest
 * thing in the panel and none of them is the point.
 */
export function Value({
  value,
  mono = false,
  copy = false,
  label,
  className,
}: {
  value: string;
  mono?: boolean;
  copy?: boolean;
  /** What the copy control announces, when it is not the fact's own label. */
  label?: string;
  className?: string;
}): ReactElement {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span
        data-selectable
        title={value}
        className={cx(
          'min-w-0 flex-1 truncate',
          mono ? 'font-mono text-ui-mono' : 'text-ui',
          className,
        )}>
        {value}
      </span>

      {copy && (
        <span className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 has-[:focus-visible]:opacity-100">
          <CopyButton label={label ?? 'value'} value={value} />
        </span>
      )}
    </div>
  );
}

/**
 * A value that is long, unbreakable and worth reading whole: an image
 * reference, a command line, an environment value. It scrolls sideways under a
 * mask rather than wrapping, because a line break inserted into a digest or a
 * DSN is a line break the user will copy.
 */
export function ScrollingValue({
  value,
  copy = false,
  label,
  className,
}: {
  value: string;
  copy?: boolean;
  label?: string;
  className?: string;
}): ReactElement {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span
        data-selectable
        className={cx(
          'min-w-0 flex-1 overflow-x-auto font-mono text-ui-mono whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          className,
        )}
        style={{
          maskImage: 'linear-gradient(to right, #000 calc(100% - 24px), transparent)',
          WebkitMaskImage: 'linear-gradient(to right, #000 calc(100% - 24px), transparent)',
        }}>
        {value}
      </span>

      {copy && (
        <span className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 has-[:focus-visible]:opacity-100">
          <CopyButton label={label ?? 'value'} value={value} />
        </span>
      )}
    </div>
  );
}

/**
 * What a section says when the API answered with nothing. It states the absence
 * in the product's own terms — "no environment variables" — because a section
 * that renders empty is indistinguishable from a section that failed to load.
 */
export function Absent({ children }: { children: ReactNode }): ReactElement {
  return <p className="text-ui text-faint">{children}</p>;
}
