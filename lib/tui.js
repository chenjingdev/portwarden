const { buildBrowserUrl, openUrlInBrowser } = require("./browser");
const {
  describeConfirmMode,
  ensureSettingsSelectionVisible,
  getConfigPath,
  loadConfig,
  moveSettingsSelection,
  normalizeBrowserName,
  refreshResolvedBrowser,
  refreshSettingsOptions,
  resolveBrowserPreference,
  saveConfig,
} = require("./config");
const { KEY_POSITION_ALIASES, MAIN_SHORTCUTS, SETTINGS_BROWSER_SHORTCUTS, SETTINGS_MENU_SHORTCUTS } = require("./constants");
const {
  buildPortCounts,
  buildRelaunchCommand,
  collectAllListeners,
  getEntryPreferenceKey,
  findNextAvailablePort,
  getSelectionKey,
  launchDetachedCommand,
  selectListeners,
  waitForPortListener,
} = require("./ports");
const { clamp, colorize, dim, formatTimestamp, padDisplay, renderShortcutLine, truncate, truncateDisplay } = require("./utils");

function startTui(options) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("TUI mode can only run inside a TTY terminal.");
  }

  const state = createTuiState(options, loadConfig());
  refreshSettingsOptions(state);
  const refreshIntervalMs = Math.max(500, Math.round(state.refreshSeconds * 1000));
  let cleanedUp = false;
  let refreshTimer = null;

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;

    process.stdout.write("\x1b[?25h\x1b[?1049l");
    process.stdin.removeListener("data", onData);
    process.stdout.removeListener("resize", onResize);
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  };

  const exit = (code = 0) => {
    cleanup();
    process.exit(code);
  };

  const render = () => {
    renderTui(state);
  };

  const refresh = (reason = "manual", preferredSelectionKey = null) => {
    refreshTuiData(state, reason, preferredSelectionKey);
    render();
  };

  const actions = {
    clearPendingAction: () => {
      if (clearPendingAction(state)) {
        render();
      }
    },
    closeSettingsBrowser: () => {
      closeSettingsBrowserScreen(state);
      render();
    },
    closeSettings: () => {
      closeSettingsView(state);
      render();
    },
    exit,
    moveSelectionDown: () => {
      moveSelection(state, "down");
      render();
    },
    moveSelectionOrderDown: () => {
      moveSelectedEntryOrder(state, "down");
      render();
    },
    moveSelectionOrderUp: () => {
      moveSelectedEntryOrder(state, "up");
      render();
    },
    moveSelectionUp: () => {
      moveSelection(state, "up");
      render();
    },
    moveSettingsDown: () => {
      moveSettingsSelection(state, "down");
      render();
    },
    moveSettingsUp: () => {
      moveSettingsSelection(state, "up");
      render();
    },
    openSelectedInBrowser: () => {
      openSelectedEntryInBrowser(state);
      render();
    },
    openSettings: () => {
      openSettingsView(state);
      render();
    },
    queueKillSelected: (signal) => {
      const entry = getSelectedEntry(state);
      if (
        queuePendingAction(
          state,
          entry
            ? signal === "SIGKILL"
              ? `Force stop: ${entry.port} / PID ${entry.pid}`
              : `Stop: ${entry.port} / PID ${entry.pid}`
            : signal === "SIGKILL"
              ? "Force stop"
              : "Stop",
          () => killSelectedEntry(state, signal, refresh, render)
        )
      ) {
        render();
      }
    },
    queueMoveToNextPort: () => {
      const entry = getSelectedEntry(state);
      if (!entry) {
        state.status = "No port selected.";
        render();
        return;
      }
      const nextPort = findNextAvailablePort(state.allListeners, entry.port);
      if (queuePendingAction(state, `Move port: ${entry.port} -> ${nextPort}`, () => moveSelectedEntryToNextPort(state, { render, refresh }))) {
        render();
      }
    },
    refresh,
    render,
    activateSelectedSettingsItem: () => {
      activateSelectedSettingsItem(state);
      render();
    },
    toggleSelectedPin: () => {
      toggleSelectedEntryPinned(state);
      render();
    },
  };

  const onResize = () => {
    render();
  };

  const onData = (chunk) => {
    for (const rawKey of tokenizeTuiInput(String(chunk))) {
      const key = normalizeTuiKey(rawKey);
      handleTuiKey(state, key, actions);
    }
  };

  process.once("SIGINT", () => exit(0));
  process.once("SIGTERM", () => exit(0));
  process.once("uncaughtException", (error) => {
    cleanup();
    console.error(error.stack || error.message);
    process.exit(1);
  });

  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onData);
  process.stdout.on("resize", onResize);
  refreshTimer = setInterval(() => {
    refresh("auto");
  }, refreshIntervalMs);

  refresh("initial");
}

