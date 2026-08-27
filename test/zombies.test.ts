import {describe, expect, it, vi} from 'vitest';

import {
  browserFamily,
  collectListeningPids,
  collectZombies,
  commandsByteEqual,
  detectZombieCandidates,
  hasBrowserControlFlags,
  isControllerProcess,
  reapZombie,
  revalidateZombie,
} from '../src/core/zombies.js';
import type {ProcessInfo, ZombieCandidate} from '../src/core/types.js';

const NOW = new Date('2026-08-27T00:10:00.000Z');
const OLD = new Date('2026-08-27T00:08:00.000Z');
const CONTROL_FLAGS = '--headless=new --enable-automation --remote-debugging-pipe';
const CURRENT_UID = typeof process.getuid === 'function' ? process.getuid() : 1_000;

function processInfo(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    pid: 100,
    ppid: 1,
    uid: CURRENT_UID,
    name: 'Chromium',
    command: `/Users/test/Library/Caches/ms-playwright/chromium-1200/chrome-mac/Chromium.app/Contents/MacOS/Chromium ${CONTROL_FLAGS}`,
    executable: '/Users/test/Library/Caches/ms-playwright/chromium-1200/chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    startTime: OLD,
    ...overrides,
  };
}

function candidate(overrides: Partial<ZombieCandidate> = {}): ZombieCandidate {
  return {
    ...processInfo(overrides),
    family: 'playwright',
    ageMs: 120_000,
    ageSeconds: 120,
    reapable: true,
    reason: 'playwright browser has no live controller',
    ...overrides,
  };
}

describe('zombie candidate detection', () => {
  it('detects old orphaned Playwright, Puppeteer, and generic headless Chrome browsers', () => {
    const processes = [
      processInfo({pid: 101}),
      processInfo({
        pid: 102,
        name: 'chrome-headless-shell',
        executable: '/Users/test/.cache/puppeteer/chrome-headless-shell/mac/chrome-headless-shell',
        command: `/Users/test/.cache/puppeteer/chrome-headless-shell/mac/chrome-headless-shell --headless --remote-debugging-port=0`,
      }),
      processInfo({
        pid: 103,
        name: 'google-chrome',
        executable: '/usr/bin/google-chrome',
        command: '/usr/bin/google-chrome --headless --remote-debugging-port=0',
      }),
    ];

    expect(detectZombieCandidates(processes, {now: NOW}).map(({family}) => family)).toEqual([
      'playwright',
      'puppeteer',
      'headless-chrome',
    ]);
  });

  it('requires PPID 1 or a missing parent', () => {
    const parent = processInfo({pid: 40, ppid: 1, name: 'zsh', executable: '/bin/zsh', command: '/bin/zsh'});
    const attached = processInfo({pid: 41, ppid: 40});
    const missingParent = processInfo({pid: 42, ppid: 9999});

    expect(detectZombieCandidates([parent, attached, missingParent], {now: NOW}).map(({pid}) => pid)).toEqual([42]);
  });

  it('excludes automation processes owned by another user', () => {
    expect(detectZombieCandidates([
      processInfo({uid: CURRENT_UID + 1}),
    ], {now: NOW})).toEqual([]);
  });

  it('shows young and unknown-age candidates but only makes age >= 60 seconds reapable', () => {
    const exact = processInfo({pid: 1, startTime: new Date(NOW.getTime() - 60_000)});
    const young = processInfo({pid: 2, startTime: new Date(NOW.getTime() - 59_999)});
    const unknown = processInfo({pid: 3, startTime: undefined, ageMs: undefined});
    const result = detectZombieCandidates([unknown, young, exact], {now: NOW});

    expect(result.find(({pid}) => pid === 1)?.reapable).toBe(true);
    expect(result.find(({pid}) => pid === 2)?.reapable).toBe(false);
    expect(result.find(({pid}) => pid === 3)).toMatchObject({ageMs: null, reapable: false});
  });

  it('excludes listeners, server modes, exact --port flags, run-server, and chromedriver', () => {
    const processes = [
      processInfo({pid: 1}),
      processInfo({pid: 2, command: `${processInfo().command} --server-mode`}),
      processInfo({pid: 3, command: `${processInfo().command} --port=9222`}),
      processInfo({pid: 4, command: `${processInfo().command} run-server`}),
      processInfo({
        pid: 5,
        name: 'chromedriver',
        executable: '/usr/local/bin/chromedriver',
        command: `/usr/local/bin/chromedriver ${CONTROL_FLAGS}`,
      }),
    ];

    expect(detectZombieCandidates(processes, {now: NOW, listeningPids: new Set([1])})).toEqual([]);
  });

  it('allows --remote-debugging-port while rejecting a standalone --port', () => {
    expect(detectZombieCandidates([
      processInfo({command: `${processInfo().executable} --headless --remote-debugging-port=0`}),
    ], {now: NOW})).toHaveLength(1);
  });

  it('does not treat a headed user Chrome debug profile as generic headless Chrome', () => {
    expect(detectZombieCandidates([
      processInfo({
        executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        name: 'Google Chrome',
        command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --enable-automation --remote-debugging-port=9222',
      }),
    ], {now: NOW})).toEqual([]);
  });

  it('requires real control flags and does not find flags embedded in arbitrary data', () => {
    expect(hasBrowserControlFlags('/usr/bin/chrome --headless')).toBe(false);
    expect(hasBrowserControlFlags('/usr/bin/chrome --description=--remote-debugging-pipe --mode=--headless')).toBe(false);
    expect(detectZombieCandidates([
      processInfo({command: '/usr/bin/chrome --description=--remote-debugging-pipe --headless'}),
    ], {now: NOW})).toEqual([]);
  });

  it('matches executable/script identity, not an arbitrary argv value', () => {
    const innocent = processInfo({
      name: 'node',
      executable: '/usr/bin/node',
      command: '/usr/bin/node /srv/innocent.js --fixture /node_modules/playwright/cli.js --headless --remote-debugging-pipe',
    });
    const controller = processInfo({
      name: 'node',
      executable: '/usr/bin/node',
      command: '/usr/bin/node /srv/node_modules/playwright/cli.js run-server',
    });

    expect(browserFamily(innocent)).toBeNull();
    expect(isControllerProcess(innocent)).toBe(false);
    expect(isControllerProcess(controller)).toBe(true);
    expect(detectZombieCandidates([innocent, controller], {now: NOW})).toEqual([]);
  });

  it('excludes browser descendants of a live automation controller', () => {
    const controller = processInfo({
      pid: 10,
      ppid: 1,
      name: 'node',
      executable: '/usr/bin/node',
      command: '/usr/bin/node /srv/node_modules/puppeteer/lib/cli.js',
    });
    const browser = processInfo({pid: 11, ppid: 10});
    const renderer = processInfo({pid: 12, ppid: 11});
    expect(detectZombieCandidates([controller, browser, renderer], {now: NOW})).toEqual([]);
  });

  it('detects an old orphaned portless automation wrapper only when it is a controlled leaf', () => {
    const wrapper = processInfo({
      pid: 20,
      ppid: 1,
      name: 'node',
      executable: '/usr/bin/node',
      command: '/usr/bin/node /srv/node_modules/@playwright/mcp/cli.js --headless --browser=chromium',
    });
    expect(detectZombieCandidates([wrapper], {now: NOW})).toEqual([
      expect.objectContaining({pid: 20, family: 'playwright', reapable: true}),
    ]);

    expect(detectZombieCandidates([processInfo({
      ...wrapper,
      pid: 22,
      command: '/usr/bin/node /srv/node_modules/@playwright/mcp/cli.js --extension',
    })], {now: NOW})).toEqual([
      expect.objectContaining({pid: 22, family: 'playwright'}),
    ]);

    const browserChild = processInfo({pid: 21, ppid: 20});
    expect(detectZombieCandidates([wrapper, browserChild], {now: NOW})).toEqual([]);
    expect(detectZombieCandidates([wrapper], {now: NOW, listeningPids: new Set([20])})).toEqual([]);
  });

  it('does not detect an automation-looking script from arbitrary wrapper argv data', () => {
    expect(detectZombieCandidates([processInfo({
      name: 'node',
      executable: '/usr/bin/node',
      command: '/usr/bin/node /srv/innocent.js --script=/srv/node_modules/@playwright/mcp/cli.js --headless',
    })], {now: NOW})).toEqual([]);
  });
});

