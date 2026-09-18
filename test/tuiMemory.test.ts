import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {execa} from 'execa';
import {build} from 'tsup';
import {expect, it} from 'vitest';

import buildConfig from '../tsup.config';

const PROJECT_DIRECTORY = fileURLToPath(new URL('..', import.meta.url));

it('keeps the shipped TUI heap bounded across 6000 changing process snapshots', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portwarden-tui-memory-'));
  try {
    const options = typeof buildConfig === 'function' ? await buildConfig({}) : buildConfig;
    if (Array.isArray(options)) throw new Error('Expected one Portwarden build configuration.');
    fs.symlinkSync(path.join(PROJECT_DIRECTORY, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
    fs.copyFileSync(path.join(PROJECT_DIRECTORY, 'package.json'), path.join(directory, 'package.json'));
    const outDir = path.join(directory, 'dist');
    await build({
      ...options,
      config: false,
      entry: {'tui-memory': path.join(PROJECT_DIRECTORY, 'test', 'fixtures', 'tuiMemory.tsx')},
      outDir,
      outExtension: () => ({js: '.mjs'}),
      sourcemap: false,
      dts: false,
      silent: true,
      esbuildPlugins: [
        ...(options.esbuildPlugins ?? []),
        {
          name: 'synthetic-process-snapshots',
          setup(builder) {
            // Replace scanning only; exercise the real App, Ink, and React build.
            builder.onResolve({filter: /[/\\]useScanner\.js$/}, () => ({
              path: path.join(PROJECT_DIRECTORY, 'test', 'fixtures', 'tuiMemoryScanner.ts'),
            }));
          },
        },
      ],
    });
    const {stdout} = await execa(process.execPath, [
      '--expose-gc',
      '--max-old-space-size=256',
      path.join(outDir, 'tui-memory.mjs'),
    ], {
      cwd: PROJECT_DIRECTORY,
      env: {NODE_ENV: 'development', DEV: 'true', NO_COLOR: '1'},
      timeout: 60_000,
    });
    const result = JSON.parse(stdout) as {
      samples: Array<{iteration: number; heapBytes: number; measures: number}>;
      frameCount: number;
      nodeEnv: string;
      dev: string;
    };
    expect(result.frameCount).toBeGreaterThanOrEqual(6000);
    expect(result.samples.map(({iteration}) => iteration)).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000]);
    expect(result.samples.every(({measures}) => measures === 0), JSON.stringify(result.samples)).toBe(true);
    const warmHeap = result.samples[1]!.heapBytes;
    const maximumLaterHeap = Math.max(...result.samples.slice(2).map(({heapBytes}) => heapBytes));
    expect(maximumLaterHeap - warmHeap, JSON.stringify(result.samples)).toBeLessThan(8 * 1024 * 1024);
    // Bundling production React must leave development environments intact.
    expect(result.nodeEnv).toBe('development');
    expect(result.dev).toBe('true');
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
}, 90_000);
