import {listenerKeys, selectionKey} from '../core/listeners.js';
import {redactCommandLine, sanitizeText} from '../core/commands.js';
import type {BrowserSession, ListenerEntry, ZombieCandidate} from '../core/types.js';

export type VisibleRow =
  | {type: 'browser'; key: string; browser: BrowserSession; depth: 0}
  | {type: 'process'; key: string; family: string; members: ListenerEntry[]; expanded: boolean; depth: 0}
  | {type: 'listener'; key: string; listener: ListenerEntry; depth: number; parentGroupKey?: string}
  | {type: 'group'; key: string; family: string; members: ListenerEntry[]; expanded: boolean; depth: 0}
  | {type: 'zombie'; key: string; zombie: ZombieCandidate; depth: 0};

export interface BuildRowsOptions {
  all: boolean;
  expandedGroups: ReadonlySet<string>;
  pinnedListenerKeys: readonly string[];
  query?: string;
  browsers?: readonly BrowserSession[];
  /** Full inventory keeps hidden/search-excluded ports in the visible stop scope. */
  allListeners?: readonly ListenerEntry[];
}

export function buildVisibleRows(
  listeners: readonly ListenerEntry[],
  zombies: readonly ZombieCandidate[],
  options: BuildRowsOptions,
): VisibleRow[] {
  const query = sanitizeText(options.query).toLowerCase();
  const matches = (entry: ListenerEntry) => !query || listenerSearchText(entry).includes(query);
  const listenerRows: VisibleRow[] = [];
  const groupedRows: VisibleRow[] = [];
  const taskPids = new Set((options.allListeners ?? listeners).flatMap(({task}) => task?.members.map(({pid}) => pid) ?? []));
  const browsers = (options.browsers ?? []).filter(({pid}) => !taskPids.has(pid));
  const browserPids = new Set(browsers.flatMap(({members}) => members.map(({pid}) => pid)));
  const grouped = new Map<string, {family: string; members: ListenerEntry[]}>();
  const byPid = new Map<string, ListenerEntry[]>();
  const scopeKey = (entry: ListenerEntry) => entry.task?.key ?? `pid:${entry.pid}`;
  for (const entry of options.allListeners ?? listeners) {
    const bucket = byPid.get(scopeKey(entry)) ?? [];
    bucket.push(entry);
    byPid.set(scopeKey(entry), bucket);
  }
  const eligible = listeners.filter((entry) => (byPid.get(scopeKey(entry)) ?? [entry]).some(matches) &&
    (!browserPids.has(entry.pid) || listenerIsPinned(entry, options.pinnedListenerKeys)));

  for (const listener of eligible) {
    if (listener.task || (byPid.get(scopeKey(listener))?.length ?? 0) > 1) continue;
    if (
      options.all &&
      listener.kind === 'app' &&
      listener.appFamily &&
      !listenerIsPinned(listener, options.pinnedListenerKeys)
    ) {
      const family = listener.appFamily;
      const bucketKey = family.toLowerCase();
      const bucket = grouped.get(bucketKey) ?? {family, members: []};
      bucket.members.push(listener);
      grouped.set(bucketKey, bucket);
    }
  }

  const emittedGroups = new Set<string>();
  for (const listener of eligible) {
    const members = byPid.get(scopeKey(listener))!;
    if (listener.task || members.length > 1) {
      const key = listener.task?.key ?? `process:${listener.pid}:${listener.startTime?.getTime() ?? ''}`;
      if (emittedGroups.has(key)) continue;
      emittedGroups.add(key);
      const expanded = options.expandedGroups.has(key);
      listenerRows.push({type: 'process', key, family: listener.displayProject || listener.command, members, expanded, depth: 0});
      if (expanded) listenerRows.push(...members.map((entry) => listenerRow(entry, 1, key)));
      continue;
    }
    if (
      !(
        options.all &&
        listener.kind === 'app' &&
        listener.appFamily &&
        !listenerIsPinned(listener, options.pinnedListenerKeys)
      )
    ) {
      listenerRows.push(listenerRow(listener));
      continue;
    }

    const bucketKey = listener.appFamily.toLowerCase();
    const bucket = grouped.get(bucketKey)!;
    if (bucket.members.length < 2) {
      listenerRows.push(listenerRow(listener));
      continue;
    }
    if (emittedGroups.has(bucketKey)) {
      continue;
    }
    emittedGroups.add(bucketKey);
    const groupKey = `group:regular:${bucketKey}`;
    const expanded = options.expandedGroups.has(groupKey);
    groupedRows.push({type: 'group', key: groupKey, family: bucket.family, members: bucket.members, expanded, depth: 0});
    if (expanded) {
      groupedRows.push(...bucket.members.map((member) => listenerRow(member, 1, groupKey)));
    }
  }

  const zombieRows = zombies
    .filter((zombie) => !taskPids.has(zombie.pid) && !browserPids.has(zombie.pid) && (!query || zombieSearchText(zombie).includes(query)))
    .map<VisibleRow>((zombie) => ({type: 'zombie', key: `zombie:${zombie.pid}`, zombie, depth: 0}));
  const browserRows = browsers.filter((browser) => !query || sanitizeText([
    browser.pid, browser.family, browser.name, browser.profile, browser.parentName, browser.parentState,
    redactCommandLine(browser.command), ...browser.members.map(({pid}) => pid),
    ...(options.allListeners ?? listeners).filter(({pid}) => browser.members.some((member) => member.pid === pid)).map(({port}) => port),
  ].join(' ')).toLowerCase().includes(query)).map<VisibleRow>((browser) => ({
    type: 'browser', key: `browser:${browser.pid}:${browser.startTime?.getTime() ?? ''}`, browser, depth: 0,
  }));
  return [...listenerRows, ...browserRows, ...groupedRows, ...zombieRows];
}

export function listenerIsPinned(listener: ListenerEntry, pinnedListenerKeys: readonly string[]): boolean {
  const pinned = new Set(pinnedListenerKeys);
  return listenerKeys(listener).some((key) => pinned.has(key));
}

export function rowLabel(row: VisibleRow): string {
  if (row.type === 'browser') return `${row.browser.family}:${row.browser.pid}`;
  if (row.type === 'listener') {
    return `${row.listener.displayProject || row.listener.command}:${row.listener.port}`;
  }
  if (row.type === 'zombie') {
    return `${row.zombie.family}:${row.zombie.pid}`;
  }
  return `${row.family} (${row.members.length})`;
}

function listenerRow(listener: ListenerEntry, depth = 0, parentGroupKey?: string): VisibleRow {
  return {type: 'listener', key: `listener:${selectionKey(listener)}`, listener, depth, parentGroupKey};
}

function listenerSearchText(entry: ListenerEntry): string {
  return sanitizeText([
    entry.port,
    entry.pid,
    entry.task?.root.pid,
    entry.task?.members.map(({pid}) => pid).join(' '),
    entry.task?.root.command ? redactCommandLine(entry.task.root.command) : '',
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
