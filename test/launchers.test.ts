import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';

import {attachLaunchers, collectLaunchers, isInstalledProgram, type LauncherOptions, type LauncherTarget} from '../src/core/launchers.js';
import type {BrowserSession, ListenerEntry, ProcessInfo, ProcessTask} from '../src/core/types.js';

const LIVE_SESSION = '11111111-1111-4111-8111-111111111111';
const ENDED_SESSION = '00000000-0000-4000-8000-000000000000';
const TEMP_SESSION = '22222222-2222-4222-8222-222222222222';

let home = '';
let sessionsDirectory = '';

beforeAll(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'portwarden-launchers-')));
  sessionsDirectory = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(sessionsDirectory, {recursive: true});
  fs.mkdirSync(path.join(home, 'dev', 'portwarden'), {recursive: true});
  fs.writeFileSync(path.join(sessionsDirectory, '4242.json'), JSON.stringify({pid: 4242, sessionId: LIVE_SESSION, name: 'live-chat'}));
  fs.writeFileSync(path.join(sessionsDirectory, '9999.json'), JSON.stringify({pid: 9999, sessionId: ENDED_SESSION, name: 'stale-chat'}));
  fs.writeFileSync(path.join(sessionsDirectory, '4242.abc.key'), 'not json');
  fs.writeFileSync(path.join(sessionsDirectory, '7.json'), JSON.stringify({peerToken: 'x'}));
});

afterAll(() => fs.rmSync(home, {recursive: true, force: true}));

const hcTerminals = JSON.stringify({terminals: [
  {address: 't1live', name: 'reap-test', where: 'J37 / 1', state: 'live'},
  {address: 't1gone', where: 'J37 / 2', state: 'finished'},
  {address: 't1yw', name: 'old-tab', where: 'J37 / 3', state: 'finished'},
]});

function target(overrides: Partial<LauncherTarget> = {}): LauncherTarget {
  const pid = overrides.pid ?? 500;
  return {pid, envPids: [pid], ppid: 1, cwd: '/Users/test/dev/app', command: 'python3 -m http.server 4801', executable: '', shared: false, ...overrides};
}

function options(env: Record<number, string>, extra: Partial<LauncherOptions> = {}): LauncherOptions {
  return {
    home,
    sessionsDirectory,
    runPsEnv: async (pids) => pids.map((pid) => `${pid} ${env[pid] ?? ''}`).join('\n'),
    runHc: async () => hcTerminals,
    ...extra,
  };
}

const processes = [{pid: 4242}, {pid: 1}] as ProcessInfo[];

