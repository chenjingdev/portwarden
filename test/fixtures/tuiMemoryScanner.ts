import type {ListenerEntry} from '../../src/core/types.js';
import type {ScannerSnapshot} from '../../src/tui/useScanner.js';

let snapshot: ScannerSnapshot & {refresh: () => void};

export function advanceScanner(seconds: number): void {
  const elapsed = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
  const listeners: ListenerEntry[] = Array.from({length: 25}, (_, index) => ({
    pid: 900_000 + index,
    ppid: 1,
    port: 9000 + index,
    host: '127.0.0.1',
    listenerHosts: ['127.0.0.1'],
    displayHost: '127.0.0.1',
    command: 'node',
    args: `node /tmp/portwarden-memory-fixture/app${index}.js`,
    cwd: '/tmp/portwarden-memory-fixture',
    elapsed,
    kind: 'dev',
    appFamily: '',
    projectName: `project${index}`,
    displayProject: `project${index}`,
    displayCommand: `node app${index}.js`,
    displayCwd: '/tmp/portwarden-memory-fixture',
  }));
  snapshot = {
    allListeners: listeners,
    listeners,
    zombies: [],
    browsers: [],
    loading: false,
    refreshing: false,
    error: '',
    updatedAt: new Date(Date.UTC(2026, 0, 1) + seconds * 1000),
    refresh() {},
  };
}

export function useScanner() {
  return snapshot;
}
