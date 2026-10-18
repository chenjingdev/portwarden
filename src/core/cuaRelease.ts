import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import type {CuaConnection} from './types.js';

export interface CuaReleaseResult {released: boolean; reason?: string; scopeCount?: number;}

/** The relay is opt-in. Legacy connections are never assigned guessed session IDs. */
export async function releaseCuaTabs(candidate: CuaConnection, stateDirectory = path.join(os.homedir(), 'Library/Caches/portwarden-cua')): Promise<CuaReleaseResult> {
  const privateFile = async (file: string, type: 'isDirectory' | 'isFile' | 'isSocket') => {
    const stat = await fs.lstat(file);
    if (stat.uid !== process.getuid?.() || stat.mode & 0o077 || !stat[type]()) throw new Error('unsafe relay');
    return stat;
  };
  try {
    await privateFile(stateDirectory, 'isDirectory');
    const dirs = await fs.readdir(stateDirectory, {withFileTypes: true});
    for (const dir of dirs) {
      if (!dir.isDirectory() || !/^relay-[\w-]+$/.test(dir.name)) continue;
      try {
      const directory = path.join(stateDirectory, dir.name);
      await privateFile(directory, 'isDirectory');
      const file = path.join(directory, 'relay.json');
      const stat = await privateFile(file, 'isFile');
      if (stat.size > 4096) continue;
      const data = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
      const member = candidate.members.find(entry => entry.pid === data.relayPid);
      if (data.schemaVersion !== 1 || data.rootPid !== candidate.pid || !member?.startTime ||
          Math.abs(member.startTime.getTime() - Number(data.relayStartedAt)) > 1000 ||
          !(member.command.includes('cua-runtime-proxy.mjs') ||
            (data.relayKind === 'host-frontend' && member.command.includes('mcp_stdio.py')))) continue;
      const socketPath = path.join(directory, 'control.sock');
      if (data.controlPath !== socketPath) continue;
      await privateFile(socketPath, 'isSocket');
      return await new Promise<CuaReleaseResult>(resolve => {
        const socket = net.createConnection(socketPath);
        let buffer = '', settled = false;
        const done = (result: CuaReleaseResult) => {if (!settled) {settled = true; clearTimeout(timer); socket.destroy(); resolve(result);}};
        const timer = setTimeout(() => done({released: false, reason: 'cleanup_deadline'}), 11_000);
        socket.setEncoding('utf8');
        socket.on('connect', () => socket.write(JSON.stringify({action: 'release', relayPid: member.pid, rootPid: candidate.pid}) + '\n'));
        socket.on('error', () => done({released: false, reason: 'relay_unavailable'}));
        socket.on('end', () => done({released: false, reason: 'invalid_reply'}));
        socket.on('data', chunk => {
          buffer += chunk;
          if (buffer.length > 4096) {done({released: false, reason: 'invalid_reply'}); return;}
          if (!buffer.includes('\n')) return;
          try {
            const result = JSON.parse(buffer);
            if (result.released === true && Number.isSafeInteger(result.scopeCount) && result.scopeCount > 0) {
              done({released: true, scopeCount: result.scopeCount});
            } else done({released: false, reason: 'cleanup_not_confirmed'});
          } catch {done({released: false, reason: 'invalid_reply'});}
        });
      });
      } catch {continue; /* A stale/invalid relay must not hide another valid one. */}
    }
  } catch {return {released: false, reason: 'relay_unavailable'};}
  return {released: false, reason: 'relay_not_installed'};
}
