import {useEffect, useMemo, useRef, useState} from 'react';

import {Box, Text, useApp, useInput, useStdout} from 'ink';

import {openInBrowser} from '../browser.js';
import {buildBrowserOptions, detectInstalledBrowsers, type BrowserOption} from '../browserCandidates.js';
import type {ConfigRepository, GraveyardRecord, PortwardenConfig} from '../config.js';
import {formatCommandForDisplay, redactCommandLine, sanitizeText} from '../core/commands.js';
import {
  listenerSharesStopScope,
  listenerStopProcessGroup,
  PortwardenActions,
  type ActionOutcome,
  type StopSignal,
} from '../core/actions.js';
import {listenerKey, listenerKeys, preferenceKey, selectionKey} from '../core/listeners.js';
import type {ListenerEntry} from '../core/types.js';
import {normalizeShortcut} from './keymap.js';
import {buildVisibleRows, listenerIsPinned, type VisibleRow} from './rows.js';
import {useScanner} from './useScanner.js';

type Screen = 'main' | 'settings' | 'browser' | 'graveyard' | 'help';

interface Confirmation {
  title: string;
  detail: string;
  action: () => Promise<void>;
}

export interface PortwardenAppProps {
  configRepository: ConfigRepository;
  initialAll?: boolean;
  initialZombies?: boolean;
  browserOverride?: string;
  actionsOverride?: PortwardenActions;
}

const REFRESH_INTERVALS = [1, 2, 5, 10];

