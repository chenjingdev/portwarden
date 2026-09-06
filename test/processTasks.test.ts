import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {afterEach, describe, expect, it, vi} from 'vitest';

import {ConfigRepository} from '../src/config.js';
import {captureGraveyardRecord, PortwardenActions, type ActionDependencies} from '../src/core/actions.js';
import {listenerKey} from '../src/core/listeners.js';
import {attachProcessTasks, isDevLauncher} from '../src/core/processTasks.js';
import type {ListenerEntry, ProcessInfo} from '../src/core/types.js';
import {buildVisibleRows} from '../src/tui/rows.js';
import {renderOutput} from '../src/output.js';
import {stopListenerMatches} from '../src/cliActions.js';

const uid = process.getuid!();
const started = new Date('2026-01-01');
const directories: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of directories.splice(0)) fs.rmSync(dir, {recursive: true, force: true}); });
function proc(pid: number, ppid: number, command: string, more: Partial<ProcessInfo> = {}): ProcessInfo {
  return {pid, ppid, uid, command, name: 'node', executable: '/usr/bin/node', cwd: '/tmp/site', startTime: started, rssBytes: 1024 ** 2, ...more};
}
function listener(pid: number, port: number, command = '/usr/bin/node server.js'): ListenerEntry {
  return {pid, ppid: 100, uid, port, pgid: 90, collectorPgid: 80, command: 'node', args: command,
    executable: '/usr/bin/node', cwd: '/tmp/site', startTime: started, host: '127.0.0.1', listenerHosts: ['127.0.0.1'],
    displayHost: 'localhost', elapsed: '00:01:00', kind: 'dev', appFamily: '', projectName: 'site', displayProject: 'site',
    displayCommand: command, displayCwd: '/tmp/site'};
}
function inventory() {
  return [proc(90, 1, '/usr/bin/node agent.js'), proc(100, 90, 'npm run dev'),
    proc(101, 100, '/bin/sh -c node server.js', {executable: '/bin/sh'}),
    proc(102, 101, '/usr/bin/node server.js'), proc(103, 102, '/usr/bin/node worker.js'),
    proc(200, 90, '/usr/bin/node unrelated.js')];
}
const listeners = () => [listener(102, 3000), listener(103, 9229, '/usr/bin/node worker.js'), listener(200, 4000, '/usr/bin/node unrelated.js')];
const metadata = async () => new Map();
function repo() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portwarden-task-')); directories.push(dir); return ConfigRepository.open({configDirectory: dir}); }

describe('development task scopes', () => {
  it('groups npm, its shell, server, and portless workers without crossing their agent parent', async () => {
    const grouped = await attachProcessTasks([listeners()[0]!, listeners()[2]!], inventory(), metadata);
    expect(grouped[0]?.task?.members.map(({pid}) => pid)).toEqual([100, 101, 102, 103]);
    expect(grouped[0]?.task?.ports).toEqual([3000]);
    expect(grouped[1]?.task).toBeUndefined();
  });
  it('shows different PIDs and hidden ports as one stop scope, even while filtering', async () => {
    const grouped = await attachProcessTasks(listeners(), inventory(), metadata);
    const rows = buildVisibleRows([grouped[0]!], [], {all: false, expandedGroups: new Set(), pinnedListenerKeys: [], allListeners: grouped, query: '9229'});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({type: 'process', members: [grouped[0], grouped[1]]});
    const json = JSON.parse(renderOutput([grouped[0]!], 3, [], {all: false, json: true, allListeners: grouped}));
    expect(json[0].stopScope).toMatchObject({type: 'task', rootPid: 100, memberPids: [100, 101, 102, 103], ports: [3000, 9229]});
  });
  it('does not ascend to a launcher in another working directory', async () => {
    const ps = inventory().map((entry) => entry.pid === 100 ? {...entry, cwd: '/tmp/another-project'} : entry);
    expect((await attachProcessTasks(listeners(), ps, metadata))[0]?.task?.root.pid).toBe(101);
  });
  it('resolves missing executable and cwd from matching-owner metadata', async () => {
    const ps = inventory().map((entry) => entry.pid === 100 ? {...entry, cwd: undefined, executable: ''} : entry);
    const grouped = await attachProcessTasks(listeners(), ps, async () => new Map([[100, {uid, cwd: '/tmp/site', executable: '/usr/bin/node'}]]));
    expect(grouped[0]?.task?.root.pid).toBe(100);
    expect(grouped[0]?.task?.blockedReason).toBeUndefined();
  });
  it.each(['owner', 'identity', 'collector'])('blocks a scope with an unsafe %s member', async (kind) => {
    const ps = inventory();
    ps.push(proc(kind === 'collector' ? process.pid : 104, 102, 'worker', kind === 'owner' ? {uid: uid + 1} : kind === 'identity' ? {startTime: undefined} : {}));
    const grouped = await attachProcessTasks(listeners(), ps, metadata);
    expect(grouped[0]?.task?.blockedReason).toBeTruthy();
  });
  it('recognizes dev launchers by executed command, not incidental words', () => {
    for (const command of ['npm run dev', '/bin/sh -c node server.js', 'node --watch app.js', 'node /usr/node_modules/nodemon/bin/nodemon.js app.js', 'node /usr/node_modules/npm/bin/npm-cli.js run dev']) {
      expect(isDevLauncher(proc(100, 1, command)), command).toBe(true);
    }
    for (const command of ['node agent.js --task next', 'codex exec vite', 'npm install vite', '/bin/sh -c "node server.js & node unrelated.js"']) {
      expect(isDevLauncher(proc(100, 1, command)), command).toBe(false);
    }
  });
});

