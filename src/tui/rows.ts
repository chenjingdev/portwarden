import {listenerKeys, selectionKey} from '../core/listeners.js';
import {redactCommandLine, sanitizeText} from '../core/commands.js';
import type {BrowserSession, CuaConnection, ListenerEntry, ZombieCandidate} from '../core/types.js';

export type VisibleRow =
  | {type: 'cua'; key: string; cua: CuaConnection; depth: number; parentGroupKey?: string}
  | {type: 'cua-group'; key: string; family: string; members: CuaConnection[]; expanded: boolean; depth: number; parentGroupKey?: string}
  | {type: 'browser'; key: string; browser: BrowserSession; depth: 0}
  | {type: 'project'; key: string; family: string; root: string; members: ListenerEntry[]; expanded: boolean; depth: 0}
  | {type: 'process'; key: string; family: string; members: ListenerEntry[]; expanded: boolean; depth: number; parentGroupKey?: string}
  | {type: 'listener'; key: string; listener: ListenerEntry; depth: number; parentGroupKey?: string}
  | {type: 'group'; key: string; family: string; members: ListenerEntry[]; expanded: boolean; depth: 0}
  | {type: 'zombie'; key: string; zombie: ZombieCandidate; depth: 0};

export interface BuildRowsOptions {
  all: boolean;
  expandedGroups: ReadonlySet<string>;
  pinnedListenerKeys: readonly string[];
  query?: string;
  browsers?: readonly BrowserSession[];
  cua?: readonly CuaConnection[];
  showCuaRuntimes?: boolean;
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

  // Separately started processes from one project folder share a row. App
  // helpers keep their family grouping, and a lone task or PID keeps its row.
  const projectOfScope = new Map<string, string>();
  const projects = new Map<string, {family: string; root: string; scopes: Map<string, ListenerEntry>}>();
  for (const entry of eligible) {
    const scope = scopeKey(entry);
    if (projectOfScope.has(scope)) continue;
    const root = entry.kind === 'app' ? '' : entry.projectRoot ?? '';
    const key = root ? `project:${root}` : '';
    projectOfScope.set(scope, key);
    if (!key) continue;
    const project = projects.get(key) ?? {family: entry.displayProject || entry.command, root, scopes: new Map()};
    project.scopes.set(scope, entry);
    projects.set(key, project);
  }
  const projectKey = (entry: ListenerEntry) => {
    const key = projectOfScope.get(scopeKey(entry)) ?? '';
    return (projects.get(key)?.scopes.size ?? 0) > 1 ? key : '';
  };
  const scopeRows = (listener: ListenerEntry, depth: number, parentGroupKey?: string): VisibleRow[] => {
    const members = byPid.get(scopeKey(listener)) ?? [listener];
    if (!listener.task && members.length < 2) return [listenerRow(listener, depth, parentGroupKey)];
    const key = processKey(listener);
    const expanded = options.expandedGroups.has(key);
    return [
      {type: 'process', key, family: listener.displayProject || listener.command, members, expanded, depth, parentGroupKey},
      ...(expanded ? members.map((entry) => listenerRow(entry, depth + 1, key)) : []),
    ];
  };

  for (const listener of eligible) {
    if (listener.task || (byPid.get(scopeKey(listener))?.length ?? 0) > 1) continue;
    if (
      (options.all || listenerIsPinned(listener, options.pinnedListenerKeys)) &&
      listener.kind === 'app' &&
      listener.appFamily
    ) {
      const family = listener.appFamily;
      const bucketKey = `${listenerIsPinned(listener, options.pinnedListenerKeys) ? 'pinned' : 'regular'}:${family.toLowerCase()}`;
      const bucket = grouped.get(bucketKey) ?? {family, members: []};
      bucket.members.push(listener);
      grouped.set(bucketKey, bucket);
    }
  }

