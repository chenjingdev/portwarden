import fs from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';

import {execa} from 'execa';

import {getProjectName, interpreterShortName, resolveClaudeSlug, shellTokens} from './listeners.js';
import type {BrowserSession, ListenerEntry, ProcessInfo} from './types.js';

export interface Launcher {
  sessionId?: string;
  terminal?: string;
  name?: string;
  state: 'live' | 'ended';
}

export interface LauncherTarget {
  pid: number;
  envPids: readonly number[];
  ppid: number | null;
  cwd: string;
  command: string;
  executable: string;
  sharedInstall: boolean;
}

export interface LauncherOptions {
  home?: string;
  runPsEnv?: (pids: readonly number[]) => Promise<string>;
  runHc?: () => Promise<string>;
  sessionsDirectory?: string;
}

interface ClaudeSession {
  sessionId: string;
  pid: number;
  procStart?: string;
  name?: string;
}

interface HcTerminal {
  address: string;
  name?: string;
  where?: string;
  state: string;
}

const SESSION_ID_ENV = /\bCLAUDE_CODE_SESSION_ID=([0-9a-f-]{36})/g;
const TERMINAL_ENV = /\bHC_TERMINAL_ID=(\S+)/g;

function lastEnvValue(pattern: RegExp, line: string): string | undefined {
  return [...line.matchAll(pattern)].at(-1)?.[1];
}
const CLAUDE_TEMP_PATH = /\/tmp\/claude-\d+\/([^/\s]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\/|\s|$)/;

const INSTALLED_PROGRAM_ROOTS = (home: string): readonly string[] => [
  path.join(home, '.claude', 'plugins'),
  '/Applications',
  path.join(home, 'Applications'),
  path.join(home, 'Library'),
  path.join(home, '.local'),
  '/System',
  '/Library',
];

const CACHE_ROOTS = (home: string): readonly string[] => [path.join(home, 'Library', 'Caches')];

async function runPsEnv(pids: readonly number[]): Promise<string> {
  const result = await execa('ps', ['-wwE', '-o', 'pid=,command=', '-p', pids.join(',')], {
    reject: false,
    env: {LC_ALL: 'en_US.UTF-8'},
  });
  return result.stdout;
}

async function runHc(): Promise<string> {
  const result = await execa('hc', ['ls', '--all', '--json'], {reject: false});
  return result.stdout;
}

function readSessions(directory: string): Map<string, ClaudeSession> {
  const sessions = new Map<string, ClaudeSession>();
  let files: string[];
  try {
    files = fs.readdirSync(directory).filter((file) => file.endsWith('.json'));
  } catch {
    return sessions;
  }
  for (const file of files) {
    try {
      const session = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')) as Partial<ClaudeSession>;
      if (typeof session.sessionId === 'string' && Number.isSafeInteger(session.pid)) {
        sessions.set(session.sessionId, session as ClaudeSession);
      }
    } catch {
      continue;
    }
  }
  return sessions;
}

function parseHcTerminals(raw: string): Map<string, HcTerminal> {
  try {
    const {terminals} = JSON.parse(raw) as {terminals: HcTerminal[]};
    return new Map(terminals.map((terminal) => [terminal.address, terminal]));
  } catch {
    return new Map();
  }
}

function parseEnvLines(raw: string): Map<number, string> {
  const lines = new Map<number, string>();
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*(\d+) (.*)$/.exec(line);
    if (match) lines.set(Number(match[1]), match[2]!);
  }
  return lines;
}

function scriptPath(argv: readonly string[]): string {
  return argv.slice(1).find((token) => !token.startsWith('-')) ?? '';
}

function scriptOrBinaryPath(executable: string, command: string, cwd: string): string {
  const argv = shellTokens(command);
  const binary = executable || argv[0] || '';
  if (!interpreterShortName(binary)) return binary;
  const script = scriptPath(argv);
  return script && cwd ? path.resolve(cwd, script) : script;
}

function isUnder(target: string, roots: readonly string[]): boolean {
  return roots.some((root) => target === root || target.startsWith(`${root}${path.sep}`));
}

export function isInstalledProgram(executable: string, command: string, cwd: string, home = homedir()): boolean {
  const program = scriptOrBinaryPath(executable, command, cwd);
  return isUnder(program, INSTALLED_PROGRAM_ROOTS(home)) && !isUnder(program, CACHE_ROOTS(home));
}

export function launcherLabel(launcher: Launcher | undefined): string {
  if (!launcher) return '-';
  const address = launcher.terminal ?? launcher.sessionId?.slice(0, 8) ?? '-';
  return `${address}${launcher.state === 'ended' ? '✗' : ''}${launcher.name ? ` ${launcher.name}` : ''}`;
}

