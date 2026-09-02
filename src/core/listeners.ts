import path from 'node:path';
import {homedir} from 'node:os';
import process from 'node:process';

import {execa} from 'execa';

import {collectProcesses} from './zombies.js';
import type {
  CommandResult,
  ListenerEntry,
  ListenerKind,
  ListenerSelectionOptions,
  ProcessInfo,
  RawListener,
} from './types.js';

const PROJECT_ROOT_HINTS = new Set([
  'code',
  'codes',
  'dev',
  'git',
  'project',
  'projects',
  'repo',
  'repos',
  'src',
  'work',
  'workspace',
  'workspaces',
]);

const GENERIC_PROJECT_DIRS = new Set([
  'bin',
  'cache',
  'cellar',
  'etc',
  'lib',
  'lib64',
  'local',
  'log',
  'opt',
  'resources',
  'root',
  'run',
  'sbin',
  'share',
  'srv',
  'tmp',
  'usr',
  'var',
]);

const RUNTIME_NAMES = new Set([
  'node',
  'bun',
  'deno',
  'python',
  'python3',
  'uvicorn',
  'gunicorn',
  'ruby',
  'rails',
  'php',
  'java',
  'go',
  'air',
  'cargo',
  'dotnet',
]);

const DEV_KEYWORDS = [
  'vite',
  'next',
  'nuxt',
  'astro',
  'webpack',
  'webpack-dev-server',
  'react-scripts',
  'parcel',
  'storybook',
  'cypress',
  'playwright',
  'preview',
  'serve',
  'ts-node',
  'tsx',
  'nodemon',
  'bun',
  'deno',
  'uvicorn',
  'gunicorn',
  'flask',
  'django',
  'rails',
  'artisan',
  'spring',
  'gradle',
  'phoenix',
  'mix phx.server',
] as const;

const DEV_PORTS = new Set([
  3000, 3001, 3002, 3003, 4173, 4200, 4321, 5000, 5001, 5173, 5174, 5175,
  5176, 5500, 5501, 6006, 8000, 8001, 8080, 8081, 8082, 8088, 8787, 9000, 9001,
  9229, 24678,
]);

const KIND_ORDER: Record<ListenerKind, number> = {dev: 0, app: 1, system: 2};
const LSOF_LISTEN_ARGS = ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'] as const;
const LSOF_PROCESS_CHUNK_SIZE = 200;

export interface ListenerCommandRunner {
  (file: string, args: readonly string[], signal?: AbortSignal): Promise<CommandResult>;
}

export interface CollectListenersOptions {
  /** Throw on discovery failures. Display callers may opt into an empty/degraded result instead. */
  strict?: boolean;
  signal?: AbortSignal;
  now?: Date;
  home?: string;
  runCommand?: ListenerCommandRunner;
  processProvider?: () => Promise<readonly ProcessInfo[]>;
}

export interface ListenerDetails {
  cwd?: string;
  command?: string;
  args?: string;
  executable?: string;
  appFamily?: string;
  port?: number;
  home?: string;
}

export interface LsofProcessMetadata {
  cwd?: string;
  executable?: string;
  pgid?: number;
  uid?: number;
}

export interface ProcessGroupMember {
  pid: number;
  ppid: number;
  pgid: number;
  uid?: number;
  isCollectorAncestor?: boolean;
}

async function defaultCommandRunner(
  file: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<CommandResult> {
  const result = await execa(file, args, {reject: false, cancelSignal: signal});
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 1,
  };
}

function isNoMatchesResult(result: CommandResult): boolean {
  return result.exitCode === 1 && result.stdout.trim() === '' && (result.stderr ?? '').trim() === '';
}

function commandError(file: string, result: CommandResult): Error {
  const detail = (result.stderr ?? '').trim();
  return new Error(`${file} exited with code ${result.exitCode}${detail ? `: ${detail}` : ''}`);
}

async function runLsof(
  args: readonly string[],
  options: Pick<CollectListenersOptions, 'runCommand' | 'signal' | 'strict'>,
): Promise<string> {
  const runner = options.runCommand ?? defaultCommandRunner;
  try {
    const result = await runner('lsof', args, options.signal);
    if (result.exitCode === 0) return result.stdout;
    if (isNoMatchesResult(result)) return '';
    if (options.strict) throw commandError('lsof', result);
    return '';
  } catch (error) {
    if (options.strict) throw error;
    return '';
  }
}

