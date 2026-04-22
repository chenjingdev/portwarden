const test = require("node:test");
const assert = require("node:assert/strict");

const { getEntryListenerKey } = require("../lib/ports");
const { __testing } = require("../lib/tui");

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, "");
}

function createEntry(overrides = {}) {
  return {
    pid: overrides.pid ?? 1000,
    ppid: overrides.ppid ?? 1,
    port: overrides.port ?? 3000,
    host: overrides.host ?? "127.0.0.1",
    listenerHosts: overrides.listenerHosts ?? [overrides.host ?? "127.0.0.1"],
    displayHost: overrides.displayHost ?? overrides.host ?? "127.0.0.1",
    command: overrides.command ?? "node",
    args: overrides.args ?? "pnpm dev --port 3000",
    cwd: overrides.cwd ?? "/Users/test/dev/sample",
    elapsed: overrides.elapsed ?? "00:10",
    kind: overrides.kind ?? "dev",
    appFamily: overrides.appFamily ?? "",
    entryType: overrides.entryType,
    selectionKey: overrides.selectionKey,
    groupKey: overrides.groupKey,
    groupMember: overrides.groupMember ?? false,
    groupExpanded: overrides.groupExpanded ?? false,
    groupCount: overrides.groupCount ?? 0,
    groupMembers: overrides.groupMembers ?? [],
    projectName: overrides.projectName ?? "sample",
    displayProject: overrides.displayProject ?? "sample",
    displayCommand: overrides.displayCommand ?? "pnpm dev --port 3000",
    displayCwd: overrides.displayCwd ?? "~/dev/sample",
  };
}

function createPinnedState(entry, overrides = {}) {
  return {
    visibleListeners: [entry],
    selectedIndex: 0,
    config: {
      confirmActions: overrides.confirmActions ?? true,
      pinnedListenerKeys: overrides.pinnedListenerKeys ?? [getEntryListenerKey(entry)],
      orderedEntryKeys: overrides.orderedEntryKeys ?? [getEntryListenerKey(entry)],
    },
    pendingAction: overrides.pendingAction ?? null,
    error: overrides.error ?? "",
    status: overrides.status ?? "",
    expandedAppGroups: overrides.expandedAppGroups ?? new Set(),
    selectionKey: null,
  };
}

function createRenderState(entries, overrides = {}) {
  return {
    allListeners: overrides.allListeners ?? entries,
    browser: overrides.browser ?? null,
    busy: false,
    config: {
      confirmActions: true,
      pinnedListenerKeys: overrides.pinnedListenerKeys ?? [],
      orderedEntryKeys: overrides.orderedEntryKeys ?? [],
    },
    error: overrides.error ?? "",
    lastRefreshAt: overrides.lastRefreshAt ?? null,
    pendingAction: overrides.pendingAction ?? null,
    portCounts: overrides.portCounts ?? new Map(entries.map((entry) => [entry.port, 1])),
    scrollOffset: overrides.scrollOffset ?? 0,
    selectedIndex: overrides.selectedIndex ?? 0,
    listScope: overrides.listScope ?? "all",
    status: overrides.status ?? "",
    expandedAppGroups: overrides.expandedAppGroups ?? new Set(),
    visibleListeners: entries,
  };
}

test("requestKillSelectedEntry blocks pinned entries before confirmation", () => {
  const entry = createEntry({ port: 4173 });
  const state = createPinnedState(entry, {
    confirmActions: true,
    pendingAction: { label: "old", run: () => {} },
  });

  const result = __testing.requestKillSelectedEntry(state, "SIGTERM", () => {}, () => {});

  assert.equal(result, "blocked");
  assert.equal(state.pendingAction, null);
  assert.equal(state.error, "Pinned port 4173 cannot be stopped. Unpin it first.");
});

