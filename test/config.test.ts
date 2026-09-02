import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {ConfigRepository, resolveConfigPaths} from '../src/config.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portwarden-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('ConfigRepository', () => {
  it('persists validated settings and host+port keys literally', () => {
    const directory = temporaryDirectory();
    const repository = ConfigRepository.open({configDirectory: directory});
    repository.update({
      browser: 'Firefox',
      pinnedListenerKeys: ['host:127.0.0.1::port:3000'],
      refreshSeconds: 3,
    });

    expect(ConfigRepository.open({configDirectory: directory}).get()).toMatchObject({
      browser: 'Firefox',
      pinnedListenerKeys: ['host:127.0.0.1::port:3000'],
      refreshSeconds: 3,
    });
  });

  it('migrates legacy revivablePins into safe argv graveyard records', () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(
      path.join(directory, 'config.json'),
      JSON.stringify({
        pinnedListenerKeys: ['host:::1::port:5173'],
        revivablePins: {
          'host:::1::port:5173': {
            cwd: '/tmp/project',
            cmd: 'vite --port 5173',
            capturedAt: '2026-04-22T00:00:00.000Z',
            source: 'auto',
          },
        },
      }),
    );

    const config = ConfigRepository.open({configDirectory: directory}).get();
    expect(config.graveyard).toHaveLength(1);
    expect(config.graveyard[0]).toMatchObject({
      port: 5173,
      argv: ['vite', '--port', '5173'],
      cwd: '/tmp/project',
    });
  });

  it('fails loudly on corrupt JSON instead of silently erasing settings', () => {
    const directory = temporaryDirectory();
    const configPath = path.join(directory, 'config.json');
    fs.writeFileSync(configPath, '{not json');
    expect(() => ConfigRepository.open({configDirectory: directory})).toThrow(/Could not read config/);
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{not json');
  });
});

describe('resolveConfigPaths', () => {
  it('retains the existing macOS Application Support location', () => {
    expect(resolveConfigPaths({
      homeDirectory: '/Users/test',
      platform: 'darwin',
      xdgConfigHome: '',
    }).current).toBe(
      '/Users/test/Library/Application Support/portwarden/config.json',
    );
  });
});
