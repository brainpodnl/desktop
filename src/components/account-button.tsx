import { Settings2 } from 'lucide-react';
import type { ReactElement } from 'react';

import { openSettings } from '@/lib/bridge';
import { SETTINGS_SHORTCUT } from '@/lib/platform';

/**
 * The account, at the foot of the sidebar, and the way into Settings.
 *
 * It used to be a menu holding one row. Once sign out moved into the Settings
 * window there was nothing left in it to open, so the identity is the control
 * and it goes where the account is managed — which is what the sidebar footer
 * does in every app that has one. The shortcut rides along in the tooltip
 * because a shortcut nobody can find is folklore.
 */
export function AccountButton({
  email,
  endpoint,
}: {
  email: string | null;
  /** The API this session is signed in to; only its host is worth the room. */
  endpoint: string | null;
}): ReactElement {
  const name = email ?? 'Signed in';

  return (
    <div className="shrink-0 border-t border-border p-2">
      <button
        type="button"
        title={`Settings  ${SETTINGS_SHORTCUT}`}
        onClick={() => void openSettings()}
        className="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring/50">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand/15 text-ui-sm font-semibold text-brand uppercase">
          {name.slice(0, 1)}
        </span>

        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-ui font-medium">{name}</span>
          {endpoint !== null && (
            <span className="truncate font-mono text-ui-mono text-faint">{host(endpoint)}</span>
          )}
        </span>

        {/* Quiet until the row is reached: the endpoint under the address is
            what this footer is for at rest, and a permanent glyph beside it
            would read as a second thing to do. */}
        <Settings2
          size={13}
          aria-hidden="true"
          className="shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      </button>
    </div>
  );
}

/**
 * `https://api.brainpod.io/` reduced to what tells one deployment from
 * another. A malformed endpoint is shown as stored rather than hidden: it is
 * the thing to notice if the app is talking to the wrong place.
 */
function host(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}