test("killSelectedEntry never sends a signal for pinned entries", () => {
  const entry = createEntry({ port: 3001, pid: 4321 });
  const state = createPinnedState(entry, { confirmActions: false });
  const originalKill = process.kill;
  let killCalled = false;
  let refreshed = false;
  let rendered = false;

  process.kill = () => {
    killCalled = true;
  };

  try {
    __testing.killSelectedEntry(
      state,
      "SIGKILL",
      () => {
        refreshed = true;
      },
      () => {
        rendered = true;
      }
    );
  } finally {
    process.kill = originalKill;
  }

  assert.equal(killCalled, false);
  assert.equal(refreshed, false);
  assert.equal(rendered, true);
  assert.equal(state.error, "Pinned port 3001 cannot be stopped. Unpin it first.");
});

test("renderMainScreen shows a + count on the last list line when all view has more entries below", () => {
  const entries = Array.from({ length: 12 }, (_, index) =>
    createEntry({
      pid: 1000 + index,
      port: 3000 + index,
      cwd: `/Users/test/dev/sample-${index}`,
      projectName: `sample-${index}`,
      displayProject: `sample-${index}`,
      displayCwd: `~/dev/sample-${index}`,
      args: `pnpm dev --port ${3000 + index}`,
      displayCommand: `pnpm dev --port ${3000 + index}`,
    })
  );
  const state = createRenderState(entries, {
    listScope: "all",
    selectedIndex: 0,
    scrollOffset: 0,
  });

  const lines = __testing.renderMainScreen(state, 120, 24);
  const detailsIndex = lines.findIndex((line) => line.includes("DETAILS"));

  assert.ok(detailsIndex > 0);
  assert.ok(lines[detailsIndex - 1].includes("+ 3 more"));
});

test("renderMainScreen shows the current status in the bottom info line", () => {
  const entry = createEntry({ port: 5173, displayProject: "frontend" });
  const state = createRenderState([entry], {
    status: "Refreshed: 2026-04-07 10:00:00",
    browser: "Arc",
    lastRefreshAt: new Date("2026-04-07T10:00:00+09:00"),
  });

  const lines = __testing.renderMainScreen(state, 120, 24);

  assert.ok(lines[0].includes("PORTWARDEN"));
  assert.ok(lines.at(-1).includes("info  Refreshed: 2026-04-07 10:00:00"));
});

test("renderMainScreen shows pinned rows in the dedicated pin column even when project is empty", () => {
  const pinnedEntry = createEntry({
    port: 3306,
    displayProject: "",
    projectName: "",
    displayCommand: "mysqld",
    kind: "system",
  });
  const selectedEntry = createEntry({
    port: 5173,
    displayProject: "frontend",
    projectName: "frontend",
  });
  const state = createRenderState([pinnedEntry, selectedEntry], {
    listScope: "all",
    selectedIndex: 1,
    pinnedListenerKeys: [getEntryListenerKey(pinnedEntry)],
  });

  const lines = __testing.renderMainScreen(state, 120, 24).map(stripAnsi);
  const headerLine = lines.find((line) => line.includes("PROJECT") && line.includes("PROCESS"));
  const pinnedRow = lines.find((line) => line.includes("3306"));

  assert.ok(headerLine?.includes("PIN"));
  assert.ok(pinnedRow?.includes("Y"));
  assert.ok(pinnedRow?.includes(" - "));
});

test("renderMainScreen shows single pinned rows as Y in the pin column", () => {
  const singlePinnedEntry = createEntry({
    port: 4321,
    displayProject: "",
    projectName: "",
    displayCommand: "node api.js",
  });
  const state = createRenderState([singlePinnedEntry], {
    listScope: "all",
    selectedIndex: 0,
    pinnedListenerKeys: [getEntryListenerKey(singlePinnedEntry)],
    orderedEntryKeys: [getEntryListenerKey(singlePinnedEntry)],
  });

  const lines = __testing.renderMainScreen(state, 120, 24).map(stripAnsi);
  const pinnedRow = lines.find((line) => line.includes("4321"));

  assert.ok(pinnedRow?.includes("Y"));
  assert.ok(pinnedRow?.includes(" - "));
});

test("setSelectionByIndex keeps the cursor on the same row after the list order changes", () => {
  const first = createEntry({ pid: 1001, port: 3000 });
  const second = createEntry({ pid: 1002, port: 3001 });
  const third = createEntry({ pid: 1003, port: 3002 });
  const state = createRenderState([first, second, third], {
    selectedIndex: 1,
  });

  state.visibleListeners = [first, third];
  __testing.setSelectionByIndex(state, 1);

  assert.equal(state.selectedIndex, 1);
  assert.equal(state.selectionKey, "1003:3002:127.0.0.1");
});

