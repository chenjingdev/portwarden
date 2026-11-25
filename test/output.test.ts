import {describe, expect, it} from 'vitest';

import type {ListenerEntry} from '../src/core/types.js';
import {renderOutput} from '../src/output.js';

describe('renderOutput', () => {
  it('renders a compact table that fits a narrow terminal', () => {
    const output = renderOutput([listener()], 1, [], {
      all: true,
      json: false,
      terminalWidth: 40,
    });
    const header = output.split('\n').find((line) => line.includes('PORT')) ?? '';
    expect(header).toContain('PID');
    expect(header).toContain('PROJECT');
    expect(header).not.toContain('KIND');
    expect(header.length).toBeLessThanOrEqual(40);
  });

  it('emits one compact JSON value when jsonLines is enabled', () => {
    const output = renderOutput([listener()], 1, [], {
      all: true,
      json: true,
      jsonLines: true,
    });
    expect(output).not.toContain('\n');
    expect(JSON.parse(output)).toHaveLength(1);
  });

  it('adds the launcher and leftover to JSON listeners and a BY column to the wide table', () => {
    const entry = {
      ...listener(),
      launcher: {sessionId: '00000000-0000-4000-8000-000000000000', terminal: 't1yw', name: 'old-tab', state: 'ended' as const},
      leftover: true,
    };
    const [json] = JSON.parse(renderOutput([entry], 1, [], {all: true, json: true})) as Array<Record<string, unknown>>;
    expect(json).toMatchObject({launcher: entry.launcher, leftover: true});
    const [plain] = JSON.parse(renderOutput([listener()], 1, [], {all: true, json: true})) as Array<Record<string, unknown>>;
    expect(plain).toMatchObject({leftover: false});
    expect(plain).not.toHaveProperty('launcher');
    const wide = renderOutput([entry], 1, [], {all: true, json: false, terminalWidth: 160});
    expect(wide).toMatch(/PROJECT\s+BY\s+PROCESS/);
    expect(wide).toContain('t1yw✗ old-tab');
  });
});

function listener(): ListenerEntry {
  return {
    pid: 123,
    ppid: 1,
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
    displayCommand: 'node vite --port 3000',
    displayCwd: '/tmp/project',
  };
}
