import {describe, expect, it} from 'vitest';

import {
  canonicalHost,
  classifyListener,
  collapseEquivalentListeners,
  collectListeners,
  getEntryPreferenceKey,
  getProjectName,
  listenerKey,
  matchesKeyword,
  parseEndpoint,
  parseLsofCwds,
  parseLsofListeners,
  parseLsofProcessMetadata,
  parsePsProcessTable,
  selectListeners,
  sortListeners,
} from '../src/core/listeners.js';
import type {ListenerEntry} from '../src/core/types.js';

function entry(overrides: Partial<ListenerEntry> = {}): ListenerEntry {
  return {
    pid: 1000,
    ppid: 1,
    port: 3000,
    host: '127.0.0.1',
    listenerHosts: ['127.0.0.1'],
    displayHost: 'localhost',
    command: 'node',
    args: 'pnpm dev --port 3000',
    cwd: '/Users/test/dev/sample',
    elapsed: '00:01:00',
    kind: 'dev',
    appFamily: '',
    projectName: 'sample',
    displayProject: 'sample',
    displayCommand: 'pnpm dev --port 3000',
    displayCwd: '~/dev/sample',
    ...overrides,
  };
}

describe('lsof parsing and enrichment', () => {
  it('parses macOS and Linux field output, IPv4 and IPv6 endpoints', () => {
    const raw = [
      'p101',
      'cnode',
      'n127.0.0.1:3000',
      'n[::1]:3000',
      'p202',
      'cpython3',
      'n*:8000',
      '',
    ].join('\n');

    expect(parseLsofListeners(raw)).toEqual([
      {pid: 101, command: 'node', endpoint: '127.0.0.1:3000'},
      {pid: 101, command: 'node', endpoint: '[::1]:3000'},
      {pid: 202, command: 'python3', endpoint: '*:8000'},
    ]);
    expect(parseEndpoint('[fe80::1%lo0]:4173')).toEqual({host: 'fe80::1%lo0', port: 4173});
    expect(parseEndpoint('TCP 0.0.0.0:65536 (LISTEN)')).toBeNull();
  });

  it('parses cwd records without retaining a stale invalid pid', () => {
    expect(parseLsofCwds('p10\nn/tmp/a\npbad\nn/tmp/wrong\np11\nn/tmp/b\n')).toEqual(
      new Map([[10, '/tmp/a'], [11, '/tmp/b']]),
    );
  });

  it('parses cwd and the first lsof text executable without accepting later mappings', () => {
    expect(parseLsofProcessMetadata([
      'p101',
      'fcwd',
      'n/Users/test/dev/alpha',
      'ftxt',
      'n/opt/homebrew/bin/node',
      'ftxt',
      'n/usr/lib/dyld',
      'ftxt',
      'n/Users/test/dev/alpha/node_modules/@next/swc-darwin-arm64/next-swc.darwin-arm64.node',
      'pbad',
      'fcwd',
      'n/tmp/wrong-cwd',
      'ftxt',
      'n/tmp/wrong-executable',
      'p202',
      'ftxt',
      'n/usr/bin/python3',
      'fcwd',
      'n/Users/test/dev/beta',
      '',
    ].join('\0\n'))).toEqual(new Map([
      [101, {cwd: '/Users/test/dev/alpha', executable: '/opt/homebrew/bin/node'}],
      [202, {cwd: '/Users/test/dev/beta', executable: '/usr/bin/python3'}],
    ]));
  });

  it('preserves root and user UIDs from the ps process-group inventory', () => {
    expect(parsePsProcessTable([
      '    1     0     1     0',
      '   99     1    99    -2',
      '  501     1   500   501',
      '',
    ].join('\n'))).toEqual([
      {pid: 1, ppid: 0, pgid: 1, uid: 0},
      {pid: 99, ppid: 1, pgid: 99, uid: -2},
      {pid: 501, ppid: 1, pgid: 500, uid: 501},
    ]);
  });

  it.each([
    '101 1 100',
    '101 1 100 501 trailing',
    '101 -1 100 501',
    '0 0 1 0',
    '101 1 0 501',
    '9007199254740992 1 100 501',
  ])('rejects a malformed ps process-group row: %s', (raw) => {
    expect(() => parsePsProcessTable(raw)).toThrow();
  });

  it('runs process and cwd discovery asynchronously and collapses aliases', async () => {
    const calls: string[] = [];
    const result = await collectListeners({
      home: '/Users/test',
      now: new Date('2026-08-27T00:02:00.000Z'),
      runCommand: async (_file, args) => {
        calls.push(args.join(' '));
        if (args.includes('-iTCP')) {
          return {
            exitCode: 0,
            stdout: 'p101\ncnode\nn127.0.0.1:3000\nn[::1]:3000\n',
          };
        }
        await Promise.resolve();
        return {exitCode: 0, stdout: 'p101\nfcwd\nn/Users/test/dev/alpha\n'};
      },
      processProvider: async () => {
        await Promise.resolve();
        return [{
          pid: 101,
          ppid: 1,
          name: 'node',
          command: 'node node_modules/vite/bin/vite.js --port 3000',
          executable: '/opt/homebrew/bin/node',
          startTime: new Date('2026-08-27T00:00:00.000Z'),
        }];
      },
    });

    expect(calls).toHaveLength(2);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      pid: 101,
      port: 3000,
      host: '127.0.0.1',
      listenerHosts: ['127.0.0.1', '::1'],
      displayHost: 'localhost',
      kind: 'dev',
      projectName: 'alpha',
      elapsed: '00:02:00',
    });
  });

  it('uses the first lsof text file when ps cannot resolve a titled Next executable', async () => {
    const calls: string[] = [];
    const startedAt = new Date('2026-08-27T00:00:00.000Z');
    const result = await collectListeners({
      home: '/Users/test',
      now: new Date('2026-08-27T00:02:00.000Z'),
      runCommand: async (_file, args) => {
        calls.push(args.join(' '));
        if (args.includes('-iTCP')) {
          return {
            exitCode: 0,
            stdout: 'p101\ncnode\nn*:3000\np202\ncnode\nn*:3001\n',
          };
        }
        return {
          exitCode: 0,
          stdout: [
            'p101',
            'fcwd',
            'n/Users/test/dev/alpha',
            'ftxt',
            'n/opt/homebrew/bin/node',
            'ftxt',
            'n/usr/lib/dyld',
            'ftxt',
            'n/Users/test/dev/alpha/node_modules/@next/swc-darwin-arm64/next-swc.darwin-arm64.node',
            'p202',
            'fcwd',
            'n/Users/test/dev/beta',
            'ftxt',
            'n/opt/homebrew/bin/node-from-lsof',
            '',
          ].join('\n'),
        };
      },
      processProvider: async () => [
        {
          pid: 101,
          ppid: 1,
          uid: 501,
          name: 'next-server (v15.1.4)',
          command: 'next-server (v15.1.4)',
          executable: '',
          startTime: startedAt,
        },
        {
          pid: 202,
          ppid: 1,
          uid: 501,
          name: 'node',
          command: 'node server.js',
          executable: '/custom/node',
          startTime: startedAt,
        },
      ],
    });

    expect(calls.some((call) => call.includes('-d cwd,txt') && call.includes('-F0fgpnu'))).toBe(true);
    expect(result.find(({pid}) => pid === 101)).toMatchObject({
      args: 'next-server (v15.1.4)',
      cwd: '/Users/test/dev/alpha',
      executable: '/opt/homebrew/bin/node',
      uid: 501,
      startTime: startedAt,
    });
    expect(result.find(({pid}) => pid === 202)).toMatchObject({
      executable: '/custom/node',
    });
  });

  it('degrades to an empty list by default but surfaces lsof failures in strict mode', async () => {
    const runCommand = async () => ({exitCode: 2, stdout: '', stderr: 'permission denied'});
    await expect(collectListeners({runCommand})).resolves.toEqual([]);
    await expect(collectListeners({strict: true, runCommand})).rejects.toThrow('permission denied');
  });
});

