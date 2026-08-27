import {describe, expect, it} from 'vitest';

import {
  formatCommandForDisplay,
  isSnapshotReplaySafe,
  normalizeCommandForComparison,
  parseCommandSnapshot,
  redactCommandLine,
  isSnapshotPersistable,
  rewriteCommandPort,
  sanitizeText,
} from '../src/core/commands.js';

describe('command snapshots', () => {
  it('parses argv and leading environment without keeping a shell', () => {
    expect(parseCommandSnapshot('NODE_ENV=development vite --port 3000')).toEqual({
      argv: ['vite', '--port', '3000'],
      env: {NODE_ENV: 'development'},
    });
  });

  it.each([
    'vite && curl example.com',
    'vite > output.log',
    'vite $UNTRUSTED',
    'vite *.js',
    'vite\nrm -rf nope',
  ])('rejects shell syntax instead of replaying it: %s', (command) => {
    expect(parseCommandSnapshot(command)).toBeNull();
  });

  it('rewrites explicit and inferred port arguments without shell interpolation', () => {
    const explicit = parseCommandSnapshot('vite --port=3000');
    const inferred = parseCommandSnapshot('node /project/node_modules/vite/bin/vite.js');
    expect(explicit && rewriteCommandPort(explicit, 3001)?.argv).toEqual(['vite', '--port=3001']);
    expect(inferred && rewriteCommandPort(inferred, 3001)?.argv).toEqual([
      'node',
      '/project/node_modules/vite/bin/vite.js',
      '--port',
      '3001',
    ]);
  });

  it('normalizes changed port flags when comparing process identity', () => {
    const first = parseCommandSnapshot('vite --port 3000');
    const second = parseCommandSnapshot('vite --port 3001');
    expect(first && second && normalizeCommandForComparison(first)).toBe(normalizeCommandForComparison(second!));
  });

  it('refuses to persist commands that would write credentials to config', () => {
    const envSecret = parseCommandSnapshot('API_TOKEN=secret vite');
    const flagSecret = parseCommandSnapshot('vite --api-key secret');
    expect(envSecret && isSnapshotPersistable(envSecret)).toBe(false);
    expect(flagSecret && isSnapshotPersistable(flagSecret)).toBe(false);
  });

  it.each([
    'DATABASE_URL=postgres://alice:hunter2@db.local/app vite --port 3000',
    'vite --header "Authorization: Bearer topsecret" --port 3000',
    'vite -H "Cookie: session=topsecret" --port 3000',
    'vite --header="Cookie: session=topsecret" --port 3000',
  ])('rejects and redacts credential-bearing values: %s', (command) => {
    const snapshot = parseCommandSnapshot(command);
    expect(snapshot && isSnapshotPersistable(snapshot)).toBe(false);
    expect(redactCommandLine(command)).not.toMatch(/hunter2|topsecret/);
    expect(snapshot && formatCommandForDisplay(snapshot)).not.toMatch(/hunter2|topsecret/);
  });

  it.each([
    '/bin/sh -c "vite --port 3000; touch /tmp/pwned"',
    'node -e "require(\'./payload\')"',
    'node --require=/tmp/payload.js app.js',
    'PYTHONPATH=/tmp/payload python3 -m http.server 3000',
  ])('rejects shell, eval, and code-loading replay: %s', (command) => {
    const snapshot = parseCommandSnapshot(command);
    expect(snapshot).not.toBeNull();
    expect(snapshot && isSnapshotReplaySafe(snapshot)).toBe(false);
  });

  it('does not infer port semantics from arbitrary arguments or ambiguous runtime flags', () => {
    const labelOnly = parseCommandSnapshot('node /tmp/job.js --label vite');
    const nodePrint = parseCommandSnapshot('node -p 3000 server.js');
    expect(labelOnly && rewriteCommandPort(labelOnly, 3001)).toBeNull();
    expect(nodePrint && rewriteCommandPort(nodePrint, 3001)).toBeNull();
  });

  it('redacts secrets even when unrelated shell syntax makes structured parsing fail', () => {
    const rendered = redactCommandLine('vite --api-key topsecret && echo done');
    expect(rendered).not.toContain('topsecret');
    expect(rendered).toContain('<redacted>');
  });

  it('removes ANSI and control input before rendering', () => {
    expect(sanitizeText('\u001B[31mbad\u001B[0m\nrow')).toBe('bad row');
  });
});