export function PortwardenApp({
  configRepository,
  initialAll = false,
  initialZombies = false,
  browserOverride = '',
  actionsOverride,
}: PortwardenAppProps) {
  const {exit} = useApp();
  const {write: writeStdout} = useStdout();
  const {columns, rows: terminalRows} = useTerminalSize();
  const [config, setConfig] = useState(() => configRepository.get());
  const [all, setAll] = useState(initialAll);
  const [showZombies, setShowZombies] = useState(initialZombies);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [screen, setScreen] = useState<Screen>('main');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [settingsIndex, setSettingsIndex] = useState(0);
  const [browserIndex, setBrowserIndex] = useState(0);
  const [graveyardIndex, setGraveyardIndex] = useState(0);
  const [query, setQuery] = useState('');
  const [filterDraft, setFilterDraft] = useState('');
  const [filterMode, setFilterMode] = useState(false);
  const [status, setStatus] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionWarning, setActionWarning] = useState('');
  const [busy, setBusy] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const selectionIndexHint = useRef(0);
  const pendingSelectionKey = useRef<string | null>(null);
  const actions = useMemo(
    () => actionsOverride ?? new PortwardenActions(configRepository),
    [actionsOverride, configRepository],
  );
  const normalizedBrowserOverride = useMemo(() => sanitizeText(browserOverride), [browserOverride]);
  const installedBrowsers = useMemo(() => detectInstalledBrowsers(), []);
  const browserChoices = useMemo(
    () => buildBrowserOptions({
      installedBrowsers,
      currentBrowser: config.browser,
      activeBrowser: normalizedBrowserOverride || config.browser,
    }),
    [config.browser, installedBrowsers, normalizedBrowserOverride],
  );
  const scanner = useScanner({all, showZombies, config});
  const visibleRows = useMemo(
    () => buildVisibleRows(scanner.listeners, scanner.zombies, {
      all,
      expandedGroups,
      pinnedListenerKeys: config.pinnedListenerKeys,
      query,
    }),
    [all, config.pinnedListenerKeys, expandedGroups, query, scanner.listeners, scanner.zombies],
  );
  const selectedIndex = selectedKey ? visibleRows.findIndex(({key}) => key === selectedKey) : -1;
  const effectiveSelectedIndex = visibleRows.length === 0
    ? -1
    : selectedIndex >= 0
      ? selectedIndex
      : clamp(selectionIndexHint.current, 0, visibleRows.length - 1);
  const selectedRow = effectiveSelectedIndex >= 0 ? visibleRows[effectiveSelectedIndex] ?? null : null;
  const filterLineCount = filterMode || query ? 1 : 0;
  const mainPageSize = Math.max(1, terminalRows - 15 - filterLineCount);

  useEffect(() => {
    if (selectedIndex >= 0) {
      selectionIndexHint.current = selectedIndex;
    }
  }, [selectedIndex]);

  useEffect(() => {
    const pending = pendingSelectionKey.current;
    if (pending && visibleRows.some(({key}) => key === pending)) {
      pendingSelectionKey.current = null;
      setSelectedKey(pending);
    } else if (visibleRows.length === 0) {
      setSelectedKey(null);
    } else if (!selectedKey || !visibleRows.some(({key}) => key === selectedKey)) {
      setSelectedKey(visibleRows[Math.min(Math.max(effectiveSelectedIndex, 0), visibleRows.length - 1)]?.key ?? null);
    }
  }, [effectiveSelectedIndex, selectedKey, visibleRows]);

  useEffect(() => {
    setGraveyardIndex((current) => clamp(current, 0, Math.max(0, config.graveyard.length - 1)));
  }, [config.graveyard.length]);

  useEffect(() => {
    setScrollOffset((current) => {
      const maximum = Math.max(0, visibleRows.length - mainPageSize);
      const bounded = clamp(current, 0, maximum);
      if (effectiveSelectedIndex < 0) return 0;
      if (effectiveSelectedIndex < bounded) return effectiveSelectedIndex;
      if (effectiveSelectedIndex >= bounded + mainPageSize) {
        return clamp(effectiveSelectedIndex - mainPageSize + 1, 0, maximum);
      }
      return bounded;
    });
  }, [effectiveSelectedIndex, mainPageSize, visibleRows.length]);

  const refreshConfig = () => setConfig(configRepository.get());
  const saveConfig = (patch: Partial<PortwardenConfig>, message = '') => {
    try {
      const saved = configRepository.update(patch);
      setConfig(saved);
      setActionError('');
      setActionWarning('');
      if (message) setStatus(message);
    } catch (error) {
      setActionWarning('');
      setActionError(errorMessage(error));
    }
  };

  const runAction = async (label: string, action: () => Promise<ActionOutcome | string>) => {
    setBusy(label);
    setActionError('');
    setActionWarning('');
    try {
      const result = await action();
      setStatus(typeof result === 'string' ? result : result.message);
      let warning = typeof result === 'string' ? '' : result.warning ?? '';
      if (typeof result !== 'string' && result.listener) {
        pendingSelectionKey.current = `listener:${selectionKey(result.listener)}`;
      }
      try {
        refreshConfig();
      } catch (error) {
        warning ||= `Config could not be reloaded: ${errorMessage(error)}`;
      }
      try {
        scanner.refresh();
      } catch (error) {
        warning ||= `Port list could not be refreshed: ${errorMessage(error)}`;
      }
      setActionWarning(warning);
    } catch (error) {
      pendingSelectionKey.current = null;
      setActionWarning('');
      setActionError(errorMessage(error));
      try {
        refreshConfig();
      } catch {
        // Keep the original action error visible.
      }
      try {
        scanner.refresh();
      } catch {
        // The original action error still explains why manual verification is needed.
      }
    } finally {
      setBusy('');
    }
  };

  const queueAction = (title: string, detail: string, action: () => Promise<void>) => {
    setActionError('');
    setActionWarning('');
    if (config.confirmActions) {
      setConfirmation({title, detail, action});
    } else {
      void action();
    }
  };

  const moveMainSelection = (delta: number) => {
    if (visibleRows.length === 0) return;
    pendingSelectionKey.current = null;
    const next = clamp(effectiveSelectedIndex + delta, 0, visibleRows.length - 1);
    selectionIndexHint.current = next;
    setSelectedKey(visibleRows[next]?.key ?? null);
  };

  const toggleSelectedPin = () => {
    pendingSelectionKey.current = null;
    if (selectedRow?.type !== 'listener') {
      setActionError(selectedRow?.type === 'group' ? 'Expand the app group and select one listener to pin it.' : 'Only LISTEN ports can be pinned.');
      return;
    }
    const aliases = new Set(listenerKeys(selectedRow.listener));
    const pinned = config.pinnedListenerKeys.some((key) => aliases.has(key));
    const next = config.pinnedListenerKeys.filter((key) => !aliases.has(key));
    if (!pinned) next.push(listenerKey(selectedRow.listener));

    const selectedIdentity = selectionKey(selectedRow.listener);
    const selectedOrderKey = listenerKey(selectedRow.listener);
    const otherListeners = scanner.listeners.filter((listener) => selectionKey(listener) !== selectedIdentity);
    const pinnedListeners = otherListeners.filter((listener) => listenerIsPinned(listener, config.pinnedListenerKeys));
    const regularListeners = otherListeners.filter((listener) => !listenerIsPinned(listener, config.pinnedListenerKeys));
    const visibleAliases = new Set(scanner.listeners.flatMap((listener) => [
      ...listenerKeys(listener),
      preferenceKey(listener),
      selectionKey(listener),
    ]));
    const staleSavedOrder = config.orderedEntryKeys.filter((key) => !visibleAliases.has(key));
    const orderedEntryKeys = [
      ...pinnedListeners.map(listenerKey),
      selectedOrderKey,
      ...regularListeners.map(listenerKey),
      ...staleSavedOrder,
    ];
    saveConfig(
      {pinnedListenerKeys: next, orderedEntryKeys},
      `${pinned ? 'Unpinned' : 'Pinned'} ${selectedRow.listener.displayProject || selectedRow.listener.command}:${selectedRow.listener.port}.`,
    );
  };

  const reorderSelected = (direction: -1 | 1) => {
    pendingSelectionKey.current = null;
    if (selectedRow?.type !== 'listener') {
      if (selectedRow?.type === 'group') toggleGroup(selectedRow, direction > 0);
      return;
    }
    const selectedPinned = listenerIsPinned(selectedRow.listener, config.pinnedListenerKeys);
    const section = visibleRows.filter((row): row is Extract<VisibleRow, {type: 'listener'}> =>
      row.type === 'listener' &&
      row.parentGroupKey === selectedRow.parentGroupKey &&
      listenerIsPinned(row.listener, config.pinnedListenerKeys) === selectedPinned,
    );
    const visibleIndex = section.findIndex(({listener}) => selectionKey(listener) === selectionKey(selectedRow.listener));
    const targetRow = section[visibleIndex + direction];
    if (visibleIndex < 0 || !targetRow) {
      setStatus('Already at the edge of this section.');
      return;
    }
    const reordered = [...scanner.listeners];
    const sourceIndex = reordered.findIndex((listener) => selectionKey(listener) === selectionKey(selectedRow.listener));
    const targetIndex = reordered.findIndex((listener) => selectionKey(listener) === selectionKey(targetRow.listener));
    if (sourceIndex < 0 || targetIndex < 0) {
      setActionError('The selected listener changed. Refresh and try again.');
      return;
    }
    [reordered[sourceIndex], reordered[targetIndex]] = [reordered[targetIndex]!, reordered[sourceIndex]!];
    const presentKeys = new Set(scanner.listeners.flatMap((listener) => [
      ...listenerKeys(listener),
      preferenceKey(listener),
      selectionKey(listener),
    ]));
    const staleSaved = config.orderedEntryKeys.filter((key) => !presentKeys.has(key));
    saveConfig(
      {orderedEntryKeys: [...reordered.map(listenerKey), ...staleSaved]},
      `Moved ${selectedRow.listener.displayProject || selectedRow.listener.command} ${direction < 0 ? 'up' : 'down'}.`,
    );
  };

  const toggleGroup = (row: Extract<VisibleRow, {type: 'group'}>, force?: boolean) => {
    pendingSelectionKey.current = null;
    setExpandedGroups((current) => {
      const next = new Set(current);
      const expand = force ?? !next.has(row.key);
      if (expand) next.add(row.key);
      else next.delete(row.key);
      return next;
    });
  };

  const collapseParentGroup = (row: Extract<VisibleRow, {type: 'listener'}>): boolean => {
    if (!row.parentGroupKey) return false;
    const parent = visibleRows.find((candidate): candidate is Extract<VisibleRow, {type: 'group'}> =>
      candidate.type === 'group' && candidate.key === row.parentGroupKey,
    );
    if (!parent) return false;
    setSelectedKey(parent.key);
    selectionIndexHint.current = visibleRows.findIndex(({key}) => key === parent.key);
    toggleGroup(parent, false);
    setStatus(`Collapsed app group: ${parent.family}.`);
    return true;
  };

  const stopSelected = (signal: StopSignal) => {
    if (!selectedRow || selectedRow.type === 'group') {
      setActionError(selectedRow ? 'Expand the group and select one process first.' : 'No process selected.');
      return;
    }
    if (selectedRow.type === 'listener') {
      const pinnedForScope = scanner.allListeners.find((listener) =>
        listenerSharesStopScope(selectedRow.listener, listener) &&
        listenerIsPinned(listener, config.pinnedListenerKeys),
      );
      if (pinnedForScope) {
        const scope = pinnedForScope.pid === selectedRow.listener.pid
          ? `PID ${selectedRow.listener.pid}`
          : `Process group ${selectedRow.listener.pgid}`;
        setActionError(selectionKey(pinnedForScope) === selectionKey(selectedRow.listener)
          ? `Port ${selectedRow.listener.port} is pinned. Unpin it before stopping.`
          : `${scope} also owns pinned port ${pinnedForScope.port}. Unpin every listener in the stop scope before stopping it.`);
        return;
      }
    }
    const siblingPorts = selectedRow.type === 'listener'
      ? scanner.allListeners
        .filter((listener) =>
          listenerSharesStopScope(selectedRow.listener, listener) &&
          selectionKey(listener) !== selectionKey(selectedRow.listener),
        )
        .map((listener) => `${listener.displayHost || listener.host}:${listener.port}`)
      : [];
    let target: string;
    if (selectedRow.type === 'listener') {
      const pgid = listenerStopProcessGroup(selectedRow.listener);
      const processIdentity = pgid === null
        ? `PID ${selectedRow.listener.pid}`
        : `PGID ${pgid}, PID ${selectedRow.listener.pid}`;
      target = siblingPorts.length > 0
        ? `port ${selectedRow.listener.port} (${processIdentity}; also stops ${siblingPorts.join(', ')})`
        : `port ${selectedRow.listener.port} (${processIdentity}, ${selectedRow.listener.displayProject || selectedRow.listener.command})`;
    } else {
      target = `PID ${selectedRow.zombie.pid} (${selectedRow.zombie.family})`;
    }
    queueAction(
      signal === 'SIGKILL' ? `Force-stop ${target}?` : `Stop ${target}?`,
      signal === 'SIGKILL' ? 'SIGKILL does not allow cleanup.' : 'SIGTERM lets the process clean up first.',
      async () => runAction(signal === 'SIGKILL' ? 'Force-stopping…' : 'Stopping…', () =>
        selectedRow.type === 'listener'
          ? actions.stopListener(selectedRow.listener, signal)
          : actions.stopZombie(selectedRow.zombie, signal),
      ),
    );
  };

  const moveSelected = () => {
    if (selectedRow?.type !== 'listener') {
      setActionError('Select one LISTEN port to move it.');
      return;
    }
    const listener = selectedRow.listener;
    const siblings = scanner.allListeners.filter((candidate) =>
      candidate.pid === listener.pid && selectionKey(candidate) !== selectionKey(listener),
    );
    const pinnedSibling = siblings.find((candidate) => listenerIsPinned(candidate, config.pinnedListenerKeys));
    if (pinnedSibling) {
      setActionError(`PID ${listener.pid} also owns pinned port ${pinnedSibling.port}. Unpin it before moving this process.`);
      return;
    }
    const nextPort = nextAvailablePort(scanner.allListeners, listener.port);
    if (nextPort === '-') {
      setActionError(`No higher port is available after ${listener.port}.`);
      return;
    }
    const moveTitle = siblings.length > 0
      ? `Move port ${listener.port} to the next available port; restarting PID ${listener.pid} also stops ${siblings.map((candidate) => `${candidate.displayHost || candidate.host}:${candidate.port}`).join(', ')}?`
      : `Move port ${listener.port} (PID ${listener.pid}) to the next available port?`;
    queueAction(
      moveTitle,
      `Project ${listener.displayProject || listener.command}. Current candidate: ${nextPort}; Portwarden rechecks before launch, so the target can change.`,
      async () => runAction('Moving port…', () => actions.moveListener(listener)),
    );
  };

  const openSelected = () => {
    if (selectedRow?.type !== 'listener') {
      setActionError('Select one LISTEN port to open it.');
      return;
    }
    const listener = selectedRow.listener;
    void runAction('Opening browser…', async () => {
      const url = await openInBrowser(
        {host: listener.host, port: listener.port, commandLine: listener.args},
        normalizedBrowserOverride || config.browser,
      );
      return `Opened ${url}.`;
    });
  };

  const reviveSelected = () => {
    const record = config.graveyard[graveyardIndex];
    if (!record) return;
    queueAction(
      `Revive port ${record.port} (${record.project})?`,
      'The record stays in the graveyard until the expected listener is verified.',
      async () => runAction('Reviving…', () => actions.revive(record)),
    );
  };

  const discardSelected = () => {
    const record = config.graveyard[graveyardIndex];
    if (!record) return;
    queueAction(
      `Discard port ${record.port} (${record.project})?`,
      'This removes only the saved relaunch record.',
      async () => runAction('Discarding…', async () => actions.discard(record)),
    );
  };

  useInput((input, key) => {
    const normalized = normalizeShortcut(input, key);
    if (key.ctrl && normalized === 'c') {
      if (!busy) exit();
      return;
    }
    if (key.ctrl && normalized === 'l') {
      writeStdout('\u001B[2J\u001B[3J\u001B[H');
      return;
    }
    if (busy) return;

    if (confirmation) {
      if (key.return || normalized === 'y') {
        const action = confirmation.action;
        setConfirmation(null);
        void action();
      } else if (key.escape || normalized === 'n' || normalized === 'q') {
        setConfirmation(null);
      }
      return;
    }

    if (filterMode) {
      if (key.return) {
        pendingSelectionKey.current = null;
        setQuery(filterDraft.trim());
        setFilterMode(false);
        setStatus(filterDraft.trim() ? `Filter: ${filterDraft.trim()}` : 'Filter cleared.');
      } else if (key.escape) {
        pendingSelectionKey.current = null;
        setFilterDraft(query);
        setFilterMode(false);
      } else if (key.backspace || key.delete) {
        setFilterDraft((value) => [...value].slice(0, -1).join(''));
      } else if (!key.ctrl && !key.meta && input && !/[\u0000-\u001F\u007F]/.test(input)) {
        setFilterDraft((value) => `${value}${input}`);
      }
      return;
    }

    if (screen === 'help') {
      if (key.escape || normalized === '?' || normalized === 'q') setScreen('main');
      return;
    }

    if (screen === 'browser') {
      if (key.upArrow) setBrowserIndex((value) => clamp(value - 1, 0, browserChoices.length - 1));
      else if (key.downArrow) setBrowserIndex((value) => clamp(value + 1, 0, browserChoices.length - 1));
      else if (key.return) {
        const option = browserChoices[browserIndex];
        if (option) saveConfig({browser: option.value}, `Browser: ${option.label}.`);
        setScreen('settings');
      } else if (key.escape || normalized === 'q' || normalized === 's') setScreen('settings');
      return;
    }

    if (screen === 'settings') {
      if (key.upArrow) setSettingsIndex((value) => clamp(value - 1, 0, 2));
      else if (key.downArrow) setSettingsIndex((value) => clamp(value + 1, 0, 2));
      else if (key.return || key.rightArrow) {
        if (settingsIndex === 0) {
          setBrowserIndex(Math.max(0, browserChoices.findIndex(({value}) => value === config.browser)));
          setScreen('browser');
        } else if (settingsIndex === 1) {
          saveConfig({confirmActions: !config.confirmActions}, `Confirm mode ${config.confirmActions ? 'off' : 'on'}.`);
        } else {
          const index = REFRESH_INTERVALS.indexOf(config.refreshSeconds);
          const refreshSeconds = REFRESH_INTERVALS[(index + 1) % REFRESH_INTERVALS.length] ?? 2;
          saveConfig({refreshSeconds}, `Refresh interval: ${refreshSeconds}s.`);
        }
      } else if (key.escape || normalized === 'q' || normalized === 's') setScreen('main');
      return;
    }

    if (screen === 'graveyard') {
      if (key.upArrow) setGraveyardIndex((value) => clamp(value - 1, 0, Math.max(0, config.graveyard.length - 1)));
      else if (key.downArrow) setGraveyardIndex((value) => clamp(value + 1, 0, Math.max(0, config.graveyard.length - 1)));
      else if (normalized === 'r') reviveSelected();
      else if (normalized === 'd') discardSelected();
      else if (key.escape || normalized === 'q' || normalized === 'g' || normalized === 's') setScreen('main');
      return;
    }

    if (key.upArrow) {
      moveMainSelection(-1);
    } else if (key.downArrow) {
      moveMainSelection(1);
    } else if (key.leftArrow) {
      if (selectedRow?.type === 'group') toggleGroup(selectedRow, false);
      else if (selectedRow?.type !== 'listener' || !collapseParentGroup(selectedRow)) reorderSelected(-1);
    } else if (key.rightArrow) {
      if (selectedRow?.type === 'group') toggleGroup(selectedRow, true);
      else reorderSelected(1);
    } else if (key.return && selectedRow?.type === 'group') {
      toggleGroup(selectedRow);
    } else if (key.return && selectedRow?.type === 'listener' && selectedRow.parentGroupKey) {
      collapseParentGroup(selectedRow);
    } else if (normalized === 'q') {
      exit();
    } else if (normalized === 'a') {
      pendingSelectionKey.current = null;
      setAll((value) => !value);
      setStatus(all ? 'Showing relevant + pinned ports.' : 'Showing all LISTEN ports.');
    } else if (normalized === 'z') {
      pendingSelectionKey.current = null;
      setShowZombies((value) => !value);
      setStatus(showZombies ? 'Zombies hidden.' : 'Zombies visible.');
    } else if (normalized === 'p') {
      toggleSelectedPin();
    } else if (normalized === 'o') {
      openSelected();
    } else if (normalized === 'm') {
      moveSelected();
    } else if (normalized === 'x') {
      stopSelected('SIGTERM');
    } else if (normalized === 'f') {
      stopSelected('SIGKILL');
    } else if (normalized === 'g') {
      pendingSelectionKey.current = null;
      refreshConfig();
      setScreen('graveyard');
    } else if (normalized === 's') {
      pendingSelectionKey.current = null;
      setScreen('settings');
    } else if (normalized === 'r') {
      pendingSelectionKey.current = null;
      setActionError('');
      setActionWarning('');
      scanner.refresh();
      setStatus('Refreshing…');
    } else if (normalized === '?') {
      setScreen('help');
    } else if (normalized === '/') {
      pendingSelectionKey.current = null;
      setFilterDraft(query);
      setFilterMode(true);
    } else if (key.escape && query) {
      pendingSelectionKey.current = null;
      setQuery('');
      setStatus('Filter cleared.');
    }
  });

  if (screen === 'settings') {
    return (
      <SettingsScreen
        config={config}
        selectedIndex={settingsIndex}
        status={status}
        error={actionError}
        configPath={configRepository.path}
        browserOverride={normalizedBrowserOverride}
        columns={columns}
        terminalRows={terminalRows}
      />
    );
  }
  if (screen === 'browser') {
    return (
      <BrowserScreen
        options={browserChoices}
        selectedIndex={browserIndex}
        savedBrowser={config.browser}
        activeBrowser={normalizedBrowserOverride || config.browser}
        columns={columns}
        terminalRows={terminalRows}
      />
    );
  }
  if (screen === 'graveyard') {
    return (
      <GraveyardScreen
        records={config.graveyard}
        selectedIndex={graveyardIndex}
        listeners={scanner.allListeners}
        status={status}
        error={actionError || scanner.error}
        busy={busy}
        warning={actionWarning}
        columns={columns}
        terminalRows={terminalRows}
        confirmation={confirmation}
      />
    );
  }
  if (screen === 'help') {
    return <HelpScreen />;
  }

  return (
    <Box flexDirection="column" width={columns}>
      <MainHeader
        all={all}
        showZombies={showZombies}
        listenerCount={all ? scanner.allListeners.length : scanner.listeners.length}
        rowCount={visibleRows.length}
        hiddenCount={all ? 0 : Math.max(0, scanner.allListeners.length - scanner.listeners.length)}
        zombieCount={scanner.zombies.length}
        selectedIndex={effectiveSelectedIndex}
        browser={normalizedBrowserOverride || config.browser}
        loading={scanner.loading}
        refreshing={scanner.refreshing}
        updatedAt={scanner.updatedAt}
        error={scanner.error}
      />
      {filterMode ? (
        <Text color="yellow" wrap="truncate-end">filter / {filterDraft}<Text inverse> </Text></Text>
      ) : query ? (
        <Text color="yellow" wrap="truncate-end">filter: {query}  <Text dimColor>(esc clear)</Text></Text>
      ) : null}
      <MainTable
        rows={visibleRows}
        selectedIndex={effectiveSelectedIndex}
        config={config}
        columns={columns}
        pageSize={mainPageSize}
        offset={scrollOffset}
        all={all}
      />
      <Details row={selectedRow} config={config} columns={columns} listeners={scanner.allListeners} />
      <ShortcutLine row={selectedRow} columns={columns} />
      {confirmation ? (
        <ConfirmationBox confirmation={confirmation} />
      ) : (
        <StatusLine busy={busy} status={status} error={actionError || scanner.error} warning={actionWarning} />
      )}
    </Box>
  );
}

