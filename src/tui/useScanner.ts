import {useCallback, useEffect, useMemo, useRef, useState} from 'react';

import type {PortwardenConfig} from '../config.js';
import {collectListeners, selectListeners} from '../core/listeners.js';
import type {BrowserSession, ListenerEntry, ZombieCandidate} from '../core/types.js';
import {detectBrowserSessions} from '../core/browserSessions.js';
import {collectProcesses, detectZombieCandidates} from '../core/zombies.js';

export interface ScannerSnapshot {
  allListeners: ListenerEntry[];
  listeners: ListenerEntry[];
  zombies: ZombieCandidate[];
  browsers: BrowserSession[];
  loading: boolean;
  refreshing: boolean;
  error: string;
  updatedAt: Date | null;
}

export interface ScannerOptions {
  all: boolean;
  showZombies: boolean;
  config: PortwardenConfig;
}

const INITIAL_SNAPSHOT: ScannerSnapshot = {
  allListeners: [],
  listeners: [],
  zombies: [],
  browsers: [],
  loading: true,
  refreshing: false,
  error: '',
  updatedAt: null,
};

export function useScanner({all, showZombies, config}: ScannerOptions): ScannerSnapshot & {refresh: () => void} {
  const [snapshot, setSnapshot] = useState<ScannerSnapshot>(INITIAL_SNAPSHOT);
  const [refreshToken, setRefreshToken] = useState(0);
  const generation = useRef(0);
  const pinKey = config.pinnedListenerKeys.join('\u0000');
  const orderKey = config.orderedEntryKeys.join('\u0000');
  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);
  const selectionOptions = useMemo(
    () => ({
      all,
      pinnedListenerKeys: pinKey ? pinKey.split('\u0000') : [],
      orderedEntryKeys: orderKey ? orderKey.split('\u0000') : [],
    }),
    [all, orderKey, pinKey],
  );
  const listeners = useMemo(
    () => selectListeners(snapshot.allListeners, selectionOptions),
    [selectionOptions, snapshot.allListeners],
  );

  useEffect(() => {
    let disposed = false;
    let timer: NodeJS.Timeout | undefined;
    const abortController = new AbortController();
    const currentGeneration = ++generation.current;

    const scan = async () => {
      setSnapshot((current) => ({...current, refreshing: !current.loading, error: ''}));
      try {
        const processPromise = collectProcesses();
        const listenerPromise = collectListeners({
          strict: true,
          signal: abortController.signal,
          processProvider: () => processPromise,
        });
        const [processes, allListeners] = await Promise.all([processPromise, listenerPromise]);
        if (disposed || generation.current !== currentGeneration) {
          return;
        }

        const taskPids = new Set(allListeners.flatMap(({task}) => task?.members.map(({pid}) => pid) ?? []));
        const browsers = detectBrowserSessions(processes).filter(({pid}) => !taskPids.has(pid));
        const browserPids = new Set(browsers.flatMap(({members}) => members.map(({pid}) => pid)));
        const zombies = detectZombieCandidates(processes, {
          listeningPids: new Set(allListeners.map(({pid}) => pid)),
        }).filter(({pid}) => !browserPids.has(pid) && !taskPids.has(pid));
        setSnapshot({
          allListeners,
          listeners: allListeners,
          zombies,
          browsers,
          loading: false,
          refreshing: false,
          error: '',
          updatedAt: new Date(),
        });
      } catch (error) {
        if (disposed || generation.current !== currentGeneration) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setSnapshot((current) => ({
          ...current,
          loading: false,
          refreshing: false,
          error: message,
        }));
      }

      if (!disposed) {
        timer = setTimeout(scan, Math.max(500, config.refreshSeconds * 1000));
      }
    };

    void scan();
    return () => {
      disposed = true;
      generation.current += 1;
      abortController.abort();
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [config.refreshSeconds, refreshToken]);

  return {
    ...snapshot,
    listeners,
    zombies: showZombies ? snapshot.zombies : [],
    refresh,
  };
}