describe('launcher resolution', () => {
  it('reads the Claude session and hc terminal from the process environment and names it after the terminal', async () => {
    const launchers = await collectLaunchers([target()], processes, options({
      500: `python3 -m http.server 4801 TERM=xterm CLAUDE_CODE_SESSION_ID=${LIVE_SESSION} HC_TERMINAL_ID=t1live HOME=/Users/test`,
    }));
    expect(launchers.get(500)).toEqual({sessionId: LIVE_SESSION, terminal: 't1live', name: 'reap-test', state: 'live'});
  });

  it('marks a session ended when no live process owns it and falls back to the terminal location, then the session name', async () => {
    const launchers = await collectLaunchers([target({pid: 501}), target({pid: 502}), target({pid: 503})], processes, options({
      501: `x CLAUDE_CODE_SESSION_ID=${ENDED_SESSION} HC_TERMINAL_ID=t1gone`,
      502: `x CLAUDE_CODE_SESSION_ID=${ENDED_SESSION}`,
      503: `x CLAUDE_CODE_SESSION_ID=${LIVE_SESSION}`,
    }));
    expect(launchers.get(501)).toEqual({sessionId: ENDED_SESSION, terminal: 't1gone', name: 'J37 / 2', state: 'ended'});
    expect(launchers.get(502)).toEqual({sessionId: ENDED_SESSION, name: 'stale-chat', state: 'ended'});
    expect(launchers.get(503)).toEqual({sessionId: LIVE_SESSION, name: 'live-chat', state: 'live'});
  });

  it('uses hc alone when there is no session id, and treats a terminal hc does not list as ended', async () => {
    const launchers = await collectLaunchers([target({pid: 510}), target({pid: 511}), target({pid: 512})], processes, options({
      510: 'x HC_TERMINAL_ID=t1live',
      511: 'x HC_TERMINAL_ID=t1yw',
      512: 'x HC_TERMINAL_ID=t9none',
    }));
    expect(launchers.get(510)).toMatchObject({terminal: 't1live', name: 'reap-test', state: 'live'});
    expect(launchers.get(511)).toMatchObject({terminal: 't1yw', name: 'old-tab', state: 'ended'});
    expect(launchers.get(512)).toEqual({terminal: 't9none', state: 'ended'});
  });

  it('treats a missing hc as no terminals and a process without either id as having no launcher', async () => {
    const launchers = await collectLaunchers([target({pid: 520}), target({pid: 521})], processes, options({
      520: 'x HC_TERMINAL_ID=t1live',
    }, {runHc: async () => ''}));
    expect(launchers.get(520)).toEqual({terminal: 't1live', state: 'ended'});
    expect(launchers.has(521)).toBe(false);
  });

  it('finds the session from a Claude temp folder in the cwd or argv and names it after the project in the slug', async () => {
    const slug = `${home}/dev/portwarden`.replace(/[^a-zA-Z0-9]/g, '-');
    const tempCwd = `/private/tmp/claude-501/${slug}/${TEMP_SESSION}/scratchpad`;
    const fromCwd = await collectLaunchers([target({pid: 530, cwd: tempCwd})], processes, options({}));
    expect(fromCwd.get(530)).toEqual({sessionId: TEMP_SESSION, name: 'portwarden', state: 'ended'});
    const fromArgv = await collectLaunchers(
      [target({pid: 531, cwd: '/', command: `python3 -m http.server --directory /tmp/claude-501/${slug}/${TEMP_SESSION}/out`})],
      processes, options({}),
    );
    expect(fromArgv.get(531)?.sessionId).toBe(TEMP_SESSION);
  });

  it('asks ps for exactly the target pids in one call and hc only when a terminal is needed', async () => {
    const runPsEnv = vi.fn(async () => '');
    const runHc = vi.fn(async () => hcTerminals);
    await collectLaunchers([target({pid: 540}), target({pid: 541}), target({pid: 540})], processes, {home, sessionsDirectory, runPsEnv, runHc});
    expect(runPsEnv).toHaveBeenCalledTimes(1);
    expect(runPsEnv).toHaveBeenCalledWith([540, 541]);
    expect(runHc).not.toHaveBeenCalled();
  });
});