function MainHeader(props: {
  all: boolean;
  showZombies: boolean;
  listenerCount: number;
  rowCount: number;
  hiddenCount: number;
  zombieCount: number;
  selectedIndex: number;
  browser: string;
  loading: boolean;
  refreshing: boolean;
  updatedAt: Date | null;
  error: string;
}) {
  const activity = props.loading ? 'scanning' : props.refreshing ? 'refreshing' : props.error ? 'degraded' : '';
  return (
    <Box flexDirection="column">
      <Text bold color="cyan" wrap="truncate-end">
        PORTWARDEN  <Text color={props.all ? 'cyan' : 'green'}>[{props.all ? 'ALL' : 'MAIN'}]</Text>{' '}
        <Text color="white">[{props.listenerCount} port{props.listenerCount === 1 ? '' : 's'}]</Text>{' '}
        {props.all && props.rowCount !== props.listenerCount ? <Text color="gray">[{props.rowCount} rows] </Text> : null}
        {!props.all && props.hiddenCount > 0 ? <Text color="yellow">[hidden {props.hiddenCount}] </Text> : null}
        {props.showZombies ? <Text color={props.zombieCount ? 'red' : 'gray'}>[{props.zombieCount} zombies]</Text> : null}
      </Text>
      <Text dimColor wrap="truncate-end">
        refresh {props.updatedAt ? formatClock(props.updatedAt) : '--:--:--'}  browser {sanitizeText(props.browser) || 'system'}  selected{' '}
        {props.selectedIndex >= 0 ? props.selectedIndex + 1 : 0}/{props.rowCount}{activity ? `  ${activity}` : ''}
      </Text>
    </Box>
  );
}

