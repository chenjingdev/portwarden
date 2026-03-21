#!/usr/bin/env node

const { parseArgs, printHelp } = require("./lib/args");
const { renderWatch } = require("./lib/cli");
const { loadConfig } = require("./lib/config");
const { renderOnce } = require("./lib/output");
const { collectAllListeners, findNextAvailablePort, killByPid, killByPort, selectListeners } = require("./lib/ports");
const { startTui } = require("./lib/tui");

function shouldStartDefaultTui(options) {
  if (options.help || options.json || options.plain) {
    return false;
  }

  if (options.nextPort !== null || options.killPort !== null || options.killPid !== null) {
    return false;
  }

  return process.stdin.isTTY && process.stdout.isTTY;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  if (options.help) {
    printHelp();
    return;
  }

  if (options.tui || shouldStartDefaultTui(options)) {
    startTui(options);
    return;
  }

  if (options.nextPort !== null) {
    const allListeners = collectAllListeners();
    const nextPort = findNextAvailablePort(allListeners, options.nextPort);
    console.log(nextPort);
    return;
  }

  if (options.killPort !== null) {
    killByPort(options.killPort, options.force ? "SIGKILL" : "SIGTERM");
    return;
  }

  if (options.killPid !== null) {
    killByPid(options.killPid, options.force ? "SIGKILL" : "SIGTERM");
    return;
  }

  if (options.watchSeconds > 0) {
    renderWatch(options);
    return;
  }

  const allListeners = collectAllListeners();
  const listeners = selectListeners(allListeners, options, config);
  renderOnce(listeners, allListeners.length, options);
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