function normalizeTuiKey(key) {
  if (!key) {
    return key;
  }

  if (key.length !== 1) {
    return key;
  }

  const normalized = key.normalize("NFKC").toLowerCase();
  return KEY_POSITION_ALIASES.get(normalized) || normalized;
}

function tokenizeTuiInput(input) {
  const tokens = [];

  for (let index = 0; index < input.length; ) {
    const arrowToken = input.slice(index, index + 3);
    if (
      arrowToken === "\u001b[A" ||
      arrowToken === "\u001b[B" ||
      arrowToken === "\u001b[C" ||
      arrowToken === "\u001b[D"
    ) {
      tokens.push(arrowToken);
      index += 3;
      continue;
    }

    const codePoint = input.codePointAt(index);
    const char = String.fromCodePoint(codePoint);
    tokens.push(char);
    index += char.length;
  }

  return tokens;
}

function refreshTuiData(state, reason = "manual", preferredSelectionKey = null) {
  try {
    const previousSelectionKey = preferredSelectionKey || getCurrentSelectionKey(state);
    const allListeners = collectAllListeners();
    state.allListeners = allListeners;
    state.visibleListeners = selectListeners(allListeners, { all: false }, state.config);
    state.portCounts = buildPortCounts(allListeners);
    state.usedPorts = new Set(allListeners.map((entry) => entry.port));
    preserveSelection(state, previousSelectionKey);
    state.lastRefreshAt = new Date();
    if (reason === "manual" || reason === "initial") {
      state.status = `Refreshed: ${formatTimestamp(state.lastRefreshAt)}`;
      state.error = "";
    } else if (reason !== "auto") {
      state.error = "";
    }
  } catch (error) {
    state.error = error.message;
    state.status = "";
  }
}

function queuePendingAction(state, label, run) {
  if (!state.config.confirmActions) {
    run();
    return false;
  }

  state.pendingAction = { label, run };
  state.error = "";
  return true;
}

function clearPendingAction(state) {
  if (!state.pendingAction) {
    return false;
  }

  state.pendingAction = null;
  return true;
}

function openSettingsView(state) {
  state.view = "settings";
  state.settingsScreen = "menu";
  state.pendingAction = null;
  refreshSettingsOptions(state);
}

function openSettingsBrowserScreen(state) {
  state.settingsScreen = "browser";
  refreshSettingsOptions(state);
}

function closeSettingsBrowserScreen(state) {
  state.settingsScreen = "menu";
}

function closeSettingsView(state) {
  state.view = "list";
  state.settingsScreen = "menu";
}

function getSelectedEntry(state) {
  return state.visibleListeners[state.selectedIndex] || null;
}

function getVisibleEntryKeys(entries) {
  return entries.map((entry) => getEntryPreferenceKey(entry));
}

function isEntryPinned(state, entry) {
  const entryKey = getEntryPreferenceKey(entry);
  return state.config.pinnedEntryKeys.includes(entryKey);
}

function getPinnedVisibleEntryKeys(state) {
  return getVisibleEntryKeys(state.visibleListeners.filter((entry) => isEntryPinned(state, entry)));
}

function getUnpinnedVisibleEntryKeys(state) {
  return getVisibleEntryKeys(state.visibleListeners.filter((entry) => !isEntryPinned(state, entry)));
}

function rebuildOrderedEntryKeys(state, nextVisibleEntryKeys) {
  const visibleKeySet = new Set(nextVisibleEntryKeys);
  const preservedKeys = state.config.orderedEntryKeys.filter((entryKey) => !visibleKeySet.has(entryKey));
  return [...nextVisibleEntryKeys, ...preservedKeys];
}

