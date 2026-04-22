const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function loadFreshConfigModule() {
  delete require.cache[require.resolve("../lib/config")];
  return require("../lib/config");
}

test("saveConfig and loadConfig preserve listener pins and ordered entries", () => {
  const originalXdg = process.env.XDG_CONFIG_HOME;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portwarden-config-"));
  process.env.XDG_CONFIG_HOME = tempDir;

  try {
    const { loadConfig, saveConfig } = loadFreshConfigModule();
    saveConfig({
      browser: "Arc",
      confirmActions: true,
      pinnedListenerKeys: ["listener-a", "", "listener-a", "listener-b"],
      orderedEntryKeys: ["listener-b", "listener-a", "group:legacy", "listener-b"],
    });

    const loaded = loadConfig();
    assert.deepEqual(loaded, {
      browser: "Arc",
      confirmActions: true,
      pinnedListenerKeys: ["listener-a", "listener-b"],
      orderedEntryKeys: ["listener-b", "listener-a"],
      revivablePins: {},
    });
  } finally {
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
    delete require.cache[require.resolve("../lib/config")];
  }
});

test("saveConfig and loadConfig round-trip revivablePins records and drop malformed ones", () => {
  const originalXdg = process.env.XDG_CONFIG_HOME;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portwarden-config-"));
  process.env.XDG_CONFIG_HOME = tempDir;
  try {
    const { loadConfig, saveConfig } = loadFreshConfigModule();
    saveConfig({
      browser: "",
      confirmActions: false,
      pinnedListenerKeys: [],
      orderedEntryKeys: [],
      revivablePins: {
        "host:127.0.0.1::port:3000": {
          cwd: "/Users/test/dev/sample",
          cmd: "pnpm dev",
          capturedAt: "2026-04-22T12:00:00.000Z",
          source: "auto",
        },
        "host:::1::port:5173": {
          cwd: "/Users/test/dev/agrune",
          cmd: "node vite.js",
          capturedAt: "2026-04-22T13:00:00.000Z",
          source: "manual",
        },
        "host:*::port:9999": null,
        "host:*::port:8888": { cwd: "/x", cmd: "" },
      },
    });

    const loaded = loadConfig();
    assert.deepEqual(Object.keys(loaded.revivablePins).sort(), [
      "host:127.0.0.1::port:3000",
      "host:::1::port:5173",
    ]);
    assert.equal(loaded.revivablePins["host:127.0.0.1::port:3000"].cmd, "pnpm dev");
    assert.equal(loaded.revivablePins["host:::1::port:5173"].source, "manual");
  } finally {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    delete require.cache[require.resolve("../lib/config")];
  }
});
