function parseArgs(argv) {
  const options = {
    all: false,
    json: false,
    help: false,
    force: false,
    plain: false,
    tui: false,
    browser: "",
    watchSeconds: 0,
    nextPort: null,
    killPort: null,
    killPid: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--all" || arg === "-a") {
      options.all = true;
      continue;
    }

    if (arg === "--json" || arg === "-j") {
      options.json = true;
      continue;
    }

    if (arg === "--force" || arg === "-f") {
      options.force = true;
      continue;
    }

    if (arg === "--plain") {
      options.plain = true;
      continue;
    }

    if (arg === "--tui" || arg === "-t") {
      options.tui = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--watch" || arg === "-w") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        options.watchSeconds = parsePositiveNumber(next, "--watch");
        i += 1;
      } else {
        options.watchSeconds = 2;
      }
      continue;
    }

    if (arg === "--browser" || arg === "-b") {
      options.browser = parseRequiredString(argv[i + 1], "--browser");
      i += 1;
      continue;
    }

    if (arg === "--next-port") {
      options.nextPort = parsePositiveInt(argv[i + 1], "--next-port");
      i += 1;
      continue;
    }

    if (arg === "--kill-port") {
      options.killPort = parsePositiveInt(argv[i + 1], "--kill-port");
      i += 1;
      continue;
    }

    if (arg === "--kill-pid") {
      options.killPid = parsePositiveInt(argv[i + 1], "--kill-pid");
      i += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (options.killPort !== null && options.killPid !== null) {
    throw new Error("--kill-port and --kill-pid cannot be used together.");
  }

  if (options.nextPort !== null && (options.killPort !== null || options.killPid !== null)) {
    throw new Error("--next-port cannot be used together with kill options.");
  }

  if (options.tui && options.json) {
    throw new Error("--tui and --json cannot be used together.");
  }

  if (options.tui && options.plain) {
    throw new Error("--tui and --plain cannot be used together.");
  }

  if ((options.killPort !== null || options.killPid !== null) && options.watchSeconds > 0) {
    throw new Error("Kill options cannot be used together with --watch.");
  }

  if (options.tui && (options.killPort !== null || options.killPid !== null)) {
    throw new Error("--tui and kill options cannot be used together.");
  }

  return options;
}

function parsePositiveInt(value, flagName) {
  if (!value) {
    throw new Error(`${flagName} requires a number.`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${flagName}: ${value}`);
  }

  return parsed;
}

function parsePositiveNumber(value, flagName) {
  if (!value) {
    throw new Error(`${flagName} requires a number.`);
  }

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${flagName}: ${value}`);
  }

  return parsed;
}

function parseRequiredString(value, flagName) {
  if (!value) {
    throw new Error(`${flagName} requires a string.`);
  }

  const parsed = String(value).trim();
  if (!parsed) {
    throw new Error(`${flagName} cannot be empty.`);
  }

  return parsed;
}

function printHelp() {
  console.log(`portwarden

Small CLI for checking and managing active dev ports.

Usage:
  portwarden

Run without arguments to open the TUI.`);
}

module.exports = {
  parseArgs,
  printHelp,
};