function rebuildPinnedEntryKeys(state, nextPinnedVisibleEntryKeys, entryKeyToRemove = "") {
  const visibleKeySet = new Set(getVisibleEntryKeys(state.visibleListeners));
  const preservedKeys = state.config.pinnedEntryKeys.filter(
    (entryKey) => entryKey !== entryKeyToRemove && !visibleKeySet.has(entryKey)
  );
  return [...nextPinnedVisibleEntryKeys, ...preservedKeys];
}

function persistEntryPreferences(state, nextConfig, statusMessage, preferredSelectionKey) {
  try {
    saveConfig(nextConfig);
    state.config = nextConfig;
    state.error = "";
    refreshTuiData(state, "preferences", preferredSelectionKey);
    state.status = statusMessage;
    return true;
  } catch (error) {
    state.error = `Failed to save list preferences: ${error.message}`;
    return false;
  }
}

function moveSelectedEntryOrder(state, direction) {
  const entry = getSelectedEntry(state);
  if (!entry) {
    state.status = "No port selected.";
    return;
  }

  const entryKey = getEntryPreferenceKey(entry);
  const entryPinned = isEntryPinned(state, entry);
  const pinnedKeys = getPinnedVisibleEntryKeys(state);
  const unpinnedKeys = getUnpinnedVisibleEntryKeys(state);
  const segmentKeys = entryPinned ? pinnedKeys.slice() : unpinnedKeys.slice();
  const currentIndex = segmentKeys.indexOf(entryKey);
  const nextIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;

  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= segmentKeys.length) {
    state.status =
      direction === "up"
        ? entryPinned
          ? "Pinned item is already at the top."
          : "Item is already at the top."
        : entryPinned
          ? "Pinned item is already at the bottom."
          : "Item is already at the bottom.";
    return;
  }

  const targetKey = segmentKeys[nextIndex];
  segmentKeys[currentIndex] = targetKey;
  segmentKeys[nextIndex] = entryKey;

  const nextPinnedKeys = entryPinned ? segmentKeys : pinnedKeys;
  const nextUnpinnedKeys = entryPinned ? unpinnedKeys : segmentKeys;
  const nextConfig = {
    ...state.config,
    pinnedEntryKeys: rebuildPinnedEntryKeys(state, nextPinnedKeys),
    orderedEntryKeys: rebuildOrderedEntryKeys(state, [...nextPinnedKeys, ...nextUnpinnedKeys]),
  };

  persistEntryPreferences(
    state,
    nextConfig,
    direction === "up" ? `Moved up: ${entry.port}` : `Moved down: ${entry.port}`,
    getSelectionKey(entry)
  );
}

function toggleSelectedEntryPinned(state) {
  const entry = getSelectedEntry(state);
  if (!entry) {
    state.status = "No port selected.";
    return;
  }

  const entryKey = getEntryPreferenceKey(entry);
  const entryPinned = isEntryPinned(state, entry);
  const pinnedKeys = getPinnedVisibleEntryKeys(state);
  const unpinnedKeys = getUnpinnedVisibleEntryKeys(state);
  const nextPinnedKeys = entryPinned ? pinnedKeys.filter((key) => key !== entryKey) : [entryKey, ...pinnedKeys];
  const nextUnpinnedKeys = entryPinned ? [entryKey, ...unpinnedKeys.filter((key) => key !== entryKey)] : unpinnedKeys.filter((key) => key !== entryKey);
  const nextConfig = {
    ...state.config,
    pinnedEntryKeys: rebuildPinnedEntryKeys(state, nextPinnedKeys, entryPinned ? entryKey : ""),
    orderedEntryKeys: rebuildOrderedEntryKeys(state, [...nextPinnedKeys, ...nextUnpinnedKeys]),
  };

  persistEntryPreferences(
    state,
    nextConfig,
    entryPinned ? `Unpinned: ${entry.port}` : `Pinned to top: ${entry.port}`,
    getSelectionKey(entry)
  );
}

