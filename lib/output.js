const { formatTimestamp, padDisplay } = require("./utils");

function renderOnce(listeners, allListenerCount, options, isWatch = false) {
  if (options.json) {
    console.log(JSON.stringify(listeners, null, 2));
    return;
  }

  const shownCount = listeners.length;
  const hiddenCount = Math.max(0, allListenerCount - shownCount);
  const updatedAt = formatTimestamp(new Date());
  const scopeLabel = options.all ? "All LISTEN ports" : "Dev ports";

  console.log(`${scopeLabel}: ${shownCount}`);
  console.log(`Updated: ${updatedAt}`);
  if (!options.all && hiddenCount > 0) {
    console.log(`Other listeners hidden: ${hiddenCount}`);
  }
  if (isWatch) {
    console.log(`Refresh interval: ${options.watchSeconds}s`);
  }
  console.log("");

  if (listeners.length === 0) {
    console.log(options.all ? "No LISTEN ports found." : "No dev-like LISTEN ports found.");
    return;
  }

  const table = buildTable(listeners, options.all);
  console.log(table);
}

function buildTable(entries, showKind) {
  const terminalWidth = process.stdout.columns || 120;
  const hostWidth = 18;
  const portWidth = 6;
  const pidWidth = 7;
  const ageWidth = 11;
  const kindWidth = showKind ? 8 : 0;
  const projectWidth = 16;
  const minProcessWidth = 28;
  const minCwdWidth = 20;
  const spacing = 2;
  const fixedReserved =
    portWidth +
    pidWidth +
    ageWidth +
    hostWidth +
    projectWidth +
    (showKind ? kindWidth : 0) +
    spacing * (showKind ? 6 : 5);
  const usableWidth = Math.max(minProcessWidth + minCwdWidth, terminalWidth - fixedReserved);
  const extraWidth = Math.max(0, usableWidth - minProcessWidth - minCwdWidth);
  const processWidth = minProcessWidth + Math.floor(extraWidth * 0.45);
  const cwdWidth = minCwdWidth + (extraWidth - Math.floor(extraWidth * 0.45));

  const headers = [];
  if (showKind) {
    headers.push(padDisplay("KIND", kindWidth));
  }
  headers.push(padDisplay("PORT", portWidth));
  headers.push(padDisplay("PID", pidWidth));
  headers.push(padDisplay("AGE", ageWidth));
  headers.push(padDisplay("HOST", hostWidth));
  headers.push(padDisplay("PROJECT", projectWidth));
  headers.push(padDisplay("PROCESS", processWidth));
  headers.push(padDisplay("DIR", cwdWidth));

  const rows = [headers.join("  "), "-".repeat(Math.max(terminalWidth - 1, 80))];

  for (const entry of entries) {
    const cols = [];
    if (showKind) {
      cols.push(padDisplay(entry.kind, kindWidth));
    }
    cols.push(padDisplay(String(entry.port), portWidth));
    cols.push(padDisplay(String(entry.pid), pidWidth));
    cols.push(padDisplay(entry.elapsed, ageWidth));
    cols.push(padDisplay(entry.host, hostWidth));
    cols.push(padDisplay(entry.displayProject || "-", projectWidth));
    cols.push(padDisplay(entry.displayCommand, processWidth));
    cols.push(padDisplay(entry.displayCwd || "-", cwdWidth));
    rows.push(cols.join("  "));
  }

  return rows.join("\n");
}

module.exports = {
  renderOnce,
};