function MainTable(props: {
  rows: readonly VisibleRow[];
  selectedIndex: number;
  config: PortwardenConfig;
  columns: number;
  pageSize: number;
  offset: number;
  all: boolean;
}) {
  const offset = clamp(props.offset, 0, Math.max(0, props.rows.length - props.pageSize));
  const visible = props.rows.slice(offset, offset + props.pageSize);
  const showKind = props.all || props.rows.some((row) => row.type !== 'listener' || row.listener.kind !== 'dev');
  const widths = tableWidths(props.columns, showKind);
  const showing = props.rows.length === 0
    ? 'empty'
    : `showing ${offset + 1}-${Math.min(offset + visible.length, props.rows.length)} of ${props.rows.length}`;
  const fillerCount = Math.max(0, props.pageSize - Math.max(1, visible.length));
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text><Text bold>PORTS</Text>  <Text dimColor>{showing}</Text></Text>
      <TableRow values={['KIND', 'PIN', 'PORT', 'PID', 'AGE', 'HOST', 'PROJECT', 'PROCESS']} widths={widths} columns={props.columns} header />
      <Text dimColor>{'-'.repeat(Math.max(1, props.columns - 1))}</Text>
      {visible.length === 0 ? (
        <Text color="yellow">  {props.all ? 'No LISTEN ports found.' : 'No relevant or pinned ports found.'}</Text>
      ) : visible.map((row, localIndex) => (
        <DataRow
          key={row.key}
          row={row}
          selected={offset + localIndex === props.selectedIndex}
          widths={widths}
          config={props.config}
          columns={props.columns}
        />
      ))}
      {Array.from({length: fillerCount}, (_, index) => <Text key={`filler:${index}`}> </Text>)}
    </Box>
  );
}

