import path from 'node:path';

import {execa} from 'execa';
import psList, {type ProcessDescriptor} from 'ps-list';

import type {CommandResult, ListenerEntry, ProcessInfo, ZombieCandidate, ZombieFamily} from './types.js';

const DEFAULT_MIN_AGE_MS = 60_000;
const BROWSER_EXECUTABLES = new Set([
  'chrome',
  'chromium',
  'chromium-browser',
  'google chrome',
  'google-chrome',
  'google-chrome-stable',
  'headless_shell',
  'chrome-headless-shell',
]);
const RUNTIME_EXECUTABLES = new Set(['node', 'nodejs', 'bun', 'deno', 'python', 'python3']);
const CONTROLLER_EXECUTABLES = new Set(['playwright', 'puppeteer', 'chromedriver']);
const CONTROL_FLAG_PREFIXES = ['--remote-debugging-pipe', '--remote-debugging-port'] as const;
const AUTOMATION_FLAG_PREFIXES = ['--headless', '--enable-automation', '--no-startup-window'] as const;
const SERVER_ARGUMENTS = new Set(['run-server', 'runserver', 'server', '--server', '--server-mode']);
const WRAPPER_CONTROL_FLAG_PREFIXES = [
  '--headless',
  '--browser',
  '--browser-channel',
  '--cdp-endpoint',
  '--executable-path',
  '--user-data-dir',
  '--isolated',
  '--extension',
] as const;

export interface DetectZombieOptions {
  listeningPids?: ReadonlySet<number> | readonly number[];
  now?: Date | number;
  minAgeMs?: number;
  /** Defaults to the effective Unix uid. Pass null only for non-destructive inventory. */
  ownerUid?: number | null;
}

export interface CollectProcessesOptions {
  provider?: () => Promise<readonly ProcessDescriptor[]>;
  now?: Date | number;
}

export interface ZombieCommandRunner {
  (file: string, args: readonly string[], signal?: AbortSignal): Promise<CommandResult>;
}

export interface CollectListeningPidsOptions {
  strict?: boolean;
  signal?: AbortSignal;
  runCommand?: ZombieCommandRunner;
}

export interface CollectZombiesOptions extends DetectZombieOptions, CollectListeningPidsOptions {
  processProvider?: () => Promise<readonly ProcessInfo[]>;
}

export interface RevalidateZombieOptions {
  signal?: AbortSignal;
  now?: Date | number;
  minAgeMs?: number;
  processProvider?: () => Promise<readonly ProcessInfo[]>;
  listeningPidProvider?: () => Promise<ReadonlySet<number>>;
  runCommand?: ZombieCommandRunner;
}

export interface ReapZombieOptions extends RevalidateZombieOptions {
  signalName?: NodeJS.Signals;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  postSignalTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface WaitForZombieExitOptions {
  processProvider?: () => Promise<readonly ProcessInfo[]>;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export async function collectProcesses(options: CollectProcessesOptions = {}): Promise<ProcessInfo[]> {
  const provider = options.provider ?? (() => psList({all: true}));
  const descriptors = await provider();
  const now = toTimestamp(options.now ?? Date.now());
  return descriptors
    .filter(({pid}) => Number.isSafeInteger(pid) && pid > 0)
    .map((descriptor) => processFromDescriptor(descriptor, now))
    .sort((left, right) => left.pid - right.pid);
}

export function processFromDescriptor(descriptor: ProcessDescriptor, now = Date.now()): ProcessInfo {
  const startTime = descriptor.startTime instanceof Date && Number.isFinite(descriptor.startTime.getTime())
    ? descriptor.startTime
    : undefined;
  return {
    pid: descriptor.pid,
    ppid: descriptor.ppid,
    ...(typeof descriptor.uid === 'number' ? {uid: descriptor.uid} : {}),
    name: descriptor.name ?? '',
    command: descriptor.cmd ?? '',
    executable: descriptor.path ?? '',
    ...(startTime ? {startTime, ageMs: Math.max(0, now - startTime.getTime())} : {}),
  };
}

async function defaultCommandRunner(
  file: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<CommandResult> {
  const result = await execa(file, args, {reject: false, cancelSignal: signal});
  return {stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 1};
}

export function parseListeningPids(raw: string): Set<number> {
  const result = new Set<number>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('p')) continue;
    const pid = Number.parseInt(line.slice(1), 10);
    if (Number.isSafeInteger(pid) && pid > 0) result.add(pid);
  }
  return result;
}

/** A strict call is suitable for kill/reap decisions: every lsof failure is surfaced. */
export async function collectListeningPids(
  options: CollectListeningPidsOptions = {},
): Promise<Set<number>> {
  const runner = options.runCommand ?? defaultCommandRunner;
  try {
    const result = await runner('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fp'], options.signal);
    if (result.exitCode === 0) return parseListeningPids(result.stdout);
    const noMatches = result.exitCode === 1 && result.stdout.trim() === '' && (result.stderr ?? '').trim() === '';
    if (noMatches) return new Set();
    if (!options.strict) return new Set();
    const detail = (result.stderr ?? '').trim();
    throw new Error(`lsof exited with code ${result.exitCode}${detail ? `: ${detail}` : ''}`);
  } catch (error) {
    if (options.strict) throw error;
    return new Set();
  }
}