async function runPs(
  args: readonly string[],
  options: Pick<CollectListenersOptions, 'runCommand' | 'signal' | 'strict'>,
): Promise<string> {
  const runner = options.runCommand ?? defaultCommandRunner;
  try {
    const result = await runner('ps', args, options.signal);
    if (result.exitCode === 0) return result.stdout;
    if (options.strict) throw commandError('ps', result);
    return '';
  } catch (error) {
    if (options.strict) throw error;
    return '';
  }
}

/** Parse `lsof -Fpcn` output from both macOS and Linux. */
export function parseLsofListeners(raw: string): RawListener[] {
  const listeners: RawListener[] = [];
  let pid: number | null = null;
  let command = '';

  for (const line of raw.split(/\r?\n/)) {
    if (line.length < 2) continue;
    const field = line[0];
    const value = line.slice(1);

    if (field === 'p') {
      const parsedPid = Number.parseInt(value, 10);
      pid = Number.isSafeInteger(parsedPid) && parsedPid > 0 ? parsedPid : null;
      command = '';
    } else if (field === 'c' && pid !== null) {
      command = value.trim();
    } else if (field === 'n' && pid !== null && parseEndpoint(value) !== null) {
      listeners.push({pid, command, endpoint: value.trim()});
    }
  }

  return listeners;
}

export function parseEndpoint(input: string): {host: string; port: number} | null {
  const value = input.trim().replace(/\s+\(LISTEN\)$/i, '').replace(/^TCP\s+/i, '');
  if (!value) return null;

  const bracketed = /^\[([^\]]+)]:(\d+)$/.exec(value);
  const host = bracketed?.[1] ?? value.slice(0, value.lastIndexOf(':'));
  const portText = bracketed?.[2] ?? value.slice(value.lastIndexOf(':') + 1);
  const port = Number.parseInt(portText, 10);

  if (!host || !/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return null;
  }

  return {host, port};
}

/** Address family aliases that represent the same reachable listener. */
export function canonicalHost(host: string): string {
  const normalized = host.trim().replace(/^\[|]$/g, '').toLowerCase();
  if (
    normalized === 'localhost' ||
    normalized === 'ip6-localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    normalized === '::ffff:127.0.0.1'
  ) {
    return 'localhost';
  }

  if (
    normalized === '*' ||
    normalized === '0.0.0.0' ||
    normalized === '::' ||
    normalized === '0:0:0:0:0:0:0:0'
  ) {
    return 'all';
  }

  return normalized;
}

export function formatHostDisplay(host: string): string {
  const canonical = canonicalHost(host);
  return canonical || host.trim();
}

export function parseLsofCwds(raw: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | null = null;

  for (const line of raw.split(/\r?\n/)) {
    if (line.length < 2) continue;
    if (line[0] === 'p') {
      const parsedPid = Number.parseInt(line.slice(1), 10);
      pid = Number.isSafeInteger(parsedPid) && parsedPid > 0 ? parsedPid : null;
    } else if (line[0] === 'n' && pid !== null) {
      cwds.set(pid, line.slice(1));
    }
  }

  return cwds;
}

/** Parse the cwd and first program-text path reported for each process. */
export function parseLsofProcessMetadata(raw: string): Map<number, LsofProcessMetadata> {
  const metadata = new Map<number, LsofProcessMetadata>();
  let pid: number | null = null;
  let descriptor = '';
  const fields = raw.includes('\0')
    ? raw.split('\0').map((field) => field.replace(/^[\r\n]+/, ''))
    : raw.split(/\r?\n/);

  for (const line of fields) {
    if (line.length < 2) continue;
    if (line[0] === 'p') {
      const parsedPid = Number.parseInt(line.slice(1), 10);
      pid = Number.isSafeInteger(parsedPid) && parsedPid > 0 ? parsedPid : null;
      descriptor = '';
    } else if ((line[0] === 'g' || line[0] === 'u') && pid !== null) {
      const parsedValue = Number.parseInt(line.slice(1), 10);
      const minimum = line[0] === 'g' ? 1 : 0;
      if (!Number.isSafeInteger(parsedValue) || parsedValue < minimum) continue;
      const current = metadata.get(pid) ?? {};
      if (line[0] === 'g') current.pgid = parsedValue;
      else current.uid = parsedValue;
      metadata.set(pid, current);
    } else if (line[0] === 'f') {
      descriptor = pid === null ? '' : line.slice(1);
    } else if (line[0] === 'n' && pid !== null) {
      const name = line.slice(1);
      if (!name) continue;
      const current = metadata.get(pid) ?? {};
      if (descriptor === 'cwd') {
        current.cwd = name;
      } else if (descriptor === 'txt' && current.executable === undefined && path.isAbsolute(name)) {
        current.executable = name;
      } else {
        continue;
      }
      metadata.set(pid, current);
    }
  }

  return metadata;
}

