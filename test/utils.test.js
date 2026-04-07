const test = require("node:test");
const assert = require("node:assert/strict");

const { formatHostDisplay, summarizeCommand } = require("../lib/utils");

test("summarizeCommand collapses pnpm dlx cache paths into a readable package command", () => {
  const args =
    "node /Users/test/Library/Caches/pnpm/dlx/5e6c877401e79938bd0cfe60829a8cb14dbcb809dcffe7ee4ac5ac31ebac41b4/19d659510aa-caa9/node_modules/.bin/../.pnpm/@playwright+mcp@0.0.70/node_modules/@playwright/mcp/cli.js --port 53188 --host ::1";

  assert.equal(
    summarizeCommand("node", args, "/Users/test"),
    "pnpm dlx @playwright/mcp --port 53188 --host ::1"
  );
});

test("formatHostDisplay normalizes loopback and wildcard addresses for the UI", () => {
  assert.equal(formatHostDisplay("::1"), "localhost");
  assert.equal(formatHostDisplay("127.0.0.1"), "localhost");
  assert.equal(formatHostDisplay("0.0.0.0"), "all");
});
