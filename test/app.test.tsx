import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {cleanup, render} from 'ink-testing-library';
import React from 'react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {ConfigRepository} from '../src/config.js';
import {PortwardenActions} from '../src/core/actions.js';
import {listenerKey} from '../src/core/listeners.js';
import type {BrowserSession, ListenerEntry, ProcessTask, ZombieCandidate} from '../src/core/types.js';
import {detectBrowserSessions} from '../src/core/browserSessions.js';
import {PortwardenApp} from '../src/tui/App.js';

const scanner = vi.hoisted(() => ({
  allListeners: [] as ListenerEntry[],
  listeners: [] as ListenerEntry[],
  zombies: [] as ZombieCandidate[],
  browsers: [] as BrowserSession[],
  loading: false,
  refreshing: false,
  error: '',
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  refresh: vi.fn(),
}));

vi.mock('../src/tui/useScanner.js', () => ({
  useScanner: ({showZombies}: {showZombies: boolean}) => ({
    ...scanner,
    zombies: showZombies ? scanner.zombies : [],
  }),
}));

let configDirectory = '';

beforeEach(() => {
  configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'portwarden-app-'));
  scanner.listeners = [
    listener({pid: 101, port: 3001, displayProject: 'alpha'}),
    listener({pid: 102, port: 3002, displayProject: 'bravo'}),
    listener({pid: 103, port: 3003, displayProject: 'charlie'}),
  ];
  scanner.allListeners = [...scanner.listeners];
  scanner.zombies = [];
  scanner.browsers = [];
  scanner.refresh.mockClear();
});

afterEach(() => {
  cleanup();
  fs.rmSync(configDirectory, {recursive: true, force: true});
});

