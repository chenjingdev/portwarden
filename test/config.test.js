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
