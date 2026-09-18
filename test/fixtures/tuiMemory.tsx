import {EventEmitter} from 'node:events';
import {performance} from 'node:perf_hooks';
import {setImmediate} from 'node:timers/promises';

import {render} from 'ink';
import React from 'react';

import type {ConfigRepository, PortwardenConfig} from '../../src/config.js';
import {PortwardenApp} from '../../src/tui/App.js';
import {advanceScanner} from './tuiMemoryScanner.js';

// Unlike ink-testing-library, these streams do not retain historical frames.
class Output extends EventEmitter {
  columns = 160;
  rows = 45;
  isTTY = true;
  frameCount = 0;
  lastFrame = '';

  write(frame: string): boolean {
    this.frameCount += 1;
    this.lastFrame = frame;
    return true;
  }
}

class Input extends EventEmitter {
  isTTY = true;
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read() { return null; }
}

const config: PortwardenConfig = {
  browser: '',
  confirmActions: false,
  pinnedListenerKeys: [],
  orderedEntryKeys: [],
  graveyard: [],
  refreshSeconds: 2,
};
const repository = {
  path: '/tmp/portwarden-unused-memory-fixture-config.json',
  get: () => structuredClone(config),
} as ConfigRepository;
const stdout = new Output();
const stderr = new Output();
const samples: Array<{iteration: number; heapBytes: number; measures: number}> = [];

function sample(iteration: number): void {
  if (!global.gc) throw new Error('Memory fixture requires --expose-gc.');
  global.gc();
  const heapBytes = process.memoryUsage().heapUsed;
  samples.push({iteration, heapBytes, measures: performance.getEntriesByType('measure').length});
  // Fail a leaking build before it can exhaust the host or the child heap cap.
  if (heapBytes > 128 * 1024 * 1024) {
    throw new Error(`TUI retained more than 128 MiB: ${JSON.stringify(samples)}`);
  }
}

advanceScanner(0);
const app = render(<PortwardenApp configRepository={repository} />, {
  stdout: stdout as unknown as NodeJS.WriteStream,
  stderr: stderr as unknown as NodeJS.WriteStream,
  stdin: new Input() as unknown as NodeJS.ReadStream,
  patchConsole: false,
  exitOnCtrlC: false,
  // Render every accelerated update, so frame throttling cannot hide cache growth.
  debug: true,
});

try {
  await setImmediate();
  await setImmediate();
  if (!stdout.lastFrame.includes('project0')) throw new Error('The real TUI did not render its fixture rows.');
  sample(0);
  for (let iteration = 1; iteration <= 6000; iteration += 1) {
    advanceScanner(iteration);
    app.rerender(<PortwardenApp configRepository={repository} />);
    await setImmediate();
    if (iteration % 1000 === 0) sample(iteration);
  }
  process.stdout.write(`${JSON.stringify({
    samples,
    frameCount: stdout.frameCount,
    nodeEnv: Reflect.get(process.env, 'NODE_ENV'),
    dev: Reflect.get(process.env, 'DEV'),
  })}\n`);
} finally {
  app.unmount();
  app.cleanup();
}
