import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type ReactElement } from 'react';

import { Button } from '@/components/button';
import { Absent, Section, Select } from '@/components/inspector/parts';
import { useAuth } from '@/lib/auth';
import type { EventKind, EventLevel, Resource, ResourceEvent } from '@/lib/bridge';
import { cx } from '@/lib/cx';
import { errorMessage, eventsQuery } from '@/lib/queries';

/**
 * What the resource has been doing, from the one stream the API exposes.
 *
 * There is no logs endpoint in Brainpod: events *are* the logs, with an app's
 * stdout, the platform's own notices and HTTP access records arriving through
 * the same query under different kinds.
 *
 * This band is a preview of that stream, not a reader of it. A fifteen-minute
 * window can run to a hundred lines, and a hundred lines in a 360px rail is a
 * scroller inside a scroller that is worse at reading logs than the console is
 * at everything. So it shows the newest handful — enough to answer "is it
 * doing anything, and is any of it red" — and hands the rest to the console,
 * which has the width, the paging and the search.
 */

/** The window every resource is read at. Long enough to cover a deploy. */
const RANGE = '15m';

/** As many lines as answer the glance. Past this the console is the answer. */
const PREVIEW = 5;

const SKELETON_ROWS = [0, 1, 2, 3];

/**
 * Levels in the API's own vocabulary, shortened to a column that stays aligned.
 * `error` and `warn` are the two the eye is scanning for, so they are the two
 * that carry colour; the rest recede rather than competing with the message.
 */
const LEVEL_STYLE: Record<EventLevel, string> = {
  error: 'text-destructive',
  warn: 'text-warn-strong',
  info: 'text-muted-foreground',
  debug: 'text-faint',
  trace: 'text-faint',
};

/**
 * Which kinds this resource can actually produce. A route answers requests, so
 * its stream is HTTP access; everything else that runs writes logs. Offering a
 * filter that can only ever return nothing is a filter that teaches the wrong
 * thing about the product.
 */
function kindOptions(resource: Resource): { value: string; label: string }[] {
  const own =
    resource.kind === 'Route'
      ? { value: 'httpAccess', label: 'Requests' }
      : { value: 'app', label: 'Logs' };

  return [{ value: '', label: 'Everything' }, own, { value: 'platform', label: 'Platform' }];
}

