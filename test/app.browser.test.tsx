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
  useScanner: () => scanner,
}));

let configDirectory = '';

beforeEach(() => {
  configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'portwarden-browser-ui-'));
  scanner.refresh.mockClear();
});

afterEach(() => {
  cleanup();
  fs.rmSync(configDirectory, {recursive: true, force: true});
});

describe('browser settings UI', () => {
  it('keeps the selected browser visible in a four-row viewport and saves it', async () => {
    const repo = repository();
    const app = render(<PortwardenApp configRepository={repo} />);
    await update();
    await resize(app, 80, 10);
    await openBrowserPicker(app);

    for (let index = 0; index < 12; index += 1) {
      app.stdin.write('\u001B[B');
      await update();
    }

    const browserFrame = frameLines(app);
    const visibleOptions = browserOptionLines(browserFrame);
    expect(visibleOptions).toHaveLength(4);
    expect(visibleOptions).toContain('> DuckDuckGo');
    expect(browserFrame).not.toContain('  System default browser  saved · active');

    app.stdin.write('\r');
    await update();

    expect(repo.get().browser).toBe('DuckDuckGo');
    expect(frameLines(app)).toContain('info  Browser: DuckDuckGo.');
  });

  it('shows saved and session-active browsers separately while an override remains in force', async () => {
    const repo = repository();
    repo.update({browser: 'Safari'});
    const app = render(<PortwardenApp configRepository={repo} browserOverride="Arc" />);
    await update();
    await resize(app, 100, 18);

    app.stdin.write('s');
    await update();
    expect(frameLines(app)).toContain('This session uses browser override: Arc');

    app.stdin.write('\r');
    await update();
    let lines = frameLines(app);
    expect(lines).toContain('saved Safari  active Arc');
    expect(lines).toContain('  Arc  active');
    expect(lines).toContain('> Safari  saved');

    app.stdin.write('\u001B[B');
    await update();
    app.stdin.write('\r');
    await update();

    expect(repo.get().browser).toBe('Firefox');
    lines = frameLines(app);
    expect(lines).toContain('This session uses browser override: Arc');
    expect(lines.some((line) => line.includes('Default browser') && line.includes('Firefox'))).toBe(true);

    app.stdin.write('\r');
    await update();
    lines = frameLines(app);
    expect(lines).toContain('saved Firefox  active Arc');
    expect(lines).toContain('  Arc  active');
    expect(lines).toContain('> Firefox  saved');
  });

  it('normalizes an environment-style override and keeps a seven-row picker usable', async () => {
    const repo = repository();
    const app = render(
      <PortwardenApp configRepository={repo} browserOverride={'  \u001B[31mArc\u001B[0m  '} />,
    );
    await update();
    await resize(app, 80, 7);
    await openBrowserPicker(app);

    app.stdin.write('\u001B[B');
    await update();

    const lines = frameLines(app);
    expect(lines).toContain('saved System default browser  active Arc');
    expect(browserOptionLines(lines)).toEqual(['> Arc  active']);
    expect(lines).toContain('keys: enter save  ↑↓ select  s/esc/q back');
    expect(lines.every((line) => line.length <= 80)).toBe(true);
  });

  it('truncates a custom browser name without pushing the picker footer off screen', async () => {
    const customBrowser = `Custom Browser ${'x'.repeat(160)}`;
    const app = render(<PortwardenApp configRepository={repository()} browserOverride={customBrowser} />);
    await update();
    await resize(app, 80, 7);
    await openBrowserPicker(app);

    for (let index = 0; index < 13; index += 1) {
      app.stdin.write('\u001B[B');
      await update();
    }

    const lines = frameLines(app);
    expect(lines).toHaveLength(7);
    expect(browserOptionLines(lines)).toHaveLength(1);
    expect(browserOptionLines(lines)[0]).toMatch(/^> Custom Browser x+…$/);
    expect(lines.at(-1)).toBe('keys: enter save  ↑↓ select  s/esc/q back');
    expect(lines.every((line) => line.length <= 80)).toBe(true);
  });
});

function repository(): ConfigRepository {
  return ConfigRepository.open({configDirectory});
}

function frameLines(app: ReturnType<typeof render>): string[] {
  return stripAnsi(app.lastFrame() ?? '').split('\n').map((line) => line.trimEnd());
}

function browserOptionLines(lines: readonly string[]): string[] {
  const titleIndex = lines.indexOf('BROWSER LIST');
  const keysIndex = lines.findIndex((line) => line.startsWith('keys: enter save'));
  return titleIndex >= 0 && keysIndex > titleIndex
    ? lines.slice(titleIndex + 2, keysIndex).filter((line) => line.trim())
    : [];
}

async function openBrowserPicker(app: ReturnType<typeof render>): Promise<void> {
  app.stdin.write('s');
  await update();
  app.stdin.write('\r');
  await update();
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
