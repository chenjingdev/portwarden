import Table from 'cli-table3';

import {redactCommandLine, sanitizeText} from './core/commands.js';
import type {BrowserSession, ListenerEntry, ZombieCandidate} from './core/types.js';
import {formatMemory} from './core/browserSessions.js';

export interface OutputOptions {
  all: boolean;
  json: boolean;
  jsonLines?: boolean;
  showZombies?: boolean;
  terminalWidth?: number;
  watchSeconds?: number;
  allListeners?: readonly ListenerEntry[];
}

export interface ReapResult {
  candidate: ZombieCandidate;
  status: 'dry-run' | 'stopped' | 'skipped';
}

export function renderOutput(
  listeners: readonly ListenerEntry[],
  allListenerCount: number,
  zombies: readonly ZombieCandidate[],
  options: OutputOptions,
  browsers: readonly BrowserSession[] = [],
): string {
  const tasks = new Map((options.allListeners ?? listeners).flatMap(({task}) => task ? [[task.key, task] as const] : []));
  const taskPids = new Set([...tasks.values()].flatMap(({members}) => members.map(({pid}) => pid)));
  browsers = browsers.filter(({pid}) => !taskPids.has(pid));
  const browserPids = new Set(browsers.flatMap(({members}) => members.map(({pid}) => pid)));
  const scopePorts = (pid: number) => [...new Set((options.allListeners ?? listeners).filter((entry) => entry.pid === pid).map(({port}) => port))];
  zombies = zombies.filter(({pid}) => !browserPids.has(pid) && !taskPids.has(pid));
  if (options.json) {
    const entries = [
      ...listeners.map((entry) => ({...listenerToJson(entry), stopScope: entry.task ? {
        type: 'task', rootPid: entry.task.root.pid, ports: entry.task.ports,
        memberPids: entry.task.members.map(({pid}) => pid), processCount: entry.task.members.length,
        command: redactCommandLine(entry.task.root.command), memoryBytes: entry.task.memoryBytes,
        blockedReason: entry.task.blockedReason,
      } : {pid: entry.pid, ports: scopePorts(entry.pid)}})),
      ...zombies.map(zombieToJson),
      ...browsers.map(browserToJson),
    ];
    return options.jsonLines ? JSON.stringify(entries) : JSON.stringify(entries, null, 2);
  }

  const shown = listeners.length + zombies.length + browsers.length;
  const hidden = Math.max(0, allListenerCount - listeners.length);
  const lines = [
    `${options.all ? 'All LISTEN ports' : 'Relevant + pinned ports'}: ${listeners.length}${zombies.length ? ` · zombies: ${zombies.length}` : ''}`,
    `Updated: ${new Date().toLocaleString()}`,
  ];
  if (!options.all && hidden > 0) {
    lines.push(`Other listeners hidden: ${hidden}`);
  }
  if (options.watchSeconds && options.watchSeconds > 0) {
    lines.push(`Refresh interval: ${options.watchSeconds}s`);
  }
  lines.push('');

  if (shown === 0) {
    lines.push(options.all ? 'No LISTEN ports found.' : 'No relevant or pinned LISTEN ports found.');
    return lines.join('\n');
  }

  const width = options.terminalWidth ?? process.stdout.columns ?? 120;
  const ultraCompact = width < 32;
  const compact = width < 90;
  const projectWidth = Math.max(10, Math.min(18, Math.floor(width * 0.25)));
  const commandWidth = compact
    ? Math.max(1, width - (ultraCompact ? 8 : 18 + projectWidth))
    : Math.max(8, Math.min(52, width - 60 - projectWidth));
  const head = ultraCompact
    ? ['PORT', 'PROCESS']
    : compact
      ? ['PORT', 'PID', 'PROJECT', 'PROCESS']
      : ['KIND', 'PORT', 'PID', 'AGE', 'HOST', 'PROJECT', 'PROCESS'];
  const colWidths = ultraCompact
    ? [7, commandWidth]
    : compact
      ? [7, 8, projectWidth, commandWidth]
      : [9, 7, 8, 13, 17, projectWidth, commandWidth];
  const table = new Table({
    head,
    colWidths,
    colAligns: ultraCompact
      ? ['right', 'left']
      : compact
        ? ['right', 'right', 'left', 'left']
        : ['left', 'right', 'right', 'left', 'left', 'left', 'left'],
    wordWrap: false,
    style: {'padding-left': 0, 'padding-right': 1, head: [], border: []},
    chars: {
      top: '', 'top-mid': '', 'top-left': '', 'top-right': '',
      bottom: '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '',
      left: '', 'left-mid': '', mid: '', 'mid-mid': '',
      right: '', 'right-mid': '', middle: ' ',
    },
  });

  for (const entry of new Map(listeners.filter(({pid}) => !browserPids.has(pid)).map((entry) => [entry.task?.key ?? `pid:${entry.pid}`, entry])).values()) {
    const ports = entry.task?.ports ?? scopePorts(entry.pid);
    const fullRow = [
      entry.task ? 'task' : entry.kind,
      ports.length > 1 ? `${ports.length}x` : String(entry.port),
      String(entry.task?.root.pid ?? entry.pid),
      entry.elapsed,
      entry.displayHost,
      sanitizeText(entry.displayProject) || '-',
      `${entry.task ? `${entry.task.members.length} procs · ` : ''}${ports.length > 1 ? `ports ${ports.join(', ')} · ` : ''}${redactCommandLine(entry.task?.root.command || entry.args || entry.displayCommand)}`,
    ];
    table.push(ultraCompact ? [fullRow[1]!, fullRow[6]!] : compact ? [fullRow[1]!, fullRow[2]!, fullRow[5]!, fullRow[6]!] : fullRow);
  }
  for (const zombie of zombies) {
    const fullRow = [
      'zombie',
      '-',
      String(zombie.pid),
      formatAge(zombie.ageSeconds),
      '-',
      zombie.family,
      redactCommandLine(zombie.command),
    ];
    table.push(ultraCompact ? [fullRow[1]!, fullRow[6]!] : compact ? [fullRow[1]!, fullRow[2]!, fullRow[5]!, fullRow[6]!] : fullRow);
  }
  if (listeners.length + zombies.length > 0) lines.push(table.toString());
  if (browsers.length > 0) {
    const memory = browsers.every(({memoryBytes}) => memoryBytes !== null)
      ? browsers.reduce((sum, {memoryBytes}) => sum + (memoryBytes ?? 0), 0) : null;
    lines.push('', `Dev browsers: ${browsers.length} · ${formatMemory(memory)} RSS sum (includes helpers)`,
      '  PID      RAM        PROCS  AGE          FAMILY      PARENT');
    for (const browser of browsers) {
      lines.push(`  ${String(browser.pid).padEnd(8)} ${formatMemory(browser.memoryBytes).padEnd(10)} ${String(browser.members.length).padEnd(6)} ${formatAge(browser.ageSeconds).padEnd(12)} ${browser.family.padEnd(11)} ${browser.ppid} ${sanitizeText(browser.parentName)} (${browser.parentState})`);
    }
    lines.push('RSS can count shared memory more than once. A running parent does not establish activity.',
      'Stop one browser + helpers: portwarden --kill-pid <PID> (add --force for SIGKILL)');
  }
  return lines.join('\n');
}

