import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {afterEach, expect, it} from 'vitest';

import {createDiagnostics} from '../src/diagnostics.js';

const directories: string[] = [];
function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portwarden-diagnostics-'));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, {recursive: true, force: true});
});

it('records memory and rotates logs with private permissions', () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, 'runtime.jsonl');
  const diagnostics = createDiagnostics(directory);
  diagnostics.record('start');
  const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(entry.event).toBe('start');
  expect(entry.memory.rss).toBeGreaterThan(0);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  fs.writeFileSync(file, 'x'.repeat(1024 * 1024));
  diagnostics.record('heartbeat');
  expect(fs.statSync(`${file}.1`).size).toBe(1024 * 1024);
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).event).toBe('heartbeat');
});

it('omits error messages that may contain credentials and tolerates write failure', () => {
  const directory = temporaryDirectory();
  const diagnostics = createDiagnostics(directory);
  diagnostics.error('fatal-error', new Error('command failed --token=secret-value'));
  const text = fs.readFileSync(path.join(directory, 'runtime.jsonl'), 'utf8');
  expect(text).not.toContain('secret-value');
  expect(JSON.parse(text).frames.length).toBeGreaterThan(0);
  const blocked = path.join(directory, 'not-a-directory');
  fs.writeFileSync(blocked, '');
  expect(() => createDiagnostics(blocked).record('heartbeat')).not.toThrow();
});
