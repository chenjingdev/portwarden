const { spawn } = require("node:child_process");
const path = require("node:path");

const { DEV_KEYWORDS, DEV_PORTS, HOME, RUNTIME_NAMES } = require("./constants");
const {
  firstToken,
  normalizeWhitespace,
  run,
  shellEscape,
  shortenPath,
  sleep,
  summarizeCommand,
  unique,
} = require("./utils");

const PROJECT_ROOT_HINTS = new Set(["code", "codes", "dev", "git", "project", "projects", "repo", "repos", "src", "work", "workspace", "workspaces"]);
const GENERIC_PROJECT_DIRS = new Set([
  "bin",
  "cache",
  "cellar",
  "etc",
  "lib",
  "lib64",
  "local",
  "log",
  "opt",
  "resources",
  "root",
  "run",
  "sbin",
  "share",
  "srv",
  "tmp",
  "usr",
  "var",
]);

function collectAllListeners() {
  const baseListeners = parseListeners(run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], true));
  const pids = unique(baseListeners.map((entry) => entry.pid));
  const psMap = getProcessMap(pids);
  const cwdMap = getCwdMap(pids);

  return baseListeners
    .map((entry) => enrichEntry(entry, psMap.get(entry.pid), cwdMap.get(entry.pid)))
    .filter(Boolean)
    .sort(compareEntries);
}

function selectListeners(allListeners, options, config = null) {
  const filtered = options.all ? allListeners.slice() : allListeners.filter((entry) => entry.kind === "dev");
  return sortListeners(filtered, config);
}

function buildPortCounts(entries) {
  const counts = new Map();
  for (const entry of entries) {
    counts.set(entry.port, (counts.get(entry.port) || 0) + 1);
  }
  return counts;
}

function findNextAvailablePort(entries, basePort) {
  const usedPorts = new Set(entries.map((entry) => entry.port));
  let candidate = Math.max(1, Number.parseInt(basePort, 10) + 1);

  while (candidate <= 65535) {
    if (!usedPorts.has(candidate)) {
      return candidate;
    }
    candidate += 1;
  }

  throw new Error("Could not find an available port.");
}

function buildRelaunchCommand(entry, newPort) {
  const command = normalizeWhitespace(entry.args || "");
  if (!command) {
    throw new Error("Could not determine the original launch command.");
  }

  const replacementRules = [
    [/(--port=)(\d+)/, `$1${newPort}`],
    [/(--port\s+)(\d+)/, `$1${newPort}`],
    [/(^|\s)(-p=)(\d+)/, `$1$2${newPort}`],
    [/(^|\s)(-p\s+)(\d+)/, `$1$2${newPort}`],
    [/(^|\s)(PORT=)(\d+)/, `$1$2${newPort}`],
    [/(python(?:3)?\s+-m\s+http\.server\s+)(\d+)/, `$1${newPort}`],
    [/(php\s+-S\s+[^:\s]+:)(\d+)/, `$1${newPort}`],
  ];

  for (const [pattern, replacement] of replacementRules) {
    if (pattern.test(command)) {
      return command.replace(pattern, replacement);
    }
  }

  const lower = command.toLowerCase();

  if (/\bnext\b/.test(lower)) {
    return `${command} -p ${newPort}`;
  }

  if (/\bhttp\.server\b/.test(lower)) {
    return `${command} ${newPort}`;
  }

  if (/\b(vite|astro|nuxt|storybook|webpack|parcel|serve|uvicorn|flask|django|bun|deno)\b/.test(lower)) {
    return `${command} --port ${newPort}`;
  }

  if (/\brails\b/.test(lower)) {
    return `PORT=${newPort} ${command}`;
  }

  throw new Error("This process does not match an automatic port rewrite rule. Only `--port`, `-p`, and `PORT=` patterns are supported.");
}

function waitForPortListener(port, options = {}) {
  const timeoutMs = options.timeoutMs || 12000;
  const cwd = options.cwd || "";
  const originalPid = options.originalPid || null;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const listeners = collectAllListeners();
    const exactMatch = listeners.find((entry) => {
      if (entry.port !== port) {
        return false;
      }
      if (originalPid && entry.pid === originalPid) {
        return false;
      }
      if (cwd && entry.cwd === cwd) {
        return true;
      }
      return true;
    });

    if (exactMatch) {
      return exactMatch;
    }

    sleep(300);
  }

  throw new Error(`Port ${port} did not start listening within ${Math.round(timeoutMs / 1000)}s.`);
}