async function collectProcessMetadata(
  pids: readonly number[],
  options: Pick<CollectListenersOptions, 'runCommand' | 'signal' | 'strict'>,
): Promise<Map<number, LsofProcessMetadata>> {
  if (pids.length === 0) return new Map();
  const uniquePids = [...new Set(pids)].sort((left, right) => left - right);
  const chunks: number[][] = [];
  for (let index = 0; index < uniquePids.length; index += LSOF_PROCESS_CHUNK_SIZE) {
    chunks.push(uniquePids.slice(index, index + LSOF_PROCESS_CHUNK_SIZE));
  }

  const outputs = await Promise.all(
    chunks.map((chunk) =>
      runLsof(['-nP', '-a', '-d', 'cwd,txt', '-p', chunk.join(','), '-F0fgpnu'], options),
    ),
  );
  const result = new Map<number, LsofProcessMetadata>();
  for (const output of outputs) {
    for (const [pid, processMetadata] of parseLsofProcessMetadata(output)) result.set(pid, processMetadata);
  }
  return result;
}

export async function collectProcessGroupMembers(
  pgid: number,
  options: Pick<CollectListenersOptions, 'runCommand' | 'signal' | 'strict'> = {},
): Promise<ProcessGroupMember[]> {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return [];
  const processes = parsePsProcessTable(await runPs(
    ['-axo', 'pid=,ppid=,pgid=,uid='],
    options,
  ));
  const processByPid = new Map(processes.map((entry) => [entry.pid, entry]));
  if (!processByPid.has(process.pid)) {
    throw new Error(`ps did not return the Portwarden process ${process.pid}.`);
  }
  const collectorAncestors = new Set<number>();
  let ancestor = processByPid.get(process.pid);
  while (ancestor && !collectorAncestors.has(ancestor.pid)) {
    collectorAncestors.add(ancestor.pid);
    ancestor = processByPid.get(ancestor.ppid);
  }
  return processes
    .filter((entry) => entry.pgid === pgid)
    .map((entry) => ({
      ...entry,
      isCollectorAncestor: collectorAncestors.has(entry.pid),
    }));
}

export function parsePsProcessTable(raw: string): ProcessGroupMember[] {
  const processes: ProcessGroupMember[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)$/.exec(line);
    if (!match) throw new Error('Could not parse the process-group inventory returned by ps.');
    const [, pidText, ppidText, pgidText, uidText] = match;
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    const processGroupId = Number(pgidText);
    const uid = Number(uidText);
    if (
      !Number.isSafeInteger(pid) || pid <= 0 ||
      !Number.isSafeInteger(ppid) || ppid < 0 ||
      !Number.isSafeInteger(processGroupId) || processGroupId <= 0 ||
      !Number.isSafeInteger(uid)
    ) {
      throw new Error('ps returned invalid process-group identity data.');
    }
    processes.push({pid, ppid, pgid: processGroupId, uid});
  }
  return processes;
}