test("renderMainScreen prefers normalized host labels in rows and details", () => {
  const entry = createEntry({
    host: "::1",
    displayHost: "localhost",
    displayProject: "@playwright/mcp",
    projectName: "@playwright/mcp",
    displayCwd: "",
    displayCommand: "pnpm dlx @playwright/mcp --port 53188",
  });
  const state = createRenderState([entry], {
    listScope: "all",
    selectedIndex: 0,
  });

  const lines = __testing.renderMainScreen(state, 120, 24).map(stripAnsi);
  const portRow = lines.find((line) => line.includes("3000"));

  assert.ok(portRow?.includes("localhost"));
  assert.match(lines.join("\n"), /host localhost/);
});

test("buildVisibleEntries collapses app helper listeners into a single group row in all view", () => {
  const antigravityHelper = createEntry({
    pid: 2001,
    port: 59267,
    kind: "app",
    appFamily: "Antigravity",
    projectName: "Antigravity Helper (Plugin)",
    displayProject: "Antigravity Helper (Plugin)",
    displayCommand: "/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper (Plugin).app/Contents/MacOS/Antigravity Helper (Plugin)",
    displayCwd: "",
    cwd: "/",
  });
  const antigravityLanguageServer = createEntry({
    pid: 2002,
    port: 61473,
    kind: "app",
    appFamily: "Antigravity",
    projectName: "language_server_macos_arm",
    displayProject: "language_server_macos_arm",
    displayCommand: "/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm",
    displayCwd: "",
    cwd: "/",
  });
  const devEntry = createEntry({
    pid: 1001,
    port: 53188,
    kind: "dev",
    projectName: "@playwright/mcp",
    displayProject: "@playwright/mcp",
    displayCommand: "pnpm dlx @playwright/mcp --extension",
    displayCwd: "",
    cwd: "/",
  });
  const figmaAgent = createEntry({
    pid: 2200,
    port: 44950,
    kind: "app",
    appFamily: "Figma",
    projectName: "figma_agent",
    displayProject: "figma_agent",
    displayCommand: "~/Library/Application Support/Figma/FigmaAgent.app/Contents/MacOS/figma_agent",
    displayCwd: "",
    cwd: "/",
  });
  const state = createRenderState([], {
    allListeners: [devEntry, antigravityHelper, figmaAgent, antigravityLanguageServer],
    listScope: "all",
  });

  const visibleEntries = __testing.buildVisibleEntries([devEntry, antigravityHelper, figmaAgent, antigravityLanguageServer], state);

  assert.equal(visibleEntries.length, 3);
  assert.equal(visibleEntries[1].displayProject, "figma_agent");
  assert.equal(visibleEntries[2].entryType, "app-group");
  assert.equal(visibleEntries[2].displayProject, "Antigravity");
  assert.equal(visibleEntries[2].groupCount, 2);
});

test("buildVisibleEntries moves grouped app rows to the end of the all view", () => {
  const groupedFirst = createEntry({
    pid: 2001,
    port: 59267,
    kind: "app",
    appFamily: "Antigravity",
    projectName: "Antigravity Helper (Plugin)",
    displayProject: "Antigravity Helper (Plugin)",
    displayCommand: "/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper (Plugin).app/Contents/MacOS/Antigravity Helper (Plugin)",
    displayCwd: "",
    cwd: "/",
  });
  const systemEntry = createEntry({
    pid: 3001,
    port: 5000,
    kind: "system",
    projectName: "ControlCenter",
    displayProject: "ControlCenter",
    displayCommand: "/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter",
    displayCwd: "",
    cwd: "/",
  });
  const groupedSecond = createEntry({
    pid: 2002,
    port: 61473,
    kind: "app",
    appFamily: "Antigravity",
    projectName: "language_server_macos_arm",
    displayProject: "language_server_macos_arm",
    displayCommand: "/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm",
    displayCwd: "",
    cwd: "/",
  });
  const state = createRenderState([], {
    allListeners: [groupedFirst, systemEntry, groupedSecond],
    listScope: "all",
  });

  const visibleEntries = __testing.buildVisibleEntries([groupedFirst, systemEntry, groupedSecond], state);

  assert.deepEqual(
    visibleEntries.map((entry) => entry.displayProject),
    ["ControlCenter", "Antigravity"]
  );
  assert.equal(visibleEntries[1].entryType, "app-group");
});

