import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {afterEach, describe, expect, it, vi} from 'vitest';

import {ConfigRepository, type GraveyardRecord, type PortwardenConfig} from '../src/config.js';
import {
  captureGraveyardRecord,
  PortwardenActions,
  type ActionDependencies,
} from '../src/core/actions.js';
import {listenerKey, preferenceKey, selectionKey} from '../src/core/listeners.js';
import type {ListenerEntry, ProcessInfo, ZombieCandidate} from '../src/core/types.js';

vi.mock('node:fs/promises', () => ({
  default: {
    mkdir: vi.fn(async () => undefined),
  },
}));

const NOW = new Date('2026-08-27T01:02:03.000Z');
const STARTED_AT = new Date('2026-08-27T01:00:00.000Z');
const temporaryDirectories: string[] = [];

type Collect = NonNullable<ActionDependencies['collect']>;
type Kill = NonNullable<ActionDependencies['kill']>;
type FindPort = NonNullable<ActionDependencies['getPort']>;
type Launch = NonNullable<ActionDependencies['launch']>;
type LaunchedProcess = ReturnType<Launch>;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

function repository(patch: Partial<PortwardenConfig> = {}): ConfigRepository {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portwarden-actions-test-'));
  temporaryDirectories.push(directory);
  const result = ConfigRepository.open({configDirectory: directory});
  if (Object.keys(patch).length > 0) result.update(patch);
  return result;
}

function listener(overrides: Partial<ListenerEntry> = {}): ListenerEntry {
  return {
    pid: 1_000,
    ppid: 1,
    uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
    executable: '/usr/local/bin/vite',
    port: 3_000,
    host: '127.0.0.1',
    listenerHosts: ['127.0.0.1'],
    displayHost: 'localhost',
    command: 'vite',
    args: 'vite --port 3000',
    cwd: '/Users/test/dev/sample',
    elapsed: '00:02:03',
    kind: 'dev',
    appFamily: '',
    projectName: 'sample',
    displayProject: 'sample',
    displayCommand: 'vite --port 3000',
    displayCwd: '~/dev/sample',
    startTime: STARTED_AT,
    ...overrides,
  };
}

function graveyardRecord(overrides: Partial<GraveyardRecord> = {}): GraveyardRecord {
  return {
    id: 'sample-3000-record',
    listenerKey: listenerKey('127.0.0.1', 3_000),
    port: 3_000,
    host: '127.0.0.1',
    project: 'sample',
    cwd: '/Users/test/dev/sample',
    argv: ['vite', '--port', '3000'],
    env: {},
    capturedAt: NOW.toISOString(),
    ...overrides,
  };
}

function processInfo(pid: number, ppid: number, command = 'vite --port 3001'): ProcessInfo {
  return {
    pid,
    ppid,
    name: 'vite',
    command,
    executable: '/usr/local/bin/vite',
    startTime: STARTED_AT,
  };
}

function zombie(overrides: Partial<ZombieCandidate> = {}): ZombieCandidate {
  return {
    pid: 7_000,
    ppid: 1,
    uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
    name: 'Chromium',
    command: '/cache/ms-playwright/Chromium --headless --enable-automation --remote-debugging-pipe',
    executable: '/cache/ms-playwright/Chromium',
    startTime: STARTED_AT,
    family: 'playwright',
    ageMs: 120_000,
    ageSeconds: 120,
    reapable: true,
    reason: 'orphaned browser',
    ...overrides,
  };
}

function launchedProcess(pid: number): LaunchedProcess {
  return {
    pid,
    subprocess: {} as LaunchedProcess['subprocess'],
  };
}

function sequentialCollector(...snapshots: ListenerEntry[][]): Collect {
  let index = 0;
  return vi.fn(async () => snapshots[Math.min(index++, snapshots.length - 1)] ?? []);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return {promise, resolve};
}