export async function collectListeners(options: CollectListenersOptions = {}): Promise<ListenerEntry[]> {
  const raw = await runLsof(LSOF_LISTEN_ARGS, options);
  if (!raw) return [];

  const baseListeners = parseLsofListeners(raw);
  const pids = [...new Set(baseListeners.map(({pid}) => pid))];
  const metadataPids = [...new Set([...pids, process.pid])];
  const processProvider = options.processProvider ?? collectProcesses;

  const [processResult, metadataResult] = await Promise.allSettled([
    processProvider(),
    collectProcessMetadata(metadataPids, options),
  ]);
  if (options.strict && processResult.status === 'rejected') throw processResult.reason;
  if (options.strict && metadataResult.status === 'rejected') throw metadataResult.reason;

  const processes = processResult.status === 'fulfilled' ? processResult.value : [];
  const processMetadata = metadataResult.status === 'fulfilled'
    ? metadataResult.value
    : new Map<number, LsofProcessMetadata>();
  const processByPid = new Map(processes.map((processInfo) => [processInfo.pid, processInfo]));
  const collectorPgid = processMetadata.get(process.pid)?.pgid;
  const now = options.now ?? new Date();

  const enriched = baseListeners.flatMap((base) => {
    const endpoint = parseEndpoint(base.endpoint);
    if (!endpoint) return [];
    const metadata = processMetadata.get(base.pid);
    const processInfo = processByPid.get(base.pid);
    const enrichedProcessInfo = processInfo && !processInfo.executable && metadata?.executable
      ? {...processInfo, executable: metadata.executable}
      : processInfo;
    return [
      {
        ...enrichListener(base, endpoint, enrichedProcessInfo, metadata?.cwd, {
          home: options.home,
          now,
        }),
        ...(metadata?.pgid === undefined ? {} : {pgid: metadata.pgid}),
        ...(collectorPgid === undefined ? {} : {collectorPgid}),
      },
    ];
  });

  return sortListeners(collapseEquivalentListeners(enriched));
}

export function enrichListener(
  base: RawListener,
  endpoint: {host: string; port: number},
  processInfo?: ProcessInfo,
  cwd = '',
  options: {home?: string; now?: Date} = {},
): ListenerEntry {
  const home = options.home ?? homedir();
  const args = processInfo?.command ?? '';
  const command = base.command || processInfo?.name || firstToken(args) || '-';
  const executable = processInfo?.executable ?? '';
  const appFamily = inferAppFamily({cwd, command, args, executable});
  const projectName = getProjectName({cwd, command, args, home});
  const startTime = processInfo?.startTime;
  const ageMs = processInfo?.ageMs ?? (
    startTime ? Math.max(0, (options.now ?? new Date()).getTime() - startTime.getTime()) : undefined
  );
  const details = {cwd, command, args, executable, appFamily, port: endpoint.port, home};

  return {
    pid: base.pid,
    ppid: processInfo?.ppid ?? null,
    ...(typeof processInfo?.uid === 'number' ? {uid: processInfo.uid} : {}),
    ...(processInfo?.executable ? {executable: processInfo.executable} : {}),
    port: endpoint.port,
    host: endpoint.host,
    listenerHosts: [endpoint.host],
    displayHost: formatHostDisplay(endpoint.host),
    command,
    args,
    cwd,
    elapsed: formatElapsed(ageMs ?? undefined),
    kind: classifyListener(details),
    appFamily,
    projectName,
    displayProject: projectName || appFamily,
    displayCommand: summarizeCommand(command, args, home),
    displayCwd: formatDisplayCwd(cwd, args, home),
    ...(startTime ? {startTime} : {}),
  };
}

export function collapseEquivalentListeners(entries: readonly ListenerEntry[]): ListenerEntry[] {
  const result: ListenerEntry[] = [];
  const byIdentity = new Map<string, ListenerEntry>();

  for (const entry of entries) {
    const identity = `${entry.pid}:${entry.port}:${canonicalHost(entry.host)}`;
    const existing = byIdentity.get(identity);
    if (!existing) {
      const copy = {
        ...entry,
        listenerHosts: uniqueStrings([entry.host, ...entry.listenerHosts]),
      };
      byIdentity.set(identity, copy);
      result.push(copy);
      continue;
    }

    existing.listenerHosts = uniqueStrings([
      ...existing.listenerHosts,
      entry.host,
      ...entry.listenerHosts,
    ]);
  }

  return result;
}

export function matchesKeyword(text: string, keyword: string): boolean {
  const escaped = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(text);
}

function hasDevEvidence(details: ListenerDetails): boolean {
  const home = details.home ?? homedir();
  const cwd = details.cwd?.trim() ?? '';
  const command = details.command?.trim() ?? '';
  const commandName = path.basename(command).toLowerCase();
  const searchText = [command, details.args, cwd].filter(Boolean).join(' ');
  const inHome = cwd === home || cwd.startsWith(`${home}${path.sep}`);
  const inLibrary = cwd === path.join(home, 'Library') || cwd.startsWith(`${path.join(home, 'Library')}${path.sep}`);
  const hasProjectCwd = Boolean(cwd) && inHome && !inLibrary && cwd !== home;
  const hasDevKeyword = DEV_KEYWORDS.some((keyword) => matchesKeyword(searchText, keyword));
  const runtime = RUNTIME_NAMES.has(commandName);
  const port = details.port ?? 0;
  const commonDevPort = DEV_PORTS.has(port) || (port >= 3000 && port <= 5999);
  return hasDevKeyword || (hasProjectCwd && (runtime || commonDevPort)) || (runtime && commonDevPort);
}

