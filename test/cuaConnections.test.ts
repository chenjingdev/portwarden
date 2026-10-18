import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {afterEach, describe, expect, it, vi} from 'vitest';

import {ConfigRepository} from '../src/config.js';
import {PortwardenActions} from '../src/core/actions.js';
import {detectCuaConnections, parseCuaSockets, parseCuaSocketTable} from '../src/core/cuaConnections.js';
import type {ProcessInfo} from '../src/core/types.js';
import {renderOutput} from '../src/output.js';
import {buildVisibleRows} from '../src/tui/rows.js';

const uid = process.getuid!();
const started = new Date('2026-10-11T01:00:00Z');
const directories: string[] = [];
afterEach(() => {vi.restoreAllMocks(); for (const dir of directories.splice(0)) fs.rmSync(dir, {recursive: true, force: true});});
function proc(pid: number, ppid: number, command: string, executable = '/usr/bin/node'): ProcessInfo {
  return {pid, ppid, command, executable, uid, name: path.basename(executable), startTime: started, rssBytes: 1024};
}
const agent = proc(700, 1, '/usr/bin/claude', '/usr/bin/claude');
const bridge = proc(701, 700, 'python /test/claude-computer-use-plugin/mcp_stdio.py', '/usr/bin/python');
const runtime = proc(702, 701, 'node /app/@oai/cua-repl/bin/cua-repl.mjs');
const helper = proc(703, 702, '/app/node_repl', '/app/node_repl');

