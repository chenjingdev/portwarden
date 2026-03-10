const { execFileSync } = require("node:child_process");

const COLOR_CODES = {
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

function pad(value, width) {
  const text = truncate(value, width);
  return text + " ".repeat(Math.max(0, width - text.length));
}

function getCharDisplayWidth(char) {
  const codePoint = char.codePointAt(0);
  if (!codePoint) {
    return 0;
  }

  if (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  ) {
    return 2;
  }

  return 1;
}

function getDisplayWidth(value) {
  let width = 0;
  for (const char of String(value ?? "")) {
    width += getCharDisplayWidth(char);
  }
  return width;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function sleep(ms) {
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  Atomics.wait(view, 0, 0, ms);
}

function truncate(value, width) {
  const text = String(value ?? "");
  if (text.length <= width) {
    return text;
  }
  if (width <= 1) {
    return text.slice(0, width);
  }
  return `${text.slice(0, width - 1)}…`;
}

function truncateDisplay(value, width) {
  const text = String(value ?? "");
  if (width <= 0) {
    return "";
  }

  if (getDisplayWidth(text) <= width) {
    return text;
  }

  if (width === 1) {
    return "…";
  }

  const targetWidth = width - 1;
  let result = "";
  let used = 0;

  for (const char of text) {
    const charWidth = getCharDisplayWidth(char);
    if (used + charWidth > targetWidth) {
      break;
    }
    result += char;
    used += charWidth;
  }

  return `${result}…`;
}

function padDisplay(value, width) {
  const text = truncateDisplay(value, width);
  const padding = Math.max(0, width - getDisplayWidth(text));
  return text + " ".repeat(padding);
}

function normalizeWhitespace(input) {
  return String(input || "").replace(/\s+/g, " ").trim();
}

function summarizeCommand(command, args, home) {
  const cleanedArgs = normalizeWhitespace(args);
  if (!cleanedArgs) {
    return command || "-";
  }

  return cleanedArgs.replace(home, "~");
}

function shortenPath(input, home) {
  if (!input) {
    return "";
  }

  if (home && input.startsWith(home)) {
    return `~${input.slice(home.length)}`;
  }

  return input;
}

function renderShortcutLine(shortcuts, width, prefix = "") {
  const parts = [];
  let used = prefix.length;

  if (prefix) {
    parts.push(dim(prefix));
  }

  for (let index = 0; index < shortcuts.length; index += 1) {
    const [key, description] = shortcuts[index];
    const separator = index === 0 ? "" : "  ";
    const rawChunk = `${separator}${key} ${description}`;

    if (used + rawChunk.length > width) {
      break;
    }

    if (separator) {
      parts.push(separator);
    }
    parts.push(colorize(key, "yellow"));
    parts.push(" ");
    parts.push(dim(description));
    used += rawChunk.length;
  }

  return parts.join("");
}

function colorize(input, colorName) {
  const prefix = COLOR_CODES[colorName];
  if (!prefix) {
    return String(input);
  }
  return `${prefix}${input}\x1b[0m`;
}

function dim(input) {
  return colorize(input, "dim");
}

function firstToken(input) {
  return normalizeWhitespace(input).split(" ")[0] || "";
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function formatTimestamp(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function run(command, args, allowFailure) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stdout = typeof error.stdout === "string" ? error.stdout : "";
    if (allowFailure && error.code !== "ENOENT") {
      return stdout;
    }

    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    throw new Error(stderr || `Failed to run ${command}.`);
  }
}

function shellEscape(input) {
  return `'${String(input).replace(/'/g, `'\"'\"'`)}'`;
}

module.exports = {
  clamp,
  colorize,
  dim,
  firstToken,
  getDisplayWidth,
  formatTimestamp,
  normalizeWhitespace,
  pad,
  padDisplay,
  renderShortcutLine,
  run,
  shellEscape,
  shortenPath,
  sleep,
  summarizeCommand,
  truncate,
  truncateDisplay,
  unique,
};
