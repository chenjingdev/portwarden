import {useEffect, useMemo, useRef, useState} from 'react';

import {Box, Text, useApp, useInput, useStdout} from 'ink';

import {openInBrowser} from '../browser.js';
import type {ConfigRepository, GraveyardRecord, PortwardenConfig} from '../config.js';
import {formatCommandForDisplay, redactCommandLine, sanitizeText} from '../core/commands.js';
import {PortwardenActions, type ActionOutcome, type StopSignal} from '../core/actions.js';
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
}

const BROWSERS = [
  {label: 'System default', value: ''},
  {label: 'Google Chrome', value: 'Google Chrome'},
  {label: 'Safari', value: 'Safari'},
  {label: 'Firefox', value: 'Firefox'},
  {label: 'Arc', value: 'Arc'},
  {label: 'Brave Browser', value: 'Brave Browser'},
  {label: 'Microsoft Edge', value: 'Microsoft Edge'},
];
const REFRESH_INTERVALS = [1, 2, 5, 10];

export function PortwardenApp({
  configRepository,
  initialAll = false,
  initialZombies = false,
  browserOverride = '',
}: PortwardenAppProps) {
  const {exit} = useApp();
  const {columns, rows: terminalRows} = useTerminalSize();
  const [config, setConfig] = useState(() => configRepository.get());
  const [all, setAll] = useState(initialAll);
  const [showZombies, setShowZombies] = useState(initialZombies);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [screen, setScreen] = useState<Screen>('main');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [settingsIndex, setSettingsIndex] = useState(0);
  const [browserIndex, setBrowserIndex] = useState(0);
  const [graveyardIndex, setGraveyardIndex] = useState(0);
  const [query, setQuery] = useState('');
  const [filterDraft, setFilterDraft] = useState('');
  const [filterMode, setFilterMode] = useState(false);
  const [status, setStatus] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const selectionIndexHint = useRef(0);
  const actions = useMemo(() => new PortwardenActions(configRepository), [configRepository]);
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

  useEffect(() => {
    if (selectedIndex >= 0) {
      selectionIndexHint.current = selectedIndex;
    }
  }, [selectedIndex]);

  useEffect(() => {
    if (visibleRows.length === 0) {
      setSelectedKey(null);
    } else if (!selectedKey || !visibleRows.some(({key}) => key === selectedKey)) {
      setSelectedKey(visibleRows[Math.min(Math.max(effectiveSelectedIndex, 0), visibleRows.length - 1)]?.key ?? null);
    }
  }, [effectiveSelectedIndex, selectedKey, visibleRows]);

  useEffect(() => {
    setGraveyardIndex((current) => clamp(current, 0, Math.max(0, config.graveyard.length - 1)));
  }, [config.graveyard.length]);

  const refreshConfig = () => setConfig(configRepository.get());
  const saveConfig = (patch: Partial<PortwardenConfig>, message = '') => {
    try {
      const saved = configRepository.update(patch);
      setConfig(saved);
      setActionError('');
      if (message) setStatus(message);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  };

  const runAction = async (label: string, action: () => Promise<ActionOutcome | string>) => {
    setBusy(label);
    setActionError('');
    try {
      const result = await action();
      setStatus(typeof result === 'string' ? result : result.message);
      refreshConfig();
      scanner.refresh();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy('');
    }
  };

  const queueAction = (title: string, detail: string, action: () => Promise<void>) => {
    if (config.confirmActions) {
      setConfirmation({title, detail, action});
    } else {
      void action();
    }
  };

  const moveMainSelection = (delta: number) => {
    if (visibleRows.length === 0) return;
    const next = clamp(effectiveSelectedIndex + delta, 0, visibleRows.length - 1);
    selectionIndexHint.current = next;
    setSelectedKey(visibleRows[next]?.key ?? null);
  };

  const toggleSelectedPin = () => {
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
    if (selectedRow?.type !== 'listener') {
      if (selectedRow?.type === 'group') toggleGroup(selectedRow, direction > 0);
      return;
    }
    const selectedPinned = listenerIsPinned(selectedRow.listener, config.pinnedListenerKeys);
    const section = scanner.listeners.filter((listener) => listenerIsPinned(listener, config.pinnedListenerKeys) === selectedPinned);
    const index = section.findIndex((listener) => selectionKey(listener) === selectionKey(selectedRow.listener));
    const target = index + direction;
    if (index < 0 || target < 0 || target >= section.length) {
      setStatus('Already at the edge of this section.');
      return;
    }
    const reordered = [...section];
    [reordered[index], reordered[target]] = [reordered[target]!, reordered[index]!];
    const presentKeys = new Set(scanner.listeners.flatMap((listener) => [
      ...listenerKeys(listener),
      preferenceKey(listener),
      selectionKey(listener),
    ]));
    const otherVisible = scanner.listeners
      .filter((listener) => listenerIsPinned(listener, config.pinnedListenerKeys) !== selectedPinned)
      .map(listenerKey);
    const staleSaved = config.orderedEntryKeys.filter((key) => !presentKeys.has(key));
    saveConfig(
      {orderedEntryKeys: [...reordered.map(listenerKey), ...otherVisible, ...staleSaved]},
      `Moved ${selectedRow.listener.displayProject || selectedRow.listener.command} ${direction < 0 ? 'up' : 'down'}.`,
    );
  };

  const toggleGroup = (row: Extract<VisibleRow, {type: 'group'}>, force?: boolean) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      const expand = force ?? !next.has(row.key);
      if (expand) next.add(row.key);
      else next.delete(row.key);
      return next;
    });
  };

  const stopSelected = (signal: StopSignal) => {
    if (!selectedRow || selectedRow.type === 'group') {
      setActionError(selectedRow ? 'Expand the group and select one process first.' : 'No process selected.');
      return;
    }
    const target = selectedRow.type === 'listener'
      ? `${selectedRow.listener.displayProject || selectedRow.listener.command}:${selectedRow.listener.port}`
      : `${selectedRow.zombie.family} PID ${selectedRow.zombie.pid}`;
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
    queueAction(
      `Move ${listener.displayProject || listener.command}:${listener.port}?`,
      'Portwarden starts and verifies the new listener before stopping the original.',
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
        browserOverride || config.browser,
      );
      return `Opened ${url}.`;
    });
  };

  const reviveSelected = () => {
    const record = config.graveyard[graveyardIndex];
    if (!record) return;
    queueAction(
      `Revive ${record.project}:${record.port}?`,
      'The record stays in the graveyard until the expected listener is verified.',
      async () => runAction('Reviving…', () => actions.revive(record)),
    );
  };

  const discardSelected = () => {
    const record = config.graveyard[graveyardIndex];
    if (!record) return;
    queueAction(
      `Discard ${record.project}:${record.port}?`,
      'This removes only the saved relaunch record.',
      async () => runAction('Discarding…', async () => actions.discard(record)),
    );
  };

  useInput((input, key) => {
    if (busy) return;
    const normalized = normalizeShortcut(input, key);

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
        setQuery(filterDraft.trim());
        setFilterMode(false);
        setStatus(filterDraft.trim() ? `Filter: ${filterDraft.trim()}` : 'Filter cleared.');
      } else if (key.escape) {
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
      if (key.upArrow) setBrowserIndex((value) => clamp(value - 1, 0, browserOptions(config.browser).length - 1));
      else if (key.downArrow) setBrowserIndex((value) => clamp(value + 1, 0, browserOptions(config.browser).length - 1));
      else if (key.return) {
        const option = browserOptions(config.browser)[browserIndex];
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
          const options = browserOptions(config.browser);
          setBrowserIndex(Math.max(0, options.findIndex(({value}) => value === config.browser)));
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

    if (key.ctrl && normalized === 'c') {
      exit();
    } else if (key.upArrow) {
      moveMainSelection(-1);
    } else if (key.downArrow) {
      moveMainSelection(1);
    } else if (key.leftArrow) {
      if (selectedRow?.type === 'group') toggleGroup(selectedRow, false);
      else reorderSelected(-1);
    } else if (key.rightArrow) {
      if (selectedRow?.type === 'group') toggleGroup(selectedRow, true);
      else reorderSelected(1);
    } else if (key.return && selectedRow?.type === 'group') {
      toggleGroup(selectedRow);
    } else if (normalized === 'q') {
      exit();
    } else if (normalized === 'a') {
      setAll((value) => !value);
      setStatus(all ? 'Showing pinned + dev ports.' : 'Showing all LISTEN ports.');
    } else if (normalized === 'z') {
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
      refreshConfig();
      setScreen('graveyard');
    } else if (normalized === 's') {
      setScreen('settings');
    } else if (normalized === 'r') {
      scanner.refresh();
      setStatus('Refreshing…');
    } else if (normalized === '?') {
      setScreen('help');
    } else if (normalized === '/') {
      setFilterDraft(query);
      setFilterMode(true);
    } else if (key.escape && query) {
      setQuery('');
      setStatus('Filter cleared.');
    }
  });

  if (screen === 'settings') {
    return <SettingsScreen config={config} selectedIndex={settingsIndex} status={status} error={actionError} />;
  }
  if (screen === 'browser') {
    return <BrowserScreen options={browserOptions(config.browser)} selectedIndex={browserIndex} />;
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
        columns={columns}
        terminalRows={terminalRows}
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
        listenerCount={scanner.listeners.length}
        zombieCount={scanner.zombies.length}
        loading={scanner.loading}
        refreshing={scanner.refreshing}
        updatedAt={scanner.updatedAt}
        error={scanner.error}
      />
      {filterMode ? (
        <Text color="yellow">filter / {filterDraft}<Text inverse> </Text></Text>
      ) : query ? (
        <Text color="yellow">filter: {query}  <Text dimColor>(esc clear)</Text></Text>
      ) : null}
      <MainTable
        rows={visibleRows}
        selectedIndex={effectiveSelectedIndex}
        config={config}
        columns={columns}
        terminalRows={terminalRows}
      />
      <Details row={selectedRow} config={config} columns={columns} />
      {confirmation ? (
        <ConfirmationBox confirmation={confirmation} />
      ) : (
        <StatusLine busy={busy} status={status} error={actionError || scanner.error} />
      )}
      <Text dimColor>
        ↑↓ select  ←→ reorder  a all  z zombies  p pin  o open  m move  x stop  f force-stop  g graveyard  s settings  / filter  ? help  q quit
      </Text>
    </Box>
  );
}

