import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {afterEach, describe, expect, it, vi} from 'vitest';

import {ConfigRepository} from '../src/config.js';
import {PortwardenActions} from '../src/core/actions.js';
import {detectBrowserSessions, formatMemory} from '../src/core/browserSessions.js';
import {listenerKey} from '../src/core/listeners.js';
import type {ListenerEntry, ProcessInfo} from '../src/core/types.js';
import {collectProcesses, detectZombieCandidates, parseResidentMemory} from '../src/core/zombies.js';
import {renderOutput} from '../src/output.js';
import {buildVisibleRows} from '../src/tui/rows.js';

const uid = process.getuid!();
const executable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portwarden-browser-test-'));
let configs = 0;
afterEach(() => { vi.useRealTimers(); });
process.once('exit', () => fs.rmSync(directory, {recursive: true, force: true}));

function root(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return {pid: 101, ppid: 50, uid, name: 'Google Chrome', executable,
    command: `${executable} --user-data-dir=/tmp/playwright_chromiumdev_profile-test --remote-debugging-pipe`,
    startTime: new Date('2026-01-01'), rssBytes: 128 * 1024 ** 2, ...overrides};
}
function parent(): ProcessInfo {
  return root({pid: 50, ppid: 1, name: 'node', executable: '/usr/bin/node', command: 'node /node_modules/playwright-core/lib/entry/cliDaemon.js'});
}
function helper(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return root({pid: 102, ppid: 101, name: 'Google Chrome Helper', executable: '/Applications/Chrome Helper', command: '/Applications/Chrome Helper --type=renderer', ...overrides});
}
function repo() { return ConfigRepository.open({platform: 'linux', xdgConfigHome: path.join(directory, String(++configs)), homeDirectory: directory}); }
function listener(pid = 101): ListenerEntry {
  return {pid, ppid: 50, uid, executable, startTime: new Date('2026-01-01'),
    port: 9222, host: '127.0.0.1', listenerHosts: ['127.0.0.1'], displayHost: 'localhost',
    command: 'Google Chrome', args: root().command, cwd: '/tmp', elapsed: '01:00:00', kind: 'app',
    appFamily: 'Chrome', projectName: 'Chrome', displayProject: 'Chrome', displayCommand: 'Chrome', displayCwd: '/tmp'};
}