function launchDetachedCommand(command, cwd) {
  const shell = process.env.SHELL || "/bin/zsh";
  const shellCommand = cwd ? `cd ${shellEscape(cwd)} && ${command}` : command;

  if (process.env.DEV_PORTS_SPAWN_DRY_RUN === "1") {
    return { command: shellCommand, pid: null };
  }

  const child = spawn(shell, ["-lc", shellCommand], {
    cwd: cwd || undefined,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { command: shellCommand, pid: child.pid || null };
}

function getSelectionKey(entry) {
  return `${entry.pid}:${entry.port}:${entry.host}`;
}

function normalizeCommandPreferenceValue(value) {
  return normalizeWhitespace(value)
    .replace(/(^|\s)(PORT=)\d+\b/g, "$1$2<port>")
    .replace(/(--port=)\d+\b/g, "$1<port>")
    .replace(/(--port\s+)\d+\b/g, "$1<port>")
    .replace(/(^|\s)(-p=)\d+\b/g, "$1$2<port>")
    .replace(/(^|\s)(-p\s+)\d+\b/g, "$1$2<port>")
    .replace(/(python(?:3)?\s+-m\s+http\.server\s+)\d+\b/gi, "$1<port>")
    .replace(/(php\s+-S\s+[^:\s]+:)\d+\b/gi, "$1<port>");
}

function getEntryPreferenceKey(entry) {
  const cwdKey = normalizeWhitespace(entry?.cwd || "");
  const commandKey = normalizeCommandPreferenceValue(entry?.args || entry?.command || "");
  const hostKey = normalizeWhitespace(entry?.host || "");

  if (cwdKey && commandKey) {
    return `cwd:${cwdKey}::cmd:${commandKey}`;
  }

  if (cwdKey && hostKey) {
    return `cwd:${cwdKey}::host:${hostKey}`;
  }

  if (cwdKey) {
    return `cwd:${cwdKey}`;
  }

  if (commandKey && hostKey) {
    return `cmd:${commandKey}::host:${hostKey}`;
  }

  if (commandKey) {
    return `cmd:${commandKey}`;
  }

  return `pid:${entry?.pid || "-"}::port:${entry?.port || "-"}`;
}

function sortListeners(entries, config = null) {
  const baseline = entries.slice().sort(compareEntries);
  const pinnedEntryKeys = Array.isArray(config?.pinnedEntryKeys) ? config.pinnedEntryKeys : [];
  const orderedEntryKeys = Array.isArray(config?.orderedEntryKeys) ? config.orderedEntryKeys : [];

  if (pinnedEntryKeys.length === 0 && orderedEntryKeys.length === 0) {
    return baseline;
  }

  const pinnedKeySet = new Set(pinnedEntryKeys);
  const orderedIndex = new Map();
  for (let index = 0; index < orderedEntryKeys.length; index += 1) {
    const entryKey = orderedEntryKeys[index];
    if (!orderedIndex.has(entryKey)) {
      orderedIndex.set(entryKey, index);
    }
  }

  return baseline.sort((left, right) => {
    const leftKey = getEntryPreferenceKey(left);
    const rightKey = getEntryPreferenceKey(right);
    const leftPinned = pinnedKeySet.has(leftKey);
    const rightPinned = pinnedKeySet.has(rightKey);

    if (leftPinned !== rightPinned) {
      return leftPinned ? -1 : 1;
    }

    const leftOrder = orderedIndex.has(leftKey) ? orderedIndex.get(leftKey) : Number.MAX_SAFE_INTEGER;
    const rightOrder = orderedIndex.has(rightKey) ? orderedIndex.get(rightKey) : Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    return compareEntries(left, right);
  });
}

function killByPort(port, signal) {
  const listeners = collectAllListeners();
  const matches = listeners.filter((entry) => entry.port === port);
  const pids = unique(matches.map((entry) => entry.pid));

  if (pids.length === 0) {
    throw new Error(`Could not find a LISTEN process using port ${port}.`);
  }

  for (const pid of pids) {
    process.kill(pid, signal);
  }

  console.log(`Port ${port} target PIDs: ${pids.join(", ")} (${signal})`);
}

function killByPid(pid, signal) {
  process.kill(pid, signal);
  console.log(`Sent ${signal} to PID ${pid}.`);
}

function parseListeners(raw) {
  const lines = raw.split(/\r?\n/);
  const entries = [];
  let pid = null;
  let command = "";

  for (const line of lines) {
    if (!line) {
      continue;
    }

    const field = line[0];
    const value = line.slice(1);

    if (field === "p") {
      pid = Number.parseInt(value, 10);
      command = "";
      continue;
    }

    if (field === "c") {
      command = value.trim();
      continue;
    }

    if (field === "n" && pid) {
      entries.push({
        pid,
        command,
        name: value.trim(),
      });
    }
  }

  return entries;
}

function getProcessMap(pids) {
  const map = new Map();
  if (pids.length === 0) {
    return map;
  }

  const raw = run("ps", ["-p", pids.join(","), "-o", "pid=,ppid=,etime=,args="], true);
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/);
    if (!match) {
      continue;
    }

    const pid = Number.parseInt(match[1], 10);
    map.set(pid, {
      ppid: Number.parseInt(match[2], 10),
      elapsed: match[3],
      args: (match[4] || "").trim(),
    });
  }

  return map;
}