describe('fail-closed collection and reaping', () => {
  it('treats lsof no-match as empty but throws strict operational failures', async () => {
    await expect(collectListeningPids({
      strict: true,
      runCommand: async () => ({exitCode: 1, stdout: '', stderr: ''}),
    })).resolves.toEqual(new Set());
    await expect(collectListeningPids({
      strict: true,
      runCommand: async () => ({exitCode: 2, stdout: '', stderr: 'not permitted'}),
    })).rejects.toThrow('not permitted');
  });

  it('fails closed when zombie collection cannot establish listener state', async () => {
    await expect(collectZombies({
      strict: true,
      processProvider: async () => [processInfo()],
      runCommand: async () => ({exitCode: 2, stdout: '', stderr: 'lsof failed'}),
    })).rejects.toThrow('lsof failed');
  });

  it('requires byte-exact commands during revalidation', async () => {
    const original = candidate();
    const common = {
      now: NOW,
      listeningPidProvider: async () => new Set<number>(),
    };
    await expect(revalidateZombie(original, {
      ...common,
      processProvider: async () => [processInfo()],
    })).resolves.toBe(true);
    await expect(revalidateZombie(original, {
      ...common,
      processProvider: async () => [processInfo({command: `${original.command} `})],
    })).resolves.toBe(false);
    expect(commandsByteEqual('chrome  --headless', 'chrome --headless')).toBe(false);
  });

  it('does not kill when lsof fails or the process becomes a listener', async () => {
    const kill = vi.fn();
    const original = candidate();
    await expect(reapZombie(original, {
      now: NOW,
      processProvider: async () => [processInfo()],
      listeningPidProvider: async () => {
        throw new Error('lsof unavailable');
      },
      kill,
    })).resolves.toBe(false);
    await expect(reapZombie(original, {
      now: NOW,
      processProvider: async () => [processInfo()],
      listeningPidProvider: async () => new Set([original.pid]),
      kill,
    })).resolves.toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('kills only after successful exact revalidation', async () => {
    const kill = vi.fn();
    const original = candidate();
    let processScans = 0;
    await expect(reapZombie(original, {
      now: NOW,
      processProvider: async () => ++processScans === 1 ? [processInfo()] : [],
      listeningPidProvider: async () => new Set(),
      kill,
    })).resolves.toBe(true);
    expect(kill).toHaveBeenCalledWith(original.pid, 'SIGTERM');
  });

  it('does not report success while the exact process remains after the signal', async () => {
    const kill = vi.fn();
    const original = candidate();
    await expect(reapZombie(original, {
      now: NOW,
      processProvider: async () => [processInfo()],
      listeningPidProvider: async () => new Set(),
      postSignalTimeoutMs: 0,
      kill,
    })).resolves.toBe(false);
    expect(kill).toHaveBeenCalledWith(original.pid, 'SIGTERM');
  });
});