function DataRow({row, selected, widths, config, columns}: {
  row: VisibleRow;
  selected: boolean;
  widths: number[];
  config: PortwardenConfig;
  columns: number;
}) {
  if (row.type === 'group') {
    const hosts = [...new Set(row.members.map(({displayHost}) => displayHost))].join(', ');
    return (
      <TableRow
        values={[
          'APP',
          '-',
          `${row.members.length}x`,
          '-',
          '-',
          hosts,
          `${row.expanded ? 'v ' : '> '}${row.family}`,
          row.expanded ? `open · ${row.members.length} listeners · enter collapse` : `closed · ${row.members.length} listeners`,
        ]}
        widths={widths}
        columns={columns}
        selected={selected}
        color={row.expanded ? 'cyan' : 'yellow'}
      />
    );
  }
  if (row.type === 'zombie') {
    return (
      <TableRow
        values={['ZOMBIE', '-', '-', String(row.zombie.pid), formatSeconds(row.zombie.ageSeconds), '-', row.zombie.family, redactCommandLine(row.zombie.command)]}
        widths={widths}
        columns={columns}
        selected={selected}
        color="red"
      />
    );
  }
  const pinned = listenerIsPinned(row.listener, config.pinnedListenerKeys);
  return (
    <TableRow
      values={[
        row.depth ? '' : row.listener.kind.toUpperCase(),
        pinned ? 'Y' : '-',
        String(row.listener.port),
        String(row.listener.pid),
        row.listener.elapsed,
        row.listener.displayHost,
        `${row.depth ? '| ' : ''}${row.listener.displayProject || '-'}`,
        `${row.depth ? '| ' : ''}${redactCommandLine(row.listener.displayCommand || row.listener.args)}`,
      ]}
      widths={widths}
      columns={columns}
      selected={selected}
      color={undefined}
    />
  );
}

