const test = require("node:test");
const assert = require("node:assert/strict");

const { getEntryListenerKey, getEntryPreferenceKey, selectListeners, sortListeners } = require("../lib/ports");

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

test("getEntryPreferenceKey ignores rewritten port arguments", () => {
  const left = createEntry({
    port: 3000,
    args: "pnpm dev --port 3000",
    displayCommand: "pnpm dev --port 3000",
  });
  const right = createEntry({
    port: 4173,
    args: "pnpm dev --port 4173",
    displayCommand: "pnpm dev --port 4173",
  });

  assert.equal(getEntryPreferenceKey(left), getEntryPreferenceKey(right));
});

test("sortListeners places pinned entries first and respects saved order", () => {
  const alpha = createEntry({
    pid: 1001,
    port: 3000,
    cwd: "/Users/test/dev/alpha",
    projectName: "alpha",
    displayProject: "alpha",
    displayCwd: "~/dev/alpha",
    args: "pnpm dev --port 3000",
    displayCommand: "pnpm dev --port 3000",
  });
  const beta = createEntry({
    pid: 1002,
    port: 3001,
    cwd: "/Users/test/dev/beta",
    projectName: "beta",
    displayProject: "beta",
    displayCwd: "~/dev/beta",
    args: "pnpm dev --port 3001",
    displayCommand: "pnpm dev --port 3001",
  });
  const gamma = createEntry({
    pid: 1003,
    port: 3002,
    cwd: "/Users/test/dev/gamma",
    projectName: "gamma",
    displayProject: "gamma",
    displayCwd: "~/dev/gamma",
    args: "pnpm dev --port 3002",
    displayCommand: "pnpm dev --port 3002",
  });

  const sorted = sortListeners([alpha, beta, gamma], {
    pinnedListenerKeys: [getEntryListenerKey(gamma)],
    orderedEntryKeys: [getEntryListenerKey(gamma), getEntryListenerKey(beta), getEntryListenerKey(alpha)],
  });

  assert.deepEqual(
    sorted.map((entry) => entry.displayProject),
    ["gamma", "beta", "alpha"]
  );
});

test("selectListeners keeps pinned non-dev entries in the default view", () => {
  const alpha = createEntry({
    pid: 1001,
    port: 3000,
    cwd: "/Users/test/dev/alpha",
    projectName: "alpha",
    displayProject: "alpha",
    displayCwd: "~/dev/alpha",
    kind: "dev",
    args: "pnpm dev --port 3000",
    displayCommand: "pnpm dev --port 3000",
  });
  const postgres = createEntry({
    pid: 2001,
    port: 5432,
    cwd: "/Users/test/local/postgres",
    projectName: "postgres",
    displayProject: "postgres",
    displayCwd: "~/local/postgres",
    kind: "system",
    command: "postgres",
    args: "postgres -D /opt/homebrew/var/postgresql@16",
    displayCommand: "postgres -D /opt/homebrew/var/postgresql@16",
  });

  const selected = selectListeners([postgres, alpha], { all: false }, {
    pinnedListenerKeys: [getEntryListenerKey(postgres)],
    orderedEntryKeys: [getEntryListenerKey(postgres), getEntryListenerKey(alpha)],
  });

  assert.deepEqual(
    selected.map((entry) => entry.port),
    [5432, 3000]
  );
});

test("selectListeners keeps individually pinned listeners without pinning the whole app group", () => {
  const alpha3000 = createEntry({
    pid: 1001,
    port: 3000,
    cwd: "/Users/test/dev/alpha",
    projectName: "alpha",
    displayProject: "alpha",
    displayCwd: "~/dev/alpha",
    kind: "system",
    args: "pnpm dev --port 3000",
    displayCommand: "pnpm dev --port 3000",
  });
  const alpha4173 = createEntry({
    pid: 1002,
    port: 4173,
    cwd: "/Users/test/dev/alpha",
    projectName: "alpha",
    displayProject: "alpha",
    displayCwd: "~/dev/alpha",
    kind: "system",
    args: "pnpm dev --port 4173",
    displayCommand: "pnpm dev --port 4173",
  });

  const selected = selectListeners([alpha3000, alpha4173], { all: false }, {
    pinnedListenerKeys: [getEntryListenerKey(alpha4173)],
    orderedEntryKeys: [getEntryListenerKey(alpha4173)],
  });

  assert.deepEqual(
    selected.map((entry) => entry.port),
    [4173]
  );
});
