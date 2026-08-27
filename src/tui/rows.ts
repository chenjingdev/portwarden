import {listenerKeys, selectionKey} from '../core/listeners.js';
import {redactCommandLine, sanitizeText} from '../core/commands.js';
import type {ListenerEntry, ZombieCandidate} from '../core/types.js';

export type VisibleRow =
  | {type: 'listener'; key: string; listener: ListenerEntry; depth: number}
  | {type: 'group'; key: string; family: string; members: ListenerEntry[]; expanded: boolean; depth: 0}
  | {type: 'zombie'; key: string; zombie: ZombieCandidate; depth: 0};

export interface BuildRowsOptions {
  all: boolean;
  expandedGroups: ReadonlySet<string>;
  pinnedListenerKeys: readonly string[];
  query?: string;
}

export function buildVisibleRows(
  listeners: readonly ListenerEntry[],
  zombies: readonly ZombieCandidate[],
  options: BuildRowsOptions,
): VisibleRow[] {
  const query = sanitizeText(options.query).toLowerCase();
  const matches = (entry: ListenerEntry) => !query || listenerSearchText(entry).includes(query);
  const listenerRows: VisibleRow[] = [];
  const eligible = listeners.filter(matches);
  const grouped = new Map<string, {family: string; members: ListenerEntry[]; pinned: boolean}>();

  for (const listener of eligible) {
    if (options.all && listener.kind === 'app' && listener.appFamily) {
      const family = listener.appFamily;
      const pinned = listenerIsPinned(listener, options.pinnedListenerKeys);
      const bucketKey = `${pinned ? 'pinned' : 'regular'}:${family.toLowerCase()}`;
      const bucket = grouped.get(bucketKey) ?? {family, members: [], pinned};
      bucket.members.push(listener);
      grouped.set(bucketKey, bucket);
    }
  }

  const emittedGroups = new Set<string>();
  for (const listener of eligible) {
    if (!(options.all && listener.kind === 'app' && listener.appFamily)) {
      listenerRows.push(listenerRow(listener));
      continue;
    }

    const pinned = listenerIsPinned(listener, options.pinnedListenerKeys);
    const bucketKey = `${pinned ? 'pinned' : 'regular'}:${listener.appFamily.toLowerCase()}`;
    const bucket = grouped.get(bucketKey)!;
    if (bucket.members.length < 2) {
      listenerRows.push(listenerRow(listener));
      continue;
    }
    if (emittedGroups.has(bucketKey)) {
      continue;
    }
    emittedGroups.add(bucketKey);
    const groupKey = `group:${bucketKey}`;
    const expanded = Boolean(query) || options.expandedGroups.has(groupKey);
    listenerRows.push({type: 'group', key: groupKey, family: bucket.family, members: bucket.members, expanded, depth: 0});
    if (expanded) {
      listenerRows.push(...bucket.members.map((member) => listenerRow(member, 1)));
    }
  }

  const zombieRows = zombies
    .filter((zombie) => !query || zombieSearchText(zombie).includes(query))
    .map<VisibleRow>((zombie) => ({type: 'zombie', key: `zombie:${zombie.pid}`, zombie, depth: 0}));
  return [...listenerRows, ...zombieRows];
}

export function listenerIsPinned(listener: ListenerEntry, pinnedListenerKeys: readonly string[]): boolean {
  const pinned = new Set(pinnedListenerKeys);
  return listenerKeys(listener).some((key) => pinned.has(key));
}

export function rowLabel(row: VisibleRow): string {
  if (row.type === 'listener') {
    return `${row.listener.displayProject || row.listener.command}:${row.listener.port}`;
  }
  if (row.type === 'zombie') {
    return `${row.zombie.family}:${row.zombie.pid}`;
  }
  return `${row.family} (${row.members.length})`;
}

function listenerRow(listener: ListenerEntry, depth = 0): VisibleRow {
  return {type: 'listener', key: `listener:${selectionKey(listener)}`, listener, depth};
}

function listenerSearchText(entry: ListenerEntry): string {
  return sanitizeText([
    entry.port,
    entry.pid,
    entry.kind,
    entry.displayHost,
    entry.displayProject,
    entry.displayCwd,
    redactCommandLine(entry.args),
  ].join(' ')).toLowerCase();
}

function zombieSearchText(entry: ZombieCandidate): string {
  return sanitizeText([entry.pid, entry.family, redactCommandLine(entry.command), entry.reason].join(' ')).toLowerCase();
}
