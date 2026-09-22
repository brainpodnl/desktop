import { ArrowLeftRight, Box, FileCog, HardDrive } from 'lucide-react';
import type { ComponentType } from 'react';

import { MariaDbMark, MssqlMark, PostgresMark, ValkeyMark } from '@/components/marks/engines';
import type { ResourceKind } from '@/lib/bridge';

/**
 * How a resource kind presents itself, in one table. The console tints every
 * resource by kind and labels it the same way in its graph, its lists and its
 * detail panes; a `switch` per call site is how those drift apart.
 *
 * `accent` is a `var()` reference rather than a Tailwind class because the
 * lookup happens at runtime — the consumer drops it into an inline `style`,
 * which is the one place inline style beats a utility here.
 *
 * A database states which database it is: the engines carry their own marks
 * and their own hue, and the generic cylinder only ever said "database" to
 * someone already reading the word underneath it. Lucide covers the kinds
 * Brainpod itself defines, which have no logo to show. Both satisfy the same
 * `{ size }` call, so the card renders either without knowing which it holds.
 */
export type KindStyle = { icon: ComponentType<{ size: number }>; accent: string; label: string };

/**
 * The kind accent, held back to a wash. Every surface that tints by kind mixes
 * it identically — the graph's icon tile and its chips, the inspector's header
 * — which is what keeps one resource reading as one colour across the window.
 * It cannot be a utility for the same reason `accent` is not one: the value is
 * a runtime `var()` lookup.
 *
 * `percent` is the one thing a call site is allowed to vary, and only to build
 * a ramp out of the same hue: the tile lights itself from 22 to 11 across its
 * own height, and a chip stays at the flat default.
 */
export const tint = (accent: string, percent = 16): string =>
  `color-mix(in oklab, ${accent} ${percent}%, transparent)`;

export const KIND_STYLE: Record<ResourceKind, KindStyle> = {
  App: { icon: Box, accent: 'var(--color-kind-app)', label: 'App' },
  Route: { icon: ArrowLeftRight, accent: 'var(--color-kind-route)', label: 'Route' },
  Postgres: { icon: PostgresMark, accent: 'var(--color-kind-postgres)', label: 'Postgres' },
  MariaDB: { icon: MariaDbMark, accent: 'var(--color-kind-mariadb)', label: 'MariaDB' },
  Valkey: { icon: ValkeyMark, accent: 'var(--color-kind-valkey)', label: 'Valkey' },
  MSSQL: { icon: MssqlMark, accent: 'var(--color-kind-mssql)', label: 'SQL Server' },
  Disk: { icon: HardDrive, accent: 'var(--color-kind-disk)', label: 'Disk' },
  Config: { icon: FileCog, accent: 'var(--color-kind-config)', label: 'Config' },
};
