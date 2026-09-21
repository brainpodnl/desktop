import { Check, TriangleAlert } from 'lucide-react';
import { motion } from 'motion/react';
import { useId, type ReactElement } from 'react';

import { Button } from '@/components/button';
import { BrainpodMark } from '@/components/marks/brainpod';
import { Tile } from '@/components/tile';
import type { CliProgress } from '@/lib/bridge';
import { useCli } from '@/lib/cli';
import { cx } from '@/lib/cx';

/**
 * What each phase of an install is called on screen. The words are the steps
 * themselves rather than a spinner's worth of nothing: a download that turns
 * out to be a checksum failure should have said `Checking` first.
 */
const PHASES: Record<CliProgress['phase'], string> = {
  downloading: 'Downloading',
  checking: 'Checking',
  installing: 'Installing',
};

/** The mark reads best at a little over half the chip it sits on. */
const GLYPH = 0.52;
const CHIP = 26;

/**
 * The command line, as a section of the Settings window.
 *
 * This app already holds the token, the config file and the pod; the CLI is
 * the one Brainpod tool it can simply hand over. So it does — without a
 * download page, without a command to copy, and without editing the user's
 * shell. A `brainpod` already on the machine is updated where it stands; a
 * machine with none gets one in a directory the platform itself already puts
 * on `PATH`.
 *
 * It reads its own state rather than sharing the pod window's query cache:
 * Settings is a second window, so it is a second document with a cache of its
 * own, and a client here would be a second cache pretending to be the first.
 */
export function CliSection(): ReactElement {
  const problemId = useId();
  const { status, release, offline, progress, error, stale, version, install, remove, reveal } =
    useCli();

  const busy = progress !== null;

  /*
   * One CLI, kept current. An install already on this machine is updated
   * where it stands rather than answered with a second copy somewhere else,
   * and only a binary this window itself put there is ever offered for
   * removal — so a row can legitimately carry no action at all.
   */
  const action: 'Install' | 'Update' | 'Remove' | null =
    status?.installed !== true ? 'Install' : stale ? 'Update' : status.managed ? 'Remove' : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2.5 border-y border-border py-3">
        {status === null ? (
          <p className="text-ui text-muted-foreground">Reading this machine…</p>
        ) : !status.supported ? (
          <p className="text-ui">
            The Brainpod CLI publishes no build for {status.platform}.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <Tile
                size={CHIP}
                tint={status.installed ? 'var(--color-brand)' : null}
                className="shrink-0">
                <BrainpodMark size={CHIP * GLYPH} mono={!status.installed} />
              </Tile>

              <div className="min-w-0 flex-1">
                <p className="truncate text-ui">{status.platform}</p>

                {/* The path is the control: clicking it opens the directory in
                    the OS's own file manager, which is the only question the
                    row leaves open once it has named where the binary goes. */}
                <button
                  type="button"
                  title="Show in the file manager"
                  onClick={() => void reveal()}
                  className="block max-w-full truncate rounded-sm text-left font-mono text-ui-mono text-faint transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
                  {status.displayPath}
                </button>
              </div>

              {busy ? (
                <span className="shrink-0 text-ui-sm text-faint">{PHASES[progress.phase]}</span>
              ) : status.installed && version !== null ? (
                <span
                  className={cx(
                    'flex shrink-0 items-center gap-1 text-ui-sm',
                    stale ? 'text-warn-strong' : 'text-ok',
                  )}
                  title={
                    status.installedAt === null
                      ? undefined
                      : `Installed ${new Date(status.installedAt).toLocaleString()}`
                  }>
                  {!stale && <Check className="size-3" />}
                  <span className="font-mono text-ui-mono">{version}</span>
                </span>
              ) : null}

              {action !== null && (
                <Button
                  variant={action === 'Remove' ? 'ghost' : 'outline'}
                  size="sm"
                  loading={busy}
                  /* Nothing to install until the release is known: with no
                     network the pane still states what is on this machine,
                     which is most of what it is for. */
                  disabled={busy || (action !== 'Remove' && release === null)}
                  className="shrink-0"
                  aria-label={`${action} the Brainpod CLI ${action === 'Remove' ? 'from' : 'in'} ${status.directory}`}
                  aria-describedby={error === null ? undefined : problemId}
                  onClick={action === 'Remove' ? () => void remove() : () => void install()}>
                  {action}
                </Button>
              )}
            </div>

            {/* Four megabytes is a moment on a desk and a minute in a hotel,
                and the only honest answer to which one this is comes from the
                bytes. The track sits under the path rather than over the pane,
                so the row that is working is the row that reports. */}
            {busy && (
              <div
                role="progressbar"
                aria-label={PHASES[progress.phase]}
                aria-valuemin={0}
                aria-valuemax={progress.total}
                aria-valuenow={progress.received}
                className="h-[3px] overflow-hidden rounded-full bg-foreground/10">
                <motion.div
                  className="h-full rounded-full bg-brand"
                  initial={{ scaleX: 0 }}
                  animate={{
                    scaleX: progress.total > 0 ? Math.min(1, progress.received / progress.total) : 1,
                  }}
                  transition={{ type: 'spring', stiffness: 260, damping: 40 }}
                  style={{ transformOrigin: 'left' }}
                />
              </div>
            )}
          </>
        )}
      </div>

      {/*
        Where it goes, and only when that is news. `/etc/paths` proves a
        directory is on the platform's default PATH; it never proves one is
        absent from the PATH a shell profile builds. So the promise is made
        where it holds — and a binary already being run from where it sits is
        told nothing at all, because the row above already names the path.
      */}
      {status?.supported === true && (!status.adopted || status.elevates) && (
        <p className="text-ui-sm text-faint">
          {status.adopted ? 'It stays in ' : 'It goes in '}
          <span className="font-mono text-ui-mono">{status.directory}</span>
          {status.adopted
            ? '.'
            : status.onPath
              ? ', which is already on your PATH — nothing in your shell has to change.'
              : ', which your shell may need adding to its PATH.'}
          {status.elevates && ' Writing there asks for your password once.'}
        </p>
      )}

      {/* A second `brainpod` is not a problem to be solved, so this states
          both and ranks neither: which one a shell runs is decided by the
          order of a PATH this window cannot read. */}
      {status?.other != null && (
        <p className="text-ui-sm text-faint">
          Another <code className="font-mono text-ui-mono">brainpod</code> is already at{' '}
          <span className="font-mono text-ui-mono">{status.other.displayPath}</span>
          {status.other.version !== null && (
            <span className="font-mono text-ui-mono"> ({status.other.version})</span>
          )}
          . Which one your shell runs depends on the order of your{' '}
          <code className="font-mono text-ui-mono">PATH</code>.
        </p>
      )}

      {/* The tag is public for the ten minutes its build matrix takes, so the
          newest release regularly has no binaries at all. Saying so is what
          keeps the older version on offer from looking like a stale window. */}
      {release?.publishing != null && (
        <p className="text-ui-sm text-faint">
          <span className="font-mono text-ui-mono">{release.publishing}</span> was just released
          and is still building its binaries.
        </p>
      )}

      {offline !== null && (
        <p className="flex items-start gap-1.5 text-ui-sm text-warn-strong">
          <TriangleAlert className="mt-px size-3 shrink-0" />
          {offline}
        </p>
      )}

      {error !== null && (
        /* A write that failed has to reach the screen reader standing on the
           button that started it, not only the eye. */
        <p
          id={problemId}
          role="alert"
          className="flex items-start gap-1.5 text-ui-sm text-destructive">
          <TriangleAlert className="mt-px size-3 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}