function getCwdMap(pids) {
  const map = new Map();
  if (pids.length === 0) {
    return map;
  }

  const raw = run("lsof", ["-Fn", "-a", "-d", "cwd", "-p", pids.join(",")], true);
  let pid = null;

  for (const line of raw.split(/\r?\n/)) {
    if (!line) {
      continue;
    }

    const field = line[0];
    const value = line.slice(1);

    if (field === "p") {
      pid = Number.parseInt(value, 10);
      continue;
    }

    if (field === "n" && pid) {
      map.set(pid, value.trim());
    }
  }

  return map;
}

function enrichEntry(base, psInfo, cwd) {
  const endpoint = parseEndpoint(base.name);
  if (!endpoint) {
    return null;
  }

  const args = psInfo?.args || "";
  const elapsed = psInfo?.elapsed || "-";
  const ppid = psInfo?.ppid || null;
  const projectName = getProjectName({
    cwd,
    command: base.command || firstToken(args) || "",
    args,
  });
  const kind = classifyEntry({
    ...base,
    ...endpoint,
    args,
    cwd,
  });

  return {
    pid: base.pid,
    ppid,
    port: endpoint.port,
    host: endpoint.host,
    command: base.command || firstToken(args) || "-",
    args,
    cwd: cwd || "",
    elapsed,
    kind,
    projectName,
    displayProject: projectName,
    displayCommand: summarizeCommand(base.command || "", args, HOME),
    displayCwd: shortenPath(cwd || "", HOME),
  };
}

function getProjectName(details) {
  const cwd = details?.cwd || "";
  const normalized = String(cwd || "").trim().replace(/[\\/]+$/, "");
  if (!normalized) {
    return inferProjectNameFromCommand(details) || "";
  }

  if (HOME && normalized === HOME) {
    return inferProjectNameFromCommand(details) || "";
  }

  if (HOME && normalized.startsWith(`${HOME}${path.sep}`)) {
    const segments = path.relative(HOME, normalized).split(path.sep).filter(Boolean);
    if (segments.length === 0) {
      return inferProjectNameFromCommand(details) || "";
    }

    if (PROJECT_ROOT_HINTS.has(segments[0].toLowerCase())) {
      return segments[1] || inferProjectNameFromCommand(details) || "";
    }

    return segments[0];
  }

  const basename = path.basename(normalized);
  if (!isGenericProjectDir(basename)) {
    return basename;
  }

  return inferProjectNameFromCommand(details) || basename;
}

function inferProjectNameFromCommand(details) {
  const commandCandidate = normalizeProjectToken(details?.command || "");
  if (commandCandidate && !RUNTIME_NAMES.has(commandCandidate.toLowerCase())) {
    return commandCandidate;
  }

  const firstArg = firstToken(details?.args || "");
  const pathCandidate = inferProjectNameFromPath(firstArg);
  if (pathCandidate && !RUNTIME_NAMES.has(pathCandidate.toLowerCase())) {
    return pathCandidate;
  }

  return commandCandidate && !RUNTIME_NAMES.has(commandCandidate.toLowerCase()) ? commandCandidate : "";
}