test("buildVisibleEntries respects pinned host aliases for collapsed listeners", () => {
  const pinnedHelper = createEntry({
    pid: 2001,
    port: 18789,
    host: "127.0.0.1",
    listenerHosts: ["127.0.0.1", "::1"],
    displayHost: "localhost",
    kind: "app",
    appFamily: "Antigravity",
    projectName: "Antigravity Helper (Plugin)",
    displayProject: "Antigravity Helper (Plugin)",
    displayCommand: "/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper (Plugin).app/Contents/MacOS/Antigravity Helper (Plugin)",
    displayCwd: "",
    cwd: "/",
  });
  const siblingHelper = createEntry({
    pid: 2002,
    port: 61473,
    host: "::1",
    listenerHosts: ["::1"],
    displayHost: "localhost",
    kind: "app",
    appFamily: "Antigravity",
    projectName: "language_server_macos_arm",
    displayProject: "language_server_macos_arm",
    displayCommand: "/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm",
    displayCwd: "",
    cwd: "/",
  });
  const state = createRenderState([], {
    allListeners: [pinnedHelper, siblingHelper],
    listScope: "all",
    pinnedListenerKeys: ["host:::1::port:18789"],
  });

  const visibleEntries = __testing.buildVisibleEntries([pinnedHelper, siblingHelper], state);

  assert.deepEqual(
    visibleEntries.map((entry) => entry.displayProject),
    ["Antigravity Helper (Plugin)", "language_server_macos_arm"]
  );
  assert.ok(visibleEntries.every((entry) => entry.entryType !== "app-group"));
});

test("requestKillSelectedEntry blocks destructive actions on collapsed app groups", () => {
  const state = createRenderState([], {
    listScope: "all",
  });
  state.visibleListeners = [
    {
      entryType: "app-group",
      selectionKey: "app:antigravity",
      groupKey: "app:antigravity",
      groupExpanded: false,
      groupCount: 2,
      groupMembers: [],
      kind: "app",
      appFamily: "Antigravity",
      port: "2x",
      pid: "-",
      elapsed: "-",
      host: "localhost",
      displayHost: "localhost",
      projectName: "Antigravity",
      displayProject: "Antigravity",
      displayCommand: "2 listeners",
      displayCwd: "",
    },
  ];

  const result = __testing.requestKillSelectedEntry(state, "SIGTERM", () => {}, () => {});

  assert.equal(result, "blocked");
  assert.equal(state.error, "Expand Antigravity first to stop a specific listener.");
});

test("renderMainScreen shows grouped app rows with a count label", () => {
  const groupedEntry = {
    entryType: "app-group",
    selectionKey: "app:antigravity",
    groupKey: "app:antigravity",
    groupExpanded: false,
    groupCount: 4,
    groupMembers: [],
    kind: "app",
    appFamily: "Antigravity",
    port: "4x",
    pid: "-",
    elapsed: "-",
    host: "localhost",
    displayHost: "localhost",
    projectName: "Antigravity",
    displayProject: "Antigravity",
    displayCommand: "4 listeners · Antigravity Helper (Plugin), language_server_macos_arm",
    displayCwd: "",
  };
  const state = createRenderState([groupedEntry], {
    allListeners: Array.from({ length: 4 }, (_, index) =>
      createEntry({
        pid: 3000 + index,
        port: 6100 + index,
        kind: "app",
        appFamily: "Antigravity",
        displayProject: "Antigravity Helper (Plugin)",
        projectName: "Antigravity Helper (Plugin)",
      })
    ),
    listScope: "all",
  });

  const lines = __testing.renderMainScreen(state, 140, 24).map(stripAnsi);
  const groupedRow = lines.find((line) => line.includes("Antigravity"));

  assert.ok(lines[0].includes("[4 ports]"));
  assert.ok(lines[0].includes("[1 rows]"));
  assert.ok(groupedRow?.includes("4x"));
  assert.ok(groupedRow?.includes("> Antigravity"));
  assert.ok(groupedRow?.includes("APP"));
});