describe('PortwardenApp', () => {
  it('shows a whole development task and sends its displayed scope when stopping a child port', async () => {
    const entries = scanner.listeners.slice(0, 2);
    const root = {pid: 99, ppid: 1, uid: process.getuid!(), executable: '/usr/bin/node', command: 'npm run dev', name: 'npm', cwd: '/tmp/project', startTime: new Date('2026-01-01')};
    const task: ProcessTask = {
      key: 'task:99', root, members: [root, ...entries.map((entry) => ({...root, pid: entry.pid, ppid: 99, command: entry.args}))],
      ports: [3001, 3002], label: 'alpha', memoryBytes: null,
    };
    scanner.listeners = entries.map((entry) => ({...entry, task}));
    scanner.allListeners = scanner.listeners;
    const stopListener = vi.fn(async () => ({message: 'Stopped task.'}));
    const repo = repository(); repo.update({confirmActions: true});
    const app = render(<PortwardenApp configRepository={repo} actionsOverride={{stopListener} as unknown as PortwardenActions} />);
    await update();
    expect(app.lastFrame()).toContain('task 99  3 processes');
    expect(app.lastFrame()).toContain('stops PIDs 99, 101, 102');
    app.stdin.write('\r'); await update();
    app.stdin.write('\u001B[B'); await update();
    app.stdin.write('x'); await update();
    expect(app.lastFrame()).toContain('Stop task 99 (3 processes; ports 3001, 3002)?');
    app.stdin.write('\r'); await update();
    expect(stopListener).toHaveBeenCalledWith(scanner.listeners[0], 'SIGTERM');
  });

  it('allows retry and force-stop on the same target after a failure without masking the original error', async () => {
    const stopListener = vi.fn(async () => { throw new Error('Helper identity could not be verified.'); });
    const app = render(<PortwardenApp configRepository={repository()} actionsOverride={{stopListener} as unknown as PortwardenActions} />);
    await update();
    app.stdin.write('x');
    await update();
    expect(app.lastFrame()).toContain('Helper identity could not be verified.');
    app.stdin.write('x');
    await update();
    app.stdin.write('f');
    await update();
    expect(stopListener.mock.calls.map((call) => (call as unknown[])[1])).toEqual(['SIGTERM', 'SIGTERM', 'SIGKILL']);
    expect(app.lastFrame()).toContain('Helper identity could not be verified.');
    expect(app.lastFrame()).not.toContain('Choose a target with');
  });

  it('allows force-stop on the automatically selected replacement after a failed target disappears', async () => {
    const repo = repository();
    const stopListener = vi.fn(async () => { throw new Error('Partial cleanup'); });
    const actions = {stopListener} as unknown as PortwardenActions;
    const app = render(<PortwardenApp configRepository={repo} actionsOverride={actions} />);
    await update();
    app.stdin.write('x');
    await update();
    scanner.listeners = scanner.listeners.slice(1);
    scanner.allListeners = scanner.listeners;
    app.rerender(<PortwardenApp configRepository={repo} actionsOverride={actions} />);
    await update();
    app.stdin.write('f');
    await update();
    expect(stopListener).toHaveBeenCalledTimes(2);
    expect(stopListener).toHaveBeenLastCalledWith(scanner.listeners[0], 'SIGKILL');
    expect(app.lastFrame()).not.toContain('Choose a target with');
  });

  it('treats a submitted search as an explicit selection so its result can be stopped immediately', async () => {
    const stopListener = vi.fn(async () => ({message: 'Stopped.'}));
    const app = render(<PortwardenApp configRepository={repository()} actionsOverride={{stopListener} as unknown as PortwardenActions} />);
    await update();
    app.stdin.write('/');
    await update();
    app.stdin.write('bravo');
    await update();
    app.stdin.write('\r');
    await update();
    app.stdin.write('x');
    await update();
    expect(stopListener).toHaveBeenCalledWith(scanner.listeners[1], 'SIGTERM');
  });

  it('shows dev browsers by default with memory and stops one complete session', async () => {
    scanner.listeners = [];
    scanner.allListeners = [];
    scanner.browsers = detectBrowserSessions([{pid: 555, ppid: 1, uid: process.getuid!(), name: 'Google Chrome',
      executable: '/Applications/Google Chrome', command: '/Applications/Google Chrome --remote-debugging-pipe --user-data-dir=/tmp/playwright_chromiumdev_profile-test',
      startTime: new Date('2026-01-01'), rssBytes: 256 * 1024 ** 2}]);
    const stopBrowser = vi.fn(async () => ({message: 'Stopped browser.'}));
    const actions = {stopBrowser} as unknown as PortwardenActions;
    const app = render(<PortwardenApp configRepository={repository()} actionsOverride={actions} />);
    await update();
    expect(app.lastFrame()).toContain('1 browsers');
    expect(app.lastFrame()).toContain('256 MiB');
    expect(app.lastFrame()).toContain('hint x stop browser + helpers  f force-stop');
    app.stdin.write('x');
    await update();
    expect(stopBrowser).toHaveBeenCalledWith(scanner.browsers[0], 'SIGTERM');
  });

  it('stops each automatically selected next row without requiring an arrow key', async () => {
    const repo = repository();
    const stopListener = vi.fn(async () => ({message: 'Stopped.'}));
    const actions = {stopListener} as unknown as PortwardenActions;
    const app = render(<PortwardenApp configRepository={repo} actionsOverride={actions} />);
    await update();
    app.stdin.write('x');
    await update();
    scanner.listeners = scanner.listeners.slice(1);
    scanner.allListeners = scanner.listeners;
    app.rerender(<PortwardenApp configRepository={repo} actionsOverride={actions} />);
    await update();
    app.stdin.write('x');
    await update();
    expect(stopListener).toHaveBeenCalledTimes(2);
    expect(stopListener).toHaveBeenLastCalledWith(scanner.listeners[0], 'SIGTERM');
    scanner.listeners = scanner.listeners.slice(1);
    scanner.allListeners = scanner.listeners;
    app.rerender(<PortwardenApp configRepository={repo} actionsOverride={actions} />);
    await update();
    app.stdin.write('f');
    await update();
    expect(stopListener).toHaveBeenCalledTimes(3);
    expect(stopListener).toHaveBeenLastCalledWith(scanner.listeners[0], 'SIGKILL');
    expect(app.lastFrame()).not.toContain('Choose a target with');
  });

  it('ignores duplicate stop inputs only while an action is in flight, including before the busy render', async () => {
    const pending = deferred<{message: string}>();
    const repo = repository();
    const stopListener = vi.fn(() => pending.promise);
    const actions = {stopListener} as unknown as PortwardenActions;
    const app = render(<PortwardenApp configRepository={repo} actionsOverride={actions} />);
    await update();
    app.stdin.write('x');
    app.stdin.write('x');
    app.stdin.write('f');
    await update();
    expect(stopListener).toHaveBeenCalledTimes(1);

    scanner.listeners = scanner.listeners.slice(1);
    scanner.allListeners = scanner.listeners;
    app.rerender(<PortwardenApp configRepository={repo} actionsOverride={actions} />);
    await update();
    app.stdin.write('x');
    await update();
    expect(stopListener).toHaveBeenCalledTimes(1);

    pending.resolve({message: 'Stopped.'});
    await update();
    app.stdin.write('x');
    await update();
    expect(stopListener).toHaveBeenCalledTimes(2);
    expect(stopListener).toHaveBeenLastCalledWith(scanner.listeners[0], 'SIGTERM');
  });

  it('stops the next browser session at the same cursor position with another x', async () => {
    scanner.listeners = [];
    scanner.allListeners = [];
    scanner.browsers = detectBrowserSessions([555, 556].map((pid) => ({
      pid, ppid: 1, uid: process.getuid!(), name: 'Google Chrome', executable: '/Applications/Google Chrome',
      command: `/Applications/Google Chrome --remote-debugging-pipe --user-data-dir=/tmp/playwright_chromiumdev_profile-${pid}`,
      startTime: new Date('2026-01-01'), rssBytes: 256 * 1024 ** 2,
    })));
    const repo = repository();
    const sessions = [...scanner.browsers];
    const stopBrowser = vi.fn(async () => ({message: 'Stopped browser.'}));
    const actions = {stopBrowser} as unknown as PortwardenActions;
    const app = render(<PortwardenApp configRepository={repo} actionsOverride={actions} />);
    await update();
    app.stdin.write('x');
    await update();
    scanner.browsers = scanner.browsers.slice(1);
    app.rerender(<PortwardenApp configRepository={repo} actionsOverride={actions} />);
    await update();
    expect(app.lastFrame()).toContain('pid 556');
    app.stdin.write('x');
    await update();
    expect(stopBrowser).toHaveBeenNthCalledWith(1, sessions[0], 'SIGTERM');
    expect(stopBrowser).toHaveBeenNthCalledWith(2, sessions[1], 'SIGTERM');
    expect(app.lastFrame()).not.toContain('Choose a target with');
  });

  it('groups ports in one PID and exposes the complete stop scope before acting', async () => {
    const first = scanner.listeners[0]!;
    const second = {...first, port: 4500, kind: 'system' as const};
    scanner.listeners = [first];
    scanner.allListeners = [first, second];
    const repo = repository();
    repo.update({confirmActions: true});
    const app = render(<PortwardenApp configRepository={repo} />);
    await update();
    expect(app.lastFrame()).toContain('ports 3001, 4500');
    expect(app.lastFrame()).toContain('share one process');
    app.stdin.write('x');
    await update();
    expect(app.lastFrame()).toContain('Stop PID 101, ports 3001, 4500?');
  });

  it('navigates the primary screens and treats pasted chunks as text, not actions', async () => {
    const app = render(<PortwardenApp configRepository={repository()} />);
    await update();
    expect(app.lastFrame()).toContain('PORTWARDEN  [MAIN] [3 ports]');

    app.stdin.write('qrm');
    await update();
    expect(app.lastFrame()).toContain('PORTWARDEN  [MAIN]');

    app.stdin.write('a');
    await update();
    expect(app.lastFrame()).toContain('[ALL] [3 ports]');

    app.stdin.write('z');
    await update();
    expect(app.lastFrame()).toContain('[0 zombies]');

    app.stdin.write('s');
    await update();
    expect(app.lastFrame()).toContain('SETTINGS');

    app.stdin.write('s');
    await update();
    app.stdin.write('?');
    await update();
    expect(app.lastFrame()).toContain('HELP');
  });

  it('filters by pasted text and keeps ordinary j/k characters literal', async () => {
    const app = render(<PortwardenApp configRepository={repository()} />);
    await update();
    app.stdin.write('/');
    await update();
    app.stdin.write('bravojk');
    await update();
    app.stdin.write('\u007f');
    await update();
    app.stdin.write('\u007f');
    await update();
    app.stdin.write('\r');
    await update();

    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('filter: bravo');
    expect(frame).toContain('bravo');
    expect(frame).not.toContain('alpha');
    expect(frame).not.toContain('charlie');
  });

  it('pins every port in a collapsed PID including hidden siblings and can unpin without expanding', async () => {
    const first = listener({pid: 101, port: 3001});
    const hidden = listener({pid: 101, port: 9222, kind: 'system'});
    scanner.listeners = [first];
    scanner.allListeners = [first, hidden];
    const repo = repository();
    const stopListener = vi.fn(async () => ({message: 'Stopped.'}));
    const app = render(<PortwardenApp configRepository={repo} actionsOverride={{stopListener} as unknown as PortwardenActions} />);
    await update();
    app.stdin.write('p'); await update();
    expect(repo.get().pinnedListenerKeys).toEqual([listenerKey(first), listenerKey(hidden)]);
    expect(app.lastFrame()).toContain('entire PID protected');
    app.stdin.write('x'); await update();
    expect(stopListener).not.toHaveBeenCalled();
    app.stdin.write('p'); await update();
    expect(repo.get().pinnedListenerKeys).toEqual([]);
    expect(app.lastFrame()).toContain('Unpinned');
  });

  it('keeps an app group selected when pinning and unpinning all its ports', async () => {
    scanner.listeners = [
      listener({pid: 101, port: 3001, kind: 'app', appFamily: 'Ollama'}),
      listener({pid: 102, port: 3002, kind: 'app', appFamily: 'Ollama'}),
    ];
    scanner.allListeners = scanner.listeners;
    const repo = repository();
    const app = render(<PortwardenApp configRepository={repo} initialAll />);
    await update();
    app.stdin.write('p'); await update();
    expect(repo.get().pinnedListenerKeys).toEqual(scanner.listeners.map(listenerKey));
    expect(app.lastFrame()).toContain('group Ollama');
    app.stdin.write('p'); await update();
    expect(repo.get().pinnedListenerKeys).toEqual([]);
    expect(app.lastFrame()).toContain('group Ollama');
  });

  it('appends a new pin after existing visible pins and preserves its selection', async () => {
    const repo = repository();
    repo.update({
      pinnedListenerKeys: [listenerKey(scanner.listeners[0]!)],
      orderedEntryKeys: scanner.listeners.map(listenerKey),
    });
    const app = render(<PortwardenApp configRepository={repo} />);
    await update();
    app.stdin.write('\u001B[B');
    await update();
    app.stdin.write('p');
    await update();

    const config = repo.get();
    expect(config.orderedEntryKeys.slice(0, 3)).toEqual(scanner.listeners.map(listenerKey));
    expect(config.pinnedListenerKeys).toHaveLength(2);
    expect(app.lastFrame()).toContain('port 3002');
  });

  it('falls back to the nearest row when the selected process disappears', async () => {
    const repo = repository();
    const app = render(<PortwardenApp configRepository={repo} />);
    await update();
    app.stdin.write('\u001B[B');
    await update();
    app.stdin.write('\u001B[B');
    await update();
    expect(app.lastFrame()).toContain('port 3003');

    scanner.listeners = scanner.listeners.slice(0, 2);
    scanner.allListeners = [...scanner.listeners];
    app.rerender(<PortwardenApp configRepository={repo} />);
    await update();
    expect(app.lastFrame()).toContain('port 3002');
  });

  it('hides zombie rows immediately when z is toggled off', async () => {
    scanner.zombies = [{
      pid: 999,
      ppid: 1,
      name: 'chrome',
      command: 'chrome --headless --remote-debugging-pipe',
      executable: 'chrome',
      family: 'headless-chrome',
      ageMs: 120_000,
      ageSeconds: 120,
      reapable: true,
      reason: 'orphan',
    }];
    const app = render(<PortwardenApp configRepository={repository()} initialZombies />);
    await update();
    expect(app.lastFrame()).toContain('zombie');

    app.stdin.write('z');
    await update();
    expect(app.lastFrame()).not.toContain('zombie  -');
    expect(app.lastFrame()).not.toContain('[1 zombies]');
  });

  it('shows and cancels a confirmation before any destructive action', async () => {
    const repo = repository();
    repo.update({confirmActions: true});
    const app = render(<PortwardenApp configRepository={repo} />);
    await update();

    app.stdin.write('x');
    await update();
    expect(app.lastFrame()).toContain('Stop port 3001 (PID 101, alpha)?');
    expect(app.lastFrame()).toContain('enter/y confirm');

    app.stdin.write('n');
    await update();
    expect(app.lastFrame()).not.toContain('Stop port 3001 (PID 101, alpha)?');
  });

  it('shows graveyard confirmations instead of trapping input behind an invisible prompt', async () => {
    const repo = repository();
    repo.update({
      confirmActions: true,
      graveyard: [{
        id: 'alpha:3001:record',
        listenerKey: listenerKey(scanner.listeners[0]!),
        port: 3001,
        host: '127.0.0.1',
        project: 'alpha',
        cwd: '/tmp/project',
        argv: ['node', 'vite', '--port', '3001'],
        env: {},
        capturedAt: '2026-01-01T00:00:00.000Z',
      }],
    });
    const app = render(<PortwardenApp configRepository={repo} />);
    await update();
    app.stdin.write('g');
    await waitForFrame(app, 'GRAVEYARD');
    // Ink can paint the new screen before its input handler effect is rebound.
    await update();
    app.stdin.write('r');
    await waitForFrame(app, 'Revive port 3001 (alpha)?');

    expect(app.lastFrame()).toContain('enter/y confirm  esc/n cancel');
    expect(app.lastFrame()).toContain('Revive port 3001 (alpha)?');

    // Likewise, wait for the confirmation input handler before cancelling it.
    await update();
    app.stdin.write('n');
    await waitForFrameWithout(app, 'Revive port 3001 (alpha)?');
    expect(app.lastFrame()).not.toContain('Revive port 3001 (alpha)?');
    expect(app.lastFrame()).toContain('GRAVEYARD');
  });

  it('blocks a pinned stop before showing an impossible confirmation', async () => {
    const repo = repository();
    repo.update({
      confirmActions: true,
      pinnedListenerKeys: [listenerKey(scanner.listeners[0]!)],
    });
    const app = render(<PortwardenApp configRepository={repo} />);
    await update();
    app.stdin.write('x');
    await update();

    expect(app.lastFrame()).toContain('Port 3001 is pinned. Unpin it before stopping.');
    expect(app.lastFrame()).not.toContain('enter/y confirm');
  });

  it('blocks a stop when another listener on the same PID is pinned', async () => {
    const sibling = listener({
      pid: scanner.listeners[0]!.pid,
      port: scanner.listeners[0]!.port,
      host: '0.0.0.0',
      listenerHosts: ['0.0.0.0'],
      displayHost: 'all',
      args: scanner.listeners[0]!.args,
    });
    scanner.listeners = [scanner.listeners[0]!, sibling];
    scanner.allListeners = [...scanner.listeners];
    const repo = repository();
    repo.update({
      confirmActions: true,
      pinnedListenerKeys: [listenerKey(sibling)],
    });
    const app = render(<PortwardenApp configRepository={repo} />);
    await update();

    app.stdin.write('x');
    await update();

    expect(app.lastFrame()).toContain('PID 101 also owns pinned port 3001.');
    expect(app.lastFrame()).not.toContain('enter/y confirm');

    app.stdin.write('\r');
    await update();
    app.stdin.write('\u001B[B');
    await update();
    app.stdin.write('m');
    await update();
    expect(app.lastFrame()).toContain('PID 101 also owns pinned port 3001. Unpin it before moving this process.');
    expect(app.lastFrame()).not.toContain('enter/y confirm');
  });

  it('limits the stop confirmation to the selected PID even when another job shares its process group', async () => {
    const selected = listener({
      pid: 101,
      port: 3001,
      displayProject: 'alpha',
      pgid: 9_000,
      collectorPgid: 8_000,
    });
    const groupSibling = listener({
      pid: 102,
      ppid: selected.pid,
      port: 3002,
      host: '0.0.0.0',
      listenerHosts: ['0.0.0.0'],
      displayHost: 'all',
      displayProject: 'bravo',
      args: 'node vite --port 3002',
      pgid: selected.pgid,
      collectorPgid: selected.collectorPgid,
    });
    scanner.listeners = [selected, groupSibling];
    scanner.allListeners = [...scanner.listeners];
    const repo = repository();
    repo.update({confirmActions: true});
    const app = render(<PortwardenApp configRepository={repo} />);
    await update();

    app.stdin.write('f');
    await update();

    expect(app.lastFrame()).toContain('Force-stop port 3001');
    expect(app.lastFrame()).not.toContain('also stops all:3002');
    expect(app.lastFrame()).toContain('enter/y confirm');
  });

  it('keeps a pinned sibling job outside the selected PID stop scope', async () => {
    const selected = listener({
      pid: 101,
      port: 3001,
      displayProject: 'alpha',
      pgid: 9_000,
      collectorPgid: 8_000,
    });
    const pinnedGroupSibling = listener({
      pid: 102,
      ppid: selected.pid,
      port: 3002,
      displayProject: 'bravo',
      args: 'node vite --port 3002',
      pgid: selected.pgid,
      collectorPgid: selected.collectorPgid,
    });
    scanner.listeners = [selected, pinnedGroupSibling];
    scanner.allListeners = [...scanner.listeners];
    const repo = repository();
    repo.update({
      confirmActions: true,
      pinnedListenerKeys: [listenerKey(pinnedGroupSibling)],
    });
    const app = render(<PortwardenApp configRepository={repo} />);
    await update();

    app.stdin.write('x');
    await update();

    expect(app.lastFrame()).toContain('Stop port 3001');
    expect(app.lastFrame()).toContain('enter/y confirm');
  });

  it('clears stale action errors when queuing an action or refreshing manually', async () => {
    const repo = repository();
    repo.update({
      confirmActions: true,
      pinnedListenerKeys: [listenerKey(scanner.listeners[0]!)],
    });
    const app = render(<PortwardenApp configRepository={repo} />);
    await update();

    app.stdin.write('x');
    await update();
    expect(app.lastFrame()).toContain('Port 3001 is pinned.');

    app.stdin.write('m');
    await update();
    expect(app.lastFrame()).toContain('Move port 3001 (PID 101) to the next available port?');
    expect(app.lastFrame()).not.toContain('Port 3001 is pinned.');

    app.stdin.write('n');
    await update();
    app.stdin.write('x');
    await update();
    app.stdin.write('r');
    await update();
    expect(app.lastFrame()).not.toContain('Port 3001 is pinned.');
    expect(app.lastFrame()).toContain('info  Refreshing…');
  });

  it('repaints the active frame on ctrl-l', async () => {
    const app = render(<PortwardenApp configRepository={repository()} />);
    await update();
    const write = vi.spyOn(app.stdout, 'write');

    app.stdin.write('\u000c');
    await update();

    expect(write.mock.calls.some(([data]) => String(data).includes('\u001B[2J\u001B[3J\u001B[H'))).toBe(true);
  });

  it('blocks move at port 65535 before showing a confirmation', async () => {
    scanner.listeners = [listener({pid: 655, port: 65_535, args: 'vite --port 65535'})];
    scanner.allListeners = [...scanner.listeners];
    const repo = repository();
    repo.update({confirmActions: true});
    const app = render(<PortwardenApp configRepository={repo} />);
    await update();

    app.stdin.write('m');
    await update();

    expect(app.lastFrame()).toContain('No higher port is available after 65535.');
    expect(app.lastFrame()).not.toContain('enter/y confirm');
  });

  it('reorders against the next visible listener instead of a hidden collapsed group member', async () => {
    const appOne = listener({pid: 201, port: 6101, kind: 'app', appFamily: 'Antigravity'});
    const appTwo = listener({pid: 202, port: 6102, kind: 'app', appFamily: 'Antigravity'});
    const system = listener({pid: 301, port: 9000, kind: 'system', displayProject: 'system'});
    scanner.listeners = [scanner.listeners[0]!, appOne, appTwo, system];
    scanner.allListeners = [...scanner.listeners];
    const repo = repository();
    const app = render(<PortwardenApp configRepository={repo} initialAll />);
    await update();

    app.stdin.write('\u001B[C');
    await update();

    expect(repo.get().orderedEntryKeys.slice(0, 4)).toEqual([
      listenerKey(system),
      listenerKey(appOne),
      listenerKey(appTwo),
      listenerKey(scanner.listeners[0]!),
    ]);
  });

  it('keeps the cursor on the verified listener returned by a successful move', async () => {
    const original = scanner.listeners[0]!;
    const moved = listener({
      ...original,
      pid: 501,
      port: 3004,
      args: 'node vite --port 3004',
      displayCommand: 'node vite --port 3004',
    });
    const moveListener = vi.fn(async () => {
      scanner.listeners = [scanner.listeners[1]!, scanner.listeners[2]!, moved];
      scanner.allListeners = [...scanner.listeners];
      return {
        message: 'Moved alpha: 3001 → 3004.',
        warning: 'Saved pins/order were not updated: read-only config.',
        listener: moved,
        port: 3004,
        pid: 501,
      };
    });
    const actions = {moveListener} as unknown as PortwardenActions;
    const app = render(<PortwardenApp configRepository={repository()} actionsOverride={actions} />);
    await update();

    app.stdin.write('m');
    await update();
    await update();

    expect(moveListener).toHaveBeenCalledWith(original);
    expect(app.lastFrame()).toContain('DETAILS  alpha');
    expect(app.lastFrame()).toContain('port 3004  pid 501');
    expect(app.lastFrame()).toContain('warning  Saved pins/order were not updated: read-only config.');
  });

  it('does not steal the cursor after the user moves while an action target is pending', async () => {
    const original = scanner.listeners[0]!;
    const moved = listener({...original, pid: 501, port: 3004, args: 'node vite --port 3004'});
    const actions = {
      moveListener: vi.fn(async () => ({message: 'Moved.', listener: moved, port: moved.port, pid: moved.pid})),
    } as unknown as PortwardenActions;
    const repo = repository();
    const app = render(<PortwardenApp configRepository={repo} actionsOverride={actions} />);
    await update();

    app.stdin.write('m');
    await update();
    app.stdin.write('\u001B[B');
    await update();
    expect(app.lastFrame()).toContain('port 3002');

    scanner.listeners = [scanner.listeners[1]!, scanner.listeners[2]!, moved];
    scanner.allListeners = [...scanner.listeners];
    app.rerender(<PortwardenApp configRepository={repo} actionsOverride={actions} />);
    await update();

    expect(app.lastFrame()).toContain('port 3002');
    expect(app.lastFrame()).not.toContain('port 3004  pid 501');
  });

  it('refreshes after an action failure so rollback state is visible', async () => {
    const actions = {
      stopListener: vi.fn(async () => {
        throw new Error('Rollback was requested; verify the process list.');
      }),
    } as unknown as PortwardenActions;
    const app = render(<PortwardenApp configRepository={repository()} actionsOverride={actions} />);
    await update();

    app.stdin.write('x');
    await update();

    expect(app.lastFrame()).toContain('error  Rollback was requested; verify the process list.');
    expect(scanner.refresh).toHaveBeenCalled();
  });

  it('ignores ctrl-c while a destructive action is still running', async () => {
    const pending = deferred<{message: string}>();
    const actions = {
      moveListener: vi.fn(() => pending.promise),
    } as unknown as PortwardenActions;
    const app = render(<PortwardenApp configRepository={repository()} actionsOverride={actions} />);
    await update();

    app.stdin.write('m');
    await update();
    expect(app.lastFrame()).toContain('working  Moving port…');

    app.stdin.write('\u0003');
    await update();
    expect(app.lastFrame()).toContain('working  Moving port…');

    pending.resolve({message: 'Moved.'});
    await update();
    expect(app.lastFrame()).toContain('info  Moved.');
  });
});

function repository(): ConfigRepository {
  return ConfigRepository.open({configDirectory});
}

function listener(overrides: Partial<ListenerEntry>): ListenerEntry {
  return {
    pid: 1,
    ppid: 0,
    port: 3000,
    host: '127.0.0.1',
    listenerHosts: ['127.0.0.1'],
    displayHost: 'localhost',
    command: 'node',
    args: 'node vite --port 3000',
    cwd: '/tmp/project',
    elapsed: '00:01:00',
    kind: 'dev',
    appFamily: '',
    projectName: 'project',
    displayProject: 'project',
    displayCommand: 'node vite',
    displayCwd: '/tmp/project',
    ...overrides,
  };
}

async function update(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
}

async function waitForFrame(
  app: ReturnType<typeof render>,
  expected: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((app.lastFrame() ?? '').includes(expected)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for frame containing: ${expected}`);
}

async function waitForFrameWithout(
  app: ReturnType<typeof render>,
  unexpected: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(app.lastFrame() ?? '').includes(unexpected)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for frame to remove: ${unexpected}`);
}

function deferred<T>(): {promise: Promise<T>; resolve: (value: T) => void} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return {promise, resolve};
}