function normalizeProjectToken(token) {
  const value = String(token || "").trim().replace(/^['"]|['"]$/g, "");
  if (!value) {
    return "";
  }

  if (value.startsWith("-")) {
    return "";
  }

  const withoutQuery = value.split("?")[0];
  const withoutProtocol = withoutQuery.replace(/^[a-z]+:\/\//i, "");
  const cleaned = withoutProtocol.replace(/[\\/]+$/, "");
  if (!cleaned) {
    return "";
  }

  const basename = path.basename(cleaned);
  const parsed = path.parse(basename);
  const candidate = (parsed.name || basename).trim();
  if (!candidate) {
    return "";
  }

  if (candidate === "." || candidate === "..") {
    return "";
  }

  if (isGenericProjectDir(candidate)) {
    return "";
  }

  if (/^\d+$/.test(candidate)) {
    return "";
  }

  return candidate;
}

function inferProjectNameFromPath(input) {
  const value = String(input || "").trim().replace(/^['"]|['"]$/g, "");
  if (!value || !path.isAbsolute(value)) {
    return "";
  }

  const appMatch = value.match(/\/Applications\/([^/]+)\.app\//);
  if (appMatch?.[1]) {
    return appMatch[1];
  }

  const homebrewMatch = value.match(/\/(?:opt|Cellar)\/([^/]+)\//);
  if (homebrewMatch?.[1]) {
    return homebrewMatch[1];
  }

  return normalizeProjectToken(value);
}

function isGenericProjectDir(value) {
  return GENERIC_PROJECT_DIRS.has(String(value || "").toLowerCase());
}

function parseEndpoint(name) {
  if (!name) {
    return null;
  }

  const bracketMatch = name.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracketMatch) {
    return {
      host: bracketMatch[1],
      port: Number.parseInt(bracketMatch[2], 10),
    };
  }

  const lastColonIndex = name.lastIndexOf(":");
  if (lastColonIndex === -1) {
    return null;
  }

  const host = name.slice(0, lastColonIndex);
  const port = Number.parseInt(name.slice(lastColonIndex + 1), 10);

  if (!Number.isInteger(port)) {
    return null;
  }

  return { host, port };
}

function classifyEntry(entry) {
  const commandLower = (entry.command || "").toLowerCase();
  const searchText = [entry.command, entry.args, entry.cwd].filter(Boolean).join(" ").toLowerCase();
  const cwd = entry.cwd || "";
  const inHome = cwd.startsWith(`${HOME}${path.sep}`) || cwd === HOME;
  const inLibrary = cwd.startsWith(path.join(HOME, "Library"));
  const hasProjectCwd = Boolean(cwd) && inHome && !inLibrary && cwd !== HOME;
  const hasDevKeyword = DEV_KEYWORDS.some((keyword) => matchesKeyword(searchText, keyword));
  const isRuntime = RUNTIME_NAMES.has(commandLower);
  const isCommonDevPort = DEV_PORTS.has(entry.port) || (entry.port >= 3000 && entry.port <= 5999);

  if (hasDevKeyword) {
    return "dev";
  }

  if (hasProjectCwd && (isRuntime || isCommonDevPort)) {
    return "dev";
  }

  if (isRuntime && isCommonDevPort) {
    return "dev";
  }

  return "other";
}

function matchesKeyword(searchText, keyword) {
  const escapedKeyword = escapeRegExp(keyword.toLowerCase());
  const pattern = new RegExp(`(^|[^a-z0-9])${escapedKeyword}([^a-z0-9]|$)`);
  return pattern.test(searchText);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getProcessSortKey(entry) {
  return normalizeWhitespace(entry.displayCommand || entry.args || entry.command || "-").toLowerCase();
}

function getProjectSortKey(entry) {
  const projectKey = normalizeWhitespace(entry.displayProject || entry.projectName || "").toLowerCase();
  if (projectKey) {
    return projectKey;
  }

  return normalizeWhitespace(entry.displayCwd || entry.cwd || "").toLowerCase();
}

function compareEntries(left, right) {
  if (left.kind !== right.kind) {
    return left.kind === "dev" ? -1 : 1;
  }

  const leftProjectKey = getProjectSortKey(left);
  const rightProjectKey = getProjectSortKey(right);
  if (leftProjectKey !== rightProjectKey) {
    return leftProjectKey.localeCompare(rightProjectKey);
  }

  const leftProcessKey = getProcessSortKey(left);
  const rightProcessKey = getProcessSortKey(right);
  if (leftProcessKey !== rightProcessKey) {
    return leftProcessKey.localeCompare(rightProcessKey);
  }

  if (left.port !== right.port) {
    return left.port - right.port;
  }

  const leftDirKey = normalizeWhitespace(left.displayCwd || left.cwd || "").toLowerCase();
  const rightDirKey = normalizeWhitespace(right.displayCwd || right.cwd || "").toLowerCase();
  if (leftDirKey !== rightDirKey) {
    return leftDirKey.localeCompare(rightDirKey);
  }

  return left.pid - right.pid;
}

module.exports = {
  buildPortCounts,
  buildRelaunchCommand,
  collectAllListeners,
  findNextAvailablePort,
  getEntryPreferenceKey,
  getSelectionKey,
  killByPid,
  killByPort,
  launchDetachedCommand,
  selectListeners,
  sortListeners,
  waitForPortListener,
};
