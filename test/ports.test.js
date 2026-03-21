const test = require("node:test");
const assert = require("node:assert/strict");

const { getEntryPreferenceKey, sortListeners } = require("../lib/ports");

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
    pinnedEntryKeys: [getEntryPreferenceKey(gamma)],
    orderedEntryKeys: [getEntryPreferenceKey(gamma), getEntryPreferenceKey(beta), getEntryPreferenceKey(alpha)],
  });

  assert.deepEqual(
    sorted.map((entry) => entry.displayProject),
    ["gamma", "beta", "alpha"]
  );
});