describe('classification and identity', () => {
  it('uses token boundaries for dev keywords', () => {
    expect(matchesKeyword('/Applications/Reserve.app/Contents/Resources/main.js', 'serve')).toBe(false);
    expect(matchesKeyword('node ./serve/index.js', 'serve')).toBe(true);
    expect(classifyListener({
      command: 'Reserve Helper',
      args: '/Applications/Reserve.app/Contents/Resources/main.js',
      cwd: '/',
      appFamily: 'Reserve',
      port: 64321,
      home: '/Users/test',
    })).toBe('app');
    expect(classifyListener({
      command: 'ollama',
      args: '/Applications/Ollama.app/Contents/Resources/ollama serve',
      cwd: '/',
      appFamily: 'Ollama',
      port: 11434,
      home: '/Users/test',
    })).toBe('app');
  });

  it('classifies project runtimes as dev and unrelated daemons as system', () => {
    expect(classifyListener({
      command: 'node',
      cwd: '/Users/test/dev/alpha',
      port: 7000,
      home: '/Users/test',
    })).toBe('dev');
    expect(classifyListener({command: 'postgres', cwd: '/opt/postgres', port: 5432})).toBe('system');
  });

  it('does not treat an ancillary Application Support argument as the process app identity', () => {
    expect(classifyListener({
      command: 'python3.12',
      executable: '/Users/test/ComfyUI/.venv/bin/python3',
      args: '/Users/test/ComfyUI/.venv/bin/python3 ComfyUI/main.py --extra-model-paths-config /Users/test/Library/Application Support/Comfy Desktop/models.yaml',
      cwd: '/Users/test/ComfyUI-Installs/ComfyUI',
      port: 8000,
      home: '/Users/test',
    })).toBe('dev');
  });

  it('keeps pnpm dlx package inference from the original implementation', () => {
    expect(getProjectName({
      cwd: '/',
      command: 'node',
      args: 'node /Users/test/Library/Caches/pnpm/dlx/hash/node_modules/.pnpm/@playwright+mcp@0.0.70/node_modules/@playwright/mcp/cli.js --port 53188',
      home: '/Users/test',
    })).toBe('@playwright/mcp');
  });
});

