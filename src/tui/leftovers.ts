import {formatMemory} from '../core/browserSessions.js';
import {launcherLabel, type Launcher} from '../core/launchers.js';
import type {BrowserSession, ListenerEntry} from '../core/types.js';

export interface LeftoverScope {
  key: string;
  label: string;
  launcher: Launcher | undefined;
  memoryBytes: number | null;
  listener?: ListenerEntry;
  browser?: BrowserSession;
}

export function collectLeftovers(
  allListeners: readonly ListenerEntry[],
  browsers: readonly BrowserSession[],
): LeftoverScope[] {
  const browserPids = new Set(browsers.flatMap(({members}) => members.map(({pid}) => pid)));
  const scopes = new Map<string, LeftoverScope>();
  for (const listener of allListeners) {
    if (!listener.leftover || browserPids.has(listener.pid)) continue;
    const key = listener.task?.key ?? `pid:${listener.pid}`;
    const ports = listener.task?.ports ?? allListeners.filter(({pid}) => pid === listener.pid).map(({port}) => port);
    scopes.set(key, scopes.get(key) ?? {
      key,
      label: `${listener.displayProject || listener.command}:${[...new Set(ports)].join(',')}`,
      launcher: listener.launcher,
      memoryBytes: listener.task ? listener.task.memoryBytes : listener.rssBytes ?? null,
      listener,
    });
  }
  const browserScopes = browsers.filter(({leftover}) => leftover).map<LeftoverScope>((browser) => ({
    key: `browser:${browser.pid}`,
    label: `browser ${browser.pid}`,
    launcher: browser.launcher,
    memoryBytes: browser.memoryBytes,
    browser,
  }));
  return [...scopes.values(), ...browserScopes];
}

export function leftoverLine(scope: LeftoverScope): string {
  return `${scope.label}  ${launcherLabel(scope.launcher)}  ${formatMemory(scope.memoryBytes)}`;
}
