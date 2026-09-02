import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {sanitizeText} from './core/commands.js';

export const KNOWN_BROWSER_NAMES = [
  'Arc',
  'Google Chrome',
  'Safari',
  'Firefox',
  'Firefox Developer Edition',
  'Brave Browser',
  'Microsoft Edge',
  'Vivaldi',
  'Opera',
  'Zen',
  'Orion',
  'DuckDuckGo',
] as const;

const BROWSER_KEYWORDS = [
  'arc',
  'chrome',
  'safari',
  'firefox',
  'brave',
  'edge',
  'vivaldi',
  'opera',
  'zen',
  'orion',
  'duckduckgo',
] as const;

const NON_BROWSER_KEYWORDS = [
  'installer',
  'uninstall',
  'updater',
] as const;

export interface ApplicationDirectoryEntry {
  name: string;
  isDirectory(): boolean;
}

export interface BrowserDetectionOptions {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  applicationDirectories?: readonly string[];
  readDirectory?: (directory: string) => readonly ApplicationDirectoryEntry[];
}

export interface BrowserOption {
  label: string;
  value: string;
}

export interface BuildBrowserOptionsInput {
  installedBrowsers?: readonly string[];
  currentBrowser?: string;
  activeBrowser?: string;
}

/**
 * Find browser-like macOS application bundles without changing global state.
 * Individual unreadable directories and malformed entries are ignored so one
 * bad application cannot make the settings screen unusable.
 */
export function detectInstalledBrowsers(options: BrowserDetectionOptions = {}): string[] {
  if ((options.platform ?? process.platform) !== 'darwin') {
    return [];
  }

  const homeDirectory = options.homeDirectory ?? os.homedir();
  const directories = options.applicationDirectories ?? [
    '/Applications',
    path.join(homeDirectory, 'Applications'),
  ];
  const readDirectory = options.readDirectory ?? readApplicationDirectory;
  const candidates = new Set<string>();

  for (const directory of new Set(directories.filter(Boolean))) {
    let entries: readonly ApplicationDirectoryEntry[];
    try {
      entries = readDirectory(directory);
    } catch {
      continue;
    }

    for (const entry of entries) {
      try {
        if (!entry.isDirectory() || !/\.app$/i.test(entry.name)) {
          continue;
        }

        const appName = normalizeBrowserName(entry.name.replace(/\.app$/i, ''));
        const lowerName = appName.toLowerCase();
        const looksLikeBrowser = BROWSER_KEYWORDS.some((keyword) => lowerName.includes(keyword));
        const looksLikeMaintenanceTool = NON_BROWSER_KEYWORDS.some((keyword) => lowerName.includes(keyword));
        if (appName && looksLikeBrowser && !looksLikeMaintenanceTool) {
          candidates.add(appName);
        }
      } catch {
        // Treat a malformed injected or filesystem entry like an unreadable app.
      }
    }
  }

  return [...candidates].sort((left, right) => left.localeCompare(right));
}

/**
 * Build the complete browser picker list. The legacy known choices always stay
 * available, while discovered, saved, and session-only custom browsers are
 * appended once in that order.
 */
export function buildBrowserOptions(input: BuildBrowserOptionsInput = {}): BrowserOption[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const addName = (value: unknown) => {
    const name = normalizeBrowserName(value);
    if (!name || seen.has(name)) {
      return;
    }
    seen.add(name);
    names.push(name);
  };

  for (const name of KNOWN_BROWSER_NAMES) addName(name);
  for (const name of input.installedBrowsers ?? []) addName(name);
  addName(input.currentBrowser);
  addName(input.activeBrowser);

  return [
    {label: 'System default browser', value: ''},
    ...names.map((name) => ({label: name, value: name})),
  ];
}

function readApplicationDirectory(directory: string): readonly ApplicationDirectoryEntry[] {
  return fs.readdirSync(directory, {withFileTypes: true});
}

function normalizeBrowserName(value: unknown): string {
  return sanitizeText(value);
}
