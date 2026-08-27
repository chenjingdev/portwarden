import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {cleanup, render} from 'ink-testing-library';
import React from 'react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {ConfigRepository} from '../src/config.js';
import {listenerKey} from '../src/core/listeners.js';
import type {ListenerEntry, ZombieCandidate} from '../src/core/types.js';
import {PortwardenApp} from '../src/tui/App.js';

const scanner = vi.hoisted(() => ({
  allListeners: [] as ListenerEntry[],
  listeners: [] as ListenerEntry[],
  zombies: [] as ZombieCandidate[],
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
  scanner.refresh.mockClear();
});

afterEach(() => {
  cleanup();
  fs.rmSync(configDirectory, {recursive: true, force: true});
});

describe('PortwardenApp', () => {
  it('navigates the primary screens and treats pasted chunks as text, not actions', async () => {
    const app = render(<PortwardenApp configRepository={repository()} />);
    await update();
    expect(app.lastFrame()).toContain('PORTWARDEN  [DEV] [3 ports]');

    app.stdin.write('qrm');
    await update();
    expect(app.lastFrame()).toContain('PORTWARDEN  [DEV]');

    app.stdin.write('a');
    await update();
    expect(app.lastFrame()).toContain('[ALL] [3 ports]');

    app.stdin.write('z');
    await update();
    expect(app.lastFrame()).toContain('[0 zombies]');

    app.stdin.write('s');
    await update();
    expect(app.lastFrame()).toContain('PORTWARDEN  [SETTINGS]');

    app.stdin.write('s');
    await update();
    app.stdin.write('?');
    await update();
    expect(app.lastFrame()).toContain('PORTWARDEN  [HELP]');
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
    expect(app.lastFrame()).toContain('Stop alpha:3001?');
    expect(app.lastFrame()).toContain('enter/y confirm');

    app.stdin.write('n');
    await update();
    expect(app.lastFrame()).not.toContain('Stop alpha:3001?');
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