describe('task cleanup', () => {
  it('revives a saved task launcher by verifying its descendant listener and launch ancestry', async () => {
    const record = captureGraveyardRecord({...listeners()[0]!, args: 'npm run dev'}, started)!;
    const config = repo(); config.update({graveyard: [record]});
    const ps = inventory().map((entry) => ({...entry, pid: entry.pid + 1000, ppid: entry.ppid > 1 ? entry.ppid + 1000 : entry.ppid}));
    const grouped = await attachProcessTasks(listeners().map((entry) => ({...entry, pid: entry.pid + 1000})), ps, metadata);
    let launched = false;
    const launch: NonNullable<ActionDependencies['launch']> = () => {
      launched = true;
      return {pid: 1100, subprocess: {} as ReturnType<NonNullable<ActionDependencies['launch']>>['subprocess']};
    };
    const actions = new PortwardenActions(config, {
      collect: async () => launched ? grouped : [], processProvider: async () => ps,
      getPort: async () => record.port, launch,
    });
    expect((await actions.revive(record)).pid).toBe(1102);
    expect(config.get().graveyard).toEqual([]);
  });

  it.each(['SIGTERM', 'SIGKILL'] as const)('stops the entire displayed task with %s, preserving another task in the same PGID', async (signal) => {
    let ps = inventory();
    const collect = async () => attachProcessTasks(listeners().filter((entry) => ps.some(({pid}) => pid === entry.pid)), ps, metadata);
    const selected = (await collect())[1]!;
    const kill = vi.fn((pid: number) => { ps = ps.filter((entry) => entry.pid !== pid); });
    const config = repo();
    const actions = new PortwardenActions(config, {collect, processProvider: async () => ps, kill});
    const outcome = await actions.stopListener(selected, signal);
    expect(kill.mock.calls.map(([pid]) => pid)).toEqual([100, 101, 102, 103]);
    expect(ps.map(({pid}) => pid)).toEqual([90, 200]);
    expect(outcome.message).toContain('4 processes');
    expect(config.get().graveyard[0]?.argv).toEqual(['npm', 'run', 'dev']);
  });
  it('protects the whole task when a sibling PID owns a pinned port', async () => {
    const grouped = await attachProcessTasks(listeners(), inventory(), metadata);
    const config = repo(); config.update({pinnedListenerKeys: [listenerKey(grouped[1]!)]});
    const kill = vi.fn();
    const actions = new PortwardenActions(config, {collect: async () => grouped, processProvider: async () => inventory(), kill});
    await expect(actions.stopListener(grouped[0]!, 'SIGKILL')).rejects.toMatchObject({code: 'PINNED'});
    expect(kill).not.toHaveBeenCalled();
  });
  it.each(['new member', 'changed member', 'new port'])('requires a new displayed scope after a %s appears', async (change) => {
    const grouped = await attachProcessTasks(listeners(), inventory(), metadata);
    const ps = inventory(); const ls = listeners();
    if (change === 'new member') ps.push(proc(104, 102, 'node new-worker.js'));
    if (change === 'changed member') ps[4] = {...ps[4]!, startTime: new Date('2026-02-01')};
    if (change === 'new port') ls.push(listener(102, 3001));
    const fresh = await attachProcessTasks(ls, ps, metadata);
    const kill = vi.fn();
    const actions = new PortwardenActions(repo(), {collect: async () => fresh, processProvider: async () => ps, kill});
    await expect(actions.stopListener(grouped[0]!, 'SIGTERM')).rejects.toMatchObject({code: 'STALE_PROCESS'});
    expect(kill).not.toHaveBeenCalled();
  });
  it('does not report success or save a revive record when workers ignore SIGTERM', async () => {
    vi.useFakeTimers();
    const grouped = await attachProcessTasks(listeners(), inventory(), metadata);
    const config = repo();
    const actions = new PortwardenActions(config, {collect: async () => grouped, processProvider: async () => inventory(), kill: vi.fn()});
    const pending = actions.stopListener(grouped[0]!, 'SIGTERM');
    const rejected = expect(pending).rejects.toMatchObject({code: 'STOP_FAILED'});
    await vi.runAllTimersAsync(); await rejected;
    expect(config.get().graveyard).toEqual([]);
  });
  it('signals one displayed task only once when two matching listeners belong to it', async () => {
    const grouped = await attachProcessTasks(listeners(), inventory(), metadata);
    const stopListener = vi.fn(async () => ({message: 'Stopped.'}));
    await stopListenerMatches({stopListener, validateListener: vi.fn(async (entry) => entry)}, grouped.slice(0, 2), 'SIGTERM');
    expect(stopListener).toHaveBeenCalledTimes(1);
  });
});