export function Activity({
  pod,
  resource,
  onFollow,
}: {
  pod: string;
  resource: Resource;
  /** The pane's one outbound link, so a browser that refuses lands in its banner. */
  onFollow: (url: string) => void;
}): ReactElement | null {
  const { status } = useAuth();
  const [kind, setKind] = useState<EventKind | null>(null);
  /*
   * A disk and a config are declarations, not processes, and the events API
   * does not accept them. The urn is withheld rather than the band merely
   * returning null further down: this query polls every five seconds, and a
   * request nothing renders would keep going for as long as the panel stays
   * open on that node.
   */
  const eventful = resource.kind !== 'Disk' && resource.kind !== 'Config';
  const events = useQuery(eventsQuery(pod, eventful ? resource.urn : null, kind, RANGE));

  /*
   * Where the console keeps this pod, which is the only place a full event
   * history can be read. Absent until the shared CLI config has been read, and
   * the link waits for it rather than guessing an endpoint.
   */
  const consoleHref =
    status === null
      ? null
      : `${status.consoleEndpoint.replace(/\/+$/, '')}/pods/${encodeURIComponent(pod)}`;

  /*
   * Newest first, decided here rather than trusted from the API: this band
   * shows the top of the stream, so the most recent line is the one that has
   * to be at the top.
   */
  const ordered = useMemo(
    () =>
      [...(events.data ?? [])]
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
        .slice(0, PREVIEW),
    [events.data],
  );

  // A band that can only ever be empty is worth nothing.
  if (!eventful) return null;

  return (
    <Section
      title="Recent events"
      action={
        <Select
          label="Event kind"
          size="xs"
          value={kind ?? ''}
          options={kindOptions(resource)}
          onChange={(next) => setKind(next === '' ? null : (next as EventKind))}
        />
      }>
      {events.isPending ? (
        SKELETON_ROWS.map((row) => (
          <div key={row} className="flex items-center gap-2 py-1">
            <span className="h-2 w-12 shrink-0 rounded-full bg-foreground/10" />
            <span
              className="h-2 rounded-full bg-foreground/[0.07]"
              style={{ width: `${70 - row * 12}%` }}
            />
          </div>
        ))
      ) : events.isError ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-ui text-destructive">
            {errorMessage(events.error, 'Could not read this resource’s activity.')}
          </p>
          <Button variant="outline" size="xs" title="Retry" onClick={() => void events.refetch()} />
        </div>
      ) : ordered.length === 0 ? (
        <Absent>Nothing in the last 15 minutes.</Absent>
      ) : (
        /*
         * The same gesture the Scale band uses when its controls belong
         * somewhere else: the lines recede and the way to the real thing comes
         * forward. Hover is not the only path to it — `group-focus-within`
         * brings it up for the keyboard too, and the control keeps its own
         * pointer events so it is clickable while the rows below it are not.
         */
        <div className="group relative -mx-1 px-1">
          <div className="transition-all group-hover:pointer-events-none group-hover:opacity-30 group-hover:blur-[2px] group-hover:select-none group-focus-within:pointer-events-none group-focus-within:opacity-30 group-focus-within:blur-[2px]">
            {ordered.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </div>

          {consoleHref !== null && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              <Button
                variant="outline"
                size="sm"
                title="The console holds the full history, with paging and search."
                onClick={() => onFollow(consoleHref)}
                className="pointer-events-auto">
                View all in the console
              </Button>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

/**
 * One event, in three columns: when, what kind of line it is, and the line
 * itself. The time and marker columns are fixed and tabular so the bodies
 * start on one x — that left edge is the single thing that separates a log
 * from a paragraph, and it is why the body does not wrap: a log line reads by
 * scanning down the starts, and a wrapped line breaks the column it belongs to.
 *
 * The full line is never lost. It scrolls sideways under a mask, the same way
 * every other unbreakable value in this panel does.
 */
function EventRow({ event }: { event: ResourceEvent }): ReactElement {
  const at = new Date(event.timestamp);
  const time = Number.isNaN(at.getTime())
    ? '--:--:--'
    : at.toLocaleTimeString(undefined, { hour12: false });

  return (
    <div className="grid grid-cols-[3.75rem_2.6rem_minmax(0,1fr)] items-baseline gap-x-2 py-[3px]">
      <span className="font-mono text-ui-mono tabular-nums text-faint">{time}</span>
      <Marker event={event} />

      <span
        data-selectable
        title={event.body}
        className="min-w-0 overflow-x-auto font-mono text-ui-mono whitespace-nowrap text-foreground/80 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{
          maskImage: 'linear-gradient(to right, #000 calc(100% - 20px), transparent)',
          WebkitMaskImage: 'linear-gradient(to right, #000 calc(100% - 20px), transparent)',
        }}>
        {event.body}
      </span>
    </div>
  );
}

/**
 * What kind of line this is. It holds its own column rather than riding the
 * message, because the column is what makes a level scannable: an `error` in a
 * hundred lines is found by looking down one narrow strip, not by reading.
 *
 * The three kinds fill it with the one fact each of them has — a log level, a
 * response status, a platform reason — so the column is never empty and never
 * means two things at once.
 */
function Marker({ event }: { event: ResourceEvent }): ReactElement {
  if (event.kind === 'httpAccess') {
    const status = event.status;

    return (
      <span
        title={[event.method, event.path, event.durationMs === null ? null : `${event.durationMs}ms`]
          .filter((part) => part !== null)
          .join(' ')}
        className={cx(
          'truncate font-mono text-ui-mono tabular-nums',
          status === null
            ? 'text-faint'
            : status >= 500
              ? 'text-destructive'
              : status >= 400
                ? 'text-warn-strong'
                : 'text-ok',
        )}>
        {status ?? '···'}
      </span>
    );
  }

  if (event.kind === 'platform') {
    // A platform notice carries a reason rather than a level — `BackOff`,
    // `Scheduled`. It is the resource's own vocabulary, so it is shown whole
    // and the tooltip carries it when the column cannot.
    return (
      <span
        title={event.reason ?? 'platform'}
        className="truncate font-mono text-ui-mono text-brand">
        {event.reason ?? 'system'}
      </span>
    );
  }

  return (
    <span className={cx('truncate font-mono text-ui-mono', LEVEL_STYLE[event.level ?? 'info'])}>
      {event.level ?? 'info'}
    </span>
  );
}
