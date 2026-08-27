import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {execa, type ResultPromise} from 'execa';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import packageMetadata from '../package.json';

const PROJECT_DIRECTORY = fileURLToPath(new URL('..', import.meta.url));
const TSX = path.join(PROJECT_DIRECTORY, 'node_modules', '.bin', 'tsx');
const CLI = path.join(PROJECT_DIRECTORY, 'src', 'cli.tsx');

let configHome = '';

beforeEach(() => {
  configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'portwarden-cli-'));
});

afterEach(() => {
  fs.rmSync(configHome, {recursive: true, force: true});
});

describe('portwarden CLI', () => {
  it('uses the package version as its single source of truth', async () => {
    const result = await run(['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(packageMetadata.version);
  });

  it('rejects partially numeric values and meaningless action combinations', async () => {
    const invalidPort = await run(['--next-port', '3000abc']);
    expect(invalidPort.exitCode).toBe(1);
    expect(invalidPort.stderr).toContain('Expected a positive integer');

    const invalidCombination = await run(['--reap', '--json']);
    expect(invalidCombination.exitCode).toBe(1);
    expect(invalidCombination.stderr).toContain('Headless actions cannot be combined');
  });

  it('finds the next port even when the unrelated config file is corrupt', async () => {
    const directory = path.join(configHome, 'portwarden');
    fs.mkdirSync(directory, {recursive: true});
    fs.writeFileSync(path.join(directory, 'config.json'), '{broken', 'utf8');

    const result = await run(['--next-port', '45000']);
    expect(result.exitCode).toBe(0);
    expect(Number(result.stdout.trim())).toBeGreaterThan(45_000);
  });

  it('streams parseable NDJSON snapshots and interrupts a long wait promptly', async () => {
    const subprocess = spawn(['--all', '--json', '--watch', '10']);
    try {
      const lines = await waitForLines(subprocess, 1);
      expect(JSON.parse(lines[0]!)).toBeInstanceOf(Array);
      const signaledAt = Date.now();
      subprocess.kill('SIGINT');
      const result = await subprocess;
      expect(result.exitCode).toBe(0);
      expect(Date.now() - signaledAt).toBeLessThan(1_000);
    } finally {
      if (!subprocess.killed) subprocess.kill('SIGKILL');
    }
  }, 10_000);
});

function run(args: readonly string[]) {
  return execa(TSX, [CLI, ...args], {
    cwd: PROJECT_DIRECTORY,
    env: cliEnvironment(),
    reject: false,
  });
}

function spawn(args: readonly string[]): ResultPromise {
  return execa(TSX, [CLI, ...args], {
    cwd: PROJECT_DIRECTORY,
    env: cliEnvironment(),
    reject: false,
  });
}

function cliEnvironment(): NodeJS.ProcessEnv {
  return {...process.env, XDG_CONFIG_HOME: configHome, NO_COLOR: '1'};
}

async function waitForLines(subprocess: ResultPromise, count: number): Promise<string[]> {
  const stdout = subprocess.stdout;
  if (!stdout) throw new Error('CLI stdout was not captured.');
  stdout.setEncoding('utf8');
  return new Promise<string[]>((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${count} output line(s).`));
    }, 5_000);
    const onData = (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      if (lines.length >= count) {
        cleanup();
        resolve(lines.slice(0, count));
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      stdout.off('data', onData);
      stdout.off('error', onError);
    };
    stdout.on('data', onData);
    stdout.on('error', onError);
  });
}