function MainHeader(props: {
  all: boolean;
  showZombies: boolean;
  listenerCount: number;
  zombieCount: number;
  loading: boolean;
  refreshing: boolean;
  updatedAt: Date | null;
  error: string;
}) {
  const activity = props.loading ? 'scanning…' : props.refreshing ? 'refreshing…' : props.error ? 'degraded' : 'ready';
  return (
    <Box justifyContent="space-between">
      <Text bold color="cyan">
        PORTWARDEN  <Text color="white">[{props.all ? 'ALL' : 'DEV'}]</Text> <Text color="green">[{props.listenerCount} ports]</Text>{' '}
        {props.showZombies ? <Text color={props.zombieCount ? 'red' : 'gray'}>[{props.zombieCount} zombies]</Text> : null}
      </Text>
      <Text color={props.error ? 'red' : props.refreshing || props.loading ? 'yellow' : 'gray'}>
        {activity}{props.updatedAt ? ` · ${formatClock(props.updatedAt)}` : ''}
      </Text>
    </Box>
  );
}

function MainTable(props: {
  rows: readonly VisibleRow[];
  selectedIndex: number;
  config: PortwardenConfig;
  columns: number;
  terminalRows: number;
}) {
  const pageSize = Math.max(3, props.terminalRows - 12);
  const offset = props.selectedIndex < 0
    ? 0
    : clamp(props.selectedIndex - Math.floor(pageSize / 2), 0, Math.max(0, props.rows.length - pageSize));
  const visible = props.rows.slice(offset, offset + pageSize);
  const widths = tableWidths(props.columns);
  return (
    <Box flexDirection="column" marginTop={1}>
      <TableRow values={['KIND', 'PIN', 'PORT', 'PID', 'AGE', 'HOST', 'PROJECT', 'PROCESS']} widths={widths} header />
      {visible.length === 0 ? (
        <Text dimColor>No matching LISTEN ports or zombies.</Text>
      ) : visible.map((row, localIndex) => (
        <DataRow
          key={row.key}
          row={row}
          selected={offset + localIndex === props.selectedIndex}
          widths={widths}
          config={props.config}
        />
      ))}
      {props.rows.length > pageSize ? (
        <Text dimColor>{offset + 1}–{Math.min(offset + pageSize, props.rows.length)} / {props.rows.length}</Text>
      ) : null}
    </Box>
  );
}

