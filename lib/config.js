const fs = require("node:fs");
const path = require("node:path");

const { BROWSER_KEYWORDS, HOME, KNOWN_BROWSER_NAMES } = require("./constants");
const { clamp } = require("./utils");

function getCurrentConfigPath() {
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, "portwarden", "config.json");
  }

  if (process.platform === "darwin") {
    return path.join(HOME, "Library", "Application Support", "portwarden", "config.json");
  }

  return path.join(HOME, ".config", "portwarden", "config.json");
}

function getLegacyConfigPath() {
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, "dev-port-watch", "config.json");
  }

  if (process.platform === "darwin") {
    return path.join(HOME, "Library", "Application Support", "dev-port-watch", "config.json");
  }

  return path.join(HOME, ".config", "dev-port-watch", "config.json");
}

function getConfigPath() {
  const currentPath = getCurrentConfigPath();
  if (fs.existsSync(currentPath)) {
    return currentPath;
  }

  const legacyPath = getLegacyConfigPath();
  if (fs.existsSync(legacyPath)) {
    return legacyPath;
  }

  return currentPath;
}

function createDefaultConfig() {
  return {
    browser: "",
    confirmActions: false,
    pinnedEntryKeys: [],
    orderedEntryKeys: [],
  };
}

function normalizeBrowserName(value) {
  return String(value || "").trim();
}

function normalizeConfirmActions(value) {
  return value === true;
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = [];
  for (const item of value) {
    const text = String(item || "").trim();
    if (!text || normalized.includes(text)) {
      continue;
    }
    normalized.push(text);
  }

  return normalized;
}

function normalizeConfig(config) {
  return {
    browser: normalizeBrowserName(config?.browser),
    confirmActions: normalizeConfirmActions(config?.confirmActions),
    pinnedEntryKeys: normalizeStringList(config?.pinnedEntryKeys),
    orderedEntryKeys: normalizeStringList(config?.orderedEntryKeys),
  };
}

function loadConfig() {
  const currentPath = getCurrentConfigPath();
  const legacyPath = getLegacyConfigPath();
  const configPath = fs.existsSync(currentPath) ? currentPath : legacyPath;

  try {
    if (!fs.existsSync(configPath)) {
      return createDefaultConfig();
    }

    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return normalizeConfig(parsed);
  } catch (error) {
    return createDefaultConfig();
  }
}

function saveConfig(config) {
  const configPath = getCurrentConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        browser: normalizeBrowserName(config.browser),
        confirmActions: normalizeConfirmActions(config.confirmActions),
        pinnedEntryKeys: normalizeStringList(config.pinnedEntryKeys),
        orderedEntryKeys: normalizeStringList(config.orderedEntryKeys),
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function resolveBrowserPreference(options, config) {
  const cliBrowser = normalizeBrowserName(options.browser);
  if (cliBrowser) {
    return { browser: cliBrowser, source: "cli" };
  }

  const envBrowser = normalizeBrowserName(process.env.DEV_PORTS_BROWSER);
  if (envBrowser) {
    return { browser: envBrowser, source: "env" };
  }

  const savedBrowser = normalizeBrowserName(config?.browser);
  if (savedBrowser) {
    return { browser: savedBrowser, source: "config" };
  }

  return { browser: "", source: "system" };
}

function refreshResolvedBrowser(state) {
  const resolved = resolveBrowserPreference(state.options, state.config);
  state.browser = resolved.browser;
  state.browserSource = resolved.source;
}

function detectInstalledBrowsers() {
  const candidates = [];
  const appDirs = process.platform === "darwin" ? ["/Applications", path.join(HOME, "Applications")] : [];

  for (const appDir of appDirs) {
    try {
      const entries = fs.readdirSync(appDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.endsWith(".app")) {
          continue;
        }

        const appName = entry.name.replace(/\.app$/, "");
        const lower = appName.toLowerCase();
        if (BROWSER_KEYWORDS.some((keyword) => lower.includes(keyword))) {
          candidates.push(appName);
        }
      }
    } catch (error) {
      continue;
    }
  }

  return [...new Set(candidates)].sort((left, right) => left.localeCompare(right));
}

function buildSettingsMenuOptions(config) {
  return [
    {
      kind: "browser",
      label: "Default browser",
      value: config.browser || "System default browser",
      detail: "",
    },
    {
      kind: "confirm",
      label: "Confirm mode",
      value: config.confirmActions ? "On" : "Off",
      detail: "",
    },
  ];
}