describe('CUA inventory', () => {
  it('recognizes a versioned installed host frontend without widening its process scope', () => {
    const installed = {...bridge, command: 'python /cache/codex-computer-use/0.3.2/mcp_stdio.py'};
    expect(detectCuaConnections([agent, installed])[0]).toMatchObject({pid: 701, agent: 'Claude', members: [installed]});
  });
  it('shows a single Claude bridge instead of its backend; excludes the parent agent and siblings from its scope', () => {
    const sibling = proc(704, 700, 'node /app/server.mjs');
    const rows = detectCuaConnections([agent, bridge, runtime, helper, sibling]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({pid: 701, ppid: 700, agent: 'Claude', tabOwnership: 'unknown', canStop: true});
    expect(rows[0]!.members.map(({pid}) => pid)).toEqual([701, 702, 703]);
  });
  it('does not classify generic node, subscription-gateway, or other users as CUA', () => {
    expect(detectCuaConnections([proc(800, 1, 'node /dev/subscription-gateway/ui/server.mjs'), {...runtime, uid: uid + 1}])).toEqual([]);
  });
  it('marks Chrome and macOS shared helpers read-only', () => {
    const rows = detectCuaConnections([
      proc(800, 1, '/app/ChatGPT for Chrome', '/app/ChatGPT for Chrome'),
      proc(801, 1, '/app/SkyComputerUseService', '/app/SkyComputerUseService'),
    ]);
    expect(rows.every(({agent, canStop}) => agent === 'Shared' && !canStop)).toBe(true);
    expect(rows).toHaveLength(2);
  });
  it('parses named Unix sockets without interpreting socket existence as tab ownership', () => {
    const sockets = parseCuaSockets('p701\nn/tmp/codex-browser-use/a.sock\nn/tmp/codex-browser-use/a.sock\np702\nn/other/private.sock\nn/Users/test/IPC/computeruse.sock\n');
    expect(sockets.get(701)).toEqual(['/tmp/codex-browser-use/a.sock']);
    expect(sockets.get(702)).toEqual(['/Users/test/IPC/computeruse.sock']);
  });
  it('resolves unnamed macOS client sockets through the server kernel endpoint', () => {
    const sockets = parseCuaSocketTable([
      'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME',
      'node 702 user 27u unix 0x111 0t0 ->0x222',
      'ChatGPT 900 user 4u unix 0x222 0t0 /tmp/codex-browser-use/a.sock',
      'node 703 user 22u unix 0x333 0t0 ->0x444',
    ].join('\n'));
    expect(sockets.get(702)).toEqual(['/tmp/codex-browser-use/a.sock']);
    expect(sockets.has(703)).toBe(false);
  });
  it('hides unconnected runtimes by default but exposes them through the CUA toggle', () => {
    const cua = detectCuaConnections([agent, bridge]).map((entry) => ({...entry, transportState: 'not-observed' as const}));
    const opts = {all: false, expandedGroups: new Set<string>(), pinnedListenerKeys: [], cua};
    expect(buildVisibleRows([], [], opts)).toEqual([]);
    expect(buildVisibleRows([], [], {...opts, showCuaRuntimes: true})).toHaveLength(1);
    expect(buildVisibleRows([], [], {...opts, cua: cua.map((entry) => ({...entry, transportState: 'unknown'}))})).toHaveLength(1);
  });
  it('shows portless CUA rows in main view, filter and JSON', () => {
    const cua = detectCuaConnections([agent, bridge, runtime]);
    expect(buildVisibleRows([], [], {all: false, expandedGroups: new Set(), pinnedListenerKeys: [], cua, query: 'claude'})).toMatchObject([{type: 'cua'}]);
    const output = JSON.parse(renderOutput([], 0, [], {all: false, json: true, cua}));
    expect(output).toMatchObject([{type: 'cua', pid: 701, memberPids: [701, 702], tabOwnership: 'unknown'}]);
  });
  it('groups all and per-agent CUA scopes without shared services, preserving filtered-out members in the stop scope', () => {
    const codex = {...runtime, pid: 800, ppid: 1};
    const sharedProcess = proc(900, 1, '/app/SkyComputerUseService', '/app/SkyComputerUseService');
    const cua = detectCuaConnections([agent, bridge, runtime, codex, sharedProcess]);
    const opts = {all: false, expandedGroups: new Set<string>(), pinnedListenerKeys: [], cua, showCuaRuntimes: true};
    const rows = buildVisibleRows([], [], opts);
    expect(rows.map(({type}) => type)).toEqual(['cua-group', 'cua']);
    expect(rows[0]).toMatchObject({family: 'All CUA', members: [expect.objectContaining({pid: 701}), expect.objectContaining({pid: 800})]});
    const filtered = buildVisibleRows([], [], {...opts, query: '701'});
    expect(filtered[0]).toMatchObject({type: 'cua-group', members: expect.arrayContaining([expect.objectContaining({pid: 800})])});
    expect(filtered.some((entry) => entry.type === 'cua' && entry.cua.pid === 900)).toBe(false);
  });
});

describe('CUA disconnect scope', () => {
  function actions(processProvider: () => Promise<readonly ProcessInfo[]>, kill: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portwarden-cua-'));
    directories.push(dir);
    return new PortwardenActions(ConfigRepository.open({configDirectory: dir}), {
      processProvider, kill, collect: async () => [], collectProcessMetadata: async () => new Map(),
    });
  }
  it('SIGTERM signals only the bridge; verifies graceful helper exit and keeps parent/sibling alive', async () => {
    let processes = [agent, bridge, runtime, helper, proc(704, 700, 'node /app/server.mjs')];
    const candidate = detectCuaConnections(processes)[0]!;
    const kill = vi.fn(() => {processes = processes.filter(({pid}) => ![701, 702, 703].includes(pid));});
    const result = await actions(async () => processes, kill).stopCua(candidate, 'SIGTERM');
    expect(kill.mock.calls).toEqual([[701, 'SIGTERM']]);
    expect(processes.map(({pid}) => pid)).toEqual([700, 704]);
    expect(result.pid).toBe(701);
  });
  it('force-stop does not signal a recycled child PID', async () => {
    let processes = [agent, bridge, runtime, helper];
    const candidate = detectCuaConnections(processes)[0]!;
    const kill = vi.fn((pid: number) => {
      processes = processes.filter((entry) => entry.pid !== pid).map((entry) => entry.pid === 702 ? {...entry, startTime: new Date(started.getTime() + 1)} : entry);
    });
    await expect(actions(async () => processes, kill).stopCua(candidate, 'SIGKILL')).rejects.toThrow('changed before signaling');
    expect(kill.mock.calls).toEqual([[701, 'SIGKILL']]);
  });
  it('refuses changed membership, foreign or incomplete identity before any signal', async () => {
    const candidate = detectCuaConnections([agent, bridge, runtime])[0]!;
    const kill = vi.fn();
    for (const processes of [[agent, bridge, runtime, helper], [agent, {...bridge, uid: uid + 1}, runtime], [agent, {...bridge, startTime: undefined}, runtime]]) {
      await expect(actions(async () => processes, kill).stopCua(candidate, 'SIGTERM')).rejects.toThrow('changed or has incomplete');
    }
    expect(kill).not.toHaveBeenCalled();
  });
  it('refuses shared transport cleanup', async () => {
    const shared = detectCuaConnections([proc(800, 1, '/app/SkyComputerUseService', '/app/SkyComputerUseService')])[0]!;
    const kill = vi.fn();
    await expect(actions(async () => [shared], kill).stopCua(shared, 'SIGTERM')).rejects.toThrow('Shared CUA');
    expect(kill).not.toHaveBeenCalled();
  });
  it('bulk-stops only the selected connections while retaining parent, sibling, shared service and a new connection', async () => {
    const second = {...runtime, pid: 810, ppid: 1};
    const shared = proc(900, 1, '/app/SkyComputerUseService', '/app/SkyComputerUseService');
    let processes = [agent, bridge, runtime, helper, second, shared];
    const candidates = detectCuaConnections(processes).filter((entry) => entry.canStop);
    const later = {...runtime, pid: 820, ppid: 1};
    processes.push(later);
    const kill = vi.fn((pid: number) => {processes = processes.filter((entry) => !((pid === 701 && [701, 702, 703].includes(entry.pid)) || entry.pid === pid));});
    const result = await actions(async () => processes, kill).stopCuaGroup(candidates, 'SIGTERM');
    expect(result.message).toContain('2/2');
    expect(result.warning).toBeUndefined();
    expect(kill.mock.calls.map(([pid]) => pid).sort()).toEqual([701, 810]);
    expect(processes.map(({pid}) => pid)).toEqual([700, 900, 820]);
  });
  it('preflights every group member before signaling any member', async () => {
    const second = {...runtime, pid: 810, ppid: 1};
    const original = [agent, bridge, runtime, second];
    const candidates = detectCuaConnections(original).filter((entry) => entry.canStop);
    const kill = vi.fn();
    const changed = original.map((entry) => entry.pid === 810 ? {...entry, startTime: new Date(started.getTime() + 1)} : entry);
    await expect(actions(async () => changed, kill).stopCuaGroup(candidates, 'SIGTERM')).rejects.toThrow('nothing was stopped');
    expect(kill).not.toHaveBeenCalled();
  });
  it('does not fail or signal again when stopping a frontend also removes a selected dependent runtime', async () => {
    const second = {...runtime, pid: 810, ppid: 1};
    let processes = [agent, bridge, runtime, second];
    const selected = detectCuaConnections(processes);
    const kill = vi.fn(() => {processes = [agent];});
    const result = await actions(async () => processes, kill).stopCuaGroup(selected, 'SIGTERM');
    expect(result.message).toContain('2/2');
    expect(result.warning).toBeUndefined();
    expect(kill.mock.calls).toEqual([[701, 'SIGTERM']]);
  });
  it('reports partial bulk failures and continues the remaining selected connections', async () => {
    const original = [agent, bridge, runtime, {...runtime, pid: 810, ppid: 1}];
    const action = actions(async () => original, vi.fn());
    const stop = vi.spyOn(action, 'stopCua').mockRejectedValueOnce(new Error('fixture refusal')).mockResolvedValueOnce({message: 'stopped'});
    const result = await action.stopCuaGroup(detectCuaConnections(original), 'SIGTERM');
    expect(stop).toHaveBeenCalledTimes(2);
    expect(result.message).toContain('1/2');
    expect(result.warning).toContain('fixture refusal');
  });
});