describe('development browser inventory', () => {
  it('finds the headed stock Chrome + live cliDaemon + pipe setup missed by the zombie detector', () => {
    const processes = [parent(), root(), helper(), helper({pid: 103, ppid: 102})];
    expect(detectZombieCandidates(processes)).toEqual([]);
    const [session] = detectBrowserSessions(processes);
    expect(session).toMatchObject({family: 'playwright', parentState: 'running', memoryBytes: 384 * 1024 ** 2});
    expect(session?.members.map(({pid}) => pid)).toEqual([101, 102, 103]);
  });
  it('excludes personal Chrome, remote-debugging-only profiles, child browsers, other users and command lookalikes', () => {
    expect(detectBrowserSessions([
      root({command: executable}),
      root({pid: 102, command: `${executable} --user-data-dir=/Users/test/personal --remote-debugging-port=9222`}),
      root({pid: 103, command: `${root().command} --type=renderer`}),
      root({pid: 104, uid: uid + 1}),
      root({pid: 105, executable: '/usr/bin/node', name: 'node'}),
    ])).toEqual([]);
  });
  it('supports quoted profiles, Puppeteer, testing binaries, headless browsers and memory ordering', () => {
    const sessions = detectBrowserSessions([
      root({pid: 110, command: `${executable} --user-data-dir "/tmp/puppeteer_dev_profile-abc" --remote-debugging-port=0`, rssBytes: 0}),
      root({pid: 111, executable: '/tmp/Google Chrome for Testing', command: '/tmp/Google Chrome for Testing --headless=new --remote-debugging-pipe', rssBytes: 1024 ** 3}),
      root({pid: 112, executable: '/cache/ms-playwright/chrome', command: '/cache/ms-playwright/chrome --enable-automation --remote-debugging-pipe'}),
    ]);
    expect(sessions.map(({pid}) => pid)).toEqual([111, 112, 110]);
    expect(sessions.at(-1)?.family).toBe('puppeteer');
  });
  it('reports missing memory as unknown and handles cycles without double counting', () => {
    const [session] = detectBrowserSessions([root({ppid: 102}), helper({rssBytes: undefined})]);
    expect(session?.members).toHaveLength(2);
    expect(session?.memoryBytes).toBeNull();
    expect(formatMemory(null)).toBe('? RAM');
  });
  it('collects RSS in bytes without rounded percentage estimates', async () => {
    expect([...parseResidentMemory(' 101 1234\n102 0\nBAD 45\n103 -4')]).toEqual([[101, 1234 * 1024], [102, 0]]);
    const processes = await collectProcesses({provider: async () => [{pid: 101, ppid: 1, name: 'chrome'}], memoryProvider: async () => new Map([[101, 1234]])});
    expect(processes[0]?.rssBytes).toBe(1234);
  });
  it('shows sessions once without a port or zombie opt-in and emits structured memory totals', () => {
    const sessions = detectBrowserSessions([root(), helper()]);
    const rows = buildVisibleRows([listener()], [], {all: false, expandedGroups: new Set(), pinnedListenerKeys: [], browsers: sessions});
    expect(rows.map(({type}) => type)).toEqual(['browser']);
    const json = JSON.parse(renderOutput([], 0, [], {all: false, json: true}, sessions));
    expect(json[0]).toMatchObject({type: 'browser', memoryBytes: 256 * 1024 ** 2, processCount: 2, memberPids: [101, 102]});
    expect(renderOutput([], 0, [], {all: false, json: false}, sessions)).toContain('256 MiB');
    const filtered = buildVisibleRows([listener()], [], {all: false, expandedGroups: new Set(), pinnedListenerKeys: [], browsers: sessions, query: '9222'});
    expect(filtered).toHaveLength(1);
  });
});

