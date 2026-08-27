import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {cleanup, render} from 'ink-testing-library';
import React from 'react';
import stripAnsi from 'strip-ansi';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {ConfigRepository} from '../src/config.js';
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
  configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'portwarden-legacy-ui-'));
  scanner.listeners = [
    listener({pid: 101, port: 3001, displayProject: 'alpha'}),
    listener({pid: 102, port: 3002, displayProject: 'bravo'}),
    listener({pid: 103, port: 3003, displayProject: 'charlie'}),
  ];
  scanner.allListeners = [...scanner.listeners];
  scanner.zombies = [];
  scanner.loading = false;
  scanner.refreshing = false;
  scanner.error = '';
  scanner.updatedAt = new Date('2026-01-01T00:00:00Z');
  scanner.refresh.mockClear();
});

afterEach(() => {
  cleanup();
  fs.rmSync(configDirectory, {recursive: true, force: true});
});

describe('legacy main-screen UI contract', () => {
  it('keeps header, meta, PORTS, DETAILS, contextual keys, and status in their legacy order', async () => {
    const app = render(<PortwardenApp configRepository={repository()} />);
    await update();
    await resize(app, 120, 30);

    const lines = frameLines(app);
    const metaIndex = lines.findIndex((line) => /^refresh \d{2}:\d{2}:\d{2}  browser system  selected 1\/3$/.test(line));
    const portsIndex = lines.findIndex((line) => /^PORTS  showing 1-3 of 3$/.test(line));
    const tableHeaderIndex = lines.findIndex((line) => /\bPIN\b.*\bPORT\b.*\bPID\b.*\bAGE\b.*\bHOST\b.*\bPROJECT\b.*\bPROCESS\b/.test(line));
    const selectedRowIndex = lines.findIndex((line) => /^> .*\b3001\b.*\balpha\b/.test(line));
    const detailsIndex = lines.findIndex((line) => /^DETAILS  alpha$/.test(line));
    const keysIndex = lines.findIndex((line) => /^keys: ←\/→ reorder  a all\/main  m move-port  o open  p pin/.test(line));
    const statusIndex = lines.findIndex((line) => /^info  Ready$/.test(line));

    expect.soft(lines[0]).toBe('PORTWARDEN  [MAIN] [3 ports]');
    expect.soft(metaIndex).toBe(1);
    expect.soft(lines[2]).toBe('');
    expect.soft(portsIndex).toBeGreaterThan(metaIndex);
    expect.soft(tableHeaderIndex).toBeGreaterThan(portsIndex);
    expect.soft(selectedRowIndex).toBeGreaterThan(tableHeaderIndex);
    expect.soft(detailsIndex).toBeGreaterThan(selectedRowIndex);
    expect.soft(lines[detailsIndex + 1]).toMatch(/^-+$/);
    expect.soft(lines.slice(detailsIndex + 2, detailsIndex + 7)).toEqual([
      'port 3001  pid 101  kind DEV  age 00:01:00  pin NO',
      'next 3004  dup none  host localhost',
      'proj alpha',
      'dir  /tmp/project',
      'cmd  node vite',
    ]);
    expect.soft(keysIndex).toBeGreaterThan(detailsIndex);
    expect.soft(statusIndex).toBe(keysIndex + 1);
    expect.soft(statusIndex).toBe(lines.length - 1);
  });

  it('uses the legacy selection, collapsed-group, expanded-group, and child markers', async () => {
    scanner.listeners = appGroupListeners();
    scanner.allListeners = [...scanner.listeners];
    const app = render(<PortwardenApp configRepository={repository()} initialAll />);
    await update();
    await resize(app, 140, 30);

    let lines = frameLines(app);
    let groupRow = lines.find((line) => line.includes('2x') && line.includes('Antigravity'));
    expect.soft(lines[0]).toBe('PORTWARDEN  [ALL] [2 ports] [1 rows]');
    expect.soft(groupRow).toMatch(/^> .*\bAPP\b.*\b2x\b.*> Antigravity.*closed.*2 listeners/);
    expect.soft(lines).toContain('DETAILS  Antigravity');
    expect.soft(lines.some((line) => /^keys: → expand  enter expand  a all\/main/.test(line))).toBe(true);

    app.stdin.write('\u001B[C');
    await update();
    lines = frameLines(app);
    groupRow = lines.find((line) => line.includes('2x') && line.includes('Antigravity'));
    const unselectedChild = lines.find((line) => line.includes('6101') && line.includes('helper-one'));
    expect.soft(groupRow).toMatch(/^> .*\bAPP\b.*\b2x\b.*v Antigravity.*open.*2 listeners/);
    expect.soft(unselectedChild).toMatch(/^  .*\| helper-one/);
    expect.soft(lines.some((line) => /^keys: ← collapse  enter collapse  a all\/main/.test(line))).toBe(true);

    app.stdin.write('\u001B[B');
    await update();
    lines = frameLines(app);
    groupRow = lines.find((line) => line.includes('2x') && line.includes('Antigravity'));
    const selectedChild = lines.find((line) => line.includes('6101') && line.includes('helper-one'));
    expect.soft(groupRow).toMatch(/^  .*\bAPP\b.*\b2x\b.*v Antigravity/);
    expect.soft(selectedChild).toMatch(/^> .*\| helper-one/);
  });

  it.each([
    ['left arrow', '\u001B[D'],
    ['enter', '\r'],
  ])('collapses an expanded group from any selected child with %s', async (_label, collapseKey) => {
    scanner.listeners = appGroupListeners();
    scanner.allListeners = [...scanner.listeners];
    const repo = repository();
    const app = render(<PortwardenApp configRepository={repo} initialAll />);
    await update();

    app.stdin.write('\u001B[C');
    await update();
    app.stdin.write('\u001B[B');
    await update();
    app.stdin.write('\u001B[B');
    await update();
    const expandedLines = frameLines(app);
    const childDetailsIndex = expandedLines.findIndex((line) => line === 'DETAILS  helper-two');
    expect(childDetailsIndex).toBeGreaterThan(-1);
    expect(expandedLines[childDetailsIndex + 2]).toMatch(/^port 6102\b/);

    app.stdin.write(collapseKey);
    await update();

    const lines = frameLines(app);
    const tableRows = tableBody(lines);
    expect.soft(tableRows.some((line) => line.includes('6101') || line.includes('6102'))).toBe(false);
    expect.soft(lines).toContain('DETAILS  Antigravity');
    expect.soft(lines).toContain('group Antigravity  kind APP  listeners 2  state collapsed');
    expect.soft(lines.some((line) => /^keys: → expand  enter expand  a all\/main/.test(line))).toBe(true);
    expect.soft(repo.get().orderedEntryKeys).toEqual([]);
  });

  it('preserves the legacy row geometry at 80, 120, and 140 columns', async () => {
    scanner.listeners = [listener({
      pid: 404,
      port: 4100,
      kind: 'system',
      elapsed: '01:23:45',
      displayProject: 'responsive-project-name-that-is-long',
      projectName: 'responsive-project-name-that-is-long',
      args: 'node /Applications/Responsive Demo/bin/server.js --inspect --config production.json',
      displayCommand: 'node /Applications/Responsive Demo/bin/server.js --inspect --config production.json',
    })];
    scanner.allListeners = [...scanner.listeners];
    const app = render(<PortwardenApp configRepository={repository()} initialAll />);
    await update();

    const selectedRows = new Map<number, string>();
    for (const columns of [80, 120, 140]) {
      await resize(app, columns, 30);
      const lines = frameLines(app);
      const header = lines.find((line) => /\bKIND\b.*\bPIN\b.*\bPORT\b/.test(line));
      const row = lines.find((line) => /^> .*\b4100\b/.test(line));
      expect.soft(header, `${columns}-column table header`).toMatch(/\bKIND\b.*\bPIN\b.*\bPORT\b.*\bPID\b.*\bAGE\b.*\bHOST\b.*\bPROJECT\b.*\bPROCESS\b/);
      expect.soft(row, `${columns}-column selected row`).toBeDefined();
      selectedRows.set(columns, row ?? '');
    }

    expect.soft(selectedRows.get(80)).toBe(
      '> SYSTEM -   4100  404    01:23:45 localhost   responsive-proj… node /Applicati…',
    );
    expect.soft(selectedRows.get(120)).toBe(
      '> SYSTEM -   4100  404    01:23:45 localhost        responsive-project-n… node /Applications/Responsive Demo/bin/serve…',
    );
    expect.soft(selectedRows.get(140)).toBe(
      '> SYSTEM -   4100  404    01:23:45 localhost           responsive-project-name… node /Applications/Responsive Demo/bin/server.js --inspect…',
    );
  });

  it('keeps a long details label on one line inside a short viewport', async () => {
    const longProject = `아주긴프로젝트-${'x'.repeat(160)}`;
    scanner.listeners = [listener({displayProject: longProject, projectName: longProject})];
    scanner.allListeners = [...scanner.listeners];
    const app = render(<PortwardenApp configRepository={repository()} />);
    await update();
    await resize(app, 80, 18);

    const lines = frameLines(app);
    const details = lines.find((line) => line.startsWith('DETAILS  '));
    expect.soft(lines).toHaveLength(18);
    expect.soft(details).toMatch(/^DETAILS  아주긴프로젝트-x+…$/);
    expect.soft(lines.every((line) => displayWidth(line) <= 80)).toBe(true);
  });

  it('keeps graveyard state columns aligned for wide project names', async () => {
    scanner.listeners = [];
    scanner.allListeners = [];
    const repo = repository();
    repo.update({graveyard: [{
      id: 'wide:3001:record',
      listenerKey: 'host:127.0.0.1::port:3001',
      port: 3001,
      host: '127.0.0.1',
      project: '가나다라마바사아자차카타파하',
      cwd: '/tmp/project',
      argv: ['node', 'vite', '--port', '3001'],
      env: {},
      capturedAt: '2026-01-01T00:00:00.000Z',
    }]});
    const app = render(<PortwardenApp configRepository={repo} />);
    await update();
    await resize(app, 80, 20);
    app.stdin.write('g');
    await update();

    const recordLine = frameLines(app).find((line) => line.includes('dead')) ?? '';
    expect.soft(recordLine).toContain('가나다라마바사아자차…');
    expect.soft(displayWidth(recordLine.slice(0, recordLine.indexOf('dead')))).toBe(31);
    expect.soft(displayWidth(recordLine)).toBeLessThanOrEqual(80);
  });

  it('keeps a main-screen confirmation visible within an 80x18 viewport', async () => {
    const repo = repository();
    repo.update({confirmActions: true});
    const app = render(<PortwardenApp configRepository={repo} />);
    await update();
    await resize(app, 80, 18);

    app.stdin.write('x');
    await update();

    const lines = frameLines(app);
    expect.soft(lines).toHaveLength(18);
    expect.soft(lines.at(-2)).toMatch(/^keys: /);
    expect.soft(lines.at(-1)).toMatch(/^confirm  Stop port 3001 \(PID 101, alpha\)\?  enter\/y confirm  esc\/n cancel/);
    expect.soft(lines.every((line) => displayWidth(line) <= 80)).toBe(true);
  });

  it('keeps a graveyard confirmation visible within an 80x12 viewport', async () => {
    const repo = repository();
    repo.update({
      confirmActions: true,
      graveyard: [{
        id: 'alpha:3001:record',
        listenerKey: 'host:127.0.0.1::port:3001',
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
    await resize(app, 80, 12);

    app.stdin.write('g');
    await update();
    app.stdin.write('r');
    await update();

    const lines = frameLines(app);
    expect.soft(lines).toHaveLength(12);
    expect.soft(lines.at(-2)).toBe('keys: r revive  d drop  ↑↓ select  g/s/esc/q back');
    expect.soft(lines.at(-1)).toMatch(/^confirm  Revive port 3001 \(alpha\)\?  enter\/y confirm  esc\/n cancel/);
    expect.soft(lines.every((line) => displayWidth(line) <= 80)).toBe(true);
  });

  it('scrolls the browser picker while keeping selection and footer inside an 80x10 viewport', async () => {
    const app = render(<PortwardenApp configRepository={repository()} />);
    await update();
    await resize(app, 80, 10);

    app.stdin.write('s');
    await update();
    app.stdin.write('\r');
    await update();
    for (let index = 0; index < 8; index += 1) {
      app.stdin.write('\u001B[B');
      await update();
    }

    const lines = frameLines(app);
    const optionLines = browserOptionLines(lines);
    expect.soft(lines).toHaveLength(10);
    expect.soft(optionLines).toHaveLength(4);
    expect.soft(optionLines.some((line) => /^> Vivaldi$/.test(line))).toBe(true);
    expect.soft(optionLines.some((line) => /System default browser/.test(line))).toBe(false);
    expect.soft(lines.at(-1)).toBe('keys: enter save  ↑↓ select  s/esc/q back');
    expect.soft(lines.every((line) => displayWidth(line) <= 80)).toBe(true);
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

function appGroupListeners(): ListenerEntry[] {
  return [
    listener({
      pid: 201,
      port: 6101,
      kind: 'app',
      appFamily: 'Antigravity',
      projectName: 'helper-one',
      displayProject: 'helper-one',
      args: '/Applications/Antigravity.app/helper-one',
      displayCommand: '/Applications/Antigravity.app/helper-one',
    }),
    listener({
      pid: 202,
      port: 6102,
      kind: 'app',
      appFamily: 'Antigravity',
      projectName: 'helper-two',
      displayProject: 'helper-two',
      args: '/Applications/Antigravity.app/helper-two',
      displayCommand: '/Applications/Antigravity.app/helper-two',
    }),
  ];
}

function frameLines(app: ReturnType<typeof render>): string[] {
  return stripAnsi(app.lastFrame() ?? '').split('\n').map((line) => line.trimEnd());
}

function tableBody(lines: readonly string[]): string[] {
  const headerIndex = lines.findIndex((line) => /\bKIND\b.*\bPIN\b.*\bPORT\b/.test(line));
  const detailsIndex = lines.findIndex((line) => line.startsWith('DETAILS'));
  return headerIndex >= 0 && detailsIndex > headerIndex ? lines.slice(headerIndex + 1, detailsIndex) : [];
}

function browserOptionLines(lines: readonly string[]): string[] {
  const headerIndex = lines.findIndex((line) => line === 'BROWSER LIST');
  const footerIndex = lines.findIndex((line) => line.startsWith('keys: enter save'));
  return headerIndex >= 0 && footerIndex > headerIndex
    ? lines.slice(headerIndex + 2, footerIndex).filter(Boolean)
    : [];
}

function displayWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    width += codePoint >= 0x1100 && (
      codePoint <= 0x115f || codePoint === 0x2329 || codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    ) ? 2 : 1;
  }
  return width;
}

async function resize(app: ReturnType<typeof render>, columns: number, rows: number): Promise<void> {
  Object.defineProperty(app.stdout, 'columns', {configurable: true, value: columns});
  Object.defineProperty(app.stdout, 'rows', {configurable: true, value: rows});
  app.stdout.emit('resize');
  await update();
}

async function update(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
}