test("renderMainScreen shows expanded app groups with an open marker", () => {
  const expandedGroup = {
    entryType: "app-group",
    selectionKey: "app:antigravity",
    groupKey: "app:antigravity",
    groupExpanded: true,
    groupCount: 2,
    groupMembers: [],
    kind: "app",
    appFamily: "Antigravity",
    port: "2x",
    pid: "-",
    elapsed: "-",
    host: "localhost",
    displayHost: "localhost",
    projectName: "Antigravity",
    displayProject: "Antigravity",
    displayCommand: "open · 2 listeners · enter collapse",
    displayCwd: "",
  };
  const childEntry = createEntry({
    pid: 4001,
    port: 61473,
    kind: "app",
    appFamily: "Antigravity",
    groupKey: "app:antigravity",
    groupMember: true,
    displayProject: "language_server_macos_arm",
    projectName: "language_server_macos_arm",
    displayCommand: "/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm",
    displayCwd: "",
    cwd: "/",
  });
  const state = createRenderState([expandedGroup, childEntry], {
    allListeners: [childEntry],
    listScope: "all",
  });

  const lines = __testing.renderMainScreen(state, 140, 24).map(stripAnsi);
  const groupedRow = lines.find((line) => line.includes("2x"));
  const childRow = lines.find((line) => line.includes("language_server_macos"));

  assert.ok(groupedRow?.includes("v Antigravity"));
  assert.ok(groupedRow?.includes("APP"));
  assert.ok(groupedRow?.includes("open · 2 listeners"));
  assert.ok(childRow);
  assert.ok(!childRow.includes("APP"));
  assert.match(lines.join("\n"), /\|\s+language_server_macos/);
});