function saveBrowserSetting(state, browserName) {
  try {
    state.config.browser = normalizeBrowserName(browserName);
    saveConfig(state.config);
    refreshResolvedBrowser(state);
    refreshSettingsOptions(state);
    state.settingsScreen = "menu";
    state.settingsNotice = state.config.browser ? `Saved: ${state.config.browser}` : "Saved: system default browser";
    state.error = "";
  } catch (error) {
    state.error = `Failed to save settings: ${error.message}`;
  }
}

function saveConfirmModeSetting(state, confirmActions) {
  try {
    state.config.confirmActions = Boolean(confirmActions);
    state.pendingAction = null;
    saveConfig(state.config);
    refreshSettingsOptions(state);
    const confirmIndex = state.settingsMenuOptions.findIndex((option) => option.kind === "confirm");
    if (confirmIndex >= 0) {
      state.settingsMenuIndex = confirmIndex;
    }
    state.settingsNotice = state.config.confirmActions ? "Saved: confirm mode on" : "Saved: confirm mode off";
    state.error = "";
  } catch (error) {
    state.error = `Failed to save settings: ${error.message}`;
  }
}

function activateSelectedSettingsItem(state) {
  if (state.settingsScreen === "browser") {
    const option = state.settingsBrowserOptions[state.settingsBrowserIndex];
    if (!option) {
      return;
    }
    saveBrowserSetting(state, option.value);
    return;
  }

  const option = state.settingsMenuOptions[state.settingsMenuIndex];
  if (!option) {
    return;
  }

  if (option.kind === "browser") {
    openSettingsBrowserScreen(state);
    return;
  }

  if (option.kind === "confirm") {
    saveConfirmModeSetting(state, !state.config.confirmActions);
  }
}

function openSelectedEntryInBrowser(state) {
  const entry = getSelectedEntry(state);
  if (!entry) {
    state.status = "No port selected.";
    return;
  }

  try {
    const url = buildBrowserUrl(entry);
    openUrlInBrowser(url, state.browser);
    state.status = `Opened in browser: ${url}`;
    state.error = "";
  } catch (error) {
    state.error = `Failed to open browser: ${error.message}`;
  }
}

function moveSelectedEntryToNextPort(state, helpers) {
  const { render, refresh } = helpers;

  if (state.busy) {
    state.error = "Another action is already running.";
    render();
    return;
  }

  const entry = getSelectedEntry(state);
  if (!entry) {
    state.status = "No port selected.";
    render();
    return;
  }

  state.busy = true;
  state.error = "";
  state.status = `Preparing port move: ${entry.port}`;
  render();

  setImmediate(() => {
    try {
      const nextPort = findNextAvailablePort(state.allListeners, entry.port);
      const command = buildRelaunchCommand(entry, nextPort);
      const launched = launchDetachedCommand(command, entry.cwd);

      if (process.env.DEV_PORTS_SPAWN_DRY_RUN === "1") {
        state.status = `[dry-run] move ${entry.port} -> ${nextPort}: ${launched.command}`;
        return;
      }

      state.status = `Waiting for new port: ${entry.port} -> ${nextPort}`;
      render();

      const startedEntry = waitForPortListener(nextPort, {
        timeoutMs: 12000,
        cwd: entry.cwd,
        originalPid: entry.pid,
      });

      process.kill(entry.pid, "SIGTERM");
      refresh("move", startedEntry ? getSelectionKey(startedEntry) : null);
      state.status = `Port move complete: ${entry.port} -> ${nextPort}`;
      state.error = "";
    } catch (error) {
      state.error = `Port move failed: ${error.message}`;
    } finally {
      state.busy = false;
      render();
    }
  });
}

function killSelectedEntry(state, signal, refresh, render) {
  const entry = getSelectedEntry(state);
  if (!entry) {
    state.status = "No port selected.";
    render();
    return;
  }

  try {
    process.kill(entry.pid, signal);
    state.selectionKey = null;
    state.status = `Stop request sent: ${entry.port} / PID ${entry.pid} (${signal})`;
    refresh("kill");
  } catch (error) {
    state.error = `Failed to stop ${entry.port} / PID ${entry.pid}: ${error.message}`;
    render();
  }
}

