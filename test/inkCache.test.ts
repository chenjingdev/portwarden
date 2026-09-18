import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';

import {expect, it} from 'vitest';

const execFileAsync = promisify(execFile);
const inkEntry = pathToFileURL(createRequire(import.meta.url).resolve('ink'));

it('keeps Ink text caches bounded as dashboard text changes', async () => {
  // Exercise the installed dependency in a fresh process, without React or the
  // test runner retaining frames. Forced GC distinguishes live caches from churn.
  const script = `
    import measure from ${JSON.stringify(new URL('./measure-text.js', inkEntry).href)};
    import wrap from ${JSON.stringify(new URL('./wrap-text.js', inkEntry).href)};

    function exercise(start, count, length) {
      for (let index = start; index < start + count; index += 1) {
        const text = ('age ' + index + ' ').padEnd(length, 'x');
        measure(text);
        wrap(text, 80, 'truncate-end');
      }
    }
    async function retainedHeap() {
      await new Promise(resolve => setImmediate(resolve));
      global.gc();
      global.gc();
      return process.memoryUsage().heapUsed;
    }

    exercise(0, 5000, 512);
    const warmed = await retainedHeap();
    exercise(5000, 20000, 512);
    const afterUpdates = await retainedHeap();
    // A count limit alone can still retain large process commands. Those must
    // bypass both caches, while preserving measurement/truncation behavior.
    exercise(25000, 3000, 8192);
    const afterLongText = await retainedHeap();
    const output = {
      warmed,
      afterUpdates,
      afterLongText,
      dimensions: measure('\\u001B[31m한글\\u001B[0m\\nab'),
      empty: measure(''),
      wrapped: wrap('abcdef', 3, 'wrap'),
      truncated: wrap('abcdef', 3, 'truncate-end'),
      truncatedStart: wrap('abcdef', 3, 'truncate-start'),
      truncatedMiddle: wrap('abcdef', 3, 'truncate-middle'),
      longDimensions: measure('x'.repeat(8192)),
      longTruncated: wrap('x'.repeat(8192), 3, 'truncate-end'),
    };
    console.log(JSON.stringify(output));
  `;
  const {stdout} = await execFileAsync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], {
    timeout: 45_000,
  });
  const result = JSON.parse(stdout) as {
    warmed: number;
    afterUpdates: number;
    afterLongText: number;
    dimensions: {width: number; height: number};
    empty: {width: number; height: number};
    wrapped: string;
    truncated: string;
    truncatedStart: string;
    truncatedMiddle: string;
    longDimensions: {width: number; height: number};
    longTruncated: string;
  };
  // The original unbounded caches retain tens of MiB in each workload. Leave
  // ample room for JIT/runtime differences while detecting sustained retention.
  expect(result.afterUpdates - result.warmed).toBeLessThan(4 * 1024 ** 2);
  expect(result.afterLongText - result.afterUpdates).toBeLessThan(4 * 1024 ** 2);
  expect(result.dimensions).toEqual({width: 4, height: 2});
  expect(result.empty).toEqual({width: 0, height: 0});
  expect(result.wrapped).toBe('abc\ndef');
  expect(result.truncated).toBe('ab…');
  expect(result.truncatedStart).toBe('…ef');
  expect(result.truncatedMiddle).toBe('a…f');
  expect(result.longDimensions).toEqual({width: 8192, height: 1});
  expect(result.longTruncated).toBe('xx…');
}, 50_000);