function DataRow({row, selected, widths, config}: {
  row: VisibleRow;
  selected: boolean;
  widths: number[];
  config: PortwardenConfig;
}) {
  if (row.type === 'group') {
    const hosts = [...new Set(row.members.map(({displayHost}) => displayHost))].join(', ');
    const pinned = row.members.every((listener) => listenerIsPinned(listener, config.pinnedListenerKeys));
    return (
      <TableRow
        values={['app', pinned ? '●' : '-', `${row.members.length}×`, '-', '-', hosts, row.family, `${row.expanded ? '▾' : '▸'} ${row.members.length} listeners` ]}
        widths={widths}
        selected={selected}
        color={pinned ? 'cyan' : 'magenta'}
      />
    );
  }
  if (row.type === 'zombie') {
    return (
      <TableRow
        values={['zombie', '-', '-', String(row.zombie.pid), formatSeconds(row.zombie.ageSeconds), '-', row.zombie.family, redactCommandLine(row.zombie.command)]}
        widths={widths}
        selected={selected}
        color="red"
      />
    );
  }
  const pinned = listenerIsPinned(row.listener, config.pinnedListenerKeys);
  return (
    <TableRow
      values={[
        row.listener.kind,
        pinned ? '●' : '-',
        String(row.listener.port),
        String(row.listener.pid),
        row.listener.elapsed,
        row.listener.displayHost,
        `${row.depth ? '  ↳ ' : ''}${row.listener.displayProject || '-'}`,
        redactCommandLine(row.listener.args || row.listener.displayCommand),
      ]}
      widths={widths}
      selected={selected}
      color={pinned ? 'cyan' : row.listener.kind === 'dev' ? 'green' : undefined}
    />
  );
}

