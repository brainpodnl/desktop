import type { ReactElement } from 'react';

import { Fact, ScrollingValue, Section } from '@/components/inspector/parts';
import { MASK } from '@/components/tunnel-dialog';
import type { Resource } from '@/lib/bridge';

/**
 * What other resources can reference about this one.
 *
 * This is the answer to the question the graph provokes and cannot settle: an
 * app needs a database's URI, and the way to reach it is not a value to copy
 * but a reference to paste — `${db.uri}` — which the control plane resolves at
 * deploy time. So the reference is what the copy control takes, and the
 * resolved value is shown underneath it as confirmation rather than as the
 * thing to use.
 *
 * Two states are not failures and must not read as any. A secret resolves to
 * nothing because the API never returns a password; an unresolved variable is
 * one the current revision cannot answer yet, such as a hostname the platform
 * has not assigned.
 */
export function Variables({ resource }: { resource: Resource }): ReactElement | null {
  // A kind with nothing to export — a Disk, a Config — gets no band at all
  // rather than a band explaining that it has nothing to export.
  if (resource.variables.length === 0) return null;

  return (
    <Section title="Variables" note="Paste a reference into another resource's environment.">
      {resource.variables.map((variable) => (
        <Fact key={variable.name} label={variable.name} align="start">
          <ScrollingValue value={variable.ref} copy label={`${variable.name} reference`} />
          <Resolved variable={variable} />
        </Fact>
      ))}
    </Section>
  );
}

/**
 * What the reference above resolves to, in the one line under it.
 *
 * A secret is drawn rather than described. The row used to carry the sentence
 * "Secret · tunnel only", which put prose in the column every other row fills
 * with a value, and repeated it for every secret a database exports — two or
 * three times in six rows, saying the same thing each time. The window already
 * owns a mark for a value that exists and may not be shown, on the tunnel's own
 * password row, so the same mask does the work here: the column stays a column
 * of values, and the eye can tell a hidden one from a stated one without
 * reading a word.
 *
 * Where it is revealed is a tooltip and a screen-reader label rather than a
 * line of its own, because it is the answer to a question the mask provokes —
 * not a fact the panel needs to state six times over.
 */
function Resolved({
  variable,
}: {
  variable: Resource['variables'][number];
}): ReactElement | null {
  if (variable.secret) {
    return (
      <p
        title="Never returned by the API. Open a tunnel to reveal it."
        /* Pulled in hard: JetBrains Mono advances 0.6em per glyph, so twelve
           bullets at their natural pitch read as a dotted rule rather than as
           a covered value. Tightened they group into one mark, and they carry
           the value colour rather than the faint one — this row holds
           something, and the column should not look like it skipped it. */
        className="truncate font-mono text-ui-mono tracking-[-0.18em] text-muted-foreground select-none">
        <span aria-hidden="true">{MASK}</span>
        <span className="sr-only">Secret, revealed only inside a tunnel</span>
      </p>
    );
  }

  if (!variable.resolved) {
    /* Not an error and not a value: this revision simply cannot answer it yet,
       which the mask would misstate as something being withheld. */
    return <p className="truncate text-ui-sm text-faint">Not resolved yet</p>;
  }

  // A resolved variable the API answered with nothing gets no line at all: an
  // empty one is a row of blank space that reads as a value that failed to load.
  if (variable.value === null || variable.value.length === 0) return null;

  return (
    <p className="truncate text-ui-sm text-faint" title={variable.description ?? undefined}>
      {variable.value}
    </p>
  );
}
