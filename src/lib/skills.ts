import type { Harness } from '@/lib/bridge';

/**
 * The agent skill's staleness rule, in one place.
 *
 * It is read by the installer at the foot of the sidebar and by the updates
 * band above it, and the two must never disagree about whether an agent is
 * behind — the same reason `cli.ts` owns the command line's rule.
 */

/**
 * An install that is ours and older than what the repository publishes.
 *
 * `managed` is the whole of it: a skill directory this window did not write
 * carries no receipt, so there is no version to compare and nothing this
 * window may claim about it.
 */
export function outdated(harness: Harness, latest: string | null): boolean {
  return harness.managed && latest !== null && harness.version !== latest;
}

/** Every agent holding a skill this window installed that has fallen behind. */
export function staleHarnesses(list: Harness[], latest: string | null): Harness[] {
  return list.filter((harness) => outdated(harness, latest));
}