test("renderMainScreen colors collapsed and expanded app groups differently", () => {
  const collapsedGroup = {
    entryType: "app-group",
    selectionKey: "app:antigravity",
    groupKey: "app:antigravity",
    groupExpanded: false,
    groupCount: 2,
    groupMembers: [],
    kind: "app",
    appFamily: "Antigravity",
    port: "2x",
    pid: "-",
    elapsed: "-",
    host: "localhost",
    displayHost: "localhost",
    projectName: "Antigravity",
    displayProject: "Antigravity",
    displayCommand: "closed · 2 listeners",
    displayCwd: "",
  };
  const expandedGroup = {
    ...collapsedGroup,
    selectionKey: "app:figma",
    groupKey: "app:figma",
    groupExpanded: true,
    appFamily: "Figma",
    projectName: "Figma",
    displayProject: "Figma",
    displayCommand: "open · 2 listeners",
  };
  const state = createRenderState([collapsedGroup, expandedGroup], {
    allListeners: [],
    listScope: "all",
  });

  const lines = __testing.renderMainScreen(state, 140, 24);
  const collapsedRow = lines.find((line) => line.includes("Antigravity"));
  const expandedRow = lines.find((line) => line.includes("Figma"));

  assert.match(collapsedRow, /\x1b\[33m/);
  assert.match(expandedRow, /\x1b\[36m/);
});

test("handleMainViewKey uses arrows to expand and collapse app groups", () => {
  const actionsCalled = [];
  const actions = new Proxy(
    {},
    {
      get(_target, prop) {
        return () => {
          actionsCalled.push(prop);
        };
      },
    }
  );
  const groupEntry = {
    entryType: "app-group",
    selectionKey: "app:antigravity",
    groupKey: "app:antigravity",
    groupExpanded: false,
    displayProject: "Antigravity",
  };
  const childEntry = createEntry({
    groupKey: "app:antigravity",
    groupMember: true,
    displayProject: "language_server_macos_arm",
    projectName: "language_server_macos_arm",
  });
  const state = createRenderState([groupEntry, childEntry], {
    allListeners: [],
    listScope: "all",
    selectedIndex: 0,
  });

  assert.equal(__testing.handleMainViewKey(state, "\u001b[C", actions), true);
  assert.deepEqual(actionsCalled, ["toggleSelectedAppGroup"]);

  actionsCalled.length = 0;
  state.visibleListeners[0].groupExpanded = true;
  assert.equal(__testing.handleMainViewKey(state, "\u001b[D", actions), true);
  assert.deepEqual(actionsCalled, ["toggleSelectedAppGroup"]);

  actionsCalled.length = 0;
  state.selectedIndex = 1;
  assert.equal(__testing.handleMainViewKey(state, "\u001b[D", actions), true);
  assert.deepEqual(actionsCalled, ["toggleSelectedAppGroup"]);
});

// --- graveyard (v0.3 무덤 뷰) ---

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function withTempXdg(fn) {
  const original = process.env.XDG_CONFIG_HOME;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "portwarden-grave-"));
  process.env.XDG_CONFIG_HOME = temp;
  try { fn(temp); } finally {
    if (original === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = original;
  }
}

test("graveyard: killSelectedEntry captures a revive snapshot for non-pinned entries", () => {
  withTempXdg(() => {
    const entry = createEntry({ port: 5173, args: "node vite.js", cwd: "/u/t" });
    const state = {
      visibleListeners: [entry],
      selectedIndex: 0,
      selectionKey: null,
      config: {
        confirmActions: false,
        pinnedListenerKeys: [], // NOT pinned — passes pin-kill guard
        orderedEntryKeys: [],
        revivablePins: {},
      },
      allListeners: [entry],
      pendingAction: null,
      error: "",
      status: "",
      expandedAppGroups: new Set(),
    };
    const originalKill = process.kill;
    process.kill = () => {};
    try {
      __testing.killSelectedEntry(state, "SIGTERM", () => {}, () => {});
    } finally { process.kill = originalKill; }

    const key = getEntryListenerKey(entry);
    assert.ok(state.config.revivablePins[key], "revivablePins must be populated for the killed entry");
    assert.equal(state.config.revivablePins[key].cmd, "node vite.js");
    assert.ok(state.status.includes("무덤"));
  });
});

test("graveyard: pin-kill guard still protects pinned entries (no capture, no kill)", () => {
  withTempXdg(() => {
    const entry = createEntry({ port: 3306 });
    const state = {
      visibleListeners: [entry],
      selectedIndex: 0,
      selectionKey: null,
      config: {
        confirmActions: false,
        pinnedListenerKeys: [getEntryListenerKey(entry)],
        orderedEntryKeys: [getEntryListenerKey(entry)],
        revivablePins: {},
      },
      allListeners: [entry],
      pendingAction: null,
      error: "",
      status: "",
      expandedAppGroups: new Set(),
    };
    const originalKill = process.kill;
    let killed = false;
    process.kill = () => { killed = true; };
    try {
      __testing.killSelectedEntry(state, "SIGTERM", () => {}, () => {});
    } finally { process.kill = originalKill; }

    assert.equal(killed, false);
    assert.deepEqual(state.config.revivablePins, {});
    assert.ok(state.error.includes("Pinned"));
  });
});

test("graveyard: openGraveyardView switches view and getGraveyardEntries returns records sorted newest-first", () => {
  const state = {
    view: "list",
    graveyardSelectedIndex: 0,
    pendingAction: null,
    allListeners: [],
    config: {
      revivablePins: {
        "host:*::port:3000": { cwd: "/a", cmd: "x", capturedAt: "2026-04-22T10:00:00Z", source: "auto" },
        "host:*::port:5173": { cwd: "/b", cmd: "y", capturedAt: "2026-04-22T12:00:00Z", source: "auto" },
      },
    },
  };
  __testing.openGraveyardView(state);
  assert.equal(state.view, "graveyard");
  const entries = __testing.getGraveyardEntries(state);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].port, 5173, "newest first");
  assert.equal(entries[1].port, 3000);
});

