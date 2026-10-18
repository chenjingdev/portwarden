import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {execa} from 'execa';

import {collectProcessMetadata} from './listeners.js';
import type {CuaConnection, ProcessInfo} from './types.js';
import {tokenizeCommand} from './zombies.js';

function identity(entry: ProcessInfo): Pick<CuaConnection, 'provider' | 'label' | 'canStop'> | undefined {
  const args = tokenizeCommand(entry.command);
  if (args.some((arg) => /\/(?:claude-computer-use-plugin|codex-computer-use)(?:\/\d+(?:\.\d+)*)?\/mcp_stdio\.py$/.test(arg))) {
    return {provider: 'codex-cua', label: 'Claude CUA bridge', canStop: true};
  }
  if (args.some((arg) => /\/@oai\/cua-repl\/bin\/cua-repl\.mjs$/.test(arg))) {
    return {provider: 'codex-cua', label: 'Codex CUA connection', canStop: true};
  }
  if (path.basename(entry.executable || args[0] || '') === 'cmux-cua' && args.includes('mcp')) {
    return {provider: 'cmux-cua', label: 'cmux CUA connection', canStop: true};
  }
  if (path.basename(entry.executable) === 'ChatGPT for Chrome' || entry.name === 'ChatGPT for Chrome' || /\/ChatGPT for Chrome chrome-extension:\/\//.test(entry.command)) {
    return {provider: 'chrome-extension', label: 'Chrome CUA shared transport', canStop: false};
  }
  if (path.basename(entry.executable) === 'SkyComputerUseService' || entry.name === 'SkyComputerUseService') {
    return {provider: 'macos-service', label: 'macOS CUA shared service', canStop: false};
  }
  return undefined;
}

export function detectCuaConnections(processes: readonly ProcessInfo[], options: {ownerUid?: number; now?: number} = {}): CuaConnection[] {
  const uid = options.ownerUid ?? process.getuid?.();
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const children = new Map<number, ProcessInfo[]>();
  for (const entry of processes) children.set(entry.ppid, [...(children.get(entry.ppid) ?? []), entry]);
  return processes.flatMap((root): CuaConnection[] => {
    if (uid === undefined || root.uid !== uid || root.pid <= 1) return [];
    const kind = identity(root);
    if (!kind) return [];
    // A Claude bridge owns its cua-repl child; emit only the bridge row.
    if (kind.canStop && byPid.get(root.ppid) && identity(byPid.get(root.ppid)!)?.canStop) return [];
    const members: ProcessInfo[] = [];
    const seen = new Set<number>();
    const queue = [root];
    for (let index = 0; index < queue.length; index++) {
      const entry = queue[index]!;
      if (seen.has(entry.pid) || entry.uid !== uid) continue;
      seen.add(entry.pid);
      members.push(entry);
      if (kind.canStop) queue.push(...(children.get(entry.pid) ?? []));
    }
    let ancestor = byPid.get(root.ppid);
    const ancestors = new Set<number>();
    let agent: CuaConnection['agent'] = kind.canStop ? 'Codex' : 'Shared';
    while (ancestor && !ancestors.has(ancestor.pid)) {
      ancestors.add(ancestor.pid);
      if (path.basename(ancestor.executable || tokenizeCommand(ancestor.command)[0] || '') === 'claude') {agent = 'Claude'; break;}
      ancestor = byPid.get(ancestor.ppid);
    }
    const ageMs = root.startTime ? (options.now ?? Date.now()) - root.startTime.getTime() : root.ageMs;
    const workingDir = members.map((entry) => flagValue(tokenizeCommand(entry.command), '--working-dir')).find(Boolean);
    return [{...root, ...kind, agent, ...(workingDir ? {cwd: workingDir} : {}), members,
      memoryBytes: members.every(({rssBytes}) => rssBytes !== undefined) ? members.reduce((sum, {rssBytes}) => sum + rssBytes!, 0) : null,
      ageSeconds: typeof ageMs === 'number' ? Math.floor(Math.max(0, ageMs) / 1000) : null,
      sockets: [], transportState: kind.canStop ? 'unknown' : 'shared', tabOwnership: 'unknown'}];
  }).sort((a, b) => Number(b.canStop) - Number(a.canStop) || a.agent.localeCompare(b.agent) || a.pid - b.pid);
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
  return index < 0 ? undefined : args[index] === flag ? args[index + 1] : args[index]!.slice(flag.length + 1);
}

export function parseCuaSockets(raw: string): Map<number, string[]> {
  const result = new Map<number, string[]>();
  let pid = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    if (pid && line.startsWith('n/') && /codex-browser-use|computeruse\.sock|cmux-cua.*\.sock/.test(line)) {
      result.set(pid, [...new Set([...(result.get(pid) ?? []), line.slice(1)])]);
    }
  }
  return result;
}

/** On macOS client sockets show ->kernel-address rather than the server's path.
 * Match those peers against the named server endpoint; a missing path alone is not inactivity. */