function TableRow({values, widths, selected = false, header = false, color}: {
  values: readonly string[];
  widths: readonly number[];
  selected?: boolean;
  header?: boolean;
  color?: string;
}) {
  return (
    <Box>
      {values.map((value, index) => widths[index] && widths[index]! > 0 ? (
        <Box key={index} width={widths[index]} paddingRight={1}>
          <Text bold={header} dimColor={header} inverse={selected} color={color} wrap="truncate-end">
            {sanitizeText(value)}
          </Text>
        </Box>
      ) : null)}
    </Box>
  );
}

function Details({row, config, columns}: {row: VisibleRow | null; config: PortwardenConfig; columns: number}) {
  if (!row) {
    return <Box marginTop={1}><Text dimColor>No selection.</Text></Box>;
  }
  if (row.type === 'group') {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>DETAILS  <Text color="magenta">{row.family}</Text> · {row.members.length} listeners · {row.expanded ? 'expanded' : 'collapsed'}</Text>
        <Text dimColor>enter/←/→ {row.expanded ? 'collapse' : 'expand'} · choose a child listener before pin/open/move/stop</Text>
      </Box>
    );
  }
  if (row.type === 'zombie') {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>DETAILS  <Text color="red">ZOMBIE</Text> · pid {row.zombie.pid} · ppid {row.zombie.ppid} · age {formatSeconds(row.zombie.ageSeconds)} · reapable {row.zombie.reapable ? 'yes' : 'no'}</Text>
        <Text wrap="truncate-end">{redactCommandLine(row.zombie.command).slice(0, Math.max(10, columns - 1))}</Text>
        <Text dimColor>{sanitizeText(row.zombie.reason)} · x stop · f force-stop</Text>
      </Box>
    );
  }
  const pinned = listenerIsPinned(row.listener, config.pinnedListenerKeys);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>
        DETAILS  port <Text color="cyan">{row.listener.port}</Text> · pid {row.listener.pid} · {row.listener.kind} · age {row.listener.elapsed} · pin {pinned ? 'yes' : 'no'}
      </Text>
      <Text wrap="truncate-end">cwd {sanitizeText(row.listener.displayCwd || row.listener.cwd) || '-'}</Text>
      <Text dimColor wrap="truncate-end">cmd {redactCommandLine(row.listener.args || row.listener.displayCommand)}</Text>
    </Box>
  );
}

function StatusLine({busy, status, error}: {busy: string; status: string; error: string}) {
  return (
    <Box marginTop={1}>
      {error ? <Text color="red">error  {sanitizeText(error)}</Text>
        : busy ? <Text color="yellow">working  {busy}</Text>
          : <Text color="cyan">info  {sanitizeText(status) || 'Ready.'}</Text>}
    </Box>
  );
}