export function renderReapResults(results: readonly ReapResult[], signal: NodeJS.Signals): string {
  if (results.length === 0) {
    return 'No orphaned automation processes found.';
  }
  const stopped = results.filter(({status}) => status === 'stopped');
  const preview = results.filter(({status}) => status === 'dry-run');
  const skipped = results.filter(({status}) => status === 'skipped');
  const heading = preview.length > 0
    ? `Would stop ${preview.length} orphaned automation process(es) (${signal}):`
    : `Stopped ${stopped.length} orphaned automation process(es) (${signal}):`;
  const lines = [heading];
  for (const {candidate, status} of results) {
    lines.push(
      `  ${status === 'skipped' ? 'SKIP' : 'PID'} ${candidate.pid}  ${candidate.family}  age ${formatAge(candidate.ageSeconds)}  ${redactCommandLine(candidate.command)}`,
    );
  }
  if (skipped.length > 0) {
    lines.push(`${skipped.length} process(es) changed or became active and were skipped.`);
  }
  return lines.join('\n');
}

function listenerToJson(entry: ListenerEntry): Record<string, unknown> {
  return {
    type: 'listener',
    kind: entry.kind,
    port: entry.port,
    pid: entry.pid,
    ppid: entry.ppid,
    age: entry.elapsed,
    host: entry.displayHost,
    listenerHosts: entry.listenerHosts.map(sanitizeText),
    project: sanitizeText(entry.displayProject),
    command: redactCommandLine(entry.args || entry.displayCommand),
    cwd: sanitizeText(entry.displayCwd),
  };
}

function zombieToJson(entry: ZombieCandidate): Record<string, unknown> {
  return {
    type: 'zombie',
    kind: entry.family,
    pid: entry.pid,
    ppid: entry.ppid,
    ageSeconds: entry.ageSeconds,
    reapable: entry.reapable,
    command: redactCommandLine(entry.command),
    reason: sanitizeText(entry.reason),
  };
}

function browserToJson(entry: BrowserSession): Record<string, unknown> {
  return {
    type: 'browser', kind: entry.family, pid: entry.pid, ppid: entry.ppid,
    ageSeconds: entry.ageSeconds, memoryBytes: entry.memoryBytes, memoryMetric: 'rss-sum',
    processCount: entry.members.length, memberPids: entry.members.map(({pid}) => pid),
    parentState: entry.parentState, parentName: sanitizeText(entry.parentName),
    profile: sanitizeText(entry.profile), reason: sanitizeText(entry.reason),
    command: redactCommandLine(entry.command),
  };
}

function formatAge(seconds: number | null): string {
  if (seconds === null) {
    return '-';
  }
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  const clock = [hours, minutes, remainder].map((part) => String(part).padStart(2, '0')).join(':');
  return days > 0 ? `${days}-${clock}` : clock;
}
