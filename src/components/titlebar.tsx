import type { ReactElement, ReactNode } from 'react';

/**
 * The window's only chrome, and it is not a bar. `tauri.conf.json` overlays the
 * traffic lights on a transparent title bar, so there is nothing to draw here:
 * a strip with a background and a hairline would cut the vibrant sidebar off at
 * the top and give the window a seam no Mac app has.
 *
 * What remains is the drag region. It floats over both panes, which each keep
 * `pt-[38px]` of clearance so their content passes under it rather than into
 * the traffic lights.
 *
 * `title` is for the Settings window and only for it: a utility window states
 * what it is, a document window does not. The pod window passes nothing and
 * keeps the bare strip it has always had.
 */
export function Titlebar({ title, children }: { title?: string; children?: ReactNode }): ReactElement {
  return (
    // Inert by default: the strip lies over live content, so only the two
    // layers below opt back into receiving the pointer. The left padding is
    // exactly where the traffic lights end: AppKit leaves 60pt between the
    // close button's left edge and the zoom button's right one, and
    // `tauri.conf.json` puts that left edge on 16.
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex h-[38px] items-center justify-end gap-2 pr-3 pl-[76px]">
      {/* The drag surface, behind the controls and painting nothing. */}
      <div data-tauri-drag-region className="pointer-events-auto absolute inset-0" />

      {/* Centred on the window, not on the space left over beside the traffic
          lights — which is where AppKit puts it. */}
      {title !== undefined && (
        <span className="pointer-events-none absolute inset-x-0 text-center text-ui font-semibold">
          {title}
        </span>
      )}

      {/* Later in the DOM and a layer up, so a click on a control is a click on
          the control rather than the start of a window drag. */}
      <div className="pointer-events-auto relative z-10 flex items-center gap-2">{children}</div>
    </div>
  );
}
