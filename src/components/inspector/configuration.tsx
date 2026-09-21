import { ChevronRight } from 'lucide-react';
import { useState, type ReactElement } from 'react';

import { CopyButton } from '@/components/tunnel-dialog';
import { Absent, Fact, ScrollingValue, Section, Value } from '@/components/inspector/parts';
import type { ConfigFile, Resource } from '@/lib/bridge';
import { cx } from '@/lib/cx';

/**
 * The resource's spec, as the API actually returned it.
 *
 * Only fields the kind declares appear, and a field the API answered with
 * nothing is absent rather than shown as a dash: the pod file is hand-written,
 * so "no readiness check" and "a readiness check this panel failed to read"
 * must not look the same.
 *
 * `instance` and `replicas` are deliberately not here. They are the two spec
 * fields this window can change, so they live in the actions band where they
 * are editable, and stating them twice would leave one copy stale for as long
 * as a draft write takes to come back.
 */
export function Configuration({ resource }: { resource: Resource }): ReactElement | null {
  switch (resource.kind) {
    case 'App':
      return <AppConfiguration resource={resource} />;
    case 'Route':
      return <RouteConfiguration resource={resource} />;
    case 'Disk':
      return <DiskConfiguration resource={resource} />;
    case 'Config':
      return <ConfigFiles resource={resource} />;
    case 'Postgres':
    case 'MariaDB':
    case 'Valkey':
    case 'MSSQL':
      return <DatabaseConfiguration resource={resource} />;
  }
}

function AppConfiguration({ resource }: { resource: Resource }): ReactElement {
  const check = resource.readyCheck;
  /*
   * Two ways to state readiness, and the API allows either: a request it makes
   * against the app, or a command it runs inside it. Rendering both slots would
   * print an empty one every time, since a check is never both.
   */
  const probe =
    check === null
      ? null
      : check.path !== null
        ? `${check.host ?? ''}${check.path}${check.port === null ? '' : `:${check.port}`}`
        : check.cmd.length > 0
          ? check.cmd.join(' ')
          : check.port === null
            ? null
            : `:${check.port}`;

  /*
   * Only the parts the spec actually sets. A half-stated `1000:?` reads as a
   * gid the panel failed to load, when what it means is that the image's own
   * gid applies — so the absent half is simply not said.
   */
  const runtime = resource.runtime;
  const user =
    runtime === null
      ? null
      : [
          runtime.uid === null ? null : `uid ${runtime.uid}`,
          runtime.gid === null ? null : `gid ${runtime.gid}`,
          runtime.fsGroup === null ? null : `fsGroup ${runtime.fsGroup}`,
        ]
          .filter((part) => part !== null)
          .join(' · ') || null;

  return (
    <>
      {/* An App's spec always carries an image, so an absent one is a resource
          the API could not parse rather than an app without a build. */}
      {resource.image !== null && (
        <Section title="Image">
          <Fact label="Reference">
            <ScrollingValue value={resource.image} copy label="image reference" />
          </Fact>

          {/* Where the image came from, when it was built from a repository
              rather than pushed by hand. */}
          {resource.artifactRepo !== null && (
            <Fact label="Repository">
              <Value value={resource.artifactRepo} mono copy label="repository" />
            </Fact>
          )}
          {resource.artifactRef !== null && (
            <Fact label="Ref">
              <Value value={resource.artifactRef} mono />
            </Fact>
          )}
        </Section>
      )}

      {(resource.initCommand !== null || probe !== null || user !== null) && (
        <Section title="Runtime">
          {resource.initCommand !== null && (
            <Fact label="Init">
              <ScrollingValue value={resource.initCommand} copy label="init command" />
            </Fact>
          )}
          {probe !== null && (
            <Fact label="Ready check">
              <ScrollingValue value={probe} />
            </Fact>
          )}
          {user !== null && (
            <Fact label="Runs as">
              <Value value={user} mono />
            </Fact>
          )}
        </Section>
      )}

      <Section title="Environment">
        {resource.env.length === 0 ? (
          <Absent>No environment variables.</Absent>
        ) : (
          resource.env.map((entry) => (
            <div key={entry.name} className="group flex flex-col gap-px">
              <span data-selectable className="truncate font-mono text-ui-mono">
                {entry.name}
              </span>
              <ScrollingValue
                value={entry.value}
                copy
                label={entry.name}
                className="text-muted-foreground"
              />
            </div>
          ))
        )}
      </Section>

      <Section title="Mounts">
        {resource.mounts.length === 0 ? (
          <Absent>Nothing is mounted into this app.</Absent>
        ) : (
          resource.mounts.map((mount) => (
            <div key={mount.path} className="flex flex-col gap-px">
              <span data-selectable className="truncate font-mono text-ui-mono">
                {mount.path}
              </span>
              <span className="truncate text-ui-sm text-muted-foreground">
                {mount.file === null ? mount.target : `${mount.target} · ${mount.file}`}
              </span>
            </div>
          ))
        )}
      </Section>
    </>
  );
}