test("graveyard: live-port entries are marked alive; absent ports marked dead", () => {
  const state = {
    allListeners: [{ port: 5173, host: "127.0.0.1", listenerHosts: ["127.0.0.1"] }],
    config: {
      revivablePins: {
        "host:::1::port:5173": { cwd: "/a", cmd: "x", capturedAt: "2026-04-22T12:00:00Z", source: "auto" },
        "host:*::port:3000":   { cwd: "/b", cmd: "y", capturedAt: "2026-04-22T11:00:00Z", source: "auto" },
      },
    },
  };
  const entries = __testing.getGraveyardEntries(state);
  const vite = entries.find((e) => e.port === 5173);
  const three = entries.find((e) => e.port === 3000);
  assert.equal(vite.alive, true);
  assert.equal(three.alive, false);
});

test("graveyard: dropSelectedGhost removes the record from revivablePins and persists", () => {
  withTempXdg(() => {
    const { loadConfig } = require("../lib/config");
    const state = {
      graveyardSelectedIndex: 0,
      allListeners: [],
      config: {
        browser: "",
        confirmActions: false,
        pinnedListenerKeys: [],
        orderedEntryKeys: [],
        revivablePins: {
          "host:*::port:9999": { cwd: "/a", cmd: "x", capturedAt: "2026-04-22T12:00:00Z", source: "auto" },
        },
      },
      error: "",
      status: "",
    };
    __testing.dropSelectedGhost(state);
    assert.deepEqual(state.config.revivablePins, {});
    const onDisk = loadConfig();
    assert.deepEqual(onDisk.revivablePins, {});
  });
});

test("graveyard: reviveSelectedGhost calls reviveSnapshot (dry-run) without crashing", () => {
  const originalEnv = process.env.DEV_PORTS_SPAWN_DRY_RUN;
  process.env.DEV_PORTS_SPAWN_DRY_RUN = "1";
  try {
    const state = {
      graveyardSelectedIndex: 0,
      allListeners: [],
      config: {
        revivablePins: {
          "host:*::port:3000": { cwd: "/x", cmd: "node a.js", capturedAt: "2026-04-22T12:00:00Z", source: "auto" },
        },
      },
      error: "",
      status: "",
    };
    let refreshCalled = false;
    __testing.reviveSelectedGhost(state, () => { refreshCalled = true; });
    assert.ok(state.status.includes("Revive"));
    assert.equal(state.error, "");
    assert.equal(refreshCalled, true);
  } finally {
    if (originalEnv === undefined) delete process.env.DEV_PORTS_SPAWN_DRY_RUN;
    else process.env.DEV_PORTS_SPAWN_DRY_RUN = originalEnv;
  }
});

test("graveyard: handleMainViewKey routes 'g' to openGraveyard action", () => {
  const called = [];
  const actions = new Proxy({}, { get: (_t, p) => () => { called.push(p); } });
  const state = createRenderState([createEntry()], { pinnedListenerKeys: [] });
  __testing.handleMainViewKey(state, "g", actions);
  assert.deepEqual(called, ["openGraveyard"]);
});

test("graveyard: handleGraveyardViewKey routes r/d/j/k/esc correctly", () => {
  const called = [];
  const actions = new Proxy({}, { get: (_t, p) => () => { called.push(p); } });
  const state = { view: "graveyard", graveyardSelectedIndex: 0, allListeners: [], config: { revivablePins: {} } };
  __testing.handleGraveyardViewKey(state, "r", actions);
  __testing.handleGraveyardViewKey(state, "d", actions);
  __testing.handleGraveyardViewKey(state, "j", actions);
  __testing.handleGraveyardViewKey(state, "k", actions);
  __testing.handleGraveyardViewKey(state, "\u001b", actions); // esc
  assert.deepEqual(called, [
    "reviveSelectedGhost",
    "dropSelectedGhost",
    "moveGraveyardDown",
    "moveGraveyardUp",
    "closeGraveyard",
  ]);
});

test("graveyard: renderGraveyardScreen shows empty-state when no revivablePins", () => {
  const state = { graveyardSelectedIndex: 0, allListeners: [], config: { revivablePins: {} } };
  const lines = __testing.renderGraveyardScreen(state, 120, 24).map(stripAnsi);
  assert.ok(lines.some((line) => line.includes("GRAVEYARD")));
  assert.ok(lines.some((line) => line.includes("아직") && line.includes("죽인")));
});