export function detectZombieCandidates(
  processes: readonly ProcessInfo[],
  options: DetectZombieOptions = {},
): ZombieCandidate[] {
  const now = toTimestamp(options.now ?? Date.now());
  const minAgeMs = options.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const ownerUid = options.ownerUid === undefined ? effectiveUid() : options.ownerUid;
  const listeningPids = options.listeningPids instanceof Set
    ? options.listeningPids
    : new Set(options.listeningPids ?? []);
  const byPid = new Map(processes.map((processInfo) => [processInfo.pid, processInfo]));
  const excludedTree = controllerAndDescendantPids(processes, listeningPids);

  return processes.flatMap((processInfo) => {
    if (typeof ownerUid === 'number' && processInfo.uid !== ownerUid) return [];
    if (excludedTree.has(processInfo.pid)) return [];
    if (listeningPids.has(processInfo.pid)) return [];
    if (!isOrphan(processInfo, byPid)) return [];
    if (hasServerIdentityOrMode(processInfo)) return [];

    const wrapperFamily = automationWrapperFamily(processInfo);
    const browser = browserFamily(processInfo);
    const family = wrapperFamily ?? browser;
    if (!family) return [];
    if (wrapperFamily) {
      // Leaf wrappers are a historical source of portless MCP leftovers. A
      // wrapper with children/listener/server state is classified as an active
      // controller above and its full subtree is protected.
      if (!hasWrapperControlFlags(processInfo.command)) return [];
    } else {
      if (!hasBrowserControlFlags(processInfo.command)) return [];
      // A stock Chrome with remote debugging can be an intentionally long-lived
      // user profile. Only cache-identified automation browsers may be headed.
      if (family === 'headless-chrome' && !hasHeadlessIdentityOrFlag(processInfo)) return [];
    }

    const ageMs = processAgeMs(processInfo, now);
    return [{
      ...processInfo,
      family,
      ageMs,
      ageSeconds: ageMs === null ? null : Math.floor(ageMs / 1000),
      reapable: ageMs !== null && ageMs >= minAgeMs,
      reason: wrapperFamily
        ? `${family} automation wrapper has no live parent or active children`
        : `${family} browser has no live controller`,
    }];
  }).sort(compareZombies);
}

export async function collectZombies(
  listeners?: readonly Pick<ListenerEntry, 'pid'>[] | CollectZombiesOptions,
  options: CollectZombiesOptions = {},
): Promise<ZombieCandidate[]> {
  const hasListenerArray = Array.isArray(listeners);
  const resolvedOptions: CollectZombiesOptions = hasListenerArray
    ? options
    : (listeners as CollectZombiesOptions | undefined) ?? options;
  const processProvider = resolvedOptions.processProvider ?? collectProcesses;
  const processesPromise = processProvider();
  const listeningPromise = hasListenerArray
    ? Promise.resolve(new Set((listeners as readonly Pick<ListenerEntry, 'pid'>[]).map(({pid}) => pid)))
    : collectListeningPids({
      strict: resolvedOptions.strict ?? true,
      signal: resolvedOptions.signal,
      runCommand: resolvedOptions.runCommand,
    });
  const [processes, listeningPids] = await Promise.all([processesPromise, listeningPromise]);
  return detectZombieCandidates(processes, {...resolvedOptions, listeningPids});
}

/**
 * Re-snapshot the process and listeners immediately before a kill. The command
 * comparison deliberately performs no trimming or whitespace normalization.
 */