describe('stopListener safety', () => {
  it('preflights a listener without sending a signal or mutating config', async () => {
    const current = listener();
    const config = repository();
    const before = config.get();
    const kill = vi.fn<Kill>();
    const actions = new PortwardenActions(config, {collect: sequentialCollector([current]), kill});
    await expect(actions.validateListener(current)).resolves.toEqual(current);
    expect(kill).not.toHaveBeenCalled();
    expect(config.get()).toEqual(before);
  });

  it('refuses to kill a pinned listener before process collection', async () => {
    const current = listener();
    const config = repository({pinnedListenerKeys: [listenerKey(current)]});
    const collect = vi.fn<Collect>(async () => [current]);
    const kill = vi.fn<Kill>();
    const actions = new PortwardenActions(config, {collect, kill});

    await expect(actions.stopListener(current, 'SIGTERM')).rejects.toMatchObject({
      name: 'ActionError',
      code: 'PINNED',
    });
    expect(collect).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it('refuses stop and destructive preflight when the PID owns another pinned listener', async () => {
    const selected = listener();
    const pinnedSibling = listener({port: 3_001, displayCommand: 'vite --port 3000'});
    const config = repository({pinnedListenerKeys: [listenerKey(pinnedSibling)]});
    const collect = vi.fn<Collect>(async () => [selected, pinnedSibling]);
    const kill = vi.fn<Kill>();
    const actions = new PortwardenActions(config, {collect, kill});

    await expect(actions.validateListener(selected)).rejects.toMatchObject({code: 'PINNED'});
    await expect(actions.stopListener(selected, 'SIGTERM')).rejects.toMatchObject({code: 'PINNED'});
    expect(kill).not.toHaveBeenCalled();
  });

  it.each([
    ['PID', {pid: 1_001}],
    ['command', {args: 'vite --port 3000 --host 0.0.0.0'}],
    ['cwd', {cwd: '/Users/test/dev/other'}],
    ['executable', {executable: '/tmp/replaced-vite'}],
    ['owner', {uid: (typeof process.getuid === 'function' ? process.getuid() : 1_000) + 1}],
    ['start time', {startTime: new Date('2026-08-27T00:59:00.000Z')}],
  ])('refuses to kill when the listener %s changed after refresh', async (_label, overrides) => {
    const expected = listener();
    const current = listener(overrides);
    const config = repository();
    const kill = vi.fn<Kill>();
    const actions = new PortwardenActions(config, {
      collect: sequentialCollector([current]),
      kill,
    });

    await expect(actions.stopListener(expected, 'SIGKILL')).rejects.toMatchObject({
      name: 'ActionError',
      code: 'STALE_PROCESS',
    });
    expect(kill).not.toHaveBeenCalled();
    expect(config.get().graveyard).toEqual([]);
  });

  it('does not create a graveyard record when the listener remains after kill', async () => {
    vi.useFakeTimers();
    const current = listener();
    const config = repository();
    const kill = vi.fn<Kill>();
    const collect = vi.fn<Collect>(async () => [current]);
    const actions = new PortwardenActions(config, {collect, kill});

    const pending = actions.stopListener(current, 'SIGTERM');
    const rejection = expect(pending).rejects.toMatchObject({
      name: 'ActionError',
      code: 'STOP_FAILED',
    });
    await vi.runAllTimersAsync();
    await rejection;

    expect(kill).toHaveBeenCalledOnce();
    expect(config.get().graveyard).toEqual([]);
  });

  it('does not create a graveyard record when signalling the process fails', async () => {
    const current = listener();
    const config = repository();
    const kill = vi.fn<Kill>(() => {
      throw new Error('EPERM');
    });
    const actions = new PortwardenActions(config, {
      collect: sequentialCollector([current]),
      kill,
    });

    await expect(actions.stopListener(current, 'SIGTERM')).rejects.toMatchObject({
      name: 'ActionError',
      code: 'STOP_FAILED',
      message: expect.stringContaining('EPERM'),
    });
    expect(config.get().graveyard).toEqual([]);
  });

  it('creates a replay-safe graveyard record only after a verified stop', async () => {
    const current = listener({args: 'NODE_ENV=development vite --port 3000'});
    const config = repository();
    const kill = vi.fn<Kill>();
    const actions = new PortwardenActions(config, {
      collect: sequentialCollector([current], []),
      kill,
      now: () => NOW,
    });

    await expect(actions.stopListener(current, 'SIGTERM')).resolves.toMatchObject({
      port: current.port,
      pid: current.pid,
    });

    expect(kill).toHaveBeenCalledWith(current.pid, 'SIGTERM');
    expect(config.get().graveyard).toEqual([expect.objectContaining({
      listenerKey: listenerKey(current),
      port: current.port,
      cwd: current.cwd,
      argv: ['vite', '--port', '3000'],
      env: {NODE_ENV: 'development'},
      capturedAt: NOW.toISOString(),
    })]);
  });

  it('stops a sensitive command without persisting its credentials', async () => {
    const current = listener({args: 'API_TOKEN=do-not-save vite --port 3000'});
    const config = repository();
    const kill = vi.fn<Kill>();
    const actions = new PortwardenActions(config, {
      collect: sequentialCollector([current], []),
      kill,
    });

    await actions.stopListener(current, 'SIGKILL');

    expect(kill).toHaveBeenCalledWith(current.pid, 'SIGKILL');
    expect(config.get().graveyard).toEqual([]);
  });

  it('never stores a shell replay record', () => {
    expect(captureGraveyardRecord(listener({
      args: '/bin/sh -c "vite --port 3000; touch /tmp/pwned"',
    }), NOW)).toBeNull();
  });
});

describe('zombie stop outcomes', () => {
  it('reports success only after revalidation and verified exit', async () => {
    const candidate = zombie();
    const kill = vi.fn<Kill>();
    const revalidate = vi.fn(async () => true);
    const waitForExit = vi.fn(async () => true);
    const actions = new PortwardenActions(repository(), {
      kill,
      revalidateZombie: revalidate,
      waitForZombieExit: waitForExit,
    });

    await expect(actions.stopZombie(candidate, 'SIGTERM')).resolves.toMatchObject({pid: candidate.pid});
    expect(kill).toHaveBeenCalledWith(candidate.pid, 'SIGTERM');
    expect(waitForExit).toHaveBeenCalled();
  });

  it('fails instead of claiming a process stopped when it remains alive', async () => {
    const candidate = zombie();
    const actions = new PortwardenActions(repository(), {
      kill: vi.fn<Kill>(),
      revalidateZombie: vi.fn(async () => true),
      waitForZombieExit: vi.fn(async () => false),
    });
    await expect(actions.stopZombie(candidate, 'SIGKILL')).rejects.toMatchObject({code: 'STOP_FAILED'});
  });
});

describe('moveListener safety', () => {
  it('does not kill the original until a matching child listener is verified', async () => {
    const original = listener();
    const moved = listener({
      pid: 2_000,
      port: 3_001,
      args: 'vite --port 3001',
      displayCommand: 'vite --port 3001',
    });
    const config = repository({orderedEntryKeys: [
      listenerKey(original),
      preferenceKey(original),
      selectionKey(original),
    ]});
    const matchingCollectionRequested = deferred<void>();
    const matchingCollection = deferred<ListenerEntry[]>();
    let collectionCount = 0;
    const collect = vi.fn<Collect>(async () => {
      collectionCount += 1;
      if (collectionCount === 1) return [original];
      if (collectionCount === 2) {
        matchingCollectionRequested.resolve();
        return matchingCollection.promise;
      }
      if (collectionCount === 3) return [original, moved];
      return [moved];
    });
    const kill = vi.fn<Kill>();
    const findPort = vi.fn<FindPort>(async () => moved.port);
    const launchedPid = moved.pid - 1;
    const launch = vi.fn<Launch>(() => launchedProcess(launchedPid));
    const actions = new PortwardenActions(config, {
      collect,
      kill,
      getPort: findPort,
      launch,
      processProvider: async () => [
        processInfo(launchedPid, 1),
        processInfo(moved.pid, launchedPid),
      ],
    });

    const pending = actions.moveListener(original);
    await matchingCollectionRequested.promise;

    expect(launch).toHaveBeenCalledWith(
      {argv: ['vite', '--port', '3001'], env: {}},
      original.cwd,
      expect.stringContaining('sample-3001.log'),
    );
    expect(kill).not.toHaveBeenCalled();

    matchingCollection.resolve([original, moved]);
    await expect(pending).resolves.toMatchObject({listener: moved, port: moved.port, pid: moved.pid});
    expect(kill).toHaveBeenCalledWith(original.pid, 'SIGTERM');
    expect(config.get().orderedEntryKeys).toEqual([listenerKey(moved)]);
  });

  it('rejects an unrelated same-command listener that races onto the selected port', async () => {
    vi.useFakeTimers();
    const original = listener();
    const unrelated = listener({pid: 3_000, port: 3_001, args: 'vite --port 3001'});
    const launchedPid = 2_000;
    const kill = vi.fn<Kill>();
    const rollbackKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const actions = new PortwardenActions(repository(), {
      collect: sequentialCollector([original], [original, unrelated]),
      kill,
      getPort: vi.fn<FindPort>(async () => unrelated.port),
      launch: vi.fn<Launch>(() => launchedProcess(launchedPid)),
      processProvider: async () => [
        processInfo(launchedPid, 1),
        processInfo(unrelated.pid, 1),
      ],
    });

    const pending = actions.moveListener(original);
    const rejection = expect(pending).rejects.toMatchObject({code: 'START_FAILED'});
    await vi.runAllTimersAsync();
    await rejection;
    expect(kill).not.toHaveBeenCalled();
    expect(rollbackKill).toHaveBeenCalledWith(-launchedPid, 'SIGTERM');
  });

  it('rejects unsafe shell replay before launching a duplicate', async () => {
    const original = listener({args: '/bin/sh -c "vite --port 3000; touch /tmp/pwned"'});
    const launch = vi.fn<Launch>();
    const actions = new PortwardenActions(repository(), {
      collect: sequentialCollector([original]),
      launch,
    });
    await expect(actions.moveListener(original)).rejects.toMatchObject({code: 'UNSAFE_COMMAND'});
    expect(launch).not.toHaveBeenCalled();
  });

  it('rolls back a verified descendant listener when stopping the original fails', async () => {
    const original = listener();
    const launchedPid = 2_000;
    const moved = listener({pid: 2_001, port: 3_001, args: 'vite --port 3001'});
    const collect = sequentialCollector(
      [original],
      [original, moved],
      [original, moved],
      [original, moved],
    );
    const originalKill = vi.fn<Kill>(() => {
      throw new Error('EPERM');
    });
    const rollbackKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const actions = new PortwardenActions(repository(), {
      collect,
      kill: originalKill,
      getPort: vi.fn<FindPort>(async () => moved.port),
      launch: vi.fn<Launch>(() => launchedProcess(launchedPid)),
      processProvider: async () => [
        processInfo(launchedPid, 1),
        processInfo(moved.pid, launchedPid),
      ],
    });

    await expect(actions.moveListener(original)).rejects.toMatchObject({code: 'STOP_FAILED'});
    expect(rollbackKill).toHaveBeenCalledWith(moved.pid, 'SIGTERM');
    expect(rollbackKill).toHaveBeenCalledWith(-launchedPid, 'SIGTERM');
  });

  it('rolls back a mismatched child and preserves the original listener', async () => {
    vi.useFakeTimers();
    const original = listener();
    const impostor = listener({
      pid: 2_000,
      port: 3_001,
      args: 'node impostor.js --port 3001',
      command: 'node',
    });
    const existingRecord = graveyardRecord();
    const config = repository({graveyard: [existingRecord]});
    const configBeforeMove = config.get();
    let collectionCount = 0;
    const collect = vi.fn<Collect>(async () => {
      collectionCount += 1;
      return collectionCount === 1 ? [original] : [original, impostor];
    });
    const kill = vi.fn<Kill>();
    const childLaunched = deferred<void>();
    const launch = vi.fn<Launch>(() => {
      childLaunched.resolve();
      return launchedProcess(impostor.pid);
    });
    const rollbackKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const actions = new PortwardenActions(config, {
      collect,
      kill,
      getPort: vi.fn<FindPort>(async () => impostor.port),
      launch,
    });

    const pending = actions.moveListener(original);
    const rejection = expect(pending).rejects.toMatchObject({
      name: 'ActionError',
      code: 'START_FAILED',
    });
    await childLaunched.promise;
    await vi.runAllTimersAsync();
    await rejection;

    expect(kill).not.toHaveBeenCalled();
    expect(rollbackKill).toHaveBeenCalledWith(-impostor.pid, 'SIGTERM');
    expect(config.get()).toEqual(configBeforeMove);
  });

  it('rejects a listener whose command declares a different port', async () => {
    vi.useFakeTimers();
    const original = listener();
    const wrongPortCommand = listener({
      pid: 2_000,
      port: 3_001,
      args: 'vite --port 9999',
    });
    const launch = vi.fn<Launch>(() => launchedProcess(wrongPortCommand.pid));
    const rollbackKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const actions = new PortwardenActions(repository(), {
      collect: sequentialCollector([original], [original, wrongPortCommand]),
      kill: vi.fn<Kill>(),
      getPort: vi.fn<FindPort>(async () => 3_001),
      launch,
    });

    const pending = actions.moveListener(original);
    const rejection = expect(pending).rejects.toMatchObject({code: 'START_FAILED'});
    await vi.runAllTimersAsync();
    await rejection;
    expect(rollbackKill).toHaveBeenCalledWith(-wrongPortCommand.pid, 'SIGTERM');
  });
});

describe('graveyard actions', () => {
  it('does not launch a stale graveyard record', async () => {
    const record = graveyardRecord();
    const launch = vi.fn<Launch>();
    const actions = new PortwardenActions(repository(), {launch});
    await expect(actions.revive(record)).rejects.toMatchObject({code: 'NOT_FOUND'});
    expect(launch).not.toHaveBeenCalled();
  });

  it('keeps a revive record until the child is verified and removes it after a match', async () => {
    const record = graveyardRecord();
    const revived = listener({pid: 3_000});
    const config = repository({graveyard: [record]});
    const matchingCollectionRequested = deferred<void>();
    const matchingCollection = deferred<ListenerEntry[]>();
    let collectionCount = 0;
    const collect = vi.fn<Collect>(async () => {
      collectionCount += 1;
      if (collectionCount === 1) return [];
      matchingCollectionRequested.resolve();
      return matchingCollection.promise;
    });
    const launch = vi.fn<Launch>(() => launchedProcess(revived.pid));
    const actions = new PortwardenActions(config, {
      collect,
      getPort: vi.fn<FindPort>(async () => record.port),
      launch,
    });

    const pending = actions.revive(record);
    await matchingCollectionRequested.promise;

    expect(config.get().graveyard).toEqual([record]);
    expect(launch).toHaveBeenCalledWith(
      {argv: record.argv, env: record.env},
      record.cwd,
      expect.stringContaining('sample-3000.log'),
    );

    matchingCollection.resolve([revived]);
    await expect(pending).resolves.toMatchObject({listener: revived, port: record.port, pid: revived.pid});
    expect(config.get().graveyard).toEqual([]);
  });

  it('retries a transient exact-port availability race before reviving', async () => {
    const record = graveyardRecord();
    const revived = listener({pid: 3_000});
    const config = repository({graveyard: [record]});
    const findPort = vi.fn<FindPort>()
      .mockResolvedValueOnce(record.port + 1)
      .mockResolvedValue(record.port);
    const actions = new PortwardenActions(config, {
      collect: sequentialCollector([], [revived]),
      getPort: findPort,
      launch: vi.fn<Launch>(() => launchedProcess(revived.pid)),
    });

    await expect(actions.revive(record)).resolves.toMatchObject({port: record.port, pid: revived.pid});
    expect(findPort).toHaveBeenCalledTimes(2);
  });

  it('discards only the selected record and reports a stale discard', () => {
    const selected = graveyardRecord();
    const retained = graveyardRecord({
      id: 'other-4000-record',
      listenerKey: listenerKey('127.0.0.1', 4_000),
      port: 4_000,
      project: 'other',
      argv: ['vite', '--port', '4000'],
    });
    const config = repository({graveyard: [selected, retained]});
    const actions = new PortwardenActions(config);

    expect(actions.discard(selected)).toMatchObject({
      message: 'Discarded sample:3000 from the graveyard.',
    });
    expect(config.get().graveyard).toEqual([retained]);
    expect(() => actions.discard(selected)).toThrow(expect.objectContaining({
      name: 'ActionError',
      code: 'NOT_FOUND',
    }));
  });
});
