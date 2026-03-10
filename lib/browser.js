const { run } = require("./utils");

function buildBrowserUrl(entry) {
  let host = entry.host || "localhost";

  if (host === "*" || host === "0.0.0.0" || host === "::" || host === "::1") {
    host = "localhost";
  }

  if (host.includes(":") && !host.startsWith("[")) {
    host = `[${host}]`;
  }

  return `http://${host}:${entry.port}`;
}

function openUrlInBrowser(url, browser) {
  const overrideCommand = process.env.DEV_PORTS_OPEN_COMMAND;
  if (overrideCommand) {
    run(overrideCommand, [url], false);
    return;
  }

  if (process.platform === "darwin") {
    if (browser) {
      run("open", ["-a", browser, url], false);
      return;
    }
    run("open", [url], false);
    return;
  }

  if (process.platform === "linux") {
    if (browser) {
      run(browser, [url], false);
      return;
    }
    run("xdg-open", [url], false);
    return;
  }

  if (process.platform === "win32") {
    if (browser) {
      run("cmd", ["/c", "start", "", browser, url], false);
      return;
    }
    run("cmd", ["/c", "start", "", url], false);
    return;
  }

  throw new Error(`Unsupported platform: ${process.platform}`);
}

module.exports = {
  buildBrowserUrl,
  openUrlInBrowser,
};
