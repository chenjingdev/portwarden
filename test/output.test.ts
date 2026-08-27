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