export async function revalidateZombie(
  candidate: ZombieCandidate,
  options: RevalidateZombieOptions = {},
): Promise<boolean> {
  try {
    const processProvider = options.processProvider ?? collectProcesses;
    const listeningPidProvider = options.listeningPidProvider ?? (() => collectListeningPids({
      strict: true,
      signal: options.signal,
      runCommand: options.runCommand,
    }));
    const [processes, listeningPids] = await Promise.all([processProvider(), listeningPidProvider()]);
    const current = processes.find(({pid}) => pid === candidate.pid);
    if (!current || !commandsByteEqual(current.command, candidate.command)) return false;
    const uid = effectiveUid();
    if (typeof uid === 'number' && (candidate.uid !== uid || current.uid !== uid)) return false;
    if (candidate.uid !== undefined && current.uid !== candidate.uid) return false;
    if (candidate.startTime && current.startTime?.getTime() !== candidate.startTime.getTime()) return false;
    if (candidate.executable && current.executable !== candidate.executable) return false;

    return detectZombieCandidates(processes, {
      listeningPids,
      now: options.now,
      minAgeMs: options.minAgeMs,
    }).some(({pid, command, reapable}) =>
      pid === candidate.pid && reapable && commandsByteEqual(command, candidate.command),
    );
  } catch {
    // lsof/ps uncertainty must never become permission to kill.
    return false;
  }
}

export async function reapZombie(
  candidate: ZombieCandidate,
  options: ReapZombieOptions = {},
): Promise<boolean> {
  if (!candidate.reapable || !(await revalidateZombie(candidate, options))) return false;
  (options.kill ?? process.kill)(candidate.pid, options.signalName ?? 'SIGTERM');
  return waitForZombieExit(candidate, {
    processProvider: options.processProvider,
    timeoutMs: options.postSignalTimeoutMs ?? (options.signalName === 'SIGKILL' ? 1_000 : 3_000),
    pollIntervalMs: options.pollIntervalMs,
  });
}

/** Confirm that the exact process identity disappeared after a signal. */
export async function waitForZombieExit(
  candidate: Pick<ZombieCandidate, 'pid' | 'command' | 'startTime' | 'executable' | 'uid'>,
  options: WaitForZombieExitOptions = {},
): Promise<boolean> {
  const provider = options.processProvider ?? collectProcesses;
  const timeoutMs = Math.max(0, options.timeoutMs ?? 3_000);
  const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 100);
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const current = (await provider()).find(({pid}) => pid === candidate.pid);
      if (!current || !sameProcessIdentity(current, candidate)) return true;
    } catch {
      return false;
    }
    if (Date.now() >= deadline) break;
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return false;
}

export function commandsByteEqual(left: string, right: string): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function sameProcessIdentity(
  current: ProcessInfo,
  expected: Pick<ZombieCandidate, 'command' | 'startTime' | 'executable' | 'uid'>,
): boolean {
  return commandsByteEqual(current.command, expected.command) &&
    (!expected.startTime || current.startTime?.getTime() === expected.startTime.getTime()) &&
    (!expected.executable || current.executable === expected.executable) &&
    (expected.uid === undefined || current.uid === expected.uid);
}

export function browserFamily(processInfo: ProcessInfo): ZombieFamily | null {
  const executableIdentity = executableName(processInfo);
  if (!BROWSER_EXECUTABLES.has(executableIdentity)) return null;

  const executablePath = normalizedExecutablePath(processInfo);
  if (/(?:^|\/)ms-playwright(?:\/|$)/.test(executablePath)) return 'playwright';
  if (/(?:^|\/)(?:\.cache\/)?puppeteer(?:\/|$)/.test(executablePath)) return 'puppeteer';
  return 'headless-chrome';
}

export function automationWrapperFamily(processInfo: ProcessInfo): Exclude<ZombieFamily, 'headless-chrome'> | null {
  if (!RUNTIME_EXECUTABLES.has(executableName(processInfo))) return null;
  const script = runtimeScriptIdentity(processInfo.command).toLowerCase().replace(/\\/g, '/');
  if (!script) return null;
  if (/(?:^|\/)node_modules\/(?:@playwright\/mcp|playwright|playwright-core)(?:\/|$)/.test(script)) {
    return 'playwright';
  }
  if (/(?:^|\/)node_modules\/(?:puppeteer|puppeteer-core)(?:\/|$)/.test(script)) {
    return 'puppeteer';
  }
  return null;
}

export function hasBrowserControlFlags(command: string): boolean {
  const args = commandArguments(command);
  const hasControl = args.some((argument) =>
    CONTROL_FLAG_PREFIXES.some((flag) => argument === flag || argument.startsWith(`${flag}=`)),
  );
  const hasAutomation = args.some((argument) =>
    AUTOMATION_FLAG_PREFIXES.some((flag) => argument === flag || argument.startsWith(`${flag}=`)),
  );
  return hasControl && hasAutomation;
}

export function hasHeadlessIdentityOrFlag(processInfo: ProcessInfo): boolean {
  const executable = executableName(processInfo);
  if (executable === 'headless_shell' || executable === 'chrome-headless-shell') return true;
  return commandArguments(processInfo.command).some((argument) =>
    argument === '--headless' || argument.startsWith('--headless='),
  );
}

