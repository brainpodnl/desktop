import { useQuery } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { useCallback, useState, type ReactElement, type ReactNode } from 'react';

import { Button } from '@/components/button';
import { RailHeading } from '@/components/rail-heading';
import { installSkill } from '@/lib/bridge';
import { useCli } from '@/lib/cli';
import { useReducedMotion } from '@/lib/motion';
import { errorMessage, harnessesQuery, latestSkillQuery, queryClient } from '@/lib/queries';
import { staleHarnesses } from '@/lib/skills';
import { useUpdate } from '@/lib/updates';

/**
 * What on this machine is behind, at the foot of the sidebar.
 *
 * It replaced a pill floating over the graph. A pill had to be dismissible
 * because it covered the thing the user was reading; a band in the rail owns
 * its own space, so it can simply stay until it is acted on — which is what
 * makes it a place rather than an interruption, and what lets the other two
 * share it instead of each opening a corner of its own.
 *
 * Three subjects, one band, because they are one question: something on this
 * machine is not the current version, and here is the one control that fixes
 * it. Each row is named for what it actually is — `Brainpod` the app,
 * `Command line` the CLI, `Agent skill` the thing the coding agents read —
 * in the same words Settings and the README use for them. They were once
 * told apart by nothing but a capital letter and a monospace font, which is
 * not a distinction.
 *
 * Nothing here paints a surface. The sidebar is a macOS vibrancy material and
 * a card stacked inside it would be a second translucent layer, so the band is
 * separated by a hairline and nothing else — the same as `Connections`.
 */
export function UpdatesBar(): ReactElement | null {
  const { state, restart } = useUpdate();
  const cli = useCli();
  const reduced = useReducedMotion() === true;

  /*
   * The same two reads the skill installer below already makes, so this costs
   * one cache hit rather than a second scan of four directories.
   */
  const harnesses = useQuery(harnessesQuery());
  const latestSkill = useQuery(latestSkillQuery());
  const [writingSkill, setWritingSkill] = useState(false);
  const [skillError, setSkillError] = useState<string | null>(null);

  const skillVersion = latestSkill.data?.version ?? null;
  const behind = staleHarnesses(harnesses.data ?? [], skillVersion);

  const updateSkill = useCallback(async () => {
    if (behind.length === 0 || writingSkill) return;

    setWritingSkill(true);
    setSkillError(null);

    try {
      // One download written into every agent that is behind; Rust answers
      // with the whole state, so the fan below re-reads nothing.
      const report = await installSkill(behind.map((harness) => harness.id));
      queryClient.setQueryData(harnessesQuery().queryKey, report.harnesses);

      const failed = report.results.filter((result) => result.error !== null);
      if (failed.length > 0) setSkillError(failed[0]?.error ?? null);
    } catch (cause) {
      setSkillError(errorMessage(cause, 'Could not update the agent skill.'));
    } finally {
      setWritingSkill(false);
    }
  }, [behind, writingSkill]);

  const app = state.phase === 'ready' ? state.version : null;
  const installing = cli.progress !== null;
  /* An install in flight keeps the row it is running in, so the band does not
     vanish under the pointer the moment the new version lands. */
  const command = cli.stale || installing ? (cli.release?.version ?? null) : null;
  const skill = (behind.length > 0 || writingSkill) && skillVersion !== null ? skillVersion : null;

  // An empty band holding a heading states nothing; the pods list takes the
  // space back instead.
  if (app === null && command === null && skill === null) return null;

  return (
    <motion.div
      role="status"
      initial={reduced ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      /* `pb-3` answers the `pt-3` the heading brings, so the block sits
         evenly between its hairline and the account below it. The padding is
         the band's, not the list's — on a scrolling list it would only be
         reachable by scrolling to the end. */
      className="shrink-0 border-t border-border pb-3">
      <RailHeading>Updates</RailHeading>

      {/* The rows carry no vertical padding of their own: each already holds
          a 24px control, and padding on top of that is what pushed this
          band's first line below every other section's. The gap between rows
          is the list's. */}
      <ul role="list" className="flex flex-col gap-1">
        {app !== null && (
          <Row
            name="Brainpod"
            version={app}
            action="Restart"
            label={`Restart Brainpod to finish updating to ${app}`}
            // `void`: relaunch resolves by never returning — the process is gone.
            onAct={() => {
              void restart();
            }}
          />
        )}

        {command !== null && (
          <Row
            name="Command line"
            version={command}
            action="Update"
            busy={installing}
            label={`Update the Brainpod CLI in ${cli.status?.directory ?? 'its install directory'}`}
            onAct={() => void cli.install()}>
            {/* The wait the row cannot shorten, in the row that is doing it.
                Four megabytes is a moment on a desk and a minute in a hotel,
                and only the bytes know which one this is. */}
            {cli.progress !== null && (
              <div
                role="progressbar"
                aria-label="Downloading the Brainpod CLI"
                aria-valuemin={0}
                aria-valuemax={cli.progress.total}
                aria-valuenow={cli.progress.received}
                className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-foreground/10">
                <motion.div
                  className="h-full rounded-full bg-brand"
                  initial={{ scaleX: 0 }}
                  animate={{
                    scaleX:
                      cli.progress.total > 0
                        ? Math.min(1, cli.progress.received / cli.progress.total)
                        : 1,
                  }}
                  transition={{ type: 'spring', stiffness: 260, damping: 40 }}
                  style={{ transformOrigin: 'left' }}
                />
              </div>
            )}
          </Row>
        )}

        {skill !== null && (
          <Row
            name="Agent skill"
            version={skill}
            action="Update"
            busy={writingSkill}
            /* The row says `Agent skill`; the accessible name says which
               agents, because that is what a count cannot carry and what the
               button is actually about to write to. */
            label={`Update the Brainpod agent skill in ${behind
              .map((harness) => harness.name)
              .join(', ')}`}
            onAct={() => void updateSkill()}
          />
        )}
      </ul>

      {(cli.error ?? skillError) !== null && (
        <p role="alert" className="px-4 pt-1 text-ui-sm text-destructive">
          {cli.error ?? skillError}
        </p>
      )}
    </motion.div>
  );
}

/**
 * One thing that is behind: what it is, the version on offer, and the single
 * control that takes it.
 */
function Row({
  name,
  version,
  action,
  label,
  busy = false,
  onAct,
  children,
}: {
  /** What is behind, in the product's own word for it: `Command line`. */
  name: string;
  version: string;
  action: string;
  /** The button's accessible name, which has to say what `Update` updates. */
  label: string;
  busy?: boolean;
  onAct: () => void;
  children?: ReactNode;
}): ReactElement {
  return (
    <li className="px-4">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-ui">
          {name} <span className="font-mono text-ui-mono text-foreground/70">{version}</span>
        </span>

        <Button
          size="xs"
          variant="outline"
          loading={busy}
          disabled={busy}
          aria-label={label}
          title={label}
          className="shrink-0"
          onClick={onAct}>
          {action}
        </Button>
      </div>

      {children}
    </li>
  );
}