function buildBrowserOptions(config, activeBrowser) {
  const names = [];
  const knownSet = new Set(KNOWN_BROWSER_NAMES);
  const addName = (name) => {
    const normalized = normalizeBrowserName(name);
    if (!normalized) {
      return;
    }
    if (!names.includes(normalized)) {
      names.push(normalized);
    }
  };

  for (const name of KNOWN_BROWSER_NAMES) {
    addName(name);
  }
  for (const name of detectInstalledBrowsers()) {
    if (!knownSet.has(name)) {
      addName(name);
    }
  }

  if (!knownSet.has(config.browser)) {
    addName(config.browser);
  }

  if (!knownSet.has(activeBrowser)) {
    addName(activeBrowser);
  }

  const options = [{ kind: "system", label: "System default browser", value: "" }];
  for (const name of names) {
    options.push({ kind: "browser", label: name, value: name });
  }
  return options;
}

function findSavedBrowserOptionIndex(options, browserName) {
  const selectedValue = normalizeBrowserName(browserName);
  return options.findIndex((option) => {
    if (option.kind === "confirm") {
      return false;
    }
    if (!selectedValue) {
      return option.kind === "system";
    }
    return option.value === selectedValue;
  });
}

function refreshSettingsOptions(state) {
  state.settingsMenuOptions = buildSettingsMenuOptions(state.config);
  state.settingsBrowserOptions = buildBrowserOptions(state.config, state.browser);

  state.settingsMenuIndex = clamp(state.settingsMenuIndex, 0, Math.max(0, state.settingsMenuOptions.length - 1));
  state.settingsMenuScrollOffset = clamp(
    state.settingsMenuScrollOffset,
    0,
    Math.max(0, state.settingsMenuOptions.length - 1)
  );

  const nextBrowserIndex = findSavedBrowserOptionIndex(state.settingsBrowserOptions, state.config.browser);
  state.settingsBrowserIndex = nextBrowserIndex >= 0 ? nextBrowserIndex : 0;
  state.settingsBrowserScrollOffset = clamp(
    state.settingsBrowserScrollOffset,
    0,
    Math.max(0, state.settingsBrowserOptions.length - 1)
  );
}

function moveSettingsSelection(state, direction) {
  const isBrowserScreen = state.settingsScreen === "browser";
  const items = isBrowserScreen ? state.settingsBrowserOptions : state.settingsMenuOptions;
  const indexKey = isBrowserScreen ? "settingsBrowserIndex" : "settingsMenuIndex";
  const lastIndex = Math.max(0, items.length - 1);
  if (direction === "down") {
    state[indexKey] = clamp(state[indexKey] + 1, 0, lastIndex);
  } else if (direction === "up") {
    state[indexKey] = clamp(state[indexKey] - 1, 0, lastIndex);
  }
}

function ensureSettingsSelectionVisible(state, listHeight) {
  const isBrowserScreen = state.settingsScreen === "browser";
  const items = isBrowserScreen ? state.settingsBrowserOptions : state.settingsMenuOptions;
  const indexKey = isBrowserScreen ? "settingsBrowserIndex" : "settingsMenuIndex";
  const scrollKey = isBrowserScreen ? "settingsBrowserScrollOffset" : "settingsMenuScrollOffset";

  if (state[indexKey] < state[scrollKey]) {
    state[scrollKey] = state[indexKey];
  }

  const bottom = state[scrollKey] + listHeight - 1;
  if (state[indexKey] > bottom) {
    state[scrollKey] = state[indexKey] - listHeight + 1;
  }

  const maxOffset = Math.max(0, items.length - listHeight);
  state[scrollKey] = clamp(state[scrollKey], 0, maxOffset);
}

function describeBrowserSource(source) {
  if (source === "cli") {
    return "--browser";
  }
  if (source === "env") {
    return "DEV_PORTS_BROWSER";
  }
  if (source === "config") {
    return "saved";
  }
  return "system";
}

function describeConfirmMode(enabled) {
  return enabled ? "On" : "Off";
}

module.exports = {
  describeBrowserSource,
  describeConfirmMode,
  ensureSettingsSelectionVisible,
  getConfigPath,
  loadConfig,
  moveSettingsSelection,
  normalizeBrowserName,
  normalizeConfirmActions,
  refreshResolvedBrowser,
  refreshSettingsOptions,
  resolveBrowserPreference,
  saveConfig,
};
