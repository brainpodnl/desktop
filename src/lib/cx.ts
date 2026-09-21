/**
 * The site pairs `clsx` with `tailwind-merge`; neither dependency earns its
 * weight here, because every call site appends its own `className` last and
 * equal-specificity utilities are resolved by cascade order anyway.
 */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
