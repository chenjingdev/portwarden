import {describe, expect, it, vi} from 'vitest';

import {formatActionOutcomes, stopListenerMatches} from '../src/cliActions.js';
import type {StopSignal} from '../src/core/actions.js';
import type {ListenerEntry} from '../src/core/types.js';

function listener(overrides: Partial<ListenerEntry> = {}): ListenerEntry {
  return {
    pid: 101,
    ppid: 1,
    uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
    executable: '/usr/local/bin/node',
    port: 3_000,
    host: '127.0.0.1',
    listenerHosts: ['127.0.0.1'],
    displayHost: 'localhost',
    command: 'node',
    args: 'node vite --port 3000',
    cwd: '/Users/test/dev/sample',
    elapsed: '00:02:03',
    kind: 'dev',
    appFamily: '',
    projectName: 'sample',
    displayProject: 'sample',
    displayCommand: 'node vite --port 3000',
    displayCwd: '~/dev/sample',
    startTime: new Date('2026-08-27T01:00:00.000Z'),
    ...overrides,
  };
}

describe('headless listener stops', () => {
  it('skips a second PID in the same group only after a successful group outcome', async () => {
    const first = listener({pid: 101, pgid: 9_000, collectorPgid: 8_000});
    const firstAlias = listener({
      ...first,
      host: '::1',
      listenerHosts: ['::1'],
    });
    const second = listener({pid: 102, ppid: 101, pgid: 9_000, collectorPgid: 8_000});
    const validateListener = vi.fn(async (entry: ListenerEntry) => entry);
    const stopListener = vi.fn(async (entry: ListenerEntry, _signal: StopSignal) => ({
      message: `Stopped ${entry.pid}`,
      pid: entry.pid,
      pgid: entry.pgid,
    }));
    const onOutcome = vi.fn();

    const outcomes = await stopListenerMatches(
      {validateListener, stopListener},
      [first, firstAlias, second],
      'SIGKILL',
      onOutcome,
    );

    expect(validateListener.mock.calls.map(([entry]) => entry.pid)).toEqual([101, 102]);
    expect(stopListener.mock.calls.map(([entry]) => entry.pid)).toEqual([101]);
    expect(outcomes).toEqual([{message: 'Stopped 101', pid: 101, pgid: 9_000}]);
    expect(onOutcome).toHaveBeenCalledOnce();
  });

  it('processes every distinct PID after group fallback and preserves warnings for output', async () => {
    const first = listener({pid: 101, pgid: 9_000, collectorPgid: 8_000});
    const firstAlias = listener({...first, host: '::1', listenerHosts: ['::1']});
    const second = listener({pid: 102, ppid: 101, pgid: 9_000, collectorPgid: 8_000});
    const validateListener = vi.fn(async (entry: ListenerEntry) => entry);
    const order: string[] = [];
    const stopListener = vi.fn(async (entry: ListenerEntry, _signal: StopSignal) => {
      order.push(`stop:${entry.pid}`);
      return {
        message: `Stopped PID ${entry.pid}`,
        warning: `Group verification failed for PID ${entry.pid}`,
        pid: entry.pid,
      };
    });
    const onOutcome = vi.fn((outcome: {pid?: number}) => {
      order.push(`outcome:${outcome.pid}`);
    });

    const outcomes = await stopListenerMatches(
      {validateListener, stopListener},
      [first, firstAlias, second],
      'SIGTERM',
      onOutcome,
    );

    expect(stopListener.mock.calls.map(([entry]) => entry.pid)).toEqual([101, 102]);
    expect(onOutcome).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['stop:101', 'outcome:101', 'stop:102', 'outcome:102']);
    expect(formatActionOutcomes(outcomes)).toEqual({
      stdout: 'Stopped PID 101\nStopped PID 102',
      stderr: 'Warning: Group verification failed for PID 101\nWarning: Group verification failed for PID 102',
    });
  });

  it('prints successful messages separately from only the outcomes that have warnings', () => {
    expect(formatActionOutcomes([
      {message: 'Stopped alpha', pid: 101},
      {message: 'Stopped bravo', warning: 'PID-only fallback', pid: 102},
    ])).toEqual({
      stdout: 'Stopped alpha\nStopped bravo',
      stderr: 'Warning: PID-only fallback',
    });
  });
});