describe('explicit browser tree cleanup', () => {
  it('resolves missing macOS helper paths from OS metadata before every signal', async () => {
    let live = [parent(), root(), helper({executable: ''})];
    const selected = detectBrowserSessions(live)[0]!;
    const collectProcessMetadata = vi.fn(async () => new Map([[102, {uid, executable: '/Applications/Chrome Helper'}]]));
    const kill = vi.fn((pid: number) => { live = live.filter((entry) => entry.pid !== pid); });
    const actions = new PortwardenActions(repo(), {
      collect: async () => [], processProvider: async () => live, collectProcessMetadata, kill,
    });
    await actions.stopBrowser(selected, 'SIGTERM');
    expect(kill.mock.calls.map(([pid]) => pid)).toEqual([101, 102]);
    expect(collectProcessMetadata.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(live.map(({pid}) => pid)).toEqual([50]);
  });

  it.each(['unavailable', 'wrong owner', 'changing executable'])('rejects %s helper metadata without signaling anything', async (failure) => {
    const live = [root(), helper({executable: ''})];
    let calls = 0;
    const collectProcessMetadata = vi.fn(async () => {
      calls += 1;
      if (failure === 'unavailable') throw new Error('Cannot read OS metadata');
      return new Map([[102, {
        uid: failure === 'wrong owner' ? uid + 1 : uid,
        executable: failure === 'changing executable' && calls > 1 ? '/different/executable' : '/Applications/Chrome Helper',
      }]]);
    });
    const kill = vi.fn();
    const actions = new PortwardenActions(repo(), {
      collect: async () => [], processProvider: async () => live, collectProcessMetadata, kill,
    });
    await expect(actions.stopBrowser(detectBrowserSessions(live)[0]!, 'SIGKILL')).rejects.toThrow();
    expect(kill).not.toHaveBeenCalled();
  });

  it.each(['SIGTERM', 'SIGKILL'] as const)('uses %s on only the selected browser + verified helpers, retaining controller and other sessions', async (signal) => {
    let live = [parent(), root(), helper(), root({pid: 201})];
    const selected = detectBrowserSessions(live).find(({pid}) => pid === 101)!;
    const kill = vi.fn((pid: number) => { live = live.filter((entry) => entry.pid !== pid); });
    const actions = new PortwardenActions(repo(), {collect: async () => [], processProvider: async () => live, kill});
    const result = await actions.stopBrowser(selected, signal);
    expect(kill.mock.calls.map(([pid]) => pid)).toEqual([101, 102]);
    expect(live.map(({pid}) => pid)).toEqual([50, 201]);
    expect(result.message).toContain('2 processes');
  });
  it.each([
    {command: 'changed'}, {uid: uid + 1}, {executable: '/different/chrome'},
    {startTime: new Date('2026-02-01')}, {startTime: undefined}, {ppid: 201},
  ])('rejects stale root identity %j before any signal', async (change) => {
    const selected = detectBrowserSessions([root()])[0]!;
    const kill = vi.fn();
    const actions = new PortwardenActions(repo(), {collect: async () => [], processProvider: async () => [root(change)], kill});
    await expect(actions.stopBrowser(selected, 'SIGKILL')).rejects.toMatchObject({code: 'STALE_PROCESS'});
    expect(kill).not.toHaveBeenCalled();
  });
  it('protects a pinned helper listener', async () => {
    const config = repo();
    const pinned = listener(102);
    config.update({pinnedListenerKeys: [listenerKey(pinned)]});
    const live = [root(), helper()];
    const kill = vi.fn();
    const actions = new PortwardenActions(config, {collect: async () => [pinned], processProvider: async () => live, kill});
    await expect(actions.stopBrowser(detectBrowserSessions(live)[0]!, 'SIGTERM')).rejects.toMatchObject({code: 'PINNED'});
    expect(kill).not.toHaveBeenCalled();
  });
  it('fails closed on inventory failure and changing tree membership', async () => {
    const live = [root()];
    const selected = detectBrowserSessions(live)[0]!;
    const kill = vi.fn();
    const failed = new PortwardenActions(repo(), {collect: async () => {throw new Error('lsof unavailable');}, processProvider: async () => live, kill});
    await expect(failed.stopBrowser(selected, 'SIGTERM')).rejects.toThrow('lsof unavailable');
    let calls = 0;
    const changed = new PortwardenActions(repo(), {collect: async () => [], processProvider: async () => ++calls === 1 ? live : [...live, helper()], kill});
    await expect(changed.stopBrowser(selected, 'SIGTERM')).rejects.toMatchObject({code: 'STALE_PROCESS'});
    expect(kill).not.toHaveBeenCalled();
  });
  it('skips a reused helper PID after signaling the browser', async () => {
    let live = [root(), helper()];
    const selected = detectBrowserSessions(live)[0]!;
    const kill = vi.fn((pid: number) => {
      live = [helper({startTime: new Date('2026-02-01'), command: 'another job'})];
    });
    const actions = new PortwardenActions(repo(), {collect: async () => [], processProvider: async () => live, kill});
    await actions.stopBrowser(selected, 'SIGKILL');
    expect(kill.mock.calls.map(([pid]) => pid)).toEqual([101]);
  });
  it('reports processes that ignore the signal instead of claiming success', async () => {
    vi.useFakeTimers();
    const live = [root(), helper()];
    const actions = new PortwardenActions(repo(), {collect: async () => [], processProvider: async () => live, kill: vi.fn()});
    const pending = actions.stopBrowser(detectBrowserSessions(live)[0]!, 'SIGTERM');
    const rejected = expect(pending).rejects.toMatchObject({code: 'STOP_FAILED', message: expect.stringContaining('still running')});
    await vi.runAllTimersAsync();
    await rejected;
  });
});