describe('real ps', () => {
  it('reads the session and terminal from a live process environment', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {
      stdio: 'ignore',
      env: {...process.env, CLAUDE_CODE_SESSION_ID: ENDED_SESSION, HC_TERMINAL_ID: 't1yw'},
    });
    try {
      const launchers = await collectLaunchers([target({pid: child.pid!})], processes, {home, sessionsDirectory, runHc: async () => hcTerminals});
      expect(launchers.get(child.pid!)).toEqual({sessionId: ENDED_SESSION, terminal: 't1yw', name: 'old-tab', state: 'ended'});
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('installed programs', () => {
  it('judges an interpreter by its script and any other program by its executable', () => {
    expect(isInstalledProgram('/opt/homebrew/Cellar/node/26.8.1/bin/node', `node ${home}/.claude/plugins/cache/khala/khala/0.17.66/scripts/ui.mjs`, home)).toBe(true);
    expect(isInstalledProgram('/Applications/Docker.app/Contents/MacOS/com.docker.backend', 'com.docker.backend services', home)).toBe(true);
    expect(isInstalledProgram('/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python', 'python3 -m http.server 4801', home)).toBe(false);
    expect(isInstalledProgram('/opt/homebrew/bin/node', `node ${home}/Library/Caches/pnpm/dlx/abc/node_modules/@playwright/mcp/cli.js`, home)).toBe(false);
    expect(isInstalledProgram('', `${home}/Library/Application Support/Foo/helper --serve`, home)).toBe(true);
    expect(isInstalledProgram('/Users/test/.bun/bin/bun', 'bun check-service.ts', home)).toBe(false);
  });
});

function listener(overrides: Partial<ListenerEntry> = {}): ListenerEntry {
  return {
    pid: 600, ppid: 1, port: 4801, host: '127.0.0.1', listenerHosts: ['127.0.0.1'], displayHost: 'localhost',
    command: 'Python', args: 'python3 -m http.server 4801', cwd: '/Users/test/dev/app', elapsed: '00:01:00', kind: 'dev',
    appFamily: '', projectName: 'app', displayProject: 'app', displayCommand: 'python3 -m http.server 4801', displayCwd: '~/dev/app',
    executable: '/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python',
    ...overrides,
  };
}

describe('leftovers', () => {
  const ended = `x CLAUDE_CODE_SESSION_ID=${ENDED_SESSION}`;
  const live = `x CLAUDE_CODE_SESSION_ID=${LIVE_SESSION}`;

  it('flags every process of an ended launcher, whatever its parent, but not live launchers or installed programs', async () => {
    const khalaUi = listener({
      pid: 601, port: 4179, command: 'node', executable: '/opt/homebrew/Cellar/node/26.8.1/bin/node',
      args: `/opt/homebrew/Cellar/node/26.8.1/bin/node ${home}/.claude/plugins/cache/khala/khala/0.17.66/scripts/ui.mjs`,
    });
    const {listeners} = await attachLaunchers([
      listener({pid: 600}),
      listener({pid: 602, port: 4802}),
      listener({pid: 603, port: 4803, ppid: 77}),
      listener({pid: 604, port: 4804}),
      khalaUi,
    ], [], processes, options({600: ended, 602: live, 603: ended, 604: 'x HOME=/Users/test', 601: ended}));
    expect(listeners.map(({pid, leftover}) => [pid, leftover])).toEqual([[600, true], [602, false], [603, true], [604, false], [601, false]]);
    expect(listeners[0]?.launcher).toMatchObject({sessionId: ENDED_SESSION, state: 'ended'});
    expect(listeners[1]?.launcher).toMatchObject({state: 'live'});
    expect(listeners[3]).not.toHaveProperty('launcher');
    expect(listeners[4]?.launcher).toMatchObject({state: 'ended'});
  });

  it('resolves a task through its root process, not the listener pid', async () => {
    const root: ProcessInfo = {pid: 700, ppid: 1, name: 'npm', command: 'npm run dev', executable: '/opt/homebrew/bin/npm', cwd: '/Users/test/dev/app'};
    const child: ProcessInfo = {...root, pid: 701, ppid: 700, command: 'node vite'};
    const task: ProcessTask = {key: 'task:700', root, members: [root, child], ports: [4805], label: 'app', memoryBytes: null};
    const {listeners} = await attachLaunchers(
      [listener({pid: 701, ppid: 700, port: 4805, task})], [], processes, options({700: ended, 701: live}),
    );
    expect(listeners[0]).toMatchObject({leftover: true, launcher: {state: 'ended'}});
  });

  it('reads the launcher from another task member when the root rewrote its environment', async () => {
    const root: ProcessInfo = {pid: 710, ppid: 1, name: 'npm', command: 'npm exec pnpm@11 dev', executable: '/opt/homebrew/bin/npm', cwd: '/Users/test/dev/app'};
    const child: ProcessInfo = {...root, pid: 711, ppid: 710, command: 'node vite'};
    const task: ProcessTask = {key: 'task:710', root, members: [root, child], ports: [4806], label: 'app', memoryBytes: null};
    const {listeners} = await attachLaunchers(
      [listener({pid: 711, ppid: 710, port: 4806, task})], [], processes, options({710: '', 711: ended}),
    );
    expect(listeners[0]).toMatchObject({leftover: true, launcher: {sessionId: ENDED_SESSION, state: 'ended'}});
  });

  it('flags browser sessions of an ended launcher even when the browser app is installed', async () => {
    const browser = {
      pid: 800, ppid: 1, name: 'Google Chrome', command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-pipe',
      executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', members: [],
    } as unknown as BrowserSession;
    const result = await attachLaunchers([], [browser, {...browser, pid: 801, ppid: 55}], processes, options({800: ended, 801: ended}));
    expect(result.browsers.map(({pid, leftover}) => [pid, leftover])).toEqual([[800, true], [801, true]]);
  });
});
