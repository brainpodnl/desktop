import type { ReactElement } from 'react';

/**
 * A section heading in the sidebar: `Pods`, `Connections`, `Updates`.
 *
 * One definition rather than three copies of the same class list, because the
 * rail's rhythm is the thing being kept — three above, one below, and every
 * section's first row the same distance under its heading. Three literals in
 * three files agreed until one of them did not.
 *
 * A real heading, so the rail has an outline a screen reader can move through;
 * `Connections` was a `<p>` and silently sat outside it.
 */
export function RailHeading({ children }: { children: string }): ReactElement {
  return (
    <h2 className="px-4 pt-3 pb-1 text-ui-sm font-medium text-foreground/70">{children}</h2>
  );
}