function TableRow({values, widths, columns, selected = false, header = false, color}: {
  values: readonly string[];
  widths: readonly number[];
  columns: number;
  selected?: boolean;
  header?: boolean;
  color?: string;
}) {
  const cells = values.flatMap((value, index) => {
    const width = widths[index] ?? 0;
    return width > 0 ? [padDisplayText(sanitizeText(value), width)] : [];
  });
  const line = truncateDisplayText(`${selected ? '>' : ' '} ${cells.join(' ')}`, columns);
  return <Text bold={header} dimColor={header} inverse={selected} color={color}>{line}</Text>;
}

function Details({row, config, columns, listeners}: {
  row: VisibleRow | null;
  config: PortwardenConfig;
  columns: number;
  listeners: readonly ListenerEntry[];
}) {
  const lines = detailLines(row, config, listeners);
  const label = row?.type === 'group'
    ? row.family
    : row?.type === 'listener'
      ? row.listener.displayProject || '-'
      : row?.type === 'zombie'
        ? row.zombie.family
        : '';
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end"><Text bold>DETAILS</Text>{label ? <>  <Text dimColor>{sanitizeText(label)}</Text></> : null}</Text>
      <Text dimColor>{'-'.repeat(Math.max(1, columns - 1))}</Text>
      {lines.map((line, index) => (
        <Text key={index} dimColor={index > 0} wrap="truncate-end">{line || ' '}</Text>
      ))}
    </Box>
  );
}

function detailLines(
  row: VisibleRow | null,
  config: PortwardenConfig,
  listeners: readonly ListenerEntry[],
): [string, string, string, string, string] {
  if (!row) return ['No port selected.', '', '', '', ''];
  if (row.type === 'group') {
    const ports = [...new Set(row.members.map(({port}) => port))];
    const hosts = [...new Set(row.members.map(({displayHost}) => displayHost))].filter(Boolean);
    const commands = [...new Set(row.members.map(({displayCommand}) => redactCommandLine(displayCommand)).filter(Boolean))];
    return [
      `group ${row.family}  kind APP  listeners ${row.members.length}  state ${row.expanded ? 'expanded' : 'collapsed'}`,
      `ports ${ports.slice(0, 5).join(', ')}${ports.length > 5 ? ` +${ports.length - 5}` : ''}  host ${hosts.join(', ') || '-'}`,
      `apps ${commands.slice(0, 4).join(' · ') || '-'}`,
      `hint enter ${row.expanded ? 'collapse' : 'expand'}  choose a listener to open, pin, move, or stop`,
      `proc ${commands[0] || '-'}`,
    ];
  }
  if (row.type === 'zombie') {
    return [
      `pid ${row.zombie.pid}  ppid ${row.zombie.ppid}  kind ZOMBIE  age ${formatSeconds(row.zombie.ageSeconds)}  reapable ${row.zombie.reapable ? 'YES' : 'NO'}`,
      `family ${row.zombie.family}`,
      `reason ${sanitizeText(row.zombie.reason) || '-'}`,
      `proc ${redactCommandLine(row.zombie.command)}`,
      'hint x stop  f force-stop',
    ];
  }
  const pinned = listenerIsPinned(row.listener, config.pinnedListenerKeys);
  const duplicateCount = listeners.filter(({port}) => port === row.listener.port).length;
  return [
    `port ${row.listener.port}  pid ${row.listener.pid}  kind ${row.listener.kind.toUpperCase()}  age ${row.listener.elapsed}  pin ${pinned ? 'YES' : 'NO'}`,
    `next ${nextAvailablePort(listeners, row.listener.port)}  dup ${duplicateCount > 1 ? `${duplicateCount} in use` : 'none'}  host ${row.listener.displayHost || row.listener.host}`,
    `proj ${row.listener.displayProject || '-'}`,
    `dir  ${sanitizeText(row.listener.displayCwd || row.listener.cwd) || '-'}`,
    `cmd  ${redactCommandLine(row.listener.displayCommand || row.listener.args) || '-'}`,
  ];
}

function StatusLine({busy, status, error, warning = ''}: {busy: string; status: string; error: string; warning?: string}) {
  if (error) return <Text color="red" wrap="truncate-end">error  {sanitizeText(error)}</Text>;
  if (busy) return <Text color="yellow" wrap="truncate-end">working  {sanitizeText(busy)}</Text>;
  if (warning) return <Text color="yellow" wrap="truncate-end">warning  {sanitizeText(warning)}</Text>;
  return status
    ? <Text color="green" wrap="truncate-end">info  {sanitizeText(status)}</Text>
    : <Text dimColor wrap="truncate-end">info  Ready</Text>;
}

function ConfirmationBox({confirmation}: {confirmation: Confirmation}) {
  return (
    <Text color="yellow" wrap="truncate-end">
      confirm  {sanitizeText(confirmation.title)}  enter/y confirm  esc/n cancel  {sanitizeText(confirmation.detail)}
    </Text>
  );
}

