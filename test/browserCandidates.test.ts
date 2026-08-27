import {describe, expect, it, vi} from 'vitest';

import {
  buildBrowserOptions,
  detectInstalledBrowsers,
  KNOWN_BROWSER_NAMES,
  type ApplicationDirectoryEntry,
} from '../src/browserCandidates.js';

function entry(name: string, directory = true): ApplicationDirectoryEntry {
  return {name, isDirectory: () => directory};
}

describe('detectInstalledBrowsers', () => {
  it('scans the system and user macOS Applications directories for browser bundles', () => {
    const readDirectory = vi.fn((directory: string): readonly ApplicationDirectoryEntry[] => {
      if (directory === '/Applications') {
        return [
          entry('Google Chrome.app'),
          entry('Firefox Nightly.app'),
          entry('DuckDuckGo.app'),
          entry('Not A Browser.app'),
          entry('Opera.app', false),
          entry('browser-notes.txt'),
        ];
      }
      return [entry('Google Chrome.app'), entry('\u001B[31mVivaldi Snapshot\u001B[0m.app')];
    });

    expect(detectInstalledBrowsers({
      platform: 'darwin',
      homeDirectory: '/Users/test',
      readDirectory,
    })).toEqual([
      'DuckDuckGo',
      'Firefox Nightly',
      'Google Chrome',
      'Vivaldi Snapshot',
    ]);
    expect(readDirectory.mock.calls.map(([directory]) => directory)).toEqual([
      '/Applications',
      '/Users/test/Applications',
    ]);
  });

  it('continues after unreadable directories and malformed entries', () => {
    const brokenEntry: ApplicationDirectoryEntry = {
      name: 'Broken Chrome.app',
      isDirectory: () => {
        throw new Error('bad directory entry');
      },
    };
    const readDirectory = vi.fn((directory: string): readonly ApplicationDirectoryEntry[] => {
      if (directory === '/unreadable') throw new Error('EACCES');
      return [brokenEntry, entry('Orion RC.app')];
    });

    expect(detectInstalledBrowsers({
      platform: 'darwin',
      applicationDirectories: ['/unreadable', '/readable'],
      readDirectory,
    })).toEqual(['Orion RC']);
  });

  it('does not inspect application directories on non-macOS platforms', () => {
    const readDirectory = vi.fn(() => [entry('Google Chrome.app')]);

    expect(detectInstalledBrowsers({platform: 'linux', readDirectory})).toEqual([]);
    expect(readDirectory).not.toHaveBeenCalled();
  });
});

describe('buildBrowserOptions', () => {
  it('keeps every legacy choice and appends discovered and custom browsers once', () => {
    const installedBrowsers = ['Google Chrome', 'Firefox Nightly', 'Vivaldi', 'Firefox Nightly'];
    const options = buildBrowserOptions({
      installedBrowsers,
      currentBrowser: '  Ladybird  ',
      activeBrowser: '\u001B[31mCustom Browser\u001B[0m',
    });
    const values = options.map(({value}) => value);

    expect(values.slice(0, KNOWN_BROWSER_NAMES.length + 1)).toEqual(['', ...KNOWN_BROWSER_NAMES]);
    expect(values.slice(KNOWN_BROWSER_NAMES.length + 1)).toEqual([
      'Firefox Nightly',
      'Ladybird',
      'Custom Browser',
    ]);
    expect(options[0]).toEqual({label: 'System default browser', value: ''});
    expect(installedBrowsers).toEqual(['Google Chrome', 'Firefox Nightly', 'Vivaldi', 'Firefox Nightly']);
  });
});