function handlePendingActionKey(state, key, actions) {
  if (key === "\r" || key === "\n") {
    const action = state.pendingAction;
    state.pendingAction = null;
    action.run();
    return true;
  }

  if (key === "\u001b") {
    actions.clearPendingAction();
    return true;
  }

  return true;
}

function handleSettingsViewKey(state, key, actions) {
  if (key === "s" || key === "\u001b") {
    if (state.settingsScreen === "browser") {
      actions.closeSettingsBrowser();
    } else {
      actions.closeSettings();
    }
    return true;
  }

  if (key === "\r" || key === "\n") {
    actions.activateSelectedSettingsItem();
    return true;
  }

  if (key === "j" || key === "\u001b[B") {
    actions.moveSettingsDown();
    return true;
  }

  if (key === "k" || key === "\u001b[A") {
    actions.moveSettingsUp();
    return true;
  }

  if (key === "\u000c") {
    actions.render();
    return true;
  }

  return true;
}

function handleMainViewKey(state, key, actions) {
  if (key === "q") {
    actions.exit(0);
    return true;
  }

  if (key === "s") {
    actions.openSettings();
    return true;
  }

  if (key === "o") {
    actions.openSelectedInBrowser();
    return true;
  }

  if (key === "p") {
    actions.toggleSelectedPin();
    return true;
  }

  if (key === "m") {
    actions.queueMoveToNextPort();
    return true;
  }

  if (key === "x") {
    actions.queueKillSelected("SIGTERM");
    return true;
  }

  if (key === "f") {
    actions.queueKillSelected("SIGKILL");
    return true;
  }

  if (key === "j" || key === "\u001b[B") {
    actions.moveSelectionDown();
    return true;
  }

  if (key === "\u001b[D") {
    actions.moveSelectionOrderUp();
    return true;
  }

  if (key === "\u001b[C") {
    actions.moveSelectionOrderDown();
    return true;
  }

  if (key === "k" || key === "\u001b[A") {
    actions.moveSelectionUp();
    return true;
  }

  if (key === "\u000c") {
    actions.render();
    return true;
  }

  return false;
}

function handleTuiKey(state, key, actions) {
  if (key === "\u0003") {
    actions.exit(0);
    return true;
  }

  if (state.pendingAction) {
    return handlePendingActionKey(state, key, actions);
  }

  if (state.view === "settings") {
    return handleSettingsViewKey(state, key, actions);
  }

  return handleMainViewKey(state, key, actions);
}

function createTuiState(options, config) {
  const resolvedBrowser = resolveBrowserPreference(options, config);
  return {
    options,
    config,
    configPath: getConfigPath(),
    browser: resolvedBrowser.browser,
    browserSource: resolvedBrowser.source,
    busy: false,
    selectedIndex: 0,
    scrollOffset: 0,
    allListeners: [],
    visibleListeners: [],
    usedPorts: new Set(),
    portCounts: new Map(),
    lastRefreshAt: null,
    refreshSeconds: options.watchSeconds > 0 ? options.watchSeconds : 2,
    status: "Initializing...",
    error: "",
    pendingAction: null,
    view: "list",
    settingsScreen: "menu",
    settingsMenuOptions: [],
    settingsMenuIndex: 0,
    settingsMenuScrollOffset: 0,
    settingsBrowserOptions: [],
    settingsBrowserIndex: 0,
    settingsBrowserScrollOffset: 0,
    settingsNotice: "",
    selectionKey: null,
    renderedLines: [],
    renderedColumns: 0,
    renderedRows: 0,
  };
}

function preserveSelection(state, previousSelectionKey) {
  state.selectionKey = previousSelectionKey || null;
  const nextIndex = state.visibleListeners.findIndex((entry) => getSelectionKey(entry) === state.selectionKey);
  state.selectedIndex = nextIndex >= 0 ? nextIndex : Math.min(state.selectedIndex, Math.max(0, state.visibleListeners.length - 1));
  state.scrollOffset = clamp(state.scrollOffset, 0, Math.max(0, state.visibleListeners.length - 1));
  const selected = state.visibleListeners[state.selectedIndex];
  state.selectionKey = selected ? getSelectionKey(selected) : null;
}

