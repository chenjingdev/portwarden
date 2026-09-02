import process from 'node:process';
import {createRequire} from 'node:module';

import {Command, Option} from 'commander';
import getPort, {portNumbers} from 'get-port';
import {render} from 'ink';
import React from 'react';

import {ConfigRepository} from './config.js';
import {formatActionOutcomes, stopListenerMatches} from './cliActions.js';
import {PortwardenActions, type ActionOutcome, type StopSignal} from './core/actions.js';
import {collectListeners, selectListeners} from './core/listeners.js';
import type {ListenerEntry, ZombieCandidate} from './core/types.js';
import {collectProcesses, detectZombieCandidates, reapZombie} from './core/zombies.js';
import {renderOutput, renderReapResults, type ReapResult} from './output.js';
import {PortwardenApp} from './tui/App.js';

const packageMetadata = createRequire(import.meta.url)('../package.json') as {version: string};
const VERSION = packageMetadata.version;

interface CliOptions {
  all: boolean;
  json: boolean;
  plain: boolean;
  tui: boolean;
  force: boolean;
  zombies: boolean;
  reap: boolean;
  dryRun: boolean;
  browser?: string;
  watch: boolean | number;
  nextPort?: number;
  killPort?: number;
  killPid?: number;
}

const program = new Command()
  .name('portwarden')
  .description('Inspect, organize, and safely clean up local development ports.')
  .version(VERSION)
  .showSuggestionAfterError()
  .allowExcessArguments(false)
  .option('-a, --all', 'show every TCP LISTEN port', false)
  .option('-j, --json', 'print machine-readable JSON (NDJSON with --watch)', false)
  .option('--plain', 'print a table instead of opening the TUI', false)
  .option('-t, --tui', 'force the interactive TUI', false)
  .option('-z, --zombies', 'include orphaned browser-automation processes', false)
  .option('--reap', 'stop reapable orphaned browser-automation processes', false)
  .option('--dry-run', 'preview --reap without sending a signal', false)
  .option('-f, --force', 'use SIGKILL with --kill-* or --reap', false)
  .addOption(new Option('-w, --watch [seconds]', 'refresh plain/JSON output continuously').argParser(parsePositiveNumber).default(false))
  .addOption(new Option('-b, --browser <name>', 'browser application used by the TUI').argParser(parseNonEmpty))
  .addOption(new Option('--next-port <port>', 'print the next actually available port').argParser(parsePort))
  .addOption(new Option('--kill-port <port>', 'stop listeners on a port (including a verified dev process group)').argParser(parsePort))
  .addOption(new Option('--kill-pid <pid>', 'stop a listener scope or detected zombie PID').argParser(parsePositiveInteger))
  .addHelpText('after', `
Examples:
  $ portwarden
  $ portwarden --all --plain
  $ portwarden --json --zombies
  $ portwarden --reap --dry-run
  $ portwarden --next-port 5173

TUI keys:
  ↑↓ select · ←→ reorder · a all · z zombies · p pin · o open
  m move · x stop · f force-stop · g graveyard · s settings · / filter · ? help
`);

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
  const options = program.opts<CliOptions>();
  validateOptions(options);

  const hasHeadlessAction = options.nextPort !== undefined || options.killPort !== undefined || options.killPid !== undefined || options.reap;
  const watchSeconds = options.watch === true ? 2 : typeof options.watch === 'number' ? options.watch : 0;
  const defaultTui = process.stdin.isTTY && process.stdout.isTTY && !options.plain && !options.json && watchSeconds === 0 && !hasHeadlessAction;

  if (options.nextPort !== undefined) {
    if (options.nextPort >= 65_535) {
      throw new Error('No port exists after 65535.');
    }
    console.log(await getPort({port: portNumbers(options.nextPort + 1, 65_535)}));
    return;
  }

  if (options.reap) {
    await runReap(options);
    return;
  }

  const configRepository = ConfigRepository.open();
  if (options.tui || defaultTui) {
    await runTui(configRepository, options);
    return;
  }

  const actions = new PortwardenActions(configRepository);
  if (options.killPort !== undefined || options.killPid !== undefined) {
    await runDirectKill(actions, options);
    return;
  }

  if (watchSeconds > 0) {
    await runWatch(configRepository, options, watchSeconds);
    return;
  }

  const snapshot = await scan(configRepository, options);
  console.log(renderOutput(snapshot.listeners, snapshot.allListeners.length, snapshot.zombies, options));
}

async function scan(
  configRepository: ConfigRepository,
  options: Pick<CliOptions, 'all' | 'json' | 'zombies'>,
): Promise<{allListeners: ListenerEntry[]; listeners: ListenerEntry[]; zombies: ZombieCandidate[]}> {
  const processPromise = collectProcesses();
  const listenerPromise = collectListeners({strict: true, processProvider: () => processPromise});
  const [processes, allListeners] = await Promise.all([processPromise, listenerPromise]);
  const config = configRepository.get();
  return {
    allListeners,
    listeners: selectListeners(allListeners, {
      all: options.all,
      pinnedListenerKeys: config.pinnedListenerKeys,
      orderedEntryKeys: config.orderedEntryKeys,
    }),
    zombies: options.zombies
      ? detectZombieCandidates(processes, {listeningPids: new Set(allListeners.map(({pid}) => pid))})
      : [],
  };
}

