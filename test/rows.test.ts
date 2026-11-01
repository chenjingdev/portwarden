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
  it('keeps the whole PID scope visible when only a hidden sibling port matches the filter', () => {
    const first = listener({pid: 101, port: 3000});
    const second = listener({pid: 101, port: 9222, kind: 'system'});
    const rows = buildVisibleRows([first], [], {
      all: false, expandedGroups: new Set(), pinnedListenerKeys: [],
      allListeners: [first, second], query: '9222',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({type: 'process', members: [first, second]});
  });

  it('does not merge separate PID stop scopes just because they share a PGID', () => {
    const rows = buildVisibleRows([
      listener({pid: 101, pgid: 9000}), listener({pid: 102, pgid: 9000}),
    ], [], {all: false, expandedGroups: new Set(), pinnedListenerKeys: []});
    expect(rows.map(({type}) => type)).toEqual(['listener', 'listener']);
  });

  it('collapses separately started servers from one project folder into one row, pinned or not', () => {
    const root = '/Users/test/dev/honcho';
    const dashboard = listener({pid: 201, port: 4173, projectRoot: root, displayProject: 'honcho'});
    const other = listener({pid: 202, port: 8790, projectRoot: '/Users/test/dev/intent-router', displayProject: 'intent-router'});
    const bridge = listener({pid: 203, port: 8766, projectRoot: root, displayProject: 'honcho'});
    const options = {all: false, pinnedListenerKeys: [`host:${dashboard.host}::port:${dashboard.port}`]};
    const collapsed = buildVisibleRows([dashboard, other, bridge], [], {...options, expandedGroups: new Set()});
    expect(collapsed).toMatchObject([
      {type: 'project', key: `project:${root}`, family: 'honcho', root, members: [dashboard, bridge], expanded: false},
      {type: 'listener', listener: other},
    ]);
    const expanded = buildVisibleRows([dashboard, other, bridge], [], {...options, expandedGroups: new Set([`project:${root}`])});
    expect(expanded.map((row) => [row.type, row.depth])).toEqual([['project', 0], ['listener', 1], ['listener', 1], ['listener', 0]]);
    expect(expanded[2]).toMatchObject({listener: bridge, parentGroupKey: `project:${root}`});
  });

  it('keeps a lone process, app helpers, and unrelated folders out of project groups', () => {
    const root = '/Users/test/dev/sample';
    const rowTypes = (entries: ListenerEntry[]) => buildVisibleRows(entries, [], {
      all: false, expandedGroups: new Set(), pinnedListenerKeys: [],
    }).map(({type}) => type);
    expect(rowTypes([listener({pid: 301, port: 3000, projectRoot: root}), listener({pid: 301, port: 3001, projectRoot: root})])).toEqual(['process']);
    expect(rowTypes([
      listener({pid: 302, port: 5001, kind: 'app', appFamily: 'Ollama', projectRoot: root}),
      listener({pid: 303, port: 5002, kind: 'app', appFamily: 'Ollama', projectRoot: root}),
    ])).toEqual(['listener', 'listener']);
    expect(rowTypes([listener({pid: 304, port: 3002}), listener({pid: 305, port: 3003})])).toEqual(['listener', 'listener']);
    expect(rowTypes([
      listener({pid: 306, port: 3004, projectRoot: '/Users/test/dev/api', displayProject: 'api'}),
      listener({pid: 307, port: 3005, projectRoot: '/Users/test/work/api', displayProject: 'api'}),
    ])).toEqual(['listener', 'listener']);
  });

  it('nests a multi-port process inside an expanded project group', () => {
    const root = '/Users/test/dev/sample';
    const api = [listener({pid: 401, port: 3000, projectRoot: root}), listener({pid: 401, port: 3001, projectRoot: root})];
    const web = listener({pid: 402, port: 5173, projectRoot: root});
    const rows = buildVisibleRows([...api, web], [], {
      all: false, pinnedListenerKeys: [], expandedGroups: new Set([`project:${root}`, 'process:401:']),
    });
    expect(rows.map((row) => [row.type, row.depth])).toEqual([
      ['project', 0], ['process', 1], ['listener', 2], ['listener', 2], ['listener', 1],
    ]);
    expect(rows[0]).toMatchObject({members: [...api, web]});
    expect(rows[1]).toMatchObject({key: 'process:401:', parentGroupKey: `project:${root}`});
    expect(rows[2]).toMatchObject({parentGroupKey: 'process:401:'});
  });

  it('lets a filter narrow a project group down to the matching process', () => {
    const root = '/Users/test/dev/honcho';
    const rows = buildVisibleRows([
      listener({pid: 501, port: 4173, projectRoot: root, args: 'node local-dashboard/server.mjs'}),
      listener({pid: 502, port: 8766, projectRoot: root, args: 'python local-mcp-bridge/server.py'}),
    ], [], {all: false, expandedGroups: new Set(), pinnedListenerKeys: [], query: 'mcp-bridge'});
    expect(rows).toMatchObject([{type: 'listener', listener: {pid: 502}}]);
  });

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