function moveSelection(state, direction) {
  const lastIndex = Math.max(0, state.visibleListeners.length - 1);

  if (direction === "top") {
    state.selectedIndex = 0;
  } else if (direction === "bottom") {
    state.selectedIndex = lastIndex;
  } else if (direction === "down") {
    state.selectedIndex = clamp(state.selectedIndex + 1, 0, lastIndex);
  } else if (direction === "up") {
    state.selectedIndex = clamp(state.selectedIndex - 1, 0, lastIndex);
  }

  const selected = state.visibleListeners[state.selectedIndex];
  state.selectionKey = selected ? getSelectionKey(selected) : null;
}

function renderTui(state) {
  const columns = process.stdout.columns || 120;
  const rows = process.stdout.rows || 30;
  const lines = state.view === "settings" ? renderSettingsScreen(state, columns, rows) : renderMainScreen(state, columns, rows);
  writeTuiFrame(state, lines.slice(0, rows), columns, rows);
}

function renderMainScreen(state, columns, rows) {
  const extraFooterLines = (state.pendingAction ? 1 : 0) + (state.error ? 1 : 0);
  const listHeight = Math.max(3, rows - 16 - extraFooterLines);
  const totalVisible = state.visibleListeners.length;
  const selected = state.visibleListeners[state.selectedIndex] || null;

  ensureSelectionVisible(state, listHeight);

  const lines = [];
  const countsLabel = `${totalVisible} dev port${totalVisible === 1 ? "" : "s"}`;
  const busyLabel = state.busy ? `  ${colorize("MOVING", "yellow")}` : "";

  lines.push(colorize("portwarden", "bright") + `  ${colorize("[DEV]", "green")}  ${countsLabel}${busyLabel}`);
  lines.push("");

  lines.push(buildTuiHeader(columns, false));
  lines.push(dim("-".repeat(Math.max(40, columns))));

  const visibleRows = state.visibleListeners.slice(state.scrollOffset, state.scrollOffset + listHeight);
  if (visibleRows.length === 0) {
    lines.push(colorize("  No dev ports found.", "yellow"));
  } else {
    for (let index = 0; index < visibleRows.length; index += 1) {
      const entry = visibleRows[index];
      const isSelected = state.scrollOffset + index === state.selectedIndex;
      lines.push(buildTuiRow(entry, columns, false, isSelected, isEntryPinned(state, entry)));
    }
  }

  const usedHeight = lines.length;
  const fillerCount = Math.max(0, listHeight - (usedHeight - 6));
  for (let i = 0; i < fillerCount; i += 1) {
    lines.push("");
  }

  lines.push(colorize("Selected", "bright"));
  lines.push(dim("-".repeat(Math.max(40, columns))));
  if (selected) {
    const duplicateCount = state.portCounts.get(selected.port) || 0;
    const nextPort = findNextAvailablePort(state.allListeners, selected.port);
    lines.push(`port ${selected.port}  pid ${selected.pid}  kind ${selected.kind}  age ${selected.elapsed}`);
    lines.push(
      `dup  ${duplicateCount > 1 ? `${duplicateCount} in use` : "none"}  next ${nextPort}  pin ${isEntryPinned(state, selected) ? "yes" : "no"}`
    );
    lines.push(`proj ${truncate(selected.displayProject || "-", columns - 5)}`);
    lines.push(`host ${truncate(selected.host, columns - 5)}`);
    lines.push(`dir  ${truncate(selected.displayCwd || "-", columns - 5)}`);
    lines.push(`cmd  ${truncate(selected.displayCommand || "-", columns - 5)}`);
  } else {
    lines.push("No port selected.");
    lines.push("");
    lines.push("");
    lines.push("");
  }

  lines.push("");
  lines.push(renderShortcutLine(MAIN_SHORTCUTS, columns, "keys: "));
  if (state.pendingAction) {
    lines.push(colorize(truncate(`enter confirm  esc cancel  ${state.pendingAction.label}`, columns), "yellow"));
  }
  if (state.error) {
    lines.push(colorize(truncate(state.error, columns), "red"));
  }
  return lines;
}