  const emittedGroups = new Set<string>();
  for (const listener of eligible) {
    const project = projectKey(listener);
    if (project) {
      if (emittedGroups.has(project)) continue;
      emittedGroups.add(project);
      const {family, root, scopes} = projects.get(project)!;
      const expanded = options.expandedGroups.has(project);
      const members = [...scopes].flatMap(([scope, first]) => byPid.get(scope) ?? [first]);
      listenerRows.push({type: 'project', key: project, family, root, members, expanded, depth: 0});
      if (expanded) for (const first of scopes.values()) listenerRows.push(...scopeRows(first, 1, project));
      continue;
    }
    const members = byPid.get(scopeKey(listener))!;
    if (listener.task || members.length > 1) {
      const key = processKey(listener);
      if (emittedGroups.has(key)) continue;
      emittedGroups.add(key);
      listenerRows.push(...scopeRows(listener, 0));
      continue;
    }
    if (
      !(
        (options.all || listenerIsPinned(listener, options.pinnedListenerKeys)) &&
        listener.kind === 'app' &&
        listener.appFamily
      )
    ) {
      listenerRows.push(listenerRow(listener));
      continue;
    }

    const isPinned = listenerIsPinned(listener, options.pinnedListenerKeys);
    const bucketKey = `${isPinned ? 'pinned' : 'regular'}:${listener.appFamily.toLowerCase()}`;
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
    const expanded = options.expandedGroups.has(groupKey);
    const destination = isPinned ? listenerRows : groupedRows;
    destination.push({type: 'group', key: groupKey, family: bucket.family, members: bucket.members, expanded, depth: 0});
    if (expanded) {
      destination.push(...bucket.members.map((member) => listenerRow(member, 1, groupKey)));
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
  const allCua = options.cua ?? [];
  const shownCua = allCua.filter((entry) => options.showCuaRuntimes || entry.transportState !== 'not-observed').filter((entry) => !query || sanitizeText([
    'cua', entry.agent, entry.provider, entry.label, entry.pid, entry.ppid, entry.cwd, entry.sessionId, ...entry.sockets,
  ].join(' ')).toLowerCase().includes(query));
  const cuaRows: VisibleRow[] = [];
  const connectionRow = (cua: CuaConnection, depth = 0, parentGroupKey?: string): VisibleRow => ({
    type: 'cua', key: `cua:${cua.pid}:${cua.startTime?.getTime() ?? ''}`, cua, depth, parentGroupKey,
  });
  const connections = allCua.filter((entry) => entry.canStop);
  const shownConnections = shownCua.filter((entry) => entry.canStop);
  if (connections.length < 2) cuaRows.push(...shownConnections.map((entry) => connectionRow(entry)));
  else if (shownConnections.length) {
    const key = 'cua-group:all';
    const expanded = options.expandedGroups.has(key) || Boolean(query);
    cuaRows.push({type: 'cua-group', key, family: 'All CUA', members: [...connections], expanded, depth: 0});
    if (expanded) {
      for (const agent of ['Codex', 'Claude'] as const) {
        const members = connections.filter((entry) => entry.agent === agent);
        const shown = shownConnections.filter((entry) => entry.agent === agent);
        if (!shown.length) continue;
        if (members.length === 1) {cuaRows.push(connectionRow(shown[0]!, 1, key)); continue;}
        const groupKey = `cua-group:${agent.toLowerCase()}`;
        const groupExpanded = options.expandedGroups.has(groupKey) || Boolean(query);
        cuaRows.push({type: 'cua-group', key: groupKey, family: `${agent} CUA`, members, expanded: groupExpanded, depth: 1, parentGroupKey: key});
        if (groupExpanded) cuaRows.push(...shown.map((entry) => connectionRow(entry, 2, groupKey)));
      }
    }
  }
  cuaRows.push(...shownCua.filter((entry) => !entry.canStop).map((entry) => connectionRow(entry)));
  return [...cuaRows, ...listenerRows, ...browserRows, ...groupedRows, ...zombieRows];
}

export function listenerIsPinned(listener: ListenerEntry, pinnedListenerKeys: readonly string[]): boolean {
  const pinned = new Set(pinnedListenerKeys);
  return listenerKeys(listener).some((key) => pinned.has(key));
}

export function rowLabel(row: VisibleRow): string {
  if (row.type === 'cua-group') return `${row.family} (${row.members.length} connections)`;
  if (row.type === 'cua') return `${row.cua.agent} CUA:${row.cua.pid}`;
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

function processKey(listener: ListenerEntry): string {
  return listener.task?.key ?? `process:${listener.pid}:${listener.startTime?.getTime() ?? ''}`;
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