function ShortcutLine({row, columns}: {row: VisibleRow | null; columns: number}) {
  const shortcuts = row?.type === 'group'
    ? `${row.expanded ? '← collapse' : '→ expand'}  enter ${row.expanded ? 'collapse' : 'expand'}  a all/main  g graveyard  s settings  q quit  z zombies  / filter  r refresh  ? help`
    : row?.type === 'listener' && row.parentGroupKey
      ? '← collapse  m move-port  o open  p pin  x stop  f force-stop  g graveyard  s settings  q quit  z zombies  / filter  r refresh  ? help'
      : row?.type === 'zombie'
        ? 'x stop  f force-stop  a all/main  g graveyard  s settings  q quit  z hide-zombies  / filter  r refresh  ? help'
        : '←/→ reorder  a all/main  m move-port  o open  p pin  x stop  f force-stop  g graveyard  s settings  q quit  z zombies  / filter  r refresh  ? help';
  return <Text dimColor wrap="truncate-end">{truncateRawText(`keys: ${shortcuts}`, columns)}</Text>;
}

function SettingsScreen({config, selectedIndex, status, error, configPath, browserOverride, columns, terminalRows}: {
  config: PortwardenConfig;
  selectedIndex: number;
  status: string;
  error: string;
  configPath: string;
  browserOverride: string;
  columns: number;
  terminalRows: number;
}) {
  const options = [
    ['Default browser', config.browser || 'System default browser'],
    ['Confirm mode', config.confirmActions ? 'On' : 'Off'],
    ['Refresh interval', `${config.refreshSeconds}s`],
  ];
  const fillerCount = Math.max(0, terminalRows - 12 - options.length);
  return (
    <Box flexDirection="column" width={columns}>
      <Text bold color="cyan">SETTINGS</Text>
      <Text dimColor wrap="truncate-end">saved {sanitizeText(config.browser) || 'System default browser'}  confirm {config.confirmActions ? 'On' : 'Off'}  refresh {config.refreshSeconds}s</Text>
      <Text wrap="truncate-end">{browserOverride ? <Text color="yellow">This session uses browser override: {sanitizeText(browserOverride)}</Text> : ' '}</Text>
      <Text wrap="truncate-end">browser {sanitizeText(config.browser) || 'System default browser'}</Text>
      <Text>safety  {config.confirmActions ? 'Confirm destructive actions' : 'Immediate actions'}</Text>
      <Text>refresh {config.refreshSeconds}s</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text bold>PREFERENCES</Text>
        <Text dimColor>{'-'.repeat(Math.max(1, columns - 1))}</Text>
        {options.map(([label, value], index) => (
          <Text key={label} inverse={index === selectedIndex} wrap="truncate-end">{index === selectedIndex ? '> ' : '  '}{label!.padEnd(18)} {value}</Text>
        ))}
        {Array.from({length: fillerCount}, (_, index) => <Text key={`settings-filler:${index}`}> </Text>)}
      </Box>
      <Text dimColor>keys: enter/right open/toggle  ↑↓ select  s/esc/q back</Text>
      {error || status
        ? <StatusLine busy="" status={status} error={error} />
        : <Text dimColor wrap="truncate-end">info  config {sanitizeText(configPath)}</Text>}
    </Box>
  );
}

function BrowserScreen({options, selectedIndex, savedBrowser, activeBrowser, columns, terminalRows}: {
  options: readonly BrowserOption[];
  selectedIndex: number;
  savedBrowser: string;
  activeBrowser: string;
  columns: number;
  terminalRows: number;
}) {
  const pageSize = Math.max(1, terminalRows - 6);
  const offset = clamp(selectedIndex - Math.floor(pageSize / 2), 0, Math.max(0, options.length - pageSize));
  const visible = options.slice(offset, offset + pageSize);
  return (
    <Box flexDirection="column" width={columns}>
      <Text bold color="cyan">BROWSER</Text>
      <Text dimColor wrap="truncate-end">saved {sanitizeText(savedBrowser) || 'System default browser'}  active {sanitizeText(activeBrowser) || 'system'}</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text bold>BROWSER LIST</Text>
        <Text dimColor>{'-'.repeat(Math.max(1, columns - 1))}</Text>
        {visible.map((option, index) => {
          const absoluteIndex = offset + index;
          const saved = option.value === savedBrowser || (!option.value && !savedBrowser);
          const active = option.value === activeBrowser || (!option.value && !activeBrowser);
          const suffix = saved && active ? '  saved · active' : saved ? '  saved' : active ? '  active' : '';
          return (
            <Text
              key={`${option.label}:${option.value}`}
              inverse={absoluteIndex === selectedIndex}
              color={saved ? 'green' : active ? 'cyan' : undefined}
              wrap="truncate-end"
            >
              {absoluteIndex === selectedIndex ? '> ' : '  '}{option.label}{suffix}
            </Text>
          );
        })}
        {Array.from({length: Math.max(0, pageSize - visible.length)}, (_, index) => <Text key={`browser-filler:${index}`}> </Text>)}
      </Box>
      <Text dimColor>keys: enter save  ↑↓ select  s/esc/q back</Text>
    </Box>
  );
}

