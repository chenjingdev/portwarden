import path from 'node:path';

import type {BrowserSession, ProcessInfo} from './types.js';
import {browserFamily, commandsByteEqual, hasBrowserControlFlags, tokenizeCommand} from './zombies.js';

/** Inventory is deliberately broader than automatic orphan cleanup. A live
 * parent says nothing about whether the user still needs a browser session. */
export function detectBrowserSessions(
  processes: readonly ProcessInfo[],
  options: {ownerUid?: number; now?: number} = {},
): BrowserSession[] {
  const uid = options.ownerUid ?? process.getuid?.();
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const children = new Map<number, ProcessInfo[]>();
  for (const entry of processes) {
    const bucket = children.get(entry.ppid) ?? [];
    bucket.push(entry);
    children.set(entry.ppid, bucket);
  }
  const sessions: BrowserSession[] = [];
  for (const root of processes) {
    if (uid === undefined || root.uid !== uid || root.pid <= 1) continue;
    const family = browserFamily(root);
    if (!family) continue;
    const args = tokenizeCommand(root.command);
    if (args.some((arg) => arg === '--type' || arg.startsWith('--type='))) continue;
    const profile = flagValue(args, '--user-data-dir');
    const profileName = path.basename(profile).toLowerCase();
    const profileFamily = /^playwright[_-].*profile[-_]/.test(profileName) ? 'playwright'
      : /^puppeteer[_-].*profile[-_]/.test(profileName) ? 'puppeteer' : null;
    const control = args.some((arg) => /^--remote-debugging-(?:pipe|port)(?:=|$)/.test(arg));
    if (!control || (!profileFamily && !hasBrowserControlFlags(root.command))) continue;

    const members: ProcessInfo[] = [];
    const seen = new Set<number>();
    const queue = [root];
    for (let index = 0; index < queue.length; index += 1) {
      const entry = queue[index]!;
      if (seen.has(entry.pid) || entry.uid !== uid) continue;
      seen.add(entry.pid);
      members.push(entry);
      queue.push(...(children.get(entry.pid) ?? []));
    }
    const memoryKnown = members.every(({rssBytes}) => typeof rssBytes === 'number' && Number.isFinite(rssBytes) && rssBytes >= 0);
    const parent = root.ppid > 1 ? byPid.get(root.ppid) : undefined;
    const ageMs = root.startTime ? (options.now ?? Date.now()) - root.startTime.getTime() : root.ageMs;
    sessions.push({
      ...root,
      family: profileFamily ?? (family === 'headless-chrome' ? 'chrome-automation' : family),
      profile,
      parentName: parent?.name || (parent ? path.basename(parent.executable) : ''),
      parentState: parent ? 'running' : 'missing',
      ageSeconds: typeof ageMs === 'number' && Number.isFinite(ageMs) ? Math.floor(Math.max(0, ageMs) / 1000) : null,
      members,
      memoryBytes: memoryKnown ? members.reduce((sum, entry) => sum + entry.rssBytes!, 0) : null,
      reason: profileFamily ? `${profileFamily} temporary browser profile` : 'Browser automation and remote-control flags',
    });
  }
  return sessions.sort((left, right) => (right.memoryBytes ?? -1) - (left.memoryBytes ?? -1) || left.pid - right.pid);
}

/** Fail closed on incomplete identity, even for explicit force-stop. */
export function sameBrowserProcess(current: ProcessInfo, expected: ProcessInfo): boolean {
  const uid = process.getuid?.();
  return uid !== undefined && current.uid === uid && expected.uid === uid &&
    current.pid === expected.pid && current.pid > 1 &&
    Boolean(expected.executable.startsWith('/') && expected.command && expected.startTime &&
      Number.isFinite(expected.startTime.getTime())) &&
    current.executable === expected.executable &&
    current.startTime?.getTime() === expected.startTime?.getTime() &&
    commandsByteEqual(current.command, expected.command);
}

export function formatMemory(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '? RAM';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  return `${Math.round(bytes / 1024 ** 2)} MiB`;
}

function flagValue(args: readonly string[], flag: string): string {
  const index = args.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
  if (index < 0) return '';
  return args[index] === flag ? args[index + 1] ?? '' : args[index]!.slice(flag.length + 1);
}
