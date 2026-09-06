import path from 'node:path';

import {parseCommandSnapshot} from './commands.js';
import {browserFamily} from './zombies.js';
import type {LsofProcessMetadata} from './listeners.js';
import type {ListenerEntry, ProcessInfo, ProcessTask} from './types.js';

type MetadataProvider = (pids: readonly number[]) => Promise<ReadonlyMap<number, LsofProcessMetadata>>;
const DEV_TOOLS = new Set(['vite', 'next', 'nuxt', 'astro', 'webpack', 'webpack-dev-server', 'nodemon', 'tsx', 'react-scripts', 'parcel', 'storybook', 'uvicorn', 'gunicorn', 'flask', 'rails']);

/** Only well-defined dev launchers may extend a scope above a listener. */
export function isDevLauncher(entry: ProcessInfo): boolean {
  const snapshot = parseCommandSnapshot(entry.command);
  if (!snapshot) return false;
  const argv = snapshot.argv;
  const name = path.basename(argv[0] ?? '').toLowerCase();
  if (DEV_TOOLS.has(name)) return true;
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) {
    const command = argv[1] === 'run' || argv[1] === 'run-script' ? argv[2] : argv[1];
    return Boolean(command && /^(?:dev|start|serve|preview|watch)(?::[\w-]+)?$/.test(command));
  }
  if (['sh', 'bash', 'zsh', 'dash'].includes(name)) {
    if (argv[1] !== '-c' || !argv[2]) return false;
    const command = argv.slice(2).join(' ');
    const child = parseCommandSnapshot(command);
    if (!child) return false;
    return /^(?:node|nodejs|python\d*(?:\.\d+)?|bun|deno|ruby)$/.test(path.basename(child.argv[0] ?? '')) ||
      isDevLauncher({...entry, command});
  }
  if (/^(?:node|nodejs|python\d*(?:\.\d+)?|bun)$/.test(name)) {
    if (argv[1] === '-m') return DEV_TOOLS.has(argv[2] ?? '');
    if (argv[1] === '--watch' || argv[1]?.startsWith('--watch-path=')) return true;
    const script = argv[1] ?? '';
    const packageManager = /\/node_modules\/npm\/bin\/npm-cli\.js$/.test(script) ? 'npm'
      : /\/node_modules\/pnpm\/bin\/pnpm\.(?:c?js)$/.test(script) ? 'pnpm'
        : /\/node_modules\/yarn\/bin\/yarn\.js$/.test(script) ? 'yarn' : '';
    if (packageManager) return isDevLauncher({...entry, command: [packageManager, ...argv.slice(2)].join(' ')});
    // Identify the executed script, not a dev-tool word appearing in arguments.
    return /(?:^|\/)node_modules\/(?:\.bin\/(?:vite|next|nuxt|astro|nodemon|tsx)|(?:vite|next|nuxt|astro|nodemon|tsx|react-scripts|webpack|webpack-dev-server)\/)/.test(script);
  }
  return false;
}

