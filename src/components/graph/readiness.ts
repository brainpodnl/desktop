import type { Resource } from '@/lib/bridge';

/**
 * What a resource is doing, in the API's own words.
 *
 * The API answers three different status shapes and one absence, and every one
 * of them has to become a sentence a person can read. A workload reports a
 * phase and its replicas; a disk reports a phase plus whether it is bound; a
 * route reports a bare boolean; a config reports nothing at all and is always
 * healthy. Guessing a common shape out of those would mean inventing a state
 * for whichever kind does not have one, so each is stated as what it is.
 *
 * `tone` is never the whole message. Every caller renders `label` beside the
 * dot it tints, because a colour is not a status to anyone who cannot see it.
 */
export type Tone = 'ok' | 'progress' | 'bad' | 'idle';

export type Readiness = {
  tone: Tone;
  /** The phase word, or the closest true sentence when there is no phase. */
  label: string;
  /** The count behind the phase, when the kind reports one. */
  detail: string | null;
};

/** The dot fill for each tone, as the tokens the rest of the window uses. */
export const TONE_FILL: Record<Tone, string> = {
  ok: 'bg-ok',
  progress: 'bg-warn',
  bad: 'bg-destructive',
  idle: 'bg-faint',
};

/** The same tones as text. `warn` is a dot fill, so words use its legible twin. */
export const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-foreground',
  progress: 'text-warn-strong',
  bad: 'text-destructive',
  idle: 'text-muted-foreground',
};

/**
 * `Degraded` is the one phase that is an alarm; `Queued` and `Starting` are a
 * deploy in progress and read as such, which is why they are not failures.
 */
const PHASE_TONE: Record<string, Tone> = {
  Ready: 'ok',
  Starting: 'progress',
  Queued: 'progress',
  Degraded: 'bad',
};

export function readiness(resource: Resource): Readiness {
  const phase = resource.phase;

  if (phase !== null) {
    const tone = PHASE_TONE[phase] ?? (resource.healthy ? 'ok' : 'idle');
    /*
     * Replica counts belong to workloads, and only to those that have more
     * than one: "1 of 1 replicas ready" beside the word Ready says nothing the
     * word did not, and the replica's own row below states its name anyway.
     * A disk reports a phase too, and its second fact is whether the volume is
     * bound rather than how many of it are running.
     */
    const ready = resource.replicaStates.filter((replica) => replica.phase === 'Ready').length;
    const detail =
      resource.replicaStates.length > 1
        ? `${ready} of ${resource.replicaStates.length} replicas ready`
        : resource.bound === null
          ? null
          : resource.bound
            ? 'Volume bound'
            : 'Volume not bound';

    return { tone, label: phase, detail };
  }

  // A route states readiness and nothing else. So does a config, which the API
  // reports as healthy with no status at all.
  if (resource.ready !== null) {
    return resource.ready
      ? { tone: 'ok', label: 'Ready', detail: null }
      : { tone: 'bad', label: 'Not ready', detail: null };
  }

  if (resource.healthy) return { tone: 'ok', label: 'Ready', detail: null };

  /*
   * No status at all. This is what a resource looks like before its first
   * deploy has produced anything to report, and the control plane labels that
   * state `Pending` — which is a truer answer than inventing a failure.
   */
  return { tone: 'idle', label: 'Pending', detail: null };
}

/**
 * The same verdict, for a whole pod's graph: what the pane header states under
 * the pod's name.
 *
 * It is derived from `readiness` rather than from `healthy` so the header can
 * never disagree with the dots on the cards below it — the sentence and the
 * graph are then two renderings of one answer. A single resource in trouble is
 * named, with its own phase word, because "1 of 3 resources not ready" sends
 * the reader hunting for which one; past that, the count is the only honest
 * summary and the graph is where the names are.
 */
export type PodReadiness = { tone: Tone; label: string };

/** Which tone wins when a graph is in several states at once. */
const TONE_RANK: Record<Tone, number> = { bad: 3, progress: 2, idle: 1, ok: 0 };

export function podReadiness(resources: Resource[]): PodReadiness {
  if (resources.length === 0) return { tone: 'idle', label: 'No resources' };

  const states = resources.map((resource) => ({ resource, state: readiness(resource) }));
  const trouble = states.filter((entry) => entry.state.tone !== 'ok');

  if (trouble.length === 0) {
    return {
      tone: 'ok',
      label:
        resources.length === 1 ? '1 resource, ready' : `All ${resources.length} resources ready`,
    };
  }

  const worst = trouble.reduce((carry, entry) =>
    TONE_RANK[entry.state.tone] > TONE_RANK[carry.state.tone] ? entry : carry,
  );

  if (trouble.length === 1) {
    return { tone: worst.state.tone, label: `${worst.resource.name} is ${worst.state.label.toLowerCase()}` };
  }

  return {
    tone: worst.state.tone,
    label: `${trouble.length} of ${resources.length} resources not ready`,
  };
}
