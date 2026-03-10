const { formatTimestamp, pad } = require("./utils");

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
  const minProcessWidth = 28;
  const spacing = 2;
  const reserved =
    portWidth +
    pidWidth +
    ageWidth +
    hostWidth +
    (showKind ? kindWidth : 0) +
    (showKind ? spacing : 0) +
    spacing * 4;
  const processWidth = Math.max(minProcessWidth, Math.floor((terminalWidth - reserved) * 0.45));
  const cwdWidth = Math.max(20, terminalWidth - reserved - processWidth);

  const headers = [];
  if (showKind) {
    headers.push(pad("KIND", kindWidth));
  }
  headers.push(pad("PORT", portWidth));
  headers.push(pad("PID", pidWidth));
  headers.push(pad("AGE", ageWidth));
  headers.push(pad("HOST", hostWidth));
  headers.push(pad("PROCESS", processWidth));
  headers.push(pad("DIR", cwdWidth));

  const rows = [headers.join("  "), "-".repeat(Math.max(terminalWidth - 1, 80))];

  for (const entry of entries) {
    const cols = [];
    if (showKind) {
      cols.push(pad(entry.kind, kindWidth));
    }
    cols.push(pad(String(entry.port), portWidth));
    cols.push(pad(String(entry.pid), pidWidth));
    cols.push(pad(entry.elapsed, ageWidth));
    cols.push(pad(entry.host, hostWidth));
    cols.push(pad(entry.displayCommand, processWidth));
    cols.push(pad(entry.displayCwd || "-", cwdWidth));
    rows.push(cols.join("  "));
  }

  return rows.join("\n");
}

module.exports = {
  renderOnce,
};