async function runDirectKill(actions: PortwardenActions, options: CliOptions): Promise<void> {
  const signal: StopSignal = options.force ? 'SIGKILL' : 'SIGTERM';
  const processPromise = collectProcesses();
  const allListeners = await collectListeners({strict: true, processProvider: () => processPromise});
  const processes = await processPromise;

  if (options.killPort !== undefined) {
    const rawMatches = allListeners.filter(({port}) => port === options.killPort);
    if (rawMatches.length === 0) {
      throw new Error(`No LISTEN process is using port ${options.killPort}.`);
    }
    await stopListenerMatches(actions, rawMatches, signal, printActionOutcome);
    return;
  }

  const listener = allListeners.find(({pid}) => pid === options.killPid);
  if (listener) {
    printActionOutcome(await actions.stopListener(listener, signal));
    return;
  }
  const zombie = detectZombieCandidates(processes, {
    listeningPids: new Set(allListeners.map(({pid}) => pid)),
    minAgeMs: 0,
  }).find(({pid}) => pid === options.killPid);
  if (zombie) {
    printActionOutcome(await actions.stopZombie(zombie, signal));
    return;
  }
  throw new Error(`PID ${options.killPid} is neither a current LISTEN process nor a detected automation zombie.`);
}

function printActionOutcome(outcome: ActionOutcome): void {
  const formatted = formatActionOutcomes([outcome]);
  if (formatted.stdout) console.log(formatted.stdout);
  if (formatted.stderr) console.error(formatted.stderr);
}

async function runReap(options: CliOptions): Promise<void> {
  const processPromise = collectProcesses();
  const allListeners = await collectListeners({strict: true, processProvider: () => processPromise});
  const processes = await processPromise;
  const candidates = detectZombieCandidates(processes, {
    listeningPids: new Set(allListeners.map(({pid}) => pid)),
  }).filter(({reapable}) => reapable);
  const signal: NodeJS.Signals = options.force ? 'SIGKILL' : 'SIGTERM';
  const results: ReapResult[] = [];
  for (const candidate of candidates) {
    if (options.dryRun) {
      results.push({candidate, status: 'dry-run'});
    } else {
      const stopped = await reapZombie(candidate, {signalName: signal});
      results.push({candidate, status: stopped ? 'stopped' : 'skipped'});
    }
  }
  console.log(renderReapResults(results, signal));
}

async function runWatch(configRepository: ConfigRepository, options: CliOptions, seconds: number): Promise<void> {
  let stopped = false;
  const stopController = new AbortController();
  const stop = () => {
    stopped = true;
    stopController.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    while (!stopped) {
      const snapshot = await scan(configRepository, options);
      if (process.stdout.isTTY) {
        process.stdout.write('\u001B[2J\u001B[H');
      }
      console.log(renderOutput(snapshot.listeners, snapshot.allListeners.length, snapshot.zombies, {
        ...options,
        jsonLines: options.json,
        watchSeconds: seconds,
      }));
      await delay(seconds * 1000, stopController.signal);
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

async function runTui(configRepository: ConfigRepository, options: CliOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('TUI mode requires an interactive terminal. Use --plain or --json in pipes.');
  }
  let instance: ReturnType<typeof render> | undefined;
  let alternateScreen = false;
  const terminate = () => instance?.unmount();
  try {
    process.stdout.write('\u001B[?1049h\u001B[H\u001B[2J');
    alternateScreen = true;
    instance = render(
      <PortwardenApp
        configRepository={configRepository}
        initialAll={options.all}
        initialZombies={options.zombies}
        browserOverride={options.browser ?? process.env.PORTWARDEN_BROWSER ?? process.env.DEV_PORTS_BROWSER}
      />,
      {exitOnCtrlC: false, incrementalRendering: true},
    );
    process.once('SIGTERM', terminate);
    await instance.waitUntilExit();
  } finally {
    process.removeListener('SIGTERM', terminate);
    instance?.unmount();
    if (alternateScreen) {
      process.stdout.write('\u001B[?25h\u001B[?1049l');
    }
  }
}

function validateOptions(options: CliOptions): void {
  const operationCount = [options.nextPort !== undefined, options.killPort !== undefined, options.killPid !== undefined, options.reap]
    .filter(Boolean).length;
  if (operationCount > 1) throw new Error('Choose only one of --next-port, --kill-port, --kill-pid, or --reap.');
  if (operationCount > 0 && (options.all || options.json || options.plain || options.tui || options.zombies || options.watch || options.browser)) {
    throw new Error('Headless actions cannot be combined with display, watch, zombie-listing, browser, or TUI options.');
  }
  if (options.tui && (options.plain || options.json || options.watch || operationCount > 0)) {
    throw new Error('--tui cannot be combined with plain, JSON, watch, or headless actions.');
  }
  if (options.plain && options.json) throw new Error('--plain and --json cannot be combined.');
  if (options.dryRun && !options.reap) throw new Error('--dry-run requires --reap.');
  if (options.force && options.killPort === undefined && options.killPid === undefined && !options.reap) {
    throw new Error('--force requires --kill-port, --kill-pid, or --reap.');
  }
}

function parsePort(value: string): number {
  const port = parsePositiveInteger(value);
  if (port > 65_535) throw new Error(`Port must be between 1 and 65535: ${value}`);
  return port;
}

function parsePositiveInteger(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`Expected a positive integer: ${value}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`Expected a positive integer: ${value}`);
  return number;
}

function parsePositiveNumber(value: string): number {
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(value)) throw new Error(`Expected a positive number: ${value}`);
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`Expected a positive number: ${value}`);
  return number;
}

function parseNonEmpty(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error('Expected a non-empty value.');
  return normalized;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      done();
    };
    function done() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    signal?.addEventListener('abort', abort, {once: true});
  });
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
