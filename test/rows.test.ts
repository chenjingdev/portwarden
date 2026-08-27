import {describe, expect, it} from 'vitest';

import type {ListenerEntry, ZombieCandidate} from '../src/core/types.js';
import {buildVisibleRows} from '../src/tui/rows.js';

function listener(overrides: Partial<ListenerEntry>): ListenerEntry {
  return {
    pid: 1,
    ppid: 0,
    port: 3000,
    host: '127.0.0.1',
    listenerHosts: ['127.0.0.1'],
    displayHost: 'localhost',
    command: 'node',
    args: 'node vite',
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

describe('buildVisibleRows', () => {
  it('groups app helpers only in all scope and expands them by stable group key', () => {
    const entries = [
      listener({pid: 10, port: 5001, kind: 'app', appFamily: 'Ollama'}),
      listener({pid: 11, port: 5002, kind: 'app', appFamily: 'Ollama'}),
    ];
    const collapsed = buildVisibleRows(entries, [], {all: true, expandedGroups: new Set(), pinnedListenerKeys: []});
    const expanded = buildVisibleRows(entries, [], {
      all: true,
      expandedGroups: new Set(['group:regular:ollama']),
      pinnedListenerKeys: [],
    });
    expect(collapsed.map(({type}) => type)).toEqual(['group']);
    expect(expanded.map(({type}) => type)).toEqual(['group', 'listener', 'listener']);
  });

  it('keeps ordinary and pinned rows in place and moves collapsed app groups to the bottom', () => {
    const entries = [
      listener({pid: 1, port: 3000, kind: 'dev', displayProject: 'alpha'}),
      listener({pid: 10, port: 5001, kind: 'app', appFamily: 'Ollama'}),
      listener({pid: 11, port: 5002, kind: 'app', appFamily: 'Ollama'}),
      listener({pid: 20, port: 9000, kind: 'system', displayProject: 'omega'}),
    ];
    const rows = buildVisibleRows(entries, [], {
      all: true,
      expandedGroups: new Set(),
      pinnedListenerKeys: [],
    });
    expect(rows.map(({type}) => type)).toEqual(['listener', 'listener', 'group']);
  });

  it('keeps pinned app listeners individually selectable instead of collapsing them into a group', () => {
    const pinned = listener({pid: 9, port: 4999, kind: 'app', appFamily: 'Ollama'});
    const entries = [
      pinned,
      listener({pid: 10, port: 5001, kind: 'app', appFamily: 'Ollama'}),
      listener({pid: 11, port: 5002, kind: 'app', appFamily: 'Ollama'}),
    ];
    const rows = buildVisibleRows(entries, [], {
      all: true,
      expandedGroups: new Set(),
      pinnedListenerKeys: [`host:${pinned.host}::port:${pinned.port}`],
    });

    expect(rows.map(({type}) => type)).toEqual(['listener', 'group']);
    expect(rows[0]).toMatchObject({type: 'listener', listener: pinned});
  });

  it('filters by project or port and expands matching groups for discoverability', () => {
    const entries = [
      listener({pid: 10, port: 5001, kind: 'app', appFamily: 'Ollama', displayProject: 'Ollama'}),
      listener({pid: 11, port: 5002, kind: 'app', appFamily: 'Ollama', displayProject: 'Ollama'}),
    ];
    const rows = buildVisibleRows(entries, [], {
      all: true,
      expandedGroups: new Set(),
      pinnedListenerKeys: [],
      query: '5002',
    });
    expect(rows.map(({type}) => type)).toEqual(['listener']);
  });

  it('keeps zombies after listeners', () => {
    const zombie = {
      pid: 99,
      ppid: 1,
      name: 'chrome',
      command: 'chrome --headless --remote-debugging-pipe',
      executable: 'chrome',
      family: 'headless-chrome',
      ageMs: 120_000,
      ageSeconds: 120,
      reapable: true,
      reason: 'orphan',
    } satisfies ZombieCandidate;
    const rows = buildVisibleRows([listener({})], [zombie], {
      all: false,
      expandedGroups: new Set(),
      pinnedListenerKeys: [],
    });
    expect(rows.map(({type}) => type)).toEqual(['listener', 'zombie']);
  });
});