export async function attachProcessTasks(
  listeners: readonly ListenerEntry[],
  rawProcesses: readonly ProcessInfo[],
  metadataProvider: MetadataProvider,
): Promise<ListenerEntry[]> {
  const uid = process.getuid?.();
  if (uid === undefined) return [...listeners];
  const byPid = new Map(rawProcesses.map((entry) => [entry.pid, {...entry}]));
  for (const listener of listeners) {
    const entry = byPid.get(listener.pid);
    if (entry && entry.uid === listener.uid && entry.command === listener.args &&
      entry.startTime?.getTime() === listener.startTime?.getTime()) {
      byPid.set(entry.pid, {...entry, cwd: listener.cwd, executable: entry.executable || listener.executable || ''});
    }
  }
  const children = new Map<number, number[]>();
  for (const entry of rawProcesses) {
    const bucket = children.get(entry.ppid) ?? [];
    bucket.push(entry.pid);
    children.set(entry.ppid, bucket);
  }
  const subtree = (pid: number): ProcessInfo[] => {
    const result: ProcessInfo[] = [];
    const seen = new Set<number>();
    const queue = [pid];
    for (let i = 0; i < queue.length; i += 1) {
      const current = queue[i]!;
      if (seen.has(current)) continue;
      seen.add(current);
      const entry = byPid.get(current);
      if (entry) result.push(entry);
      queue.push(...(children.get(current) ?? []));
    }
    return result;
  };
  const seeds = listeners.filter((entry) => entry.kind === 'dev' && entry.uid === uid &&
    byPid.has(entry.pid) && !browserFamily(byPid.get(entry.pid)!));
  const candidates = new Set<number>();
  for (const seed of seeds) {
    let entry = byPid.get(seed.pid)!;
    const seen = new Set<number>([entry.pid]);
    for (const member of subtree(entry.pid)) candidates.add(member.pid);
    while (entry.ppid > 1 && !seen.has(entry.ppid)) {
      const parent = byPid.get(entry.ppid);
      if (!parent || parent.uid !== uid || !isDevLauncher(parent)) break;
      seen.add(parent.pid);
      for (const member of subtree(parent.pid)) candidates.add(member.pid);
      entry = parent;
    }
  }
  const missing = [...candidates].filter((pid) => !byPid.get(pid)?.cwd || !byPid.get(pid)?.executable);
  if (missing.length) {
    const metadata = await metadataProvider(missing);
    for (const pid of missing) {
      const entry = byPid.get(pid)!;
      const details = metadata.get(pid);
      if (details?.uid === entry.uid) byPid.set(pid, {
        ...entry, cwd: entry.cwd || details?.cwd,
        executable: entry.executable || details?.executable || '',
      });
    }
  }
  const protectedPids = new Set<number>();
  let collector = byPid.get(process.pid);
  while (collector && !protectedPids.has(collector.pid)) {
    protectedPids.add(collector.pid);
    collector = byPid.get(collector.ppid);
  }
  const roots = new Map<number, {root: ProcessInfo; label: string}>();
  for (const seed of seeds) {
    let root = byPid.get(seed.pid)!;
    const seen = new Set<number>([root.pid]);
    while (root.ppid > 1 && !seen.has(root.ppid)) {
      const parent = byPid.get(root.ppid);
      if (!parent || parent.uid !== uid || protectedPids.has(parent.pid) ||
        !root.cwd || root.cwd !== parent.cwd || !isDevLauncher(parent)) break;
      seen.add(parent.pid);
      root = parent;
    }
    roots.set(root.pid, {root, label: seed.displayProject || seed.command});
  }
  const scopes = [...roots.values()].map(({root, label}) => ({root, label, members: subtree(root.pid)}));
  const tasks: ProcessTask[] = [];
  for (const scope of scopes) {
    if (scope.members.length < 2 || scopes.some((other) => other.root.pid !== scope.root.pid &&
      other.members.some(({pid}) => pid === scope.root.pid))) continue;
    const pids = new Set(scope.members.map(({pid}) => pid));
    const blocked = scope.members.find((member) => protectedPids.has(member.pid) || member.uid !== uid ||
      !member.executable.startsWith('/') || !member.command || !member.startTime || !Number.isFinite(member.startTime.getTime()));
    tasks.push({
      ...scope, key: `task:${scope.root.pid}:${scope.root.startTime?.getTime() ?? ''}`,
      ports: [...new Set(listeners.filter(({pid}) => pids.has(pid)).map(({port}) => port))].sort((a, b) => a - b),
      memoryBytes: scope.members.every(({rssBytes}) => rssBytes !== undefined)
        ? scope.members.reduce((sum, {rssBytes}) => sum + (rssBytes ?? 0), 0) : null,
      ...(blocked ? {blockedReason: `PID ${blocked.pid} is protected or has incomplete identity data.`} : {}),
    });
  }
  return listeners.map((listener) => {
    const task = tasks.find(({members}) => members.some(({pid}) => pid === listener.pid));
    return task ? {...listener, task} : listener;
  });
}

export function sameTaskSnapshot(current: ProcessTask, expected: ProcessTask): boolean {
  if (current.key !== expected.key || current.root.ppid !== expected.root.ppid || current.members.length !== expected.members.length ||
    current.ports.join(',') !== expected.ports.join(',')) return false;
  const expectedByPid = new Map(expected.members.map((entry) => [entry.pid, entry]));
  return current.members.every((entry) => {
    const previous = expectedByPid.get(entry.pid);
    return previous && entry.ppid === previous.ppid && entry.uid === previous.uid && entry.cwd === previous.cwd &&
      entry.command === previous.command && entry.executable === previous.executable &&
      entry.startTime?.getTime() === previous.startTime?.getTime();
  });
}