function renderSettingsScreen(state, columns, rows) {
  const isBrowserScreen = state.settingsScreen === "browser";
  const extraFooterLines = 1 + (state.error ? 1 : 0);
  const listHeight = Math.max(4, rows - 16 - extraFooterLines);
  const savedBrowser = state.config.browser || "System default browser";

  ensureSettingsSelectionVisible(state, listHeight);

  const lines = [];
  lines.push(colorize(isBrowserScreen ? "Browser" : "Settings", "bright"));
  lines.push("");

  if (isBrowserScreen) {
    lines.push(renderSettingsMetaLine("default", savedBrowser, columns));
    lines.push("");
  } else {
    lines.push(renderSettingsMetaLine("browser", savedBrowser, columns));
    lines.push(renderSettingsMetaLine("safety", describeConfirmMode(state.config.confirmActions), columns));
  }

  if (state.browserSource === "cli" || state.browserSource === "env") {
    lines.push(colorize("This session uses an explicit browser override instead of the saved setting.", "yellow"));
  } else if (state.settingsNotice) {
    lines.push(colorize(truncate(state.settingsNotice, columns), "green"));
  } else {
    lines.push("");
  }
  lines.push("");
  lines.push(colorize(isBrowserScreen ? "Browser List" : "Preferences", "bright"));
  lines.push(dim("-".repeat(Math.max(40, columns))));

  const options = isBrowserScreen ? state.settingsBrowserOptions : state.settingsMenuOptions;
  const scrollOffset = isBrowserScreen ? state.settingsBrowserScrollOffset : state.settingsMenuScrollOffset;
  const selectedIndex = isBrowserScreen ? state.settingsBrowserIndex : state.settingsMenuIndex;
  const visibleOptions = options.slice(scrollOffset, scrollOffset + listHeight);
  for (let index = 0; index < visibleOptions.length; index += 1) {
    const option = visibleOptions[index];
    const isSelected = scrollOffset + index === selectedIndex;
    const line = isBrowserScreen
      ? buildBrowserOptionLine(state, option, Math.max(1, columns - 2))
      : buildSettingsMenuLine(option, Math.max(1, columns - 2));
    lines.push(isSelected ? `\x1b[7m> ${line}\x1b[0m` : `  ${line}`);
  }

  const fillerCount = Math.max(0, listHeight - visibleOptions.length);
  for (let index = 0; index < fillerCount; index += 1) {
    lines.push("");
  }

  lines.push("");
  lines.push(renderShortcutLine(isBrowserScreen ? SETTINGS_BROWSER_SHORTCUTS : SETTINGS_MENU_SHORTCUTS, columns, "keys: "));
  if (state.error) {
    lines.push(colorize(truncate(state.error, columns), "red"));
  }
  return lines;
}

function renderSettingsMetaLine(label, value, columns) {
  const labelWidth = 8;
  const prefix = padDisplay(label, labelWidth);
  return `${prefix}${truncateDisplay(value, Math.max(1, columns - labelWidth))}`;
}

function buildSettingsMenuLine(option, columns) {
  const labelWidth = 16;
  const label = padDisplay(option.label, labelWidth);
  const detail = option.detail ? `  ${option.detail}` : "";
  return truncateDisplay(`${label} ${option.value}${detail}`, columns);
}

function buildBrowserOptionLine(state, option, columns) {
  const savedBrowser = state.config.browser;
  const isSaved = option.value === savedBrowser || (option.kind === "system" && !savedBrowser);
  const isActive = option.value === state.browser || (option.kind === "system" && !state.browser);
  const text = truncateDisplay(option.label, columns);

  if (isSaved && isActive) {
    return colorizeForeground(text, "green");
  }

  if (isSaved) {
    return colorizeForeground(text, "green");
  }

  if (isActive) {
    return colorizeForeground(text, "cyan");
  }

  return text;
}

function colorizeForeground(text, colorName) {
  if (colorName === "green") {
    return `\x1b[32m${text}\x1b[39m`;
  }

  if (colorName === "cyan") {
    return `\x1b[36m${text}\x1b[39m`;
  }

  if (colorName === "yellow") {
    return `\x1b[33m${text}\x1b[39m`;
  }

  return text;
}