describe('host collapsing, keys, selection, and sorting', () => {
  it('collapses loopback and wildcard aliases while preserving pin-compatible hosts', () => {
    const collapsed = collapseEquivalentListeners([
      entry({pid: 1, port: 3000, host: '127.0.0.1', listenerHosts: ['127.0.0.1']}),
      entry({pid: 1, port: 3000, host: '::1', listenerHosts: ['::1']}),
      entry({pid: 2, port: 4000, host: '*', listenerHosts: ['*']}),
      entry({pid: 2, port: 4000, host: '0.0.0.0', listenerHosts: ['0.0.0.0']}),
    ]);

    expect(collapsed).toHaveLength(2);
    expect(collapsed[0]?.listenerHosts).toEqual(['127.0.0.1', '::1']);
    expect(collapsed[1]?.listenerHosts).toEqual(['*', '0.0.0.0']);
    expect(canonicalHost('::1')).toBe('localhost');
    expect(canonicalHost('0:0:0:0:0:0:0:0')).toBe('all');
  });

  it('selects a collapsed non-dev listener through any saved host alias', () => {
    const merged = collapseEquivalentListeners([
      entry({kind: 'system', host: '127.0.0.1', listenerHosts: ['127.0.0.1']}),
      entry({kind: 'system', host: '::1', listenerHosts: ['::1']}),
    ])[0];
    expect(merged).toBeDefined();
    expect(selectListeners([merged!], {
      all: false,
      pinnedListenerKeys: [listenerKey('::1', 3000)],
    })).toEqual([merged]);
  });

  it('shows service-like app listeners by default without exposing ordinary app helpers', () => {
    const dev = entry({pid: 1, port: 3000});
    const ollamaService = entry({
      pid: 2,
      port: 11434,
      kind: 'app',
      appFamily: 'Ollama',
      command: 'ollama',
      args: '/Applications/Ollama.app/Contents/Resources/ollama serve',
      cwd: '/',
    });
    const ollamaApp = entry({
      pid: 3,
      port: 49880,
      kind: 'app',
      appFamily: 'Ollama',
      command: 'Ollama',
      args: '/Applications/Ollama.app/Contents/MacOS/Ollama',
      cwd: '/',
    });

    expect(selectListeners([ollamaApp, ollamaService, dev], {all: false}).map(({pid}) => pid)).toEqual([1, 2]);
  });

  it('normalizes mutable ports in preference keys', () => {
    expect(getEntryPreferenceKey(entry({port: 3000, args: 'pnpm dev --port 3000'}))).toBe(
      getEntryPreferenceKey(entry({port: 4173, args: 'pnpm dev --port 4173'})),
    );
  });

  it('sorts deterministically without mutating input and honors pin/order keys', () => {
    const alpha = entry({pid: 3, port: 3002, displayProject: 'alpha', projectName: 'alpha'});
    const beta = entry({pid: 2, port: 3001, displayProject: 'beta', projectName: 'beta'});
    const system = entry({pid: 1, port: 5432, kind: 'system', displayProject: 'postgres', projectName: 'postgres'});
    const input = [system, beta, alpha];
    const sorted = sortListeners(input, {
      pinnedListenerKeys: [listenerKey(system)],
      orderedEntryKeys: [listenerKey(system), listenerKey(alpha), listenerKey(beta)],
    });

    expect(input).toEqual([system, beta, alpha]);
    expect(sorted.map(({pid}) => pid)).toEqual([1, 3, 2]);
  });

  it('preserves a saved listener order after processes restart with new PIDs', () => {
    const before = [
      entry({pid: 100, port: 3001, displayProject: 'alpha'}),
      entry({pid: 200, port: 3002, displayProject: 'beta'}),
    ];
    const savedOrder = [listenerKey(before[1]!), listenerKey(before[0]!)];
    const restarted = [
      entry({pid: 101, port: 3001, displayProject: 'alpha'}),
      entry({pid: 201, port: 3002, displayProject: 'beta'}),
    ];

    expect(sortListeners(restarted, {orderedEntryKeys: savedOrder}).map(({port}) => port)).toEqual([3002, 3001]);
  });
});