export function isLeftover(launcher: Launcher | undefined, target: Pick<LauncherTarget, 'sharedInstall'>): boolean {
  return launcher?.state === 'ended' && !target.sharedInstall;
}

export async function collectLaunchers(
  targets: readonly LauncherTarget[],
  processes: readonly ProcessInfo[],
  options: LauncherOptions = {},
): Promise<Map<number, Launcher>> {
  const home = options.home ?? homedir();
  const pids = [...new Set(targets.flatMap(({envPids}) => envPids))];
  const envLines = pids.length === 0 ? new Map<number, string>() : parseEnvLines(await (options.runPsEnv ?? runPsEnv)(pids));
  const identities = new Map(targets.map((target) => {
    const line = target.envPids.map((pid) => envLines.get(pid) ?? '')
      .find((candidate) => lastEnvValue(SESSION_ID_ENV, candidate) || lastEnvValue(TERMINAL_ENV, candidate)) ?? '';
    const temp = CLAUDE_TEMP_PATH.exec(`${target.cwd}\n${target.command}`);
    return [target.pid, {
      sessionId: lastEnvValue(SESSION_ID_ENV, line) ?? temp?.[2],
      terminal: lastEnvValue(TERMINAL_ENV, line),
      slug: temp?.[1],
    }] as const;
  }));
  const needsTerminals = [...identities.values()].some(({terminal}) => terminal);
  const sessions = readSessions(options.sessionsDirectory ?? path.join(home, '.claude', 'sessions'));
  const terminals = needsTerminals ? parseHcTerminals(await (options.runHc ?? runHc)()) : new Map<string, HcTerminal>();
  const startByPid = new Map(processes.map(({pid, startTime}) => [pid, startTime?.getTime()]));
  const sessionAlive = (session: ClaudeSession): boolean => startByPid.has(session.pid) &&
    (!session.procStart || new Date(session.procStart).getTime() === startByPid.get(session.pid));

  const launchers = new Map<number, Launcher>();
  for (const [pid, {sessionId, terminal, slug}] of identities) {
    if (!sessionId && !terminal) continue;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    const hc = terminal ? terminals.get(terminal) : undefined;
    const live = Boolean(session && sessionAlive(session)) || hc?.state === 'live';
    const name = hc?.name ?? hc?.where ?? session?.name ??
      (slug ? getProjectName({cwd: resolveClaudeSlug(slug), command: '', args: '', home}) : undefined);
    launchers.set(pid, {
      ...(sessionId ? {sessionId} : {}),
      ...(terminal ? {terminal} : {}),
      ...(name ? {name} : {}),
      state: live ? 'live' : 'ended',
    });
  }
  return launchers;
}

export async function attachLaunchers(
  listeners: readonly ListenerEntry[],
  browsers: readonly BrowserSession[],
  processes: readonly ProcessInfo[],
  options: LauncherOptions = {},
): Promise<{listeners: ListenerEntry[]; browsers: BrowserSession[]}> {
  const home = options.home ?? homedir();
  const listenerTarget = (entry: ListenerEntry): LauncherTarget => {
    const root = entry.task?.root;
    const executable = root?.executable ?? entry.executable ?? '';
    const command = root?.command ?? entry.args;
    return {
      pid: root?.pid ?? entry.pid,
      envPids: [...new Set([root?.pid ?? entry.pid, entry.pid, ...(entry.task?.members.map(({pid}) => pid) ?? [])])],
      ppid: root ? root.ppid : entry.ppid,
      cwd: root?.cwd ?? entry.cwd,
      command,
      executable,
      sharedInstall: isInstalledProgram(executable, command, root?.cwd ?? entry.cwd, home),
    };
  };
  const browserTarget = (entry: BrowserSession): LauncherTarget => ({
    pid: entry.pid, envPids: [entry.pid], ppid: entry.ppid, cwd: entry.cwd ?? '', command: entry.command, executable: entry.executable, sharedInstall: false,
  });
  const listenerTargets = listeners.map(listenerTarget);
  const browserTargets = browsers.map(browserTarget);
  const launchers = await collectLaunchers([...listenerTargets, ...browserTargets], processes, options);
  const annotate = <T extends object>(entry: T, target: LauncherTarget): T & {leftover: boolean} => {
    const launcher = launchers.get(target.pid);
    return {...entry, ...(launcher ? {launcher} : {}), leftover: isLeftover(launcher, target)};
  };
  return {
    listeners: listeners.map((entry, index) => annotate(entry, listenerTargets[index]!)),
    browsers: browsers.map((entry, index) => annotate(entry, browserTargets[index]!)),
  };
}