export function classifyListener(details: ListenerDetails): ListenerKind {
  const appFamily = details.appFamily?.trim() ?? inferAppFamily(details);

  // Packaged desktop helpers commonly contain dev-looking words in their
  // resource path/argv (for example Ollama.app's `Resources/ollama serve`).
  // The bundle identity is stronger evidence than a generic CLI keyword.
  if (appFamily) return 'app';
  if (hasDevEvidence(details)) return 'dev';
  return 'system';
}

export function inferAppFamily(details: Pick<ListenerDetails, 'cwd' | 'command' | 'args' | 'executable'>): string {
  // Only process-identity paths may identify an app bundle. Arbitrary argv
  // values can point into another app's Application Support directory (for
  // example ComfyUI loading a Comfy Desktop model-path config).
  const argvExecutable = firstToken(details.args ?? '');
  for (const input of [details.executable, argvExecutable, details.command, details.cwd]) {
    const normalized = input?.trim().replace(/[\\/]+/g, '/');
    if (!normalized) continue;
    const application = /\/(?:System\/)?Applications\/([^/]+)\.app(?:\/|$)/.exec(normalized);
    if (application?.[1]) return normalizeAppLabel(application[1]);
    const support = /\/Library\/Application Support\/([^/]+)/.exec(normalized);
    if (support?.[1]) return normalizeAppLabel(support[1]);
  }
  return '';
}

export function getProjectName(details: ListenerDetails): string {
  const home = details.home ?? homedir();
  const cwd = details.cwd?.trim().replace(/[\\/]+$/, '') ?? '';
  if (!cwd || cwd === path.parse(cwd).root || cwd === home) {
    return inferProjectNameFromCommand(details);
  }

  if (cwd.startsWith(`${home}${path.sep}`)) {
    const segments = path.relative(home, cwd).split(path.sep).filter(Boolean);
    if (PROJECT_ROOT_HINTS.has((segments[0] ?? '').toLowerCase())) {
      return segments[1] ?? inferProjectNameFromCommand(details);
    }
    return segments[0] ?? inferProjectNameFromCommand(details);
  }

  const basename = path.basename(cwd);
  return isGenericProjectDir(basename) ? inferProjectNameFromCommand(details) || basename : basename;
}

export function inferProjectNameFromCommand(details: Pick<ListenerDetails, 'command' | 'args'>): string {
  const commandCandidate = normalizeProjectToken(details.command ?? '');
  if (commandCandidate && !RUNTIME_NAMES.has(commandCandidate.toLowerCase())) return commandCandidate;

  for (const token of shellTokens(details.args ?? '')) {
    const candidate = inferProjectNameFromPath(token);
    if (candidate && !RUNTIME_NAMES.has(candidate.toLowerCase())) return candidate;
  }
  return '';
}

export function inferProjectNameFromPath(input: string): string {
  const value = stripOuterQuotes(input);
  if (!value) return '';
  const packageName = extractPackageNameFromPath(value);
  if (packageName) return packageName;
  if (!path.isAbsolute(value)) return '';

  const normalized = value.replace(/[\\/]+/g, '/');
  const app = /\/Applications\/([^/]+)\.app(?:\/|$)/.exec(normalized);
  if (app?.[1]) return app[1];
  const homebrew = /\/(?:opt|Cellar)\/([^/]+)(?:\/|$)/.exec(normalized);
  if (homebrew?.[1]) return homebrew[1];
  return normalizeProjectToken(value);
}

export function listenerKey(host: string, port: number): string;
export function listenerKey(entry: Pick<ListenerEntry, 'host' | 'port'>): string;
export function listenerKey(
  hostOrEntry: string | Pick<ListenerEntry, 'host' | 'port'>,
  port?: number,
): string {
  const host = typeof hostOrEntry === 'string' ? hostOrEntry : hostOrEntry.host;
  const listenerPort = typeof hostOrEntry === 'string' ? port : hostOrEntry.port;
  return `host:${normalizeWhitespace(host) || '-'}::port:${listenerPort ?? '-'}`;
}

