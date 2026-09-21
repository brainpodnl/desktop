import { useState, type ReactElement } from 'react';

import { Button } from '@/components/button';
import { Fact, Section, Select } from '@/components/inspector/parts';
import { setInstance, setReplicas, type Resource, type ResourceKind } from '@/lib/bridge';
import { cx } from '@/lib/cx';
import { errorMessage, invalidatePod } from '@/lib/queries';

/**
 * The two spec fields this window is allowed to change: how many copies of an
 * app run, and how much machine each copy gets.
 *
 * Both are writes against the pod's **draft**, which is the whole of Brainpod's
 * change model: a resource write updates the mutable head and changes nothing
 * that is running until a deploy promotes it. So this band never says "scaled";
 * it says what it did, which is to put a number into a draft. Deploying that
 * draft is a pod-wide act, so it belongs to the pod-wide control beside the
 * revision picker rather than to this band.
 *
 * What is deliberately absent: restart. The REST API this window authenticates
 * against has no restart — it exists only as a console session call — and a
 * button that quietly redeployed a whole pod instead would be a lie about what
 * was done.
 */

/** The API's own picklists. A size the control plane rejects is not offered. */
const APP_INSTANCES = ['.25x', '.5x', '1x', '2x', '4x', '8x'];
const DATABASE_INSTANCES = ['.5x', '1x', '2x', '4x', '8x'];
/** SQL Server does not run below 2x, so its list starts where the engine does. */
const MSSQL_INSTANCES = ['2x', '4x', '8x'];

/** `spec.replicas` is an integer from 1 to 10; the schema refuses the rest. */
const MAX_REPLICAS = 10;

const REPLICA_OPTIONS = Array.from({ length: MAX_REPLICAS }, (_, index) => ({
  value: String(index + 1),
  label: index === 0 ? '1 replica' : `${index + 1} replicas`,
}));

function instancesFor(kind: ResourceKind): string[] | null {
  if (kind === 'App') return APP_INSTANCES;
  if (kind === 'MSSQL') return MSSQL_INSTANCES;
  if (kind === 'Postgres' || kind === 'MariaDB' || kind === 'Valkey') return DATABASE_INSTANCES;
  // A route is configuration and a disk is storage; neither runs on a machine.
  return null;
}

export function Scaling({
  pod,
  resource,
  atHead,
  onGoToHead,
  onSaved,
}: {
  pod: string;
  resource: Resource;
  /** Whether the graph is being read at the revision a write would land on. */
  atHead: boolean;
  /** Read the graph at the pod's newest revision, where a write is legal. */
  onGoToHead: () => void;
  /** The draft the write landed in, which is what the pane switches to. */
  onSaved: (revision: string) => void;
}): ReactElement | null {
  const instances = instancesFor(resource.kind);
  const scalable = resource.kind === 'App';

  /*
   * The draft values, held only while they differ from what the API last
   * answered. Keying them to the resource's own values rather than to an
   * effect is what keeps a refetch from overwriting a choice mid-edit, and
   * what makes "changed back to the original" indistinguishable from "never
   * touched" — which it is.
   */
  const [instance, setInstanceDraft] = useState<string | null>(null);
  const [replicas, setReplicasDraft] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (instances === null && !scalable) return null;

  const currentInstance = resource.instance ?? instances?.[0] ?? '';
  const currentReplicas = resource.replicas ?? 1;
  const nextInstance = instance ?? currentInstance;
  const nextReplicas = replicas ?? currentReplicas;
  const dirty = nextInstance !== currentInstance || nextReplicas !== currentReplicas;

  const save = async () => {
    setBusy(true);
    setError(null);

    try {
      /*
       * Two fields, two full-document replaces: the API has no PATCH, so each
       * write is read-modify-write in Rust. Replicas go first because the
       * second write reads the resource back from the draft the first one
       * produced — sending them in parallel would have the loser overwrite the
       * winner with a document that predates it.
       */
      let revision: string | null = null;
      if (nextReplicas !== currentReplicas) {
        revision = (await setReplicas(pod, resource.name, nextReplicas)).revisionId;
      }
      if (nextInstance !== currentInstance) {
        revision = (await setInstance(pod, resource.kind, resource.name, nextInstance)).revisionId;
      }

      setInstanceDraft(null);
      setReplicasDraft(null);
      invalidatePod(pod);
      if (revision !== null) onSaved(revision);
    } catch (cause) {
      setError(errorMessage(cause, `Could not update ${resource.name}.`));
    } finally {
      setBusy(false);
    }
  };

  const frozen = busy || resource.locked || !atHead;

  return (
    <Section title="Scale">
      {/*
       * At an older revision these controls are not merely disabled, they are
       * the wrong controls: they hold that revision's numbers, and a write
       * always lands on the pod's newest one. Disabling them said so in a line
       * of prose under two dropdowns that still looked operable. Frosting them
       * puts the state on the thing itself and leaves one thing to press — the
       * way back to the revision a change can actually be made on.
       */}
      {/* A database has one row to frost where an app has two, and a 28px
          control centred over a 28px row overhangs the band it belongs to.
          The floor is the button plus the air it needs, so both kinds read as
          one covered block. */}
      <div className={cx('relative', !atHead && 'min-h-14')}>
        <div
          aria-hidden={!atHead}
          className={cx(
            'flex flex-col gap-1.5 transition-all',
            !atHead && 'pointer-events-none opacity-40 blur-[2px] select-none',
          )}>
          {scalable && (
            <Fact label="Replicas">
              <Select
                label={`Replicas of ${resource.name}`}
                value={String(nextReplicas)}
                options={REPLICA_OPTIONS}
                disabled={frozen}
                onChange={(value) => setReplicasDraft(Number(value))}
              />
            </Fact>
          )}

          {instances !== null && (
            <Fact label="Instance">
              <Select
                label={`Instance size of ${resource.name}`}
                value={nextInstance}
                options={instances.map((size) => ({ value: size, label: size }))}
                disabled={frozen}
                onChange={setInstanceDraft}
              />
            </Fact>
          )}
        </div>

        {!atHead && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Button
              variant="outline"
              size="sm"
              title="Changes always land on the pod’s newest revision, never on the one you are reading."
              onClick={onGoToHead}>
              Switch to the newest revision
            </Button>
          </div>
        )}
      </div>

      {atHead && resource.locked && (
        /* The API says a task holds this resource — a restart, a backup or a
           restore started from the console. A write now would race it. */
        <p className="text-ui-sm text-warn-strong">An operation is running on this resource.</p>
      )}

      {error !== null && <p className="text-ui-sm text-destructive">{error}</p>}

      {dirty && (
        <div className="mt-1 flex items-center justify-between gap-2">
          {/* Stated beside the button that does it, every time: this is the one
              thing about Brainpod a new user gets wrong. */}
          <p className="min-w-0 flex-1 text-ui-sm text-muted-foreground">
            Saves to the pod’s draft. Nothing changes until it is deployed.
          </p>

          <Button
            variant="brand"
            size="sm"
            title="Save"
            aria-label={`Save ${resource.name} to the pod’s draft`}
            loading={busy}
            disabled={resource.locked}
            onClick={() => void save()}
          />
        </div>
      )}
    </Section>
  );
}
