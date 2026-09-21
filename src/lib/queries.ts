import { QueryClient, queryOptions } from '@tanstack/react-query';

import {
  latestSkill,
  listEvents,
  listPods,
  listResources,
  listRevisions,
  revisionDiff,
  scanHarnesses,
  type EventKind,
  type EventRange,
} from '@/lib/bridge';

/** The exact string `crate::error::Error` carries when the shared CLI token is gone. */
const NOT_SIGNED_IN = 'Not signed in to Brainpod';

/**
 * `invoke` rejects with whatever Rust serialized, and `crate::error::Error`
 * serializes to a flat string, so a rejection is usually not an `Error` at all.
 * Every message shown in the UI goes through here.
 */
export function errorMessage(cause: unknown, fallback: string): string {
  if (typeof cause === 'string' && cause.length > 0) return cause;
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  return fallback;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // Retrying a missing token only delays the sign-in screen.
      retry: (failureCount, error) =>
        !errorMessage(error, '').includes(NOT_SIGNED_IN) && failureCount < 2,
    },
    mutations: {
      retry: false,
    },
  },
});

export const podsQuery = () =>
  queryOptions({
    queryKey: ['pods'],
    queryFn: listPods,
  });

export const revisionsQuery = (pod: string) =>
  queryOptions({
    queryKey: ['revisions', pod],
    queryFn: () => listRevisions(pod),
    enabled: pod.length > 0,
  });

/**
 * `revision` is part of the key, not a filter applied after the fact: two
 * revisions are two different graphs, and caching them under one key would
 * show the previous one while the next is in flight.
 */
export const resourcesQuery = (pod: string, revision: string | null) =>
  queryOptions({
    queryKey: ['resources', pod, revision],
    queryFn: () => listResources(pod, revision ?? undefined),
    enabled: pod.length > 0,
  });

/**
 * The only query in the window that polls. Every other read describes a
 * revision, and a revision does not change under you, while events are a live
 * tail whose whole point is what arrived since the last glance. Five seconds is
 * enough for a glance; the API's SSE watch endpoint is the upgrade path if a
 * glance ever becomes a session.
 */
export const eventsQuery = (
  pod: string,
  urn: string | null,
  kind: EventKind | null,
  range: EventRange,
) =>
  queryOptions({
    queryKey: ['events', pod, urn, kind, range],
    queryFn: () => {
      // `enabled` already rules this out; the check is here so the URN stays
      // non-null without widening the signature the inspector calls with.
      if (urn === null) throw new Error('events query ran without a resource');
      return listEvents(pod, urn, kind, range);
    },
    enabled: pod.length > 0 && urn !== null && urn.length > 0,
    staleTime: 0,
    refetchInterval: 5000,
  });

/**
 * A revision's diff is immutable once the revision exists, with one exception:
 * a draft, which is exactly the revision this is ever asked for. So it must not
 * survive a write — `invalidatePod` is what clears it.
 */
export const revisionDiffQuery = (pod: string, revision: string | null) =>
  queryOptions({
    queryKey: ['revision-diff', pod, revision],
    queryFn: () => {
      if (revision === null) throw new Error('revision diff query ran without a revision');
      return revisionDiff(pod, revision);
    },
    enabled: pod.length > 0 && revision !== null && revision.length > 0,
  });

/**
 * Which agents on this machine hold the Brainpod skill. It is a filesystem
 * read, and the filesystem is shared with everything else the user runs — a
 * `npx skills add`, a deleted directory — so it is never cached: the installer
 * re-reads it every time it opens.
 */
export const harnessesQuery = () =>
  queryOptions({
    queryKey: ['harnesses'],
    queryFn: scanHarnesses,
    staleTime: 0,
  });

/**
 * The version `brainpodnl/skills` publishes, which is the only thing that can
 * call an install on disk current or out of date. It is allowed to fail: with
 * no network the installer still states, and still installs, everything else.
 */
export const latestSkillQuery = () =>
  queryOptions({
    queryKey: ['skill-latest'],
    queryFn: latestSkill,
    staleTime: 5 * 60_000,
    retry: false,
  });

/**
 * A draft write answers with one revision but moves four reads at once: the
 * graph is read at a revision, the revision list gains or restates the draft,
 * the pod's own row follows its head, and the draft's diff is the one diff that
 * is allowed to change. Refreshing them together is what stops the window from
 * describing a draft it has already written to.
 */
export function invalidatePod(pod: string): void {
  queryClient.invalidateQueries({ queryKey: ['resources', pod] });
  queryClient.invalidateQueries({ queryKey: ['revisions', pod] });
  queryClient.invalidateQueries({ queryKey: ['pods'] });
  queryClient.invalidateQueries({ queryKey: ['revision-diff', pod] });
}
