import type { ReactElement } from 'react';

import { KIND_STYLE, tint } from '@/components/graph/kinds';
import { Absent, Section } from '@/components/inspector/parts';
import { readiness, TONE_FILL, TONE_TEXT } from '@/components/graph/readiness';
import type { Resource } from '@/lib/bridge';
import { cx } from '@/lib/cx';

/**
 * How this resource is joined to the rest of the pod, in both directions.
 *
 * The graph already draws the edges; what it cannot draw is *why* each one
 * exists, because a line has no room for a mount path or an environment
 * variable's name. That reason is the whole value of this band: `depends on`
 * with no explanation restates an arrow, while "DATABASE_URL" or "mounted at
 * /data" is the thing the user came to find out.
 *
 * The reverse direction is not an API field at all. Nothing in the control
 * plane answers "what points at this", so it is derived here by reading every
 * other resource's own references — which is also how the graph's edges are
 * produced, one layer down.
 */

/**
 * Why `from` points at `to`, in as few words as the spec justifies. Ordered by
 * how specific the answer is: a route's rule and a mount path name an exact
 * place, while an environment reference names the variable that carries it.
 */
function reason(from: Resource, to: string): string | null {
  const rule = from.rules.find((entry) => entry.backend === to);
  if (rule !== undefined) return `${rule.path} → :${rule.port}`;

  const mount = from.mounts.find((entry) => entry.target === to);
  if (mount !== undefined) {
    return mount.file === null ? `mounted at ${mount.path}` : `${mount.file} at ${mount.path}`;
  }

  if (from.diskRef === to) return 'data disk';

  // `${db.uri}` in a value: the variable's own name is what the user will
  // recognise, since that is what their code reads.
  const variable = from.env.find((entry) => entry.value.includes(`\${${to}.`));
  if (variable !== undefined) return variable.name;

  return null;
}

export function Wiring({
  resource,
  resources,
  onSelect,
}: {
  resource: Resource;
  /** Every resource in this pod at this revision, which is what edges resolve against. */
  resources: Resource[];
  onSelect: (name: string) => void;
}): ReactElement {
  const upstream = resource.dependsOn.flatMap((name) => {
    const target = resources.find((entry) => entry.name === name);
    return target === undefined ? [] : [{ resource: target, reason: reason(resource, name) }];
  });

  const downstream = resources.flatMap((entry) =>
    entry.dependsOn.includes(resource.name)
      ? [{ resource: entry, reason: reason(entry, resource.name) }]
      : [],
  );

  return (
    <>
      <Section title="Depends on">
        {upstream.length === 0 ? (
          <Absent>This resource points at nothing else in the pod.</Absent>
        ) : (
          upstream.map((edge) => (
            <RelatedRow
              key={edge.resource.urn}
              resource={edge.resource}
              reason={edge.reason}
              onSelect={onSelect}
            />
          ))
        )}
      </Section>

      <Section title="Used by">
        {downstream.length === 0 ? (
          <Absent>Nothing else in the pod points at this one.</Absent>
        ) : (
          downstream.map((edge) => (
            <RelatedRow
              key={edge.resource.urn}
              resource={edge.resource}
              reason={edge.reason}
              onSelect={onSelect}
            />
          ))
        )}
      </Section>
    </>
  );
}

/**
 * One end of an edge, as a control rather than a label: the panel is the only
 * place in the window where a relationship can be followed, and a name that
 * names a node the user can see is a name worth clicking.
 */
function RelatedRow({
  resource,
  reason,
  onSelect,
}: {
  resource: Resource;
  reason: string | null;
  onSelect: (name: string) => void;
}): ReactElement {
  const kind = KIND_STYLE[resource.kind];
  const Glyph = kind.icon;
  const state = readiness(resource);

  return (
    <button
      type="button"
      onClick={() => onSelect(resource.name)}
      title={`Show ${resource.name}`}
      /* The sidebar's row treatment, not a bespoke one: a focus state that is
         byte-identical to hover is no focus state, and `outline-none` takes
         the UA's last fallback away with it. */
      className="-mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset focus-visible:outline-none">
      <span
        aria-hidden="true"
        className="flex size-6 shrink-0 items-center justify-center rounded-md"
        style={{ backgroundColor: tint(kind.accent), color: kind.accent }}>
        <Glyph size={12} />
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-ui font-medium">{resource.name}</span>
          <span
            aria-hidden="true"
            className={cx('size-1.5 shrink-0 rounded-full', TONE_FILL[state.tone])}
          />
        </span>

        {/* The kind is the fallback, not the first choice: it repeats the glyph
            beside it, while the reason is the one thing nothing else states.

            A resource that is not ready says so in words here. The graph's own
            card has no room for that and leans on its dot; the rail has the
            room, and a colour is not a status to anyone who cannot see it. */}
        <span className="block truncate text-ui-sm">
          {state.tone !== 'ok' && (
            <span className={cx('font-medium', TONE_TEXT[state.tone])}>{`${state.label} · `}</span>
          )}
          <span className="text-muted-foreground">{reason ?? kind.label}</span>
        </span>
      </span>
    </button>
  );
}