function writeTuiFrame(state, nextLines, columns, rows) {
  const buffer = [];
  const previousLines = state.renderedLines;
  const needsFullRender =
    previousLines.length === 0 || state.renderedColumns !== columns || state.renderedRows !== rows;

  if (needsFullRender) {
    buffer.push("\x1b[H\x1b[2J");
    buffer.push(nextLines.join("\n"));
  } else {
    const maxLines = Math.max(previousLines.length, nextLines.length);

    for (let index = 0; index < maxLines; index += 1) {
      const previousLine = previousLines[index] ?? "";
      const nextLine = nextLines[index] ?? "";
      if (previousLine === nextLine) {
        continue;
      }

      buffer.push(`\x1b[${index + 1};1H\x1b[2K`);
      if (nextLine) {
        buffer.push(nextLine);
      }
    }
  }

  buffer.push("\x1b[H");
  process.stdout.write(buffer.join(""));
  state.renderedLines = nextLines;
  state.renderedColumns = columns;
  state.renderedRows = rows;
}

function buildTuiHeader(columns, showKind) {
  const widths = getTuiColumnWidths(columns, showKind);
  const cells = [];
  if (showKind) {
    cells.push(padDisplay("KIND", widths.kind));
  }
  cells.push(padDisplay("PORT", widths.port));
  cells.push(padDisplay("PID", widths.pid));
  cells.push(padDisplay("AGE", widths.age));
  cells.push(padDisplay("HOST", widths.host));
  cells.push(padDisplay("PROJECT", widths.project));
  cells.push(padDisplay("PROCESS", widths.process));
  return `  ${cells.join(" ")}`;
}

function buildTuiRow(entry, columns, showKind, isSelected, isPinned = false) {
  const widths = getTuiColumnWidths(columns, showKind);
  const cells = [];
  if (showKind) {
    cells.push(padDisplay(entry.kind, widths.kind));
  }
  cells.push(padDisplay(String(entry.port), widths.port));
  cells.push(padDisplay(String(entry.pid), widths.pid));
  cells.push(padDisplay(entry.elapsed, widths.age));
  cells.push(padDisplay(entry.host, widths.host));
  cells.push(padDisplay(isPinned ? `^ ${entry.displayProject || "-"}` : entry.displayProject || "-", widths.project));
  cells.push(padDisplay(entry.displayCommand, widths.process));

  const line = `${isSelected ? colorize(">", "bright") : " "} ${cells.join(" ")}`;
  if (!isSelected) {
    return truncate(line, columns);
  }
  return `\x1b[7m${truncate(line, columns)}\x1b[0m`;
}

function getTuiColumnWidths(columns, showKind) {
  const usable = Math.max(80, columns - 2);
  const widths = {
    kind: showKind ? 5 : 0,
    port: 5,
    pid: 7,
    age: 10,
    host: Math.max(10, Math.floor(usable * 0.14)),
    project: Math.max(14, Math.floor(usable * 0.16)),
    process: 24,
  };

  const fixed = widths.port + widths.pid + widths.age + widths.host + widths.project + (showKind ? widths.kind : 0);
  const spaces = showKind ? 7 : 6;
  widths.process = Math.max(24, usable - fixed - spaces);
  return widths;
}

function ensureSelectionVisible(state, listHeight) {
  if (state.selectedIndex < state.scrollOffset) {
    state.scrollOffset = state.selectedIndex;
  }

  const bottom = state.scrollOffset + listHeight - 1;
  if (state.selectedIndex > bottom) {
    state.scrollOffset = state.selectedIndex - listHeight + 1;
  }

  const maxOffset = Math.max(0, state.visibleListeners.length - listHeight);
  state.scrollOffset = clamp(state.scrollOffset, 0, maxOffset);
}

function getCurrentSelectionKey(state) {
  const current = state.visibleListeners[state.selectedIndex];
  return current ? getSelectionKey(current) : state.selectionKey;
}

module.exports = {
  startTui,
};
