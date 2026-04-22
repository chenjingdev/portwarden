const test = require("node:test");
const assert = require("node:assert/strict");

const { __testing, getEntryListenerKey, getEntryPreferenceKey, selectListeners, sortListeners } = require("../lib/ports");

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

test("collapseEquivalentListeners merges rows that only differ by equivalent host labels", () => {
  const collapsed = __testing.collapseEquivalentListeners([
    createEntry({
      pid: 1001,
      port: 18789,
      host: "127.0.0.1",
      listenerHosts: ["127.0.0.1"],
      displayHost: "localhost",
      kind: "system",
    }),
    createEntry({
      pid: 1001,
      port: 18789,
      host: "::1",
      listenerHosts: ["::1"],
      displayHost: "localhost",
      kind: "system",
    }),
    createEntry({
      pid: 1002,
      port: 5000,
      host: "*",
      listenerHosts: ["*"],
      displayHost: "*",
      kind: "system",
    }),
    createEntry({
      pid: 1002,
      port: 5000,
      host: "*",
      listenerHosts: ["*"],
      displayHost: "*",
      kind: "system",
    }),
  ]);

  assert.equal(collapsed.length, 2);
  assert.equal(collapsed[0].host, "127.0.0.1");
  assert.deepEqual(collapsed[0].listenerHosts, ["127.0.0.1", "::1"]);
  assert.equal(collapsed[1].host, "*");
  assert.deepEqual(collapsed[1].listenerHosts, ["*"]);
});

test("selectListeners matches saved host aliases for collapsed listeners", () => {
  const mergedEntry = __testing.collapseEquivalentListeners([
    createEntry({
      pid: 1001,
      port: 18789,
      host: "127.0.0.1",
      listenerHosts: ["127.0.0.1"],
      displayHost: "localhost",
      kind: "system",
      projectName: "openclaw-gateway",
      displayProject: "openclaw-gateway",
    }),
    createEntry({
      pid: 1001,
      port: 18789,
      host: "::1",
      listenerHosts: ["::1"],
      displayHost: "localhost",
      kind: "system",
      projectName: "openclaw-gateway",
      displayProject: "openclaw-gateway",
    }),
  ])[0];

  const selected = selectListeners([mergedEntry], { all: false }, {
    pinnedListenerKeys: ["host:::1::port:18789"],
    orderedEntryKeys: ["host:::1::port:18789"],
  });

  assert.equal(selected.length, 1);
  assert.equal(selected[0].port, 18789);
});

test("getProjectName falls back to the pnpm dlx package name when cwd is root", () => {
  const details = {
    cwd: "/",
    command: "node",
    args: "node /Users/test/Library/Caches/pnpm/dlx/5e6c877401e79938bd0cfe60829a8cb14dbcb809dcffe7ee4ac5ac31ebac41b4/19d659510aa-caa9/node_modules/.bin/../.pnpm/@playwright+mcp@0.0.70/node_modules/@playwright/mcp/cli.js --port 53188",
  };

  assert.equal(__testing.getProjectName(details), "@playwright/mcp");
});

test("formatDisplayCwd hides root cwd for pnpm dlx cache processes", () => {
  const args = "node /Users/test/Library/Caches/pnpm/dlx/5e6c877401e79938bd0cfe60829a8cb14dbcb809dcffe7ee4ac5ac31ebac41b4/19d659510aa-caa9/node_modules/.bin/../.pnpm/@playwright+mcp@0.0.70/node_modules/@playwright/mcp/cli.js --port 53188";

  assert.equal(__testing.formatDisplayCwd("/", args), "");
});

test("inferAppFamily groups desktop helper processes by the host app", () => {
  const details = {
    cwd: "/",
    command: "Antigravity Helper (Plugin)",
    args: "/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper (Plugin).app/Contents/MacOS/Antigravity Helper (Plugin)",
  };

  assert.equal(__testing.inferAppFamily(details), "Antigravity");
});

const { buildReviveLogPath, captureReviveSnapshot, reviveSnapshot } = require("../lib/ports");

test("captureReviveSnapshot returns null when args is empty", () => {
  const snap = captureReviveSnapshot(createEntry({ args: "" }));
  assert.equal(snap, null);
});

test("captureReviveSnapshot builds a record with cwd/cmd/capturedAt/source", () => {
  const snap = captureReviveSnapshot(createEntry({ port: 5173, host: "127.0.0.1", cwd: "/u/t", args: "vite" }));
  assert.equal(snap.listenerKey, "host:127.0.0.1::port:5173");
  assert.equal(snap.record.cmd, "vite");
  assert.equal(snap.record.cwd, "/u/t");
  assert.equal(snap.record.source, "auto");
  assert.ok(typeof snap.record.capturedAt === "string" && snap.record.capturedAt.length > 0);
});

test("buildReviveLogPath produces a slug based on cwd tail + port", () => {
  const logPath = buildReviveLogPath({
    listenerKey: "host:127.0.0.1::port:5173",
    record: { cwd: "/Users/test/dev/sample", cmd: "vite", capturedAt: "x", source: "auto" },
  });
  assert.ok(logPath.endsWith("/sample-5173.log"));
});

test("reviveSnapshot dry-run returns command without spawning a child", () => {
  const originalEnv = process.env.DEV_PORTS_SPAWN_DRY_RUN;
  process.env.DEV_PORTS_SPAWN_DRY_RUN = "1";
  try {
    const result = reviveSnapshot(
      { listenerKey: "host:*::port:3000", record: { cwd: "/x", cmd: "node a.js", capturedAt: "x", source: "auto" } },
      "/tmp/test.log"
    );
    assert.equal(result.pid, null);
    assert.ok(result.command.includes("cd '/x'"));
    assert.ok(result.command.includes("node a.js"));
  } finally {
    if (originalEnv === undefined) delete process.env.DEV_PORTS_SPAWN_DRY_RUN;
    else process.env.DEV_PORTS_SPAWN_DRY_RUN = originalEnv;
  }
});