function RouteConfiguration({ resource }: { resource: Resource }): ReactElement {
  return (
    <>
      <Section title="Addresses">
        {resource.hostname !== null && (
          <Fact label="Hostname">
            <Value value={resource.hostname} mono copy label="hostname" />
          </Fact>
        )}

        <Fact label="Domains" align={resource.domains.length > 1 ? 'start' : 'center'}>
          {resource.domains.length === 0 ? (
            /* Not an error: a route answers on its provisioned hostname until
               someone points DNS at a domain of their own. */
            <Value value="None" className="text-faint" />
          ) : (
            <div className="flex flex-col gap-0.5">
              {resource.domains.map((domain) => (
                <Value key={domain} value={domain} mono copy label="domain" />
              ))}
            </div>
          )}
        </Fact>

        {resource.timeout !== null && (
          <Fact label="Timeout">
            <Value value={`${resource.timeout}s`} mono />
          </Fact>
        )}
      </Section>

      <Section title="Rules">
        {resource.rules.length === 0 ? (
          <Absent>This route forwards nothing yet.</Absent>
        ) : (
          resource.rules.map((rule) => (
            <div key={rule.name} className="flex flex-col gap-px">
              <span data-selectable className="truncate font-mono text-ui-mono">
                {rule.path}
              </span>
              <span className="truncate text-ui-sm text-muted-foreground">
                {`${rule.backend}:${rule.port} · ${rule.name}`}
              </span>
            </div>
          ))
        )}
      </Section>
    </>
  );
}

function DatabaseConfiguration({ resource }: { resource: Resource }): ReactElement {
  return (
    <Section title="Engine">
      {resource.version !== null && (
        <Fact label="Version">
          <Value value={resource.version} mono />
        </Fact>
      )}
      {resource.edition !== null && (
        <Fact label="Edition">
          <Value value={resource.edition} mono />
        </Fact>
      )}
      {resource.diskRef !== null && (
        <Fact label="Disk">
          <Value value={resource.diskRef} mono />
        </Fact>
      )}
    </Section>
  );
}

function DiskConfiguration({ resource }: { resource: Resource }): ReactElement {
  return (
    <Section title="Volume">
      {resource.size !== null && (
        <Fact label="Size">
          <Value value={`${resource.size} GB`} mono />
        </Fact>
      )}
      {resource.volumeHandle !== null && (
        <Fact label="Handle" align="start">
          <ScrollingValue value={resource.volumeHandle} copy label="volume handle" />
        </Fact>
      )}
    </Section>
  );
}

function ConfigFiles({ resource }: { resource: Resource }): ReactElement {
  return (
    <Section title="Files">
      {resource.files.length === 0 ? (
        <Absent>This config carries no files.</Absent>
      ) : (
        resource.files.map((file) => <ConfigFileRow key={file.name} file={file} />)
      )}
    </Section>
  );
}

/**
 * A config file, closed by default. The body is genuine file content — it can
 * be a hundred lines of nginx.conf — so opening it is a decision, and the row
 * states the size of that decision before it is taken.
 */
function ConfigFileRow({ file }: { file: ConfigFile }): ReactElement {
  const [open, setOpen] = useState(false);
  const lines = file.contents.split('\n').length;

  return (
    <div className="group flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="-mx-1.5 flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-0.5 text-left transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none">
          <ChevronRight
            size={12}
            aria-hidden="true"
            className={cx('shrink-0 text-faint transition-transform', open && 'rotate-90')}
          />
          <span className="truncate font-mono text-ui-mono">{file.name}</span>
          <span className="shrink-0 text-ui-sm text-faint">
            {lines === 1 ? '1 line' : `${lines} lines`}
          </span>
        </button>

        <span className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <CopyButton label={file.name} value={file.contents} />
        </span>
      </div>

      {open && (
        /* The one place in the panel with its own surface: file content is a
           quotation, and a quotation needs an edge to end at. */
        <pre
          data-selectable
          className="max-h-56 overflow-auto rounded-md bg-muted px-2.5 py-2 font-mono text-ui-mono whitespace-pre text-muted-foreground">
          {file.contents}
        </pre>
      )}
    </div>
  );
}