export function hasWrapperControlFlags(command: string): boolean {
  const args = commandArguments(command);
  return args.some((argument) =>
    CONTROL_FLAG_PREFIXES.some((flag) => argument === flag || argument.startsWith(`${flag}=`)) ||
    WRAPPER_CONTROL_FLAG_PREFIXES.some((flag) => argument === flag || argument.startsWith(`${flag}=`)),
  );
}

export function isControllerProcess(processInfo: ProcessInfo): boolean {
  const executable = executableName(processInfo);
  if (CONTROLLER_EXECUTABLES.has(executable)) return true;
  if (automationWrapperFamily(processInfo)) return true;
  if (!RUNTIME_EXECUTABLES.has(executable)) return false;

  const script = runtimeScriptIdentity(processInfo.command);
  if (!script) return false;
  const normalized = script.toLowerCase().replace(/\\/g, '/');
  return (
    /(?:^|\/)node_modules\/(?:@[^/]+\/)?(?:playwright|playwright-core|puppeteer|puppeteer-core)(?:\/|$)/.test(normalized) ||
    /(?:^|\/)(?:playwright|puppeteer)(?:\.js|\.mjs|\.cjs|\.ts|\/cli\.js)$/.test(normalized)
  );
}

export function hasServerIdentityOrMode(processInfo: ProcessInfo): boolean {
  if (executableName(processInfo) === 'chromedriver') return true;
  return commandArguments(processInfo.command).some((argument) => {
    const normalized = argument.toLowerCase();
    return (
      SERVER_ARGUMENTS.has(normalized) ||
      normalized.startsWith('--server-mode=') ||
      normalized === '--port' ||
      normalized.startsWith('--port=')
    );
  });
}

export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const character of command) {
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

function controllerAndDescendantPids(
  processes: readonly ProcessInfo[],
  listeningPids: ReadonlySet<number>,
): Set<number> {
  const children = new Map<number, number[]>();
  for (const processInfo of processes) {
    const siblings = children.get(processInfo.ppid) ?? [];
    siblings.push(processInfo.pid);
    children.set(processInfo.ppid, siblings);
  }

  const excluded = new Set<number>();
  const queue = processes
    .filter((processInfo) =>
      isControllerProcess(processInfo) && (
        executableName(processInfo) === 'chromedriver' ||
        (children.get(processInfo.pid)?.length ?? 0) > 0 ||
        listeningPids.has(processInfo.pid) ||
        hasServerIdentityOrMode(processInfo)
      ),
    )
    .map(({pid}) => pid);
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined || excluded.has(pid)) continue;
    excluded.add(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return excluded;
}

function isOrphan(processInfo: ProcessInfo, byPid: ReadonlyMap<number, ProcessInfo>): boolean {
  return processInfo.ppid === 1 || processInfo.ppid <= 0 || !byPid.has(processInfo.ppid);
}

function executableName(processInfo: ProcessInfo): string {
  const identity = processInfo.executable || processInfo.name;
  return path.basename(identity).trim().toLowerCase();
}

function normalizedExecutablePath(processInfo: ProcessInfo): string {
  return (processInfo.executable || processInfo.name).trim().toLowerCase().replace(/\\/g, '/');
}

function commandArguments(command: string): string[] {
  const tokens = tokenizeCommand(command);
  return tokens.length > 1 ? tokens.slice(1) : [];
}

function runtimeScriptIdentity(command: string): string {
  const tokens = tokenizeCommand(command);
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token === '--') return tokens[index + 1] ?? '';
    if (!token.startsWith('-')) return token;
    if (token === '-e' || token === '--eval' || token === '-p' || token === '--print') return '';
  }
  return '';
}

function processAgeMs(processInfo: ProcessInfo, now: number): number | null {
  if (processInfo.startTime && Number.isFinite(processInfo.startTime.getTime())) {
    return Math.max(0, now - processInfo.startTime.getTime());
  }
  return typeof processInfo.ageMs === 'number' && Number.isFinite(processInfo.ageMs)
    ? Math.max(0, processInfo.ageMs)
    : null;
}

function compareZombies(left: ZombieCandidate, right: ZombieCandidate): number {
  if (left.reapable !== right.reapable) return left.reapable ? -1 : 1;
  const leftAge = left.ageMs ?? -1;
  const rightAge = right.ageMs ?? -1;
  return rightAge - leftAge || left.pid - right.pid;
}

function toTimestamp(value: Date | number): number {
  return value instanceof Date ? value.getTime() : value;
}

function effectiveUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