export function parseCuaSocketTable(raw: string): Map<number, string[]> {
  const endpoints = new Map<string, string>();
  const sockets = new Map<number, string[]>();
  const peers: {pid: number; target: string}[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts[4] !== 'unix' || !/^\d+$/.test(parts[1] ?? '')) continue;
    const pid = Number(parts[1]);
    const name = /\s(\/.*|->0x[\da-f]+)\s*$/i.exec(line)?.[1]?.trim();
    if (!name) continue;
    if (name.startsWith('/') && /codex-browser-use|computeruse\.sock|cmux-cua.*\.sock/.test(name)) {
      endpoints.set(parts[5]!, name);
      sockets.set(pid, [...new Set([...(sockets.get(pid) ?? []), name])]);
    } else if (name.startsWith('->')) peers.push({pid, target: name.slice(2)});
  }
  for (const {pid, target} of peers) {
    const endpoint = endpoints.get(target);
    if (endpoint) sockets.set(pid, [...new Set([...(sockets.get(pid) ?? []), endpoint])]);
  }
  return sockets;
}

/** Read only process metadata and the bridge's small transport log, never credentials or chat transcripts. */
export async function collectCuaConnections(processes: readonly ProcessInfo[], options: {signal?: AbortSignal; home?: string} = {}): Promise<CuaConnection[]> {
  let connections = detectCuaConnections(processes);
  if (connections.length === 0) return [];
  const pids = [...new Set([...connections.flatMap(({members}) => members.map(({pid}) => pid)),
    ...processes.filter((entry) => path.basename(entry.executable) === 'cmux-cua').map(({pid}) => pid)])];
  const metadata = await collectProcessMetadata(pids, {signal: options.signal});
  connections = detectCuaConnections(processes.map((entry) => {
    const detail = metadata.get(entry.pid);
    return detail ? {...entry, executable: entry.executable || detail.executable || '', cwd: detail.cwd} : entry;
  }));
  try {
    const result = await execa('lsof', ['-nP', '-a', '-p', pids.join(','), '-U'], {reject: false, cancelSignal: options.signal});
    const sockets = parseCuaSocketTable(result.stdout);
    const complete = result.exitCode === 0 && !result.stderr.trim();
    connections = connections.map((entry) => {
      const paths = [...new Set(entry.members.flatMap(({pid}) => sockets.get(pid) ?? []))];
      return {...entry, sockets: paths, transportState: !entry.canStop ? 'shared' : paths.length ? 'connected' : complete ? 'not-observed' : 'unknown'};
    });
  } catch { /* Socket discovery can be unavailable; the process inventory remains useful. */ }
  const root = path.join(options.home ?? os.homedir(), 'Library/Caches/codex-computer-use-plugin');
  const dirs = await fs.readdir(root, {withFileTypes: true}).catch(() => []);
  const readLog = async (dir: {name: string}) => {
    const filename = path.join(root, dir.name, 'transport.jsonl');
    let file;
    try {
      file = await fs.open(filename, 'r');
      const stat = await file.stat();
      const head = Buffer.alloc(Math.min(8192, stat.size));
      await file.read(head, 0, head.length, 0);
      const started = JSON.parse(head.toString().split('\n')[0]!);
      if (started.event !== 'started') return;
      const entry = connections.find((item) => item.agent === 'Claude' && item.members.some(({pid}) => pid === started.backend_pid));
      const backend = entry?.members.find(({pid}) => pid === started.backend_pid);
      // Birth time prevents matching an old log to a recycled PID. Ambiguous metadata is omitted.
      if (!entry || !backend?.startTime || Math.abs(stat.birthtimeMs - backend.startTime.getTime()) > 10_000) return;
      if (typeof started.session_id === 'string' && /^[\w-]{1,100}$/.test(started.session_id)) entry.sessionId = started.session_id;
      if (typeof started.cwd === 'string' && started.cwd.startsWith('/')) entry.cwd = started.cwd;
      const size = Math.min(stat.size, 16_384);
      const tail = Buffer.alloc(size);
      await file.read(tail, 0, size, stat.size - size);
      const lines = tail.toString().split('\n');
      for (const line of lines.reverse()) {
        try {
          const event = JSON.parse(line);
          if (event.event === 'request_received' && typeof event.tool === 'string' && /^[\w-]{1,50}$/.test(event.tool)) {entry.lastCall = event.tool; break;}
        } catch { /* A partial or concurrently-written JSON line is ignored. */ }
      }
    } catch { /* Old/missing logs do not imply a disconnected or idle session. */ }
    finally {await file?.close();}
  };
  const logDirs = dirs.filter((dir) => dir.isDirectory() && /^[\w-]+$/.test(dir.name));
  for (let index = 0; index < logDirs.length; index += 16) {
    if (options.signal?.aborted) break;
    await Promise.all(logDirs.slice(index, index + 16).map(readLog));
  }
  return connections;
}
