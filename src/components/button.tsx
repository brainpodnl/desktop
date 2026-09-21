import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from 'react';

import { Spinner } from '@/components/spinner';
import { cx } from '@/lib/cx';

export type ButtonVariant =
  | 'default'
  | 'outline'
  | 'secondary'
  | 'ghost'
  | 'destructive'
  | 'brand';

export type ButtonSize = 'default' | 'xs' | 'sm' | 'lg' | 'icon' | 'icon-xs' | 'icon-sm';

export type ButtonProps = Omit<ComponentPropsWithoutRef<'button'>, 'children'> & {
  title?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  children?: ReactNode;
};

/**
 * Transcribed from the site's `components/ui/button.tsx`.
 * `active:translate-y-px` is its signature press.
 *
 * `BASE` states the border's *width* but never its colour. It used to carry
 * `border-transparent`, which silently beat every variant that wanted a real
 * edge: with no `tailwind-merge` in this project, two utilities from the same
 * family are decided by emission order, and Tailwind emits `border-transparent`
 * after `border-border`. `outline` therefore rendered with no border at all.
 * Every variant now names its own colour, so there is only ever one of them.
 */
const BASE =
  "inline-flex shrink-0 items-center justify-center border bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0";

const VARIANTS: Record<ButtonVariant, string> = {
  default: 'border-transparent bg-primary text-primary-foreground hover:bg-primary/80',
  outline: 'border-border bg-background hover:bg-muted hover:text-foreground',
  secondary:
    'border-transparent bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]',
  ghost: 'border-transparent hover:bg-muted hover:text-foreground',
  // Tinted, never filled: a destructive action states itself without shouting.
  destructive:
    'border-transparent bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20',
  /*
   * The site's sign-in pill. `text-on-brand` rather than its literal
   * `text-white`, because dark mode lifts the brand to #5b8dee where white
   * would land around 2.8:1.
   */
  brand: 'border-transparent bg-brand text-on-brand hover:bg-brand/90',
};

/*
 * Each entry states the glyph size for a bare lucide child outright, rather
 * than the site's base-plus-override pair. The site can layer a `size-3` over a
 * base `size-4` because `cn` runs tailwind-merge and drops the loser before it
 * ever reaches CSS; we have neither dependency, and Tailwind emits `size-3`
 * *ahead* of `size-4`, so an override would lose the cascade and a 16px glyph
 * would sit in a 24px button. `:not([class*='size-'])` still yields to a call
 * site that sizes its own icon.
 */
const GLYPH_4 = "[&_svg:not([class*='size-'])]:size-4";

const SIZES: Record<ButtonSize, string> = {
  default: `h-8 gap-1.5 px-2.5 ${GLYPH_4}`,
  xs: "h-6 gap-1 px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
  sm: "h-7 gap-1 px-2.5 text-[0.8rem] [&_svg:not([class*='size-'])]:size-3.5",
  lg: `h-9 gap-1.5 px-2.5 ${GLYPH_4}`,
  icon: `size-8 ${GLYPH_4}`,
  'icon-xs': "size-6 [&_svg:not([class*='size-'])]:size-3",
  'icon-sm': `size-7 ${GLYPH_4}`,
};

/*
 * Radius is resolved to exactly one class for the same reason the glyph sizes
 * are: without tailwind-merge, two radius utilities in one class list are
 * settled by Tailwind's emission order, not by the order written here, so the
 * brand pill silently lost `rounded-full` to the base `rounded-lg`.
 */
const RADII: Record<ButtonSize, string> = {
  default: 'rounded-lg',
  xs: 'rounded-[min(var(--radius-md),10px)]',
  sm: 'rounded-[min(var(--radius-md),12px)]',
  lg: 'rounded-lg',
  icon: 'rounded-lg',
  'icon-xs': 'rounded-[min(var(--radius-md),10px)]',
  'icon-sm': 'rounded-[min(var(--radius-md),12px)]',
};

export function Button({
  title,
  variant = 'default',
  size = 'default',
  loading = false,
  icon,
  children,
  disabled = false,
  type = 'button',
  className,
  ...rest
}: ButtonProps): ReactElement {
  const label = children ?? title;
  // `title` doubles as the label, so it is only worth a native tooltip when
  // `children` supplied the label instead — otherwise it would repeat itself.
  const tooltip = children === undefined ? undefined : title;

  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      title={tooltip}
      className={cx(
        BASE,
        variant === 'brand' ? 'rounded-full' : RADII[size],
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}>
      {loading ? (
        <Spinner />
      ) : (
        <>
          {icon}
          {label}
        </>
      )}
    </button>
  );
}