export const getEntryListenerKey = listenerKey;

export function listenerKeys(entry: Pick<ListenerEntry, 'host' | 'port' | 'listenerHosts'>): string[] {
  return uniqueStrings([entry.host, ...entry.listenerHosts]).map((host) => listenerKey(host, entry.port));
}

export const getEntryListenerKeys = listenerKeys;

export function selectionKey(entry: Pick<ListenerEntry, 'pid' | 'port' | 'host'>): string {
  return `${entry.pid}:${entry.port}:${entry.host}`;
}

export const getSelectionKey = selectionKey;

export function preferenceKey(
  entry: Pick<ListenerEntry, 'pid' | 'port' | 'host' | 'cwd' | 'args' | 'command'>,
): string {
  const cwd = normalizeWhitespace(entry.cwd);
  const command = normalizeCommandPreference(entry.args || entry.command);
  const host = normalizeWhitespace(entry.host);
  if (cwd && command) return `cwd:${cwd}::cmd:${command}`;
  if (cwd && host) return `cwd:${cwd}::host:${host}`;
  if (cwd) return `cwd:${cwd}`;
  if (command && host) return `cmd:${command}::host:${host}`;
  if (command) return `cmd:${command}`;
  return `pid:${entry.pid || '-'}::port:${entry.port || '-'}`;
}

export const getEntryPreferenceKey = preferenceKey;

export function entryMatchesListenerKey(
  entry: Pick<ListenerEntry, 'host' | 'port' | 'listenerHosts'>,
  key: string,
): boolean {
  return listenerKeys(entry).includes(key.trim());
}

export function sortListeners(
  entries: readonly ListenerEntry[],
  options: Omit<ListenerSelectionOptions, 'all'> = {},
): ListenerEntry[] {
  const pinned = new Set(options.pinnedListenerKeys ?? []);
  const order = new Map<string, number>();
  (options.orderedEntryKeys ?? []).forEach((key, index) => {
    if (key && !order.has(key)) order.set(key, index);
  });

  return [...entries].sort((left, right) => {
    const leftPinned = listenerKeys(left).some((key) => pinned.has(key));
    const rightPinned = listenerKeys(right).some((key) => pinned.has(key));
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;

    const leftOrder = orderedIndex(left, order);
    const rightOrder = orderedIndex(right, order);
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return compareListeners(left, right);
  });
}

export function selectListeners(
  entries: readonly ListenerEntry[],
  options: ListenerSelectionOptions = {},
): ListenerEntry[] {
  const pinned = new Set(options.pinnedListenerKeys ?? []);
  const selected = options.all
    ? entries
    : entries.filter(
      (entry) => isDefaultVisibleListener(entry) || listenerKeys(entry).some((key) => pinned.has(key)),
    );
  return sortListeners(selected, options);
}

/** Keep legacy-relevant local services visible without treating app bundles as dev process groups. */
export function isDefaultVisibleListener(entry: ListenerEntry): boolean {
  return entry.kind === 'dev' || (entry.kind === 'app' && hasDevEvidence(entry));
}

export function compareListeners(left: ListenerEntry, right: ListenerEntry): number {
  return (
    KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
    compareText(projectSortKey(left), projectSortKey(right)) ||
    left.port - right.port ||
    compareText(canonicalHost(left.host), canonicalHost(right.host)) ||
    compareText(processSortKey(left), processSortKey(right)) ||
    compareText(left.cwd, right.cwd) ||
    left.pid - right.pid
  );
}

function orderedIndex(entry: ListenerEntry, order: ReadonlyMap<string, number>): number {
  let result = Number.MAX_SAFE_INTEGER;
  const keys = [...listenerKeys(entry), preferenceKey(entry), selectionKey(entry)];
  for (const key of keys) result = Math.min(result, order.get(key) ?? Number.MAX_SAFE_INTEGER);
  return result;
}

function projectSortKey(entry: ListenerEntry): string {
  return entry.kind === 'app' && entry.appFamily
    ? entry.appFamily
    : entry.displayProject || entry.projectName || entry.displayCwd || entry.cwd;
}

function processSortKey(entry: ListenerEntry): string {
  return entry.displayCommand || entry.args || entry.command || '-';
}

