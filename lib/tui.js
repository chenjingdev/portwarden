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
  buildReviveLogPath,
  captureReviveSnapshot,
  collectAllListeners,
  getEntryListenerKey,
  getEntryListenerKeys,
  findNextAvailablePort,
  getSelectionKey,
  launchDetachedCommand,
  reviveSnapshot,
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
      const result = requestKillSelectedEntry(state, signal, refresh, render);
      if (result === "queued" || result === "blocked") {
        render();
      }
    },
    queueMoveToNextPort: () => {
      const entry = getSelectedListenerEntry(state);
      if (!entry) {
        const groupError = getAppGroupActionError(getSelectedEntry(state), "move");
        if (groupError) {
          state.error = groupError;
          state.status = "";
        } else {
          state.status = "No port selected.";
        }
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
    toggleSelectedAppGroup: () => {
      toggleSelectedAppGroup(state);
      render();
    },
    toggleListScope: () => {
      toggleListScope(state);
      render();
    },
    toggleSelectedPin: () => {
      toggleSelectedEntryPinned(state);
      render();
    },
    openGraveyard: () => {
      openGraveyardView(state);
      render();
    },
    closeGraveyard: () => {
      closeGraveyardView(state);
      render();
    },
    moveGraveyardDown: () => {
      moveGraveyardSelection(state, "down");
      render();
    },
    moveGraveyardUp: () => {
      moveGraveyardSelection(state, "up");
      render();
    },
    reviveSelectedGhost: () => {
      reviveSelectedGhost(state, refresh);
      render();
    },
    dropSelectedGhost: () => {
      dropSelectedGhost(state);
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
    const selectedListeners = selectListeners(allListeners, { all: state.listScope === "all" }, state.config);
    state.allListeners = allListeners;
    state.visibleListeners = buildVisibleEntries(selectedListeners, state);
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

function getGraveyardEntries(state) {
  const live = new Set();
  for (const entry of state.allListeners || []) {
    for (const key of getEntryListenerKeys(entry)) live.add(key);
  }
  const livePorts = new Set(
    (state.allListeners || [])
      .filter((entry) => Number.isFinite(entry?.port))
      .map((entry) => Number(entry.port))
  );
  const pins = (state.config && state.config.revivablePins) || {};
  const entries = [];
  for (const listenerKey of Object.keys(pins)) {
    const record = pins[listenerKey];
    if (!record) continue;
    const match = listenerKey.match(/^host:(.*)::port:([0-9]+)$/);
    if (!match) continue;
    const host = match[1] === "-" ? "" : match[1];
    const port = Number.parseInt(match[2], 10);
    if (!Number.isFinite(port)) continue;
    entries.push({
      listenerKey,
      record,
      host,
      port,
      alive: live.has(listenerKey) || livePorts.has(port),
    });
  }
  entries.sort((left, right) => {
    const leftTime = left.record.capturedAt || "";
    const rightTime = right.record.capturedAt || "";
    return rightTime.localeCompare(leftTime); // newest first
  });
  return entries;
}

function openGraveyardView(state) {
  state.view = "graveyard";
  state.pendingAction = null;
  const entries = getGraveyardEntries(state);
  if (state.graveyardSelectedIndex >= entries.length) {
    state.graveyardSelectedIndex = Math.max(0, entries.length - 1);
  }
}

function closeGraveyardView(state) {
  state.view = "list";
}

function moveGraveyardSelection(state, direction) {
  const entries = getGraveyardEntries(state);
  if (entries.length === 0) {
    state.graveyardSelectedIndex = 0;
    return;
  }
  const step = direction === "up" ? -1 : 1;
  const next = (state.graveyardSelectedIndex || 0) + step;
  state.graveyardSelectedIndex = clamp(next, 0, entries.length - 1);
}

function reviveSelectedGhost(state, refresh) {
  const entries = getGraveyardEntries(state);
  const selected = entries[state.graveyardSelectedIndex];
  if (!selected) {
    state.status = "무덤이 비었습니다.";
    return;
  }
  try {
    const pin = { listenerKey: selected.listenerKey, record: selected.record };
    const logPath = buildReviveLogPath(pin);
    const result = reviveSnapshot(pin, logPath);
    state.status = `Revive 요청: port ${selected.port} → pid ${result.pid ?? "-"} (log ${logPath})`;
    state.error = "";
    if (typeof refresh === "function") refresh("revive");
  } catch (error) {
    state.error = `Revive 실패: ${error.message}`;
  }
}

function dropSelectedGhost(state) {
  const entries = getGraveyardEntries(state);
  const selected = entries[state.graveyardSelectedIndex];
  if (!selected) {
    state.status = "무덤이 비었습니다.";
    return;
  }
  const nextRevivablePins = { ...(state.config.revivablePins || {}) };
  delete nextRevivablePins[selected.listenerKey];
  const nextConfig = { ...state.config, revivablePins: nextRevivablePins };
  try {
    saveConfig(nextConfig);
    state.config = nextConfig;
    state.status = `Drop: port ${selected.port} 흔적 삭제`;
    state.error = "";
    const after = getGraveyardEntries(state);
    if (state.graveyardSelectedIndex >= after.length) {
      state.graveyardSelectedIndex = Math.max(0, after.length - 1);
    }
  } catch (error) {
    state.error = `Drop 실패: ${error.message}`;
  }
}

function toggleListScope(state) {
  const preferredSelectionKey = getCurrentSelectionKey(state);
  state.listScope = state.listScope === "all" ? "main" : "all";
  refreshTuiData(state, "scope", preferredSelectionKey);
}

function getSelectedEntry(state) {
  return state.visibleListeners[state.selectedIndex] || null;
}

function isAppGroupEntry(entry) {
  return Boolean(entry?.entryType === "app-group");
}

function isListenerEntry(entry) {
  return Boolean(entry) && !isAppGroupEntry(entry);
}

function getEntrySelectionKey(entry) {
  return entry?.selectionKey || (entry ? getSelectionKey(entry) : null);
}

function getSelectedListenerEntry(state) {
  const entry = getSelectedEntry(state);
  return isListenerEntry(entry) ? entry : null;
}

function getSelectedGroupKey(state) {
  const entry = getSelectedEntry(state);
  if (isAppGroupEntry(entry)) {
    return entry.groupKey;
  }
  return entry?.groupKey || "";
}

function getAppGroupKey(entry) {
  const label = String(entry?.appFamily || entry?.displayProject || "").trim().toLowerCase();
  return label ? `app:${label}` : "";
}

function summarizeGroupHosts(members) {
  const hosts = uniqueOrderedValues(members.map((entry) => entry.displayHost || entry.host));
  if (hosts.length === 0) {
    return "-";
  }
  if (hosts.length === 1) {
    return hosts[0];
  }
  return `${hosts.length} hosts`;
}

function summarizeGroupProcesses(members, limit = 2) {
  const labels = uniqueOrderedValues(
    members.map((entry) => entry.displayProject || entry.projectName || entry.command || "-")
  );
  if (labels.length === 0) {
    return "-";
  }

  const visible = labels.slice(0, limit);
  const remaining = labels.length - visible.length;
  return remaining > 0 ? `${visible.join(", ")} +${remaining}` : visible.join(", ");
}

function createAppGroupEntry(groupKey, members, expanded) {
  const first = members[0];
  const hostLabel = summarizeGroupHosts(members);
  const summary = summarizeGroupProcesses(members, 3);
  return {
    entryType: "app-group",
    selectionKey: groupKey,
    groupKey,
    groupExpanded: expanded,
    groupCount: members.length,
    groupMembers: members,
    kind: "app",
    appFamily: first.appFamily || first.displayProject || "App",
    port: `${members.length}x`,
    pid: "-",
    elapsed: "-",
    host: hostLabel,
    displayHost: hostLabel,
    projectName: first.appFamily || first.displayProject || "App",
    displayProject: first.appFamily || first.displayProject || "App",
    displayCommand: expanded
      ? `open · ${members.length} listeners · enter collapse`
      : `closed · ${members.length} listeners · ${summary}`,
    displayCwd: "",
  };
}

function buildVisibleEntries(entries, state) {
  if (state.listScope !== "all") {
    return entries.slice();
  }

  const expandedGroups = state.expandedAppGroups || new Set();
  const groupedMembers = new Map();

  for (const entry of entries) {
    const groupKey = getAppGroupKey(entry);
    const shouldGroup =
      entry.kind === "app" &&
      entry.appFamily &&
      !isEntryPinnedWithConfig(state.config, entry) &&
      Boolean(groupKey);

    if (!shouldGroup) {
      continue;
    }

    if (!groupedMembers.has(groupKey)) {
      groupedMembers.set(groupKey, []);
    }
    groupedMembers.get(groupKey).push(entry);
  }

  const visibleEntries = [];
  const groupedVisibleEntries = [];
  const emittedGroups = new Set();

  for (const entry of entries) {
    const groupKey = getAppGroupKey(entry);
    const shouldGroup =
      entry.kind === "app" &&
      entry.appFamily &&
      !isEntryPinnedWithConfig(state.config, entry) &&
      Boolean(groupKey);

    if (!shouldGroup) {
      visibleEntries.push(entry);
      continue;
    }

    if (emittedGroups.has(groupKey)) {
      continue;
    }

    emittedGroups.add(groupKey);
    const members = groupedMembers.get(groupKey) || [entry];
    if (members.length <= 1) {
      visibleEntries.push(members[0]);
      continue;
    }

    const expanded = expandedGroups.has(groupKey);
    groupedVisibleEntries.push(createAppGroupEntry(groupKey, members, expanded));
    if (expanded) {
      for (const member of members) {
        groupedVisibleEntries.push({
          ...member,
          groupKey,
          groupMember: true,
        });
      }
    }
  }

  return [...visibleEntries, ...groupedVisibleEntries];
}

function uniqueOrderedValues(values) {
  const seen = new Set();
  const nextValues = [];

  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    nextValues.push(value);
  }

  return nextValues;
}

function isEntryPinnedWithConfig(config, entry) {
  if (!isListenerEntry(entry)) {
    return false;
  }

  const pinnedListenerKeys = Array.isArray(config?.pinnedListenerKeys) ? config.pinnedListenerKeys : [];
  const pinnedListenerKeySet = new Set(pinnedListenerKeys);
  return getEntryListenerKeys(entry).some((listenerKey) => pinnedListenerKeySet.has(listenerKey));
}

function isEntryPinned(state, entry) {
  return isEntryPinnedWithConfig(state.config, entry);
}

function getVisiblePinnedEntryKeys(state, config = state.config) {
  return uniqueOrderedValues(
    state.visibleListeners
      .filter((entry) => isListenerEntry(entry) && isEntryPinnedWithConfig(config, entry))
      .map((entry) => getEntryListenerKey(entry))
  );
}

function getVisibleUnpinnedEntryKeys(state, config = state.config) {
  return uniqueOrderedValues(
    state.visibleListeners
      .filter((entry) => isListenerEntry(entry) && !isEntryPinnedWithConfig(config, entry))
      .map((entry) => getEntryListenerKey(entry))
  );
}

function getAppGroupActionError(entry, actionLabel = "act on") {
  if (!isAppGroupEntry(entry)) {
    return "";
  }

  const targetLabel = entry.displayProject || "this app group";
  return `Expand ${targetLabel} first to ${actionLabel} a specific listener.`;
}

function getPinnedDeletionError(state, entry) {
  if (!entry || !isEntryPinned(state, entry)) {
    return "";
  }

  return `Pinned port ${entry.port} cannot be stopped. Unpin it first.`;
}

function getPinnedVisibleEntryKeys(state) {
  return getVisiblePinnedEntryKeys(state);
}

function getUnpinnedVisibleEntryKeys(state) {
  return getVisibleUnpinnedEntryKeys(state);
}

function rebuildOrderedEntryKeys(state, nextVisibleEntryKeys) {
  const visibleKeySet = new Set(nextVisibleEntryKeys);
  const orderedEntryKeys = Array.isArray(state.config.orderedEntryKeys) ? state.config.orderedEntryKeys : [];
  const preservedKeys = orderedEntryKeys.filter((entryKey) => !visibleKeySet.has(entryKey));
  return [...nextVisibleEntryKeys, ...preservedKeys];
}

function rebuildPinnedListenerKeys(state, nextPinnedVisibleListenerKeys, listenerKeyToRemove = "") {
  const visibleKeySet = new Set(
    uniqueOrderedValues(
      state.visibleListeners
        .filter((entry) => isListenerEntry(entry))
        .map((entry) => getEntryListenerKey(entry))
    )
  );
  const pinnedListenerKeys = Array.isArray(state.config.pinnedListenerKeys) ? state.config.pinnedListenerKeys : [];
  const preservedKeys = pinnedListenerKeys.filter(
    (listenerKey) => listenerKey !== listenerKeyToRemove && !visibleKeySet.has(listenerKey)
  );
  return [...nextPinnedVisibleListenerKeys, ...preservedKeys];
}

function setSelectionByIndex(state, index) {
  const lastIndex = Math.max(0, state.visibleListeners.length - 1);
  state.selectedIndex = clamp(index, 0, lastIndex);
  const selected = state.visibleListeners[state.selectedIndex];
  state.selectionKey = getEntrySelectionKey(selected);
}

function persistEntryPreferences(state, nextConfig, statusMessage, preferredSelectionKey, options = {}) {
  try {
    const previousSelectedIndex = state.selectedIndex;
    saveConfig(nextConfig);
    state.config = nextConfig;
    state.error = "";
    refreshTuiData(state, "preferences", preferredSelectionKey);
    if (options.preserveRowIndex) {
      setSelectionByIndex(state, previousSelectedIndex);
    }
    state.status = statusMessage;
    return true;
  } catch (error) {
    state.error = `Failed to save list preferences: ${error.message}`;
    return false;
  }
}

function moveSelectedEntryOrder(state, direction) {
  const entry = getSelectedListenerEntry(state);
  if (!entry) {
    const groupError = getAppGroupActionError(getSelectedEntry(state), "reorder");
    if (groupError) {
      state.error = groupError;
      state.status = "";
      return;
    }

    state.status = "No port selected.";
    return;
  }

  const entryKey = getEntryListenerKey(entry);
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
    pinnedListenerKeys: rebuildPinnedListenerKeys(state, nextPinnedKeys),
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
  const entry = getSelectedListenerEntry(state);
  if (!entry) {
    const groupError = getAppGroupActionError(getSelectedEntry(state), "pin");
    if (groupError) {
      state.error = groupError;
      state.status = "";
      return;
    }

    state.status = "No port selected.";
    return;
  }

  const entryKey = getEntryListenerKey(entry);
  const entryPinned = isEntryPinned(state, entry);
  const pinnedKeys = getVisiblePinnedEntryKeys(state);
  const unpinnedKeys = getVisibleUnpinnedEntryKeys(state);
  const nextPinnedKeys = entryPinned ? pinnedKeys.filter((key) => key !== entryKey) : [entryKey, ...pinnedKeys.filter((key) => key !== entryKey)];
  const nextUnpinnedKeys = entryPinned ? [entryKey, ...unpinnedKeys.filter((key) => key !== entryKey)] : unpinnedKeys.filter((key) => key !== entryKey);
  const nextConfig = {
    ...state.config,
    pinnedListenerKeys: rebuildPinnedListenerKeys(state, nextPinnedKeys, entryPinned ? entryKey : ""),
    orderedEntryKeys: rebuildOrderedEntryKeys(state, [...nextPinnedKeys, ...nextUnpinnedKeys]),
  };

  persistEntryPreferences(
    state,
    nextConfig,
    entryPinned ? `Unpinned: ${entry.port}` : `Pinned to top: ${entry.port}`,
    getSelectionKey(entry),
    { preserveRowIndex: true }
  );
}

function requestKillSelectedEntry(state, signal, refresh, render) {
  const selected = getSelectedEntry(state);
  const groupError = getAppGroupActionError(selected, signal === "SIGKILL" ? "stop" : "stop");
  if (groupError) {
    state.error = groupError;
    state.pendingAction = null;
    return "blocked";
  }

  const entry = getSelectedListenerEntry(state);
  const pinnedDeletionError = getPinnedDeletionError(state, entry);
  if (pinnedDeletionError) {
    state.error = pinnedDeletionError;
    state.pendingAction = null;
    return "blocked";
  }

  const queued = queuePendingAction(
    state,
    entry
      ? signal === "SIGKILL"
        ? `Force stop: ${entry.port} / PID ${entry.pid}`
        : `Stop: ${entry.port} / PID ${entry.pid}`
      : signal === "SIGKILL"
        ? "Force stop"
        : "Stop",
    () => killSelectedEntry(state, signal, refresh, render)
  );

  return queued ? "queued" : "ran";
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

function toggleSelectedAppGroup(state) {
  const selected = getSelectedEntry(state);
  const groupKey = getSelectedGroupKey(state);
  if (!groupKey) {
    return;
  }

  const nextExpandedGroups = new Set(state.expandedAppGroups);
  const willExpand = !nextExpandedGroups.has(groupKey);
  if (willExpand) {
    nextExpandedGroups.add(groupKey);
  } else {
    nextExpandedGroups.delete(groupKey);
  }

  state.expandedAppGroups = nextExpandedGroups;
  const familyLabel = selected?.displayProject || selected?.appFamily || "app group";
  const preferredSelectionKey =
    willExpand && isListenerEntry(selected) ? getEntrySelectionKey(selected) : groupKey;
  refreshTuiData(state, "group", preferredSelectionKey);
  state.error = "";
  state.status = willExpand ? `Expanded app group: ${familyLabel}` : `Collapsed app group: ${familyLabel}`;
}

function openSelectedEntryInBrowser(state) {
  const selected = getSelectedEntry(state);
  const groupError = getAppGroupActionError(selected, "open");
  if (groupError) {
    state.error = groupError;
    state.status = "";
    return;
  }

  const entry = getSelectedListenerEntry(state);
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

  const selected = getSelectedEntry(state);
  const groupError = getAppGroupActionError(selected, "move");
  if (groupError) {
    state.error = groupError;
    state.status = "";
    render();
    return;
  }

  const entry = getSelectedListenerEntry(state);
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
  const selected = getSelectedEntry(state);
  const groupError = getAppGroupActionError(selected, "stop");
  if (groupError) {
    state.error = groupError;
    render();
    return;
  }

  const entry = getSelectedListenerEntry(state);
  if (!entry) {
    state.status = "No port selected.";
    render();
    return;
  }

  const pinnedDeletionError = getPinnedDeletionError(state, entry);
  if (pinnedDeletionError) {
    state.error = pinnedDeletionError;
    render();
    return;
  }

  const snapshot = captureReviveSnapshot(entry);
  if (snapshot) {
    try {
      const nextRevivablePins = {
        ...(state.config.revivablePins || {}),
        [snapshot.listenerKey]: snapshot.record,
      };
      const nextConfig = { ...state.config, revivablePins: nextRevivablePins };
      saveConfig(nextConfig);
      state.config = nextConfig;
    } catch (error) {
      state.error = `Graveyard 저장 실패: ${error.message}`;
    }
  }

  try {
    process.kill(entry.pid, signal);
    state.selectionKey = null;
    state.status = snapshot
      ? `Stop 요청: ${entry.port} / PID ${entry.pid} (${signal}) — 무덤에 보관 (g)`
      : `Stop 요청: ${entry.port} / PID ${entry.pid} (${signal})`;
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
  const selected = getSelectedEntry(state);

  if (key === "\r" || key === "\n") {
    actions.toggleSelectedAppGroup();
    return true;
  }

  if (key === "\u001b[C" && isAppGroupEntry(selected) && !selected.groupExpanded) {
    actions.toggleSelectedAppGroup();
    return true;
  }

  if (
    key === "\u001b[D" &&
    ((isAppGroupEntry(selected) && selected.groupExpanded) || selected?.groupKey)
  ) {
    actions.toggleSelectedAppGroup();
    return true;
  }

  if (key === "q") {
    actions.exit(0);
    return true;
  }

  if (key === "s") {
    actions.openSettings();
    return true;
  }

  if (key === "g") {
    actions.openGraveyard();
    return true;
  }

  if (key === "o") {
    actions.openSelectedInBrowser();
    return true;
  }

  if (key === "a") {
    actions.toggleListScope();
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

  if (state.view === "graveyard") {
    return handleGraveyardViewKey(state, key, actions);
  }

  return handleMainViewKey(state, key, actions);
}

function handleGraveyardViewKey(state, key, actions) {
  if (key === "g" || key === "s" || key === "" || key === "q") {
    actions.closeGraveyard();
    return true;
  }
  if (key === "j" || key === "[B") {
    actions.moveGraveyardDown();
    return true;
  }
  if (key === "k" || key === "[A") {
    actions.moveGraveyardUp();
    return true;
  }
  if (key === "r") {
    actions.reviveSelectedGhost();
    return true;
  }
  if (key === "d") {
    actions.dropSelectedGhost();
    return true;
  }
  if (key === "") {
    actions.render();
    return true;
  }
  return true;
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
    listScope: options.all ? "all" : "main",
    graveyardSelectedIndex: 0,
    settingsScreen: "menu",
    settingsMenuOptions: [],
    settingsMenuIndex: 0,
    settingsMenuScrollOffset: 0,
    settingsBrowserOptions: [],
    settingsBrowserIndex: 0,
    settingsBrowserScrollOffset: 0,
    settingsNotice: "",
    expandedAppGroups: new Set(),
    selectionKey: null,
    renderedLines: [],
    renderedColumns: 0,
    renderedRows: 0,
  };
}

function preserveSelection(state, previousSelectionKey) {
  state.selectionKey = previousSelectionKey || null;
  const nextIndex = state.visibleListeners.findIndex((entry) => getEntrySelectionKey(entry) === state.selectionKey);
  state.selectedIndex = nextIndex >= 0 ? nextIndex : Math.min(state.selectedIndex, Math.max(0, state.visibleListeners.length - 1));
  state.scrollOffset = clamp(state.scrollOffset, 0, Math.max(0, state.visibleListeners.length - 1));
  const selected = state.visibleListeners[state.selectedIndex];
  state.selectionKey = getEntrySelectionKey(selected);
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
  state.selectionKey = getEntrySelectionKey(selected);
}

function renderTui(state) {
  const columns = process.stdout.columns || 120;
  const rows = process.stdout.rows || 30;
  let lines;
  if (state.view === "settings") {
    lines = renderSettingsScreen(state, columns, rows);
  } else if (state.view === "graveyard") {
    lines = renderGraveyardScreen(state, columns, rows);
  } else {
    lines = renderMainScreen(state, columns, rows);
  }
  writeTuiFrame(state, lines.slice(0, rows), columns, rows);
}

function getListOverflowBelowCount(state, visibleRowCount) {
  if (state.listScope !== "all") {
    return 0;
  }

  return Math.max(0, state.visibleListeners.length - (state.scrollOffset + visibleRowCount));
}

function buildBadge(label, colorName) {
  return colorize(`[${label}]`, colorName);
}

function formatRefreshClock(date) {
  return date ? formatTimestamp(date).slice(11) : "--:--:--";
}

function buildMainHeaderLine(state, totalVisible, hiddenCount) {
  const totalPortCount = state.listScope === "all" ? state.allListeners.length : totalVisible;
  const badges = [
    buildBadge(state.listScope === "all" ? "ALL" : "MAIN", state.listScope === "all" ? "cyan" : "green"),
    buildBadge(`${totalPortCount} port${totalPortCount === 1 ? "" : "s"}`, "bright"),
  ];

  if (state.listScope === "all" && totalVisible !== totalPortCount) {
    badges.push(buildBadge(`${totalVisible} rows`, "dim"));
  }

  if (hiddenCount > 0 && state.listScope !== "all") {
    badges.push(buildBadge(`hidden ${hiddenCount}`, "yellow"));
  }

  if (state.busy) {
    badges.push(buildBadge("MOVING", "yellow"));
  }

  return `${colorize("PORTWARDEN", "bright")}  ${badges.join(" ")}`;
}

function buildMainMetaLine(state, selected, totalVisible, columns) {
  const selectedLabel = selected ? `${state.selectedIndex + 1}/${totalVisible}` : `0/${totalVisible}`;
  const browserLabel = state.browser || "system";
  const text = `refresh ${formatRefreshClock(state.lastRefreshAt)}  browser ${browserLabel}  selected ${selectedLabel}`;
  return dim(truncateDisplay(text, columns));
}

function buildSectionTitle(title, columns, detail = "") {
  const normalizedDetail = detail ? truncateDisplay(detail, Math.max(1, columns - title.length - 2)) : "";
  return normalizedDetail ? `${colorize(title, "bright")}  ${dim(normalizedDetail)}` : colorize(title, "bright");
}

function buildInfoLine(state, columns) {
  if (state.error) {
    return colorize(truncateDisplay(`error  ${state.error}`, columns), "red");
  }

  if (state.pendingAction) {
    return colorize(truncateDisplay(`confirm  enter confirm  esc cancel  ${state.pendingAction.label}`, columns), "yellow");
  }

  if (state.status) {
    return colorize(truncateDisplay(`info  ${state.status}`, columns), "green");
  }

  return dim(truncateDisplay("info  Ready", columns));
}

function buildSettingsInfoLine(state, columns) {
  if (state.error) {
    return colorize(truncateDisplay(`error  ${state.error}`, columns), "red");
  }

  if (state.settingsNotice) {
    return colorize(truncateDisplay(`info  ${state.settingsNotice}`, columns), "green");
  }

  return dim(truncateDisplay(`info  config ${state.configPath}`, columns));
}

function getEntryPinLabel(state, entry, variant = "long") {
  if (!isListenerEntry(entry)) {
    return variant === "short" ? "-" : "NO";
  }

  if (variant === "short") {
    return isEntryPinned(state, entry) ? "Y" : "-";
  }

  return isEntryPinned(state, entry) ? "YES" : "NO";
}

function buildSelectedSummaryLines(state, selected, columns) {
  if (!selected) {
    return [
      "No port selected.",
      "",
      "",
      "",
      "",
    ];
  }

  if (isAppGroupEntry(selected)) {
    const ports = uniqueOrderedValues(selected.groupMembers.map((entry) => String(entry.port)));
    const processes = summarizeGroupProcesses(selected.groupMembers, 4);
    const portPreview = ports.slice(0, 5).join(", ");
    const remainingPorts = ports.length - Math.min(ports.length, 5);
    return [
      truncateDisplay(
        `group ${selected.displayProject}  kind APP  listeners ${selected.groupCount}  state ${selected.groupExpanded ? "expanded" : "collapsed"}`,
        columns
      ),
      truncateDisplay(
        `ports ${portPreview}${remainingPorts > 0 ? ` +${remainingPorts}` : ""}  host ${selected.displayHost || "-"}`,
        columns
      ),
      truncateDisplay(`apps ${processes}`, columns),
      truncateDisplay(`hint enter ${selected.groupExpanded ? "collapse" : "expand"}  choose a listener to open, pin, stop`, columns),
      truncateDisplay(`proc ${selected.displayCommand || "-"}`, columns),
    ];
  }

  const duplicateCount = state.portCounts.get(selected.port) || 0;
  const nextPort = findNextAvailablePort(state.allListeners, selected.port);
  return [
    truncateDisplay(
      `port ${selected.port}  pid ${selected.pid}  kind ${String(selected.kind).toUpperCase()}  age ${selected.elapsed}  pin ${getEntryPinLabel(
        state,
        selected
      )}`,
      columns
    ),
    truncateDisplay(
      `next ${nextPort}  dup ${duplicateCount > 1 ? `${duplicateCount} in use` : "none"}  host ${selected.displayHost || selected.host}`,
      columns
    ),
    truncateDisplay(`proj ${selected.displayProject || "-"}`, columns),
    truncateDisplay(`dir  ${selected.displayCwd || "-"}`, columns),
    truncateDisplay(`cmd  ${selected.displayCommand || "-"}`, columns),
  ];
}

function renderMainScreen(state, columns, rows) {
  const listHeight = Math.max(3, rows - 15);
  const totalVisible = state.visibleListeners.length;
  const selected = state.visibleListeners[state.selectedIndex] || null;
  const showKind = state.listScope === "all" || state.visibleListeners.some((entry) => entry.kind !== "dev");
  const hiddenCount = Math.max(0, state.allListeners.length - totalVisible);

  ensureSelectionVisible(state, listHeight);
  const visibleRows = state.visibleListeners.slice(state.scrollOffset, state.scrollOffset + listHeight);

  const lines = [];
  lines.push(buildMainHeaderLine(state, totalVisible, hiddenCount));
  lines.push(buildMainMetaLine(state, selected, totalVisible, columns));
  lines.push("");
  lines.push(
    buildSectionTitle(
      "PORTS",
      columns,
      totalVisible > 0
        ? state.listScope === "all" && totalVisible !== state.allListeners.length
          ? `showing ${state.scrollOffset + 1}-${Math.min(state.scrollOffset + visibleRows.length, totalVisible)} of ${totalVisible} rows`
          : `showing ${state.scrollOffset + 1}-${Math.min(state.scrollOffset + visibleRows.length, totalVisible)} of ${totalVisible}`
        : "empty"
    )
  );

  lines.push(buildTuiHeader(columns, showKind));
  lines.push(dim("-".repeat(Math.max(40, columns))));

  const overflowBelowCount = getListOverflowBelowCount(state, visibleRows.length);
  if (visibleRows.length === 0) {
    lines.push(colorize(state.listScope === "all" ? "  No LISTEN ports found." : "  No pinned or dev ports found.", "yellow"));
  } else {
    for (let index = 0; index < visibleRows.length; index += 1) {
      const entry = visibleRows[index];
      const isSelected = state.scrollOffset + index === state.selectedIndex;
      lines.push(buildTuiRow(entry, columns, showKind, isSelected, getEntryPinLabel(state, entry, "short")));
    }
  }

  const usedHeight = lines.length;
  const fillerCount = Math.max(0, listHeight - (usedHeight - 6) - (overflowBelowCount > 0 ? 1 : 0));
  for (let i = 0; i < fillerCount; i += 1) {
    lines.push("");
  }
  if (overflowBelowCount > 0) {
    lines.push(colorize(`  + ${overflowBelowCount} more`, "yellow"));
  }

  lines.push(buildSectionTitle("DETAILS", columns, selected ? selected.displayProject || "-" : ""));
  lines.push(dim("-".repeat(Math.max(40, columns))));
  lines.push(...buildSelectedSummaryLines(state, selected, columns));

  lines.push("");
  lines.push(renderShortcutLine(getMainShortcuts(selected), columns, "keys: "));
  lines.push(buildInfoLine(state, columns));
  return lines;
}

function getMainShortcuts(selected) {
  if (isAppGroupEntry(selected)) {
    return [
      ["j/k", "move"],
      [selected.groupExpanded ? "←" : "→", selected.groupExpanded ? "collapse" : "expand"],
      ["enter", selected.groupExpanded ? "collapse" : "expand"],
      ["a", "all/main"],
      ["s", "settings"],
      ["q", "quit"],
    ];
  }

  if (selected?.groupKey) {
    return [
      ["j/k", "move"],
      ["←", "collapse"],
      ["m", "move-port"],
      ["o", "open"],
      ["p", "pin"],
      ["x", "stop"],
      ["f", "force-stop"],
      ["s", "settings"],
      ["q", "quit"],
    ];
  }

  return MAIN_SHORTCUTS;
}

function renderSettingsScreen(state, columns, rows) {
  const isBrowserScreen = state.settingsScreen === "browser";
  const listHeight = Math.max(4, rows - 13);
  const savedBrowser = state.config.browser || "System default browser";

  ensureSettingsSelectionVisible(state, listHeight);

  const lines = [];
  lines.push(colorize(isBrowserScreen ? "BROWSER" : "SETTINGS", "bright"));
  lines.push(dim(truncateDisplay(`saved ${savedBrowser}  confirm ${describeConfirmMode(state.config.confirmActions)}`, columns)));
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
  } else {
    lines.push("");
  }
  lines.push("");
  lines.push(buildSectionTitle(isBrowserScreen ? "BROWSER LIST" : "PREFERENCES", columns));
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
  lines.push(buildSettingsInfoLine(state, columns));
  return lines;
}

function renderGraveyardScreen(state, columns, rows) {
  const lines = [];
  const entries = getGraveyardEntries(state);
  lines.push(colorize("GRAVEYARD  (kills 보관소)", "bright"));
  lines.push(dim(truncateDisplay(`total ${entries.length}  logs ~/.portwarden/logs/<slug>.log`, columns)));
  lines.push("");

  if (entries.length === 0) {
    lines.push(dim("아직 x / f 로 죽인 항목이 없습니다."));
    lines.push("");
    lines.push(dim("힌트: 메인 화면에서 dev 서버를 x / f 로 죽이면 여기에 쌓입니다."));
    while (lines.length < rows - 1) lines.push("");
    lines.push(buildGraveyardFooter(columns));
    return lines;
  }

  lines.push(buildGraveyardHeader(columns));
  lines.push(dim("-".repeat(Math.max(40, columns))));

  const listHeight = Math.max(4, rows - 10);
  const selected = clamp(state.graveyardSelectedIndex || 0, 0, entries.length - 1);
  state.graveyardSelectedIndex = selected;
  const scrollOffset = Math.max(0, Math.min(selected - Math.floor(listHeight / 2), entries.length - listHeight));
  const scroll = Math.max(0, scrollOffset);
  const visible = entries.slice(scroll, scroll + listHeight);

  for (let i = 0; i < visible.length; i += 1) {
    const entry = visible[i];
    const isSelected = scroll + i === selected;
    const line = buildGraveyardRow(entry, columns - 2);
    lines.push(isSelected ? `\x1b[7m> ${line}\x1b[0m` : `  ${line}`);
  }

  // spacer + detail
  while (lines.length < rows - 3) lines.push("");
  const detail = entries[selected];
  if (detail) {
    lines.push(dim(truncateDisplay(`cwd ${detail.record.cwd || "-"}`, columns)));
    lines.push(dim(truncateDisplay(`cmd ${detail.record.cmd}`, columns)));
  }
  lines.push(buildGraveyardFooter(columns));
  return lines;
}

function buildGraveyardHeader(columns) {
  const port = padDisplay("PORT", 7);
  const project = padDisplay("PROJECT", 22);
  const stateCol = padDisplay("STATE", 6);
  const when = padDisplay("KILLED", 20);
  const cmd = padDisplay("CMD", Math.max(10, columns - port.length - project.length - stateCol.length - when.length - 2));
  return `  ${port}${project}${stateCol}${when}${cmd}`;
}

function buildGraveyardRow(entry, columns) {
  const port = padDisplay(String(entry.port), 7);
  const cwdParts = String(entry.record.cwd || "").split(/[\\/]+/).filter(Boolean);
  const project = padDisplay(truncateDisplay(cwdParts[cwdParts.length - 1] || "-", 21), 22);
  const stateLabel = padDisplay(entry.alive ? "alive" : "dead", 6);
  const when = padDisplay(truncateDisplay(entry.record.capturedAt || "-", 19), 20);
  const cmdCol = truncateDisplay(entry.record.cmd, Math.max(10, columns - port.length - project.length - stateLabel.length - when.length));
  const raw = `${port}${project}${stateLabel}${when}${cmdCol}`;
  return entry.alive ? raw : dim(raw);
}

function buildGraveyardFooter(columns) {
  return dim(truncateDisplay("r revive   d drop   j/k 이동   g/s/esc/q 닫기", columns));
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
  cells.push(padDisplay("PIN", widths.pin));
  cells.push(padDisplay("PORT", widths.port));
  cells.push(padDisplay("PID", widths.pid));
  cells.push(padDisplay("AGE", widths.age));
  cells.push(padDisplay("HOST", widths.host));
  cells.push(padDisplay("PROJECT", widths.project));
  cells.push(padDisplay("PROCESS", widths.process));
  return `  ${cells.join(" ")}`;
}

function buildTuiRow(entry, columns, showKind, isSelected, pinLabel = "-") {
  const widths = getTuiColumnWidths(columns, showKind);
  const kindLabel = entry.groupMember ? "" : String(entry.kind).toUpperCase();
  const portLabel = isAppGroupEntry(entry) ? entry.port : String(entry.port);
  const pidLabel = isAppGroupEntry(entry) ? "-" : String(entry.pid);
  const ageLabel = isAppGroupEntry(entry) ? "-" : entry.elapsed;
  const groupMarker = isAppGroupEntry(entry) ? (entry.groupExpanded ? "v " : "> ") : "";
  const projectLabel = entry.groupMember ? `| ${entry.displayProject || "-"}` : `${groupMarker}${entry.displayProject || "-"}`;
  const processLabel = entry.groupMember ? `| ${entry.displayCommand}` : entry.displayCommand;
  const cells = [];
  if (showKind) {
    cells.push(padDisplay(kindLabel, widths.kind));
  }
  cells.push(padDisplay(pinLabel, widths.pin));
  cells.push(padDisplay(portLabel, widths.port));
  cells.push(padDisplay(pidLabel, widths.pid));
  cells.push(padDisplay(ageLabel, widths.age));
  cells.push(padDisplay(entry.displayHost || entry.host, widths.host));
  cells.push(padDisplay(projectLabel, widths.project));
  cells.push(padDisplay(processLabel, widths.process));

  const marker = isSelected ? ">" : " ";
  const line = `${marker} ${cells.join(" ")}`;
  return styleTuiRow(truncate(line, columns), entry, isSelected);
}

function styleTuiRow(line, entry, isSelected) {
  if (isAppGroupEntry(entry)) {
    const colorPrefix = entry.groupExpanded ? "\x1b[36m" : "\x1b[33m";
    if (isSelected) {
      return `\x1b[7m${colorPrefix}${line}\x1b[39m\x1b[0m`;
    }
    return `${colorPrefix}${line}\x1b[39m`;
  }

  if (isSelected) {
    return `\x1b[7m${line}\x1b[0m`;
  }

  return line;
}

function getTuiColumnWidths(columns, showKind) {
  const usable = Math.max(80, columns - 2);
  const widths = {
    kind: showKind ? 6 : 0,
    pin: 3,
    port: 5,
    pid: 6,
    age: 8,
    host: Math.max(10, Math.floor(usable * 0.14)),
    project: Math.max(16, Math.floor(usable * 0.18)),
    process: 24,
  };

  const fixed = widths.pin + widths.port + widths.pid + widths.age + widths.host + widths.project + (showKind ? widths.kind : 0);
  const spaces = showKind ? 8 : 7;
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
  return current ? getEntrySelectionKey(current) : state.selectionKey;
}

module.exports = {
  startTui,
  __testing: {
    buildVisibleEntries,
    dropSelectedGhost,
    getGraveyardEntries,
    getPinnedDeletionError,
    getListOverflowBelowCount,
    handleGraveyardViewKey,
    handleMainViewKey,
    killSelectedEntry,
    moveGraveyardSelection,
    openGraveyardView,
    closeGraveyardView,
    renderGraveyardScreen,
    renderMainScreen,
    requestKillSelectedEntry,
    reviveSelectedGhost,
    setSelectionByIndex,
    toggleSelectedAppGroup,
  },
};