function GraveyardScreen(props: {
  records: readonly GraveyardRecord[];
  selectedIndex: number;
  listeners: readonly ListenerEntry[];
  status: string;
  error: string;
  busy: string;
  warning: string;
  columns: number;
  terminalRows: number;
  confirmation: Confirmation | null;
}) {
  const selected = props.records[props.selectedIndex];
  const pageSize = Math.max(1, props.terminalRows - 9);
  const offset = clamp(props.selectedIndex - Math.floor(pageSize / 2), 0, Math.max(0, props.records.length - pageSize));
  const visible = props.records.slice(offset, offset + pageSize);
  return (
    <Box flexDirection="column" width={props.columns}>
      <Text bold color="cyan">GRAVEYARD  (kills 보관소)</Text>
      <Text dimColor>total {props.records.length}  logs ~/.portwarden/logs/&lt;slug&gt;.log</Text>
      <Box flexDirection="column" marginTop={1}>
        {props.records.length === 0 ? (
          <Text dimColor>아직 x / f 로 죽인 항목이 없습니다.</Text>
        ) : (
          <>
            <Text dimColor>  PORT   PROJECT               STATE  KILLED               CMD</Text>
            <Text dimColor>{'-'.repeat(Math.max(1, props.columns - 1))}</Text>
          </>
        )}
        {visible.map((record, index) => {
          const alive = props.listeners.some(({port}) => port === record.port);
          const command = formatCommandForDisplay({argv: record.argv, env: record.env});
          return (
            <Text key={record.id} inverse={offset + index === props.selectedIndex} color={alive ? 'green' : 'gray'} wrap="truncate-end">
              {offset + index === props.selectedIndex ? '> ' : '  '}
              {String(record.port).padEnd(7)}{padDisplayText(record.project, 21)} {(alive ? 'alive' : 'dead').padEnd(7)}
              {fitText(formatCapturedAt(record.capturedAt), 19).padEnd(20)}{command}
            </Text>
          );
        })}
        {Array.from({length: Math.max(0, pageSize - Math.max(1, visible.length))}, (_, index) => <Text key={`graveyard-filler:${index}`}> </Text>)}
      </Box>
      {selected ? (
        <Box flexDirection="column">
          <Text dimColor wrap="truncate-end">cwd {sanitizeText(selected.cwd)}</Text>
          <Text dimColor wrap="truncate-end">cmd {formatCommandForDisplay({argv: selected.argv, env: selected.env})}</Text>
        </Box>
      ) : <><Text> </Text><Text> </Text></>}
      <Text dimColor>keys: r revive  d drop  ↑↓ select  g/s/esc/q back</Text>
      {props.confirmation
        ? <ConfirmationBox confirmation={props.confirmation} />
        : <StatusLine busy={props.busy} status={props.status} error={props.error} warning={props.warning} />}
    </Box>
  );
}

function HelpScreen() {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">HELP</Text>
      <Text dimColor>PORTWARDEN keyboard reference</Text>
      <Text> </Text>
      <Text>↑/↓      move selection</Text>
      <Text>←/→      reorder a listener · collapse/expand a group</Text>
      <Text>enter    expand/collapse an app group</Text>
      <Text>a        toggle main/all LISTEN ports</Text>
      <Text>z        show/hide orphaned browser-automation processes</Text>
      <Text>p        pin/unpin one listener (pinned listeners cannot be stopped)</Text>
      <Text>o / m    open in browser / safely move to the next verified port</Text>
      <Text>x / f    SIGTERM / SIGKILL</Text>
      <Text>g / s    graveyard / settings</Text>
      <Text>/ / r    filter / refresh</Text>
      <Text>? / q    close help / quit</Text>
      <Text dimColor>Press esc, ?, or q to return.</Text>
    </Box>
  );
}

function useTerminalSize(): {columns: number; rows: number} {
  const {stdout} = useStdout();
  const [size, setSize] = useState(() => ({columns: stdout.columns || 120, rows: stdout.rows || 30}));
  useEffect(() => {
    const update = () => setSize({columns: stdout.columns || 120, rows: stdout.rows || 30});
    stdout.on('resize', update);
    return () => {
      stdout.off('resize', update);
    };
  }, [stdout]);
  return size;
}

function tableWidths(columns: number, showKind: boolean): number[] {
  const available = Math.max(1, columns - 2);
  if (columns < 32) {
    return [0, 0, 6, 0, 0, 0, 0, Math.max(1, available - 7)];
  }
  if (columns < 50) {
    return [0, 0, 6, 7, 0, 0, 10, Math.max(1, available - 26)];
  }
  if (columns < 65) {
    const kind = showKind ? 6 : 0;
    const process = Math.max(8, available - kind - 3 - 5 - 6 - 14 - (showKind ? 5 : 4));
    return [kind, 3, 5, 6, 0, 0, 14, process];
  }
  if (columns < 80) {
    const kind = showKind ? 6 : 0;
    const process = Math.max(10, available - kind - 3 - 5 - 6 - 8 - 14 - (showKind ? 6 : 5));
    return [kind, 3, 5, 6, 8, 0, 14, process];
  }
  const usable = Math.max(80, columns - 2);
  const kind = showKind ? 6 : 0;
  const pin = 3;
  const port = 5;
  const pid = 6;
  const age = 8;
  const host = Math.max(10, Math.floor(usable * 0.14));
  const project = Math.max(16, Math.floor(usable * 0.18));
  const fixed = kind + pin + port + pid + age + host + project;
  const spaces = showKind ? 8 : 7;
  const process = Math.max(24, usable - fixed - spaces);
  return [kind, pin, port, pid, age, host, project, process];
}

function nextAvailablePort(listeners: readonly ListenerEntry[], currentPort: number): number | '-' {
  const used = new Set(listeners.map(({port}) => port));
  for (let port = currentPort + 1; port <= 65_535; port += 1) {
    if (!used.has(port)) return port;
  }
  return '-';
}

function fitText(value: string, width: number): string {
  return truncateDisplayText(sanitizeText(value), width);
}

function truncateRawText(value: string, width: number): string {
  return truncateDisplayText(value, width);
}

function padDisplayText(value: string, width: number): string {
  const text = truncateDisplayText(value, width);
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

function truncateDisplayText(value: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(value) <= width) return value;
  if (width === 1) return '…';
  const target = width - 1;
  let result = '';
  let used = 0;
  for (const character of value) {
    const characterWidth = displayCharacterWidth(character);
    if (used + characterWidth > target) break;
    result += character;
    used += characterWidth;
  }
  return `${result}…`;
}

function displayWidth(value: string): number {
  let width = 0;
  for (const character of value) width += displayCharacterWidth(character);
  return width;
}

function displayCharacterWidth(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f || codePoint === 0x2329 || codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) ? 2 : 1;
}

function formatClock(date: Date): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function formatSeconds(seconds: number | null): string {
  if (seconds === null) return '-';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, '0')).join(':');
}

function formatCapturedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? sanitizeText(value) : date.toLocaleString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