function compareText(left: string, right: string): number {
  const a = normalizeWhitespace(left).toLowerCase();
  const b = normalizeWhitespace(right).toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeCommandPreference(value: string): string {
  return normalizeWhitespace(value)
    .replace(/(^|\s)(PORT=)\d+\b/g, '$1$2<port>')
    .replace(/(--port=)\d+\b/g, '$1<port>')
    .replace(/(--port\s+)\d+\b/g, '$1<port>')
    .replace(/(^|\s)(-p=)\d+\b/g, '$1$2<port>')
    .replace(/(^|\s)(-p\s+)\d+\b/g, '$1$2<port>')
    .replace(/(python(?:3)?\s+-m\s+http\.server\s+)\d+\b/gi, '$1<port>')
    .replace(/(php\s+-S\s+[^:\s]+:)\d+\b/gi, '$1<port>');
}

function extractPackageNameFromPath(input: string): string {
  const normalized = input.replace(/[\\/]+/g, '/');
  const marker = '/node_modules/';
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return '';
  const segments = normalized.slice(markerIndex + marker.length).split('/').filter(Boolean);
  if (segments[0]?.startsWith('@') && segments[1]) return `${segments[0]}/${segments[1]}`;
  return segments[0] ?? '';
}

function parsePnpmDlxCommand(input: string): {packageName: string; trailingArgs: string} | null {
  const tokens = shellTokens(input);
  const index = tokens.findIndex((token) => /(?:^|\/)Library\/Caches?\/pnpm\/dlx\//.test(token.replace(/[\\/]+/g, '/')));
  if (index < 0) return null;
  const packageName = extractPackageNameFromPath(tokens[index] ?? '');
  return packageName ? {packageName, trailingArgs: tokens.slice(index + 1).join(' ')} : null;
}

function summarizeCommand(command: string, args: string, home: string): string {
  const normalized = normalizeWhitespace(args);
  if (!normalized) return command || '-';
  const dlx = parsePnpmDlxCommand(normalized);
  if (dlx) {
    const trailing = replaceHome(dlx.trailingArgs, home);
    return `pnpm dlx ${dlx.packageName}${trailing ? ` ${trailing}` : ''}`;
  }
  return replaceHome(normalized, home);
}

function formatDisplayCwd(cwd: string, args: string, home: string): string {
  if (!cwd) return '';
  if (cwd === path.parse(cwd).root && parsePnpmDlxCommand(args)) return '';
  return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

function normalizeProjectToken(input: string): string {
  const value = stripOuterQuotes(input).replace(/[\\/]+$/, '');
  if (!value || value.startsWith('-')) return '';
  const basename = path.basename(value.split('?')[0]?.replace(/^[a-z]+:\/\//i, '') ?? '');
  const candidate = path.parse(basename).name || basename;
  if (!candidate || candidate === '.' || candidate === '..' || /^\d+$/.test(candidate) || isGenericProjectDir(candidate)) return '';
  return candidate;
}

function normalizeAppLabel(input: string): string {
  return input === input.toLowerCase() ? `${input[0]?.toUpperCase() ?? ''}${input.slice(1)}` : input;
}

function isGenericProjectDir(input: string): boolean {
  return GENERIC_PROJECT_DIRS.has(input.toLowerCase());
}

function formatElapsed(ageMs?: number): string {
  if (ageMs === undefined || !Number.isFinite(ageMs)) return '-';
  const seconds = Math.floor(Math.max(0, ageMs) / 1000);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  const clock = [hours, minutes, remainder].map((part) => String(part).padStart(2, '0')).join(':');
  return days > 0 ? `${days}-${clock}` : clock;
}

function normalizeWhitespace(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

function firstToken(input: string): string {
  return shellTokens(input)[0] ?? '';
}

function stripOuterQuotes(input: string): string {
  const value = input.trim();
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

/** Small POSIX-like tokenizer used only for identity/display inference; it never executes input. */
export function shellTokens(input: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const character of input) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = null;
      else token += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (token) {
        tokens.push(token);
        token = '';
      }
    } else {
      token += character;
    }
  }
  if (escaped) token += '\\';
  if (token) tokens.push(token);
  return tokens;
}

function replaceHome(input: string, home: string): string {
  return home ? input.split(home).join('~') : input;
}

function uniqueStrings(input: readonly string[]): string[] {
  return [...new Set(input.filter(Boolean))];
}
