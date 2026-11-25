import {detectBrowserSessions} from './browserSessions.js';
import {attachLaunchers} from './launchers.js';
import {collectListeners} from './listeners.js';
import type {BrowserSession, ListenerEntry, ProcessInfo} from './types.js';
import {collectProcesses} from './zombies.js';

export interface SystemScan {
  processes: ProcessInfo[];
  allListeners: ListenerEntry[];
  browsers: BrowserSession[];
}

export async function scanSystem(options: {signal?: AbortSignal} = {}): Promise<SystemScan> {
  const processPromise = collectProcesses();
  const listenerPromise = collectListeners({strict: true, signal: options.signal, processProvider: () => processPromise});
  const [processes, listeners] = await Promise.all([processPromise, listenerPromise]);
  const taskPids = new Set(listeners.flatMap(({task}) => task?.members.map(({pid}) => pid) ?? []));
  const browsers = detectBrowserSessions(processes).filter(({pid}) => !taskPids.has(pid));
  const attached = await attachLaunchers(listeners, browsers, processes);
  return {processes, allListeners: attached.listeners, browsers: attached.browsers};
}
