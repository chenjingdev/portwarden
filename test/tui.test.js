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
    command: overrides.command ?? "node",
    args: overrides.args ?? "pnpm dev --port 3000",
    cwd: overrides.cwd ?? "/Users/test/dev/sample",
    elapsed: overrides.elapsed ?? "00:10",
    kind: overrides.kind ?? "dev",
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
