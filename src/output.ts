import Table from 'cli-table3';

import {redactCommandLine, sanitizeText} from './core/commands.js';
import type {ListenerEntry, ZombieCandidate} from './core/types.js';

export interface OutputOptions {
  all: boolean;
  json: boolean;
  jsonLines?: boolean;
  showZombies?: boolean;
  terminalWidth?: number;
  watchSeconds?: number;
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
): string {
  if (options.json) {
    const entries = [
      ...listeners.map(listenerToJson),
      ...zombies.map(zombieToJson),
    ];
    return options.jsonLines ? JSON.stringify(entries) : JSON.stringify(entries, null, 2);
  }

  const shown = listeners.length + zombies.length;
  const hidden = Math.max(0, allListenerCount - listeners.length);
  const lines = [
    `${options.all ? 'All LISTEN ports' : 'Pinned + dev ports'}: ${listeners.length}${zombies.length ? ` · zombies: ${zombies.length}` : ''}`,
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
    lines.push(options.all ? 'No LISTEN ports found.' : 'No pinned or dev-like LISTEN ports found.');
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

  for (const entry of listeners) {
    const fullRow = [
      entry.kind,
      String(entry.port),
      String(entry.pid),
      entry.elapsed,
      entry.displayHost,
      sanitizeText(entry.displayProject) || '-',
      redactCommandLine(entry.args || entry.displayCommand),
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
  lines.push(table.toString());
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