function ConfirmationBox({confirmation}: {confirmation: Confirmation}) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text bold color="yellow">{confirmation.title}</Text>
      <Text>{confirmation.detail}</Text>
      <Text dimColor>enter/y confirm · esc/n cancel</Text>
    </Box>
  );
}

function SettingsScreen({config, selectedIndex, status, error}: {
  config: PortwardenConfig;
  selectedIndex: number;
  status: string;
  error: string;
}) {
  const options = [
    ['Default browser', config.browser || 'System default'],
    ['Confirm actions', config.confirmActions ? 'On' : 'Off'],
    ['Refresh interval', `${config.refreshSeconds}s`],
  ];
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">PORTWARDEN  [SETTINGS]</Text>
      <Text dimColor>enter change · ↑↓ select · esc/s/q back</Text>
      <Box flexDirection="column" marginTop={1}>
        {options.map(([label, value], index) => (
          <Text key={label} inverse={index === selectedIndex}>{label!.padEnd(20)} {value}</Text>
        ))}
      </Box>
      <StatusLine busy="" status={status} error={error} />
    </Box>
  );
}

function BrowserScreen({options, selectedIndex}: {options: ReturnType<typeof browserOptions>; selectedIndex: number}) {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">PORTWARDEN  [BROWSER]</Text>
      <Text dimColor>enter save · ↑↓ select · esc/q back</Text>
      <Box flexDirection="column" marginTop={1}>
        {options.map((option, index) => (
          <Text key={`${option.label}:${option.value}`} inverse={index === selectedIndex}>{option.label}</Text>
        ))}
      </Box>
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
  columns: number;
  terminalRows: number;
}) {
  const selected = props.records[props.selectedIndex];
  const pageSize = Math.max(3, props.terminalRows - 10);
  const offset = clamp(props.selectedIndex - Math.floor(pageSize / 2), 0, Math.max(0, props.records.length - pageSize));
  return (
    <Box flexDirection="column" width={props.columns}>
      <Text bold color="cyan">PORTWARDEN  [GRAVEYARD] <Text color="gray">[{props.records.length} saved]</Text></Text>
      <Text dimColor>↑↓ select · r revive · d discard · esc/g/s/q back</Text>
      <Box flexDirection="column" marginTop={1}>
        {props.records.length === 0 ? <Text dimColor>The graveyard is empty.</Text> : props.records.slice(offset, offset + pageSize).map((record, index) => {
          const alive = props.listeners.some(({port}) => port === record.port);
          return (
            <Text key={record.id} inverse={offset + index === props.selectedIndex} color={alive ? 'green' : 'gray'}>
              {alive ? 'alive' : 'dead '}  :{String(record.port).padEnd(6)}  {record.project.padEnd(20)}  {formatCapturedAt(record.capturedAt)}
            </Text>
          );
        })}
      </Box>
      {selected ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>cwd {sanitizeText(selected.cwd)}</Text>
          <Text dimColor wrap="truncate-end">cmd {formatCommandForDisplay({argv: selected.argv, env: selected.env})}</Text>
        </Box>
      ) : null}
      <StatusLine busy={props.busy} status={props.status} error={props.error} />
    </Box>
  );
}

function HelpScreen() {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">PORTWARDEN  [HELP]</Text>
      <Text>↑/↓      move selection</Text>
      <Text>←/→      reorder a listener · collapse/expand an app group</Text>
      <Text>a        toggle dev/all LISTEN ports</Text>
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

function tableWidths(columns: number): number[] {
  if (columns < 32) {
    return [0, 0, 6, 0, 0, 0, 0, Math.max(1, columns - 6)];
  }
  if (columns < 50) {
    return [0, 0, 6, 7, 0, 0, 10, Math.max(1, columns - 23)];
  }
  if (columns < 74) {
    return [7, 3, 6, 7, 0, 0, 15, Math.max(12, columns - 38)];
  }
  if (columns < 100) {
    return [8, 4, 7, 8, 0, 12, 18, Math.max(16, columns - 57)];
  }
  return [9, 4, 7, 8, 12, 14, 20, Math.max(20, columns - 74)];
}

function browserOptions(current: string): Array<{label: string; value: string}> {
  return current && !BROWSERS.some(({value}) => value === current)
    ? [...BROWSERS, {label: current, value: current}]
    : BROWSERS;
}

function formatClock(date: Date): string {
  return date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'});
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
