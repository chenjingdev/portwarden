import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {execa, type ResultPromise} from 'execa';
import getPort, {portNumbers} from 'get-port';

import type {ConfigRepository, GraveyardRecord, PortwardenConfig} from '../config.js';
import {
  isSnapshotReplaySafe,
  normalizeCommandForComparison,
  parseCommandSnapshot,
  rewriteCommandPort,
  sanitizeText,
  type CommandSnapshot,
} from './commands.js';
import {
  canonicalHost,
  collectListeners,
  collectProcessMetadata,
  listenerKey,
  listenerKeys,
  preferenceKey,
  selectionKey,
} from './listeners.js';
import type {BrowserSession, ListenerEntry, ProcessInfo, ProcessTask, ZombieCandidate} from './types.js';
import {sameTaskSnapshot} from './processTasks.js';
import {detectBrowserSessions, sameBrowserProcess} from './browserSessions.js';
import {collectProcesses, revalidateZombie, waitForZombieExit} from './zombies.js';

export type StopSignal = 'SIGTERM' | 'SIGKILL';

export interface ActionOutcome {
  message: string;
  warning?: string;
  listener?: ListenerEntry;
  port?: number;
  pid?: number;
  pgid?: number;
  logPath?: string;
  graveyardSaved?: boolean;
}

export interface ActionDependencies {
  collect?: typeof collectListeners;
  kill?: (pid: number, signal: StopSignal) => void;
  now?: () => Date;
  getPort?: typeof getPort;
  launch?: typeof launchDetached;
  processProvider?: () => Promise<readonly ProcessInfo[]>;
  collectProcessMetadata?: typeof collectProcessMetadata;
  revalidateZombie?: typeof revalidateZombie;
  waitForZombieExit?: typeof waitForZombieExit;
}

/** Match the observed task tree, falling back to one PID for standalone apps.
 * A shared POSIX process group is not sufficient evidence of a shared task. */
export function listenerSharesStopScope(target: ListenerEntry, candidate: ListenerEntry): boolean {
  return target.task ? target.task.members.some(({pid}) => pid === candidate.pid) : candidate.pid === target.pid;
}

export class ActionError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'PINNED'
      | 'STALE_PROCESS'
      | 'UNSAFE_COMMAND'
      | 'UNSUPPORTED_MOVE'
      | 'PORT_BUSY'
      | 'START_FAILED'
      | 'STOP_FAILED'
      | 'NOT_FOUND',
  ) {
    super(message);
    this.name = 'ActionError';
  }
}

export class PortwardenActions {
  private readonly collect: typeof collectListeners;
  private readonly kill: (pid: number, signal: StopSignal) => void;
  private readonly now: () => Date;
  private readonly findPort: typeof getPort;
  private readonly launch: typeof launchDetached;
  private readonly processProvider: () => Promise<readonly ProcessInfo[]>;
  private readonly processMetadataProvider: typeof collectProcessMetadata;
  private readonly revalidateZombie: typeof revalidateZombie;
  private readonly waitForZombieExit: typeof waitForZombieExit;

  constructor(
    private readonly configRepository: ConfigRepository,
    dependencies: ActionDependencies = {},
  ) {
    this.collect = dependencies.collect ?? collectListeners;
    this.kill = dependencies.kill ?? process.kill;
    this.now = dependencies.now ?? (() => new Date());
    this.findPort = dependencies.getPort ?? getPort;
    this.launch = dependencies.launch ?? launchDetached;
    this.processProvider = dependencies.processProvider ?? collectProcesses;
    this.processMetadataProvider = dependencies.collectProcessMetadata ?? collectProcessMetadata;
    this.revalidateZombie = dependencies.revalidateZombie ?? revalidateZombie;
    this.waitForZombieExit = dependencies.waitForZombieExit ?? waitForZombieExit;
  }

  /** Revalidate a listener without changing process or config state. */
  async validateListener(entry: ListenerEntry, signal: StopSignal = 'SIGTERM'): Promise<ListenerEntry> {
    const {current, listeners} = await this.requireCurrentListenerSnapshot(entry, signal === 'SIGKILL');
    this.assertStoppableListener(current, listeners);
    return current;
  }

  private assertStoppableListener(current: ListenerEntry, listeners: readonly ListenerEntry[]): void {
    if (current.task?.blockedReason) throw new ActionError(current.task.blockedReason, 'STALE_PROCESS');
    const config = this.configRepository.get();
    const pinnedSibling = listeners.find((listener) =>
      listenerSharesStopScope(current, listener) && isPinned(listener, config),
    );
    if (pinnedSibling) {
      throw new ActionError(
        `${current.task ? `Task ${current.task.root.pid}` : `PID ${current.pid}`} also owns pinned port ${pinnedSibling.port}. Unpin every listener in the stop scope before stopping it.`,
        'PINNED',
      );
    }
  }

  async stopListener(entry: ListenerEntry, signal: StopSignal): Promise<ActionOutcome> {
    const config = this.configRepository.get();
    if (isPinned(entry, config)) {
      throw new ActionError(`Port ${entry.port} is pinned. Unpin it before stopping.`, 'PINNED');
    }

    const {current, listeners} = await this.requireCurrentListenerSnapshot(entry, signal === 'SIGKILL');
    this.assertStoppableListener(current, listeners);
    const task = current.task;
    const graveyardSource = task ? {...current, args: task.root.command, cwd: task.root.cwd ?? current.cwd, startTime: task.root.startTime} : current;
    const graveyardRecord = current.kind === 'dev' ? captureGraveyardRecord(graveyardSource, this.now()) : null;
    if (task) {
      await this.stopProcessTask(current, task, signal);
    } else {
      try {
        this.kill(current.pid, signal);
      } catch (error) {
        const message = sanitizeText(error instanceof Error ? error.message : String(error));
        throw new ActionError(`Could not signal PID ${current.pid}: ${message}`, 'STOP_FAILED');
      }
      const listenerStopped = await waitForListenerGone(current, this.collect, signal === 'SIGKILL' ? 2_000 : 4_000);
      if (!listenerStopped) {
        throw new ActionError(`PID ${current.pid} still has listening ports. Refresh before retrying.`, 'STOP_FAILED');
      }
    }

    let graveyardSaved = false;
    let graveyardSaveError = '';
    if (graveyardRecord) {
      try {
        const nextConfig = this.configRepository.get();
        this.configRepository.update({
          graveyard: [graveyardRecord, ...nextConfig.graveyard.filter(({listenerKey: key}) => key !== graveyardRecord.listenerKey)].slice(0, 100),
        });
        graveyardSaved = true;
      } catch (error) {
        graveyardSaveError = sanitizeText(error instanceof Error ? error.message : String(error));
      }
    }

    const graveyardMessage = current.kind !== 'dev'
      ? ''
      : graveyardSaved
        ? ' Saved a revive record in the graveyard.'
        : graveyardSaveError
          ? ''
        : ' No revive record was saved because the command cannot be replayed safely.';
    const ports = task?.ports ?? [...new Set(listeners.filter(({pid}) => pid === current.pid).map(({port}) => port))];
    const warnings = graveyardSaveError ? `Revive record was not saved: ${graveyardSaveError}.` : '';
    return {
      message: `Stopped ${current.displayProject || current.command} on port ${ports.join(', ')} (${task ? `task ${task.root.pid}, ${task.members.length} processes` : `PID ${current.pid}`}) (${signal}).${graveyardMessage}`,
      warning: warnings || undefined,
      port: current.port,
      pid: current.pid,
      graveyardSaved: current.kind === 'dev' ? graveyardSaved : undefined,
    };
  }

  private async stopProcessTask(listener: ListenerEntry, task: ProcessTask, signal: StopSignal): Promise<void> {
    const fresh = await this.requireCurrentListenerSnapshot(listener);
    this.assertStoppableListener(fresh.current, fresh.listeners);
    if (!fresh.current.task || !sameTaskSnapshot(fresh.current.task, task) ||
      task.members.some((entry) => !sameBrowserProcess(entry, entry))) {
      throw new ActionError('The task changed or contains an unverifiable process. Refresh before stopping.', 'STALE_PROCESS');
    }
    const signaled: number[] = [];
    try {
      for (const member of task.members) {
        let current = (await this.processProvider()).find(({pid}) => pid === member.pid);
        if (!current) continue;
        if (!current.executable || (member.cwd && !current.cwd)) {
          const metadata = (await this.processMetadataProvider([member.pid], {strict: true})).get(member.pid);
          if (metadata?.uid === current.uid) current = {
            ...current, executable: current.executable || metadata?.executable || '', cwd: current.cwd || metadata?.cwd,
          };
        }
        if (!sameBrowserProcess(current, member) || (member.cwd && current.cwd !== member.cwd)) {
          if (member.pid === task.root.pid) throw new Error('Task root identity changed before its signal.');
          continue;
        }
        try {
          this.kill(member.pid, signal);
          signaled.push(member.pid);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      const expected = new Map(task.members.map((entry) => [entry.pid, entry]));
      const deadline = Date.now() + (signal === 'SIGKILL' ? 2_000 : 4_000);
      do {
        const [processes, listeners] = await Promise.all([this.processProvider(), this.collect({strict: true})]);
        const remaining = processes.filter((entry) => {
          const previous = expected.get(entry.pid);
          return previous && (!entry.startTime || entry.startTime.getTime() === previous.startTime?.getTime());
        });
        if (!remaining.length && !listeners.some(({pid}) => expected.has(pid))) return;
        if (Date.now() >= deadline) throw new Error('Some task processes or ports remain; refresh and retry or force-stop.');
        await delay(100);
      } while (true);
    } catch (error) {
      throw new ActionError(`Task cleanup: ${signaled.length} processes signaled. ${sanitizeText(error instanceof Error ? error.message : error)}`, 'STOP_FAILED');
    }
  }

  async stopBrowser(candidate: BrowserSession, signal: StopSignal): Promise<ActionOutcome> {
    const browserProcesses = async (): Promise<readonly ProcessInfo[]> => {
      const processes = await this.processProvider();
      const tree = detectBrowserSessions(processes).find(({pid}) => pid === candidate.pid);
      const targetPids = new Set([...candidate.members, ...(tree?.members ?? [])].map(({pid}) => pid));
      const missing = processes.filter((entry) => targetPids.has(entry.pid) && !entry.executable);
      if (missing.length === 0) return processes;
      // ps-list may lose Chrome Helper paths containing many spaces, or paths
      // from a previous Chrome version. Resolve those from OS program-text data
      // on every snapshot, including immediately before each helper's signal.
      const metadata = await this.processMetadataProvider(missing.map(({pid}) => pid), {strict: true});
      return processes.map((entry) => {
        const details = metadata.get(entry.pid);
        return !entry.executable && details?.executable && details.uid === entry.uid
          ? {...entry, executable: details.executable}
          : entry;
      });
    };
    const processes = await browserProcesses();
    const current = detectBrowserSessions(processes).find(({pid}) => pid === candidate.pid);
    if (!current || !sameBrowserProcess(current, candidate) || current.ppid !== candidate.ppid) {
      throw new ActionError(`Browser PID ${candidate.pid} changed; refresh before stopping.`, 'STALE_PROCESS');
    }
    const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
    const ancestors = new Set<number>();
    let ancestor: number | undefined = process.pid;
    while (ancestor && !ancestors.has(ancestor)) {
      ancestors.add(ancestor);
      ancestor = byPid.get(ancestor)?.ppid;
    }
    if (current.members.some((member) => ancestors.has(member.pid))) {
      throw new ActionError('Browser tree includes Portwarden; nothing was killed.', 'STALE_PROCESS');
    }
    const unverifiable = current.members.find((member) => !sameBrowserProcess(member, member));
    if (unverifiable) {
      throw new ActionError(`Browser helper PID ${unverifiable.pid} has incomplete identity data; nothing was killed.`, 'STALE_PROCESS');
    }
    const members = new Map(current.members.map((entry) => [entry.pid, entry]));
    const listeners = await this.collect({strict: true});
    const pinned = new Set(this.configRepository.get().pinnedListenerKeys);
    const protectedListener = listeners.find((entry) => members.has(entry.pid) && listenerKeys(entry).some((key) => pinned.has(key)));
    if (protectedListener) {
      throw new ActionError(`Browser owns pinned port ${protectedListener.port}. Unpin it before stopping.`, 'PINNED');
    }
    // Recheck membership after lsof and before the first signal. Newly discovered
    // children need a fresh pin check, so a changing tree is retried by the user.
    const verified = detectBrowserSessions(await browserProcesses()).find(({pid}) => pid === current.pid);
    if (!verified || verified.ppid !== current.ppid || verified.members.length !== members.size ||
      verified.members.some((entry) => !members.has(entry.pid) || !sameBrowserProcess(entry, members.get(entry.pid)!))) {
      throw new ActionError('Browser tree changed; refresh before stopping. Nothing was killed.', 'STALE_PROCESS');
    }
    const signaled: number[] = [];
    try {
      // Stop the browser first to prevent it from spawning replacement helpers.
      // Never signal its controller or an OS process group shared with other jobs.
      for (const member of verified.members) {
        const fresh = (await browserProcesses()).find(({pid}) => pid === member.pid);
        if (!fresh) continue;
        if (!sameBrowserProcess(fresh, member)) {
          if (member.pid === current.pid) throw new Error('Browser identity changed before its signal.');
          continue; // Exited/reused child PID: never signal its replacement.
        }
        try {
          this.kill(member.pid, signal);
          signaled.push(member.pid);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      const deadline = Date.now() + (signal === 'SIGKILL' ? 1_000 : 3_000);
      do {
        const remaining = (await this.processProvider()).filter((entry) => {
          const expected = members.get(entry.pid);
          return expected && (!entry.startTime || entry.startTime.getTime() === expected.startTime?.getTime());
        });
        if (remaining.length === 0) {
          return {message: `Stopped browser PID ${candidate.pid} and its helpers (${members.size} processes, ${signal}).`, pid: candidate.pid};
        }
        if (Date.now() >= deadline) throw new Error(`${remaining.length} browser process(es) still running or unverifiable; refresh and use force-stop if needed.`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (true);
    } catch (error) {
      throw new ActionError(`Browser cleanup: ${signaled.length} process(es) signaled. ${sanitizeText(error instanceof Error ? error.message : error)}`, 'STOP_FAILED');
    }
  }

  async stopZombie(candidate: ZombieCandidate, signal: StopSignal): Promise<ActionOutcome> {
    const stillSafe = await this.revalidateZombie({...candidate, reapable: true}, {
      minAgeMs: 0,
      processProvider: this.processProvider,
    });
    if (!stillSafe) {
      throw new ActionError(`Zombie PID ${candidate.pid} changed or became active; nothing was killed.`, 'STALE_PROCESS');
    }
    try {
      this.kill(candidate.pid, signal);
    } catch (error) {
      const message = sanitizeText(error instanceof Error ? error.message : String(error));
      throw new ActionError(`Could not signal zombie PID ${candidate.pid}: ${message}`, 'STOP_FAILED');
    }
    const stopped = await this.waitForZombieExit(candidate, {
      processProvider: this.processProvider,
      timeoutMs: signal === 'SIGKILL' ? 1_000 : 3_000,
    });
    if (!stopped) {
      throw new ActionError(`Signal ${signal} was sent, but Portwarden could not verify that zombie PID ${candidate.pid} exited.`, 'STOP_FAILED');
    }
    return {
      message: `Stopped zombie PID ${candidate.pid} (${signal}).`,
      pid: candidate.pid,
    };
  }

  async moveListener(entry: ListenerEntry): Promise<ActionOutcome> {
    const current = await this.requireMovableListener(entry);
    if (current.port >= 65_535) {
      throw new ActionError('No higher port is available after 65535.', 'PORT_BUSY');
    }
    const snapshot = parseCommandSnapshot(current.args);
    if (!snapshot || !isSnapshotReplaySafe(snapshot)) {
      throw new ActionError('The launch command cannot be replayed safely.', 'UNSAFE_COMMAND');
    }

    const nextPort = await this.findPort({port: portNumbers(current.port + 1, 65_535)});
    const rewritten = rewriteCommandPort(snapshot, nextPort);
    if (!rewritten) {
      throw new ActionError('This process has no supported port flag to rewrite.', 'UNSUPPORTED_MOVE');
    }

    const logPath = await buildLogPath(current.displayProject || current.command, nextPort);
    const child = this.launch(rewritten, current.cwd, logPath);
    let started: ListenerEntry;
    try {
      started = await waitForMatchingListener({
        port: nextPort,
        original: current,
        expected: rewritten,
        collect: this.collect,
        launchedPid: child.pid,
        processProvider: this.processProvider,
        timeoutMs: 12_000,
      });
    } catch (error) {
      const rolledBack = await rollbackLaunchedProcess(child.pid, undefined, this.collect);
      throw withRollbackResult(error, 'START_FAILED', rolledBack);
    }

    try {
      const finalSnapshot = await this.requireCurrentListenerSnapshot(current);
      this.assertMovableListener(finalSnapshot.current, finalSnapshot.listeners);
      this.kill(finalSnapshot.current.pid, 'SIGTERM');
    } catch (error) {
      const rolledBack = await rollbackLaunchedProcess(child.pid, started, this.collect);
      if (error instanceof ActionError) throw withRollbackResult(error, error.code, rolledBack);
      const message = sanitizeText(error instanceof Error ? error.message : String(error));
      throw withRollbackResult(
        new ActionError(`Could not signal original PID ${current.pid}: ${message}`, 'STOP_FAILED'),
        'STOP_FAILED',
        rolledBack,
      );
    }
    let stopped: boolean;
    try {
      stopped = await waitForListenerGone(current, this.collect, 4_000);
    } catch (error) {
      const rolledBack = await rollbackLaunchedProcess(child.pid, started, this.collect);
      throw withRollbackResult(error, 'STOP_FAILED', rolledBack);
    }
    if (!stopped) {
      const rolledBack = await rollbackLaunchedProcess(child.pid, started, this.collect);
      throw new ActionError(
        `New port ${nextPort} started, but the original PID ${current.pid} did not stop. ${rollbackStatus(rolledBack)}`,
        'STOP_FAILED',
      );
    }

    let configWarning = '';
    try {
      this.updateConfigAfterMove(current, started);
    } catch (error) {
      const message = sanitizeText(error instanceof Error ? error.message : String(error));
      configWarning = `Saved pins/order were not updated: ${message}.`;
    }
    return {
      message: `Moved ${current.displayProject || current.command}: ${current.port} → ${nextPort}.`,
      warning: configWarning || undefined,
      listener: started,
      port: nextPort,
      pid: started.pid,
      logPath,
    };
  }

  async revive(record: GraveyardRecord): Promise<ActionOutcome> {
    if (!this.configRepository.get().graveyard.some(({id}) => id === record.id)) {
      throw new ActionError('That graveyard record no longer exists.', 'NOT_FOUND');
    }
    const currentListeners = await this.collect({strict: true});
    if (currentListeners.some(({port}) => port === record.port)) {
      throw new ActionError(`Port ${record.port} is already in use.`, 'PORT_BUSY');
    }

    const available = await waitForExactPort(this.findPort, record.port);
    if (!available) {
      throw new ActionError(`Port ${record.port} is no longer available.`, 'PORT_BUSY');
    }

    const snapshot: CommandSnapshot = {argv: record.argv, env: record.env};
    if (!isSnapshotReplaySafe(snapshot)) {
      throw new ActionError('The saved command contains sensitive or unsafe arguments.', 'UNSAFE_COMMAND');
    }

    const logPath = await buildLogPath(record.project, record.port);
    const child = this.launch(snapshot, record.cwd, logPath);
    let started: ListenerEntry;
    try {
      started = await waitForMatchingListener({
        port: record.port,
        expected: snapshot,
        cwd: record.cwd,
        collect: this.collect,
        launchedPid: child.pid,
        processProvider: this.processProvider,
        timeoutMs: 12_000,
      });
    } catch (error) {
      const rolledBack = await rollbackLaunchedProcess(child.pid, undefined, this.collect);
      throw withRollbackResult(error, 'START_FAILED', rolledBack);
    }

    let configWarning = '';
    try {
      const config = this.configRepository.get();
      this.configRepository.update({graveyard: config.graveyard.filter(({id}) => id !== record.id)});
    } catch (error) {
      const message = sanitizeText(error instanceof Error ? error.message : String(error));
      configWarning = `Graveyard record was not removed: ${message}.`;
    }
    return {
      message: `Revived ${record.project} on port ${record.port}.`,
      warning: configWarning || undefined,
      listener: started,
      port: record.port,
      pid: started.pid,
      logPath,
    };
  }

  discard(record: GraveyardRecord): ActionOutcome {
    const config = this.configRepository.get();
    const graveyard = config.graveyard.filter(({id}) => id !== record.id);
    if (graveyard.length === config.graveyard.length) {
      throw new ActionError('That graveyard record no longer exists.', 'NOT_FOUND');
    }
    this.configRepository.update({graveyard});
    return {message: `Discarded ${record.project}:${record.port} from the graveyard.`};
  }

  private async requireCurrentListener(expected: ListenerEntry): Promise<ListenerEntry> {
    return (await this.requireCurrentListenerSnapshot(expected)).current;
  }

  private async requireMovableListener(expected: ListenerEntry): Promise<ListenerEntry> {
    const {current, listeners} = await this.requireCurrentListenerSnapshot(expected);
    this.assertMovableListener(current, listeners);
    return current;
  }

  private assertMovableListener(current: ListenerEntry, listeners: readonly ListenerEntry[]): void {
    if (current.task) throw new ActionError('Port move is unavailable for grouped tasks. Restart the task with its new port.', 'UNSUPPORTED_MOVE');
    const config = this.configRepository.get();
    const pinnedSibling = listeners.find((listener) =>
      listener.pid === current.pid &&
      selectionKey(listener) !== selectionKey(current) &&
      isPinned(listener, config),
    );
    if (pinnedSibling) {
      throw new ActionError(
        `PID ${current.pid} also owns pinned port ${pinnedSibling.port}. Unpin it before moving this process.`,
        'PINNED',
      );
    }
  }

  private async requireCurrentListenerSnapshot(expected: ListenerEntry, allowMissingExecutable = false): Promise<{
    current: ListenerEntry;
    listeners: ListenerEntry[];
  }> {
    const effectiveUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (
      expected.pid <= 1 || !expected.args || !expected.cwd || !expected.startTime ||
      (!allowMissingExecutable && !expected.executable) ||
      (typeof effectiveUid === 'number' && expected.uid !== effectiveUid)
    ) {
      throw new ActionError(`PID ${expected.pid} has insufficient identity data for a destructive action.`, 'STALE_PROCESS');
    }
    const listeners = await this.collect({strict: true});
    const current = listeners.find((entry) => sameListenerIdentity(entry, expected));
    if (!current) {
      throw new ActionError(`PID ${expected.pid} changed or stopped; refresh before acting.`, 'STALE_PROCESS');
    }
    if (Boolean(current.task) !== Boolean(expected.task) ||
      (current.task && expected.task && !sameTaskSnapshot(current.task, expected.task))) {
      throw new ActionError('The task process/port scope changed. Refresh before stopping; nothing was killed.', 'STALE_PROCESS');
    }
    return {current, listeners};
  }

  private updateConfigAfterMove(original: ListenerEntry, moved: ListenerEntry): void {
    const config = this.configRepository.get();
    const originalKeys = new Set(listenerKeys(original));
    const wasPinned = config.pinnedListenerKeys.some((key) => originalKeys.has(key));
    const pins = config.pinnedListenerKeys.filter((key) => !originalKeys.has(key));
    if (wasPinned) {
      pins.push(listenerKey(moved));
    }
    const originalOrderAliases = new Set([
      ...listenerKeys(original),
      preferenceKey(original),
      selectionKey(original),
    ]);
    const movedOrderKey = listenerKey(moved);
    this.configRepository.update({
      pinnedListenerKeys: pins,
      graveyard: config.graveyard.filter(({listenerKey: key}) => !originalKeys.has(key)),
      orderedEntryKeys: config.orderedEntryKeys.map((key) => originalOrderAliases.has(key) ? movedOrderKey : key),
    });
  }
}

export function captureGraveyardRecord(entry: ListenerEntry, capturedAt = new Date()): GraveyardRecord | null {
  const snapshot = parseCommandSnapshot(entry.args);
  if (!snapshot || !isSnapshotReplaySafe(snapshot) || !entry.cwd || !entry.startTime) {
    return null;
  }
  const key = listenerKey(entry);
  const timestamp = capturedAt.toISOString();
  return {
    id: `${key}:${timestamp}`,
    listenerKey: key,
    port: entry.port,
    host: entry.host,
    project: sanitizeText(entry.displayProject || entry.projectName || entry.command) || 'unknown',
    cwd: entry.cwd,
    argv: snapshot.argv,
    env: snapshot.env,
    capturedAt: timestamp,
  };
}

export function isPinned(entry: ListenerEntry, config: PortwardenConfig): boolean {
  const pinned = new Set(config.pinnedListenerKeys);
  return listenerKeys(entry).some((key) => pinned.has(key));
}

interface LaunchedProcess {
  pid: number | undefined;
  subprocess: ResultPromise;
}

export function launchDetached(snapshot: CommandSnapshot, cwd: string, logPath: string): LaunchedProcess {
  const [file, ...args] = snapshot.argv;
  if (!file || !isSnapshotReplaySafe(snapshot)) {
    throw new ActionError('The saved command has no executable.', 'UNSAFE_COMMAND');
  }
  const subprocess = execa(file, args, {
    cwd: cwd || undefined,
    env: {...process.env, ...snapshot.env},
    detached: true,
    cleanup: false,
    reject: false,
    stdin: 'ignore',
    stdout: {file: logPath, append: true},
    stderr: {file: logPath, append: true},
  });
  subprocess.catch(() => undefined);
  subprocess.unref();
  return {pid: subprocess.pid, subprocess};
}

async function buildLogPath(project: string, port: number): Promise<string> {
  const directory = path.join(os.homedir(), '.portwarden', 'logs');
  await fs.mkdir(directory, {recursive: true, mode: 0o700});
  const slug = sanitizeText(project).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'process';
  return path.join(directory, `${slug}-${port}.log`);
}

interface WaitForMatchingOptions {
  port: number;
  expected: CommandSnapshot;
  collect: typeof collectListeners;
  timeoutMs: number;
  launchedPid: number | undefined;
  processProvider: () => Promise<readonly ProcessInfo[]>;
  cwd?: string;
  original?: ListenerEntry;
}

async function waitForMatchingListener(options: WaitForMatchingOptions): Promise<ListenerEntry> {
  if (!options.launchedPid || options.launchedPid <= 1) {
    throw new ActionError('The launched process did not provide a verifiable PID.', 'START_FAILED');
  }
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const listeners = await options.collect({strict: true});
    for (const entry of listeners) {
      if (entry.port !== options.port || entry.pid === options.original?.pid) {
        continue;
      }
      const expectedCwd = options.cwd ?? options.original?.cwd ?? '';
      if (!expectedCwd || !entry.args || !entry.startTime) continue;
      const currentSnapshot = parseCommandSnapshot(entry.args);
      const rootSnapshot = entry.task ? parseCommandSnapshot(entry.task.root.command) : null;
      const commandMatches = Boolean(
        (entry.cwd === expectedCwd && currentSnapshot &&
          !declaresDifferentPort(currentSnapshot, options.port) &&
          normalizeCommandForComparison(currentSnapshot) === normalizeCommandForComparison(options.expected)) ||
        (entry.task?.root.cwd === expectedCwd && rootSnapshot &&
          !declaresDifferentPort(rootSnapshot, options.port) &&
          normalizeCommandForComparison(rootSnapshot) === normalizeCommandForComparison(options.expected)),
      );
      if (commandMatches && await belongsToLaunch(entry.pid, options.launchedPid, options.processProvider)) {
        return entry;
      }
    }
    await delay(200);
  }
  throw new ActionError(`The new process did not open port ${options.port} with the expected command and cwd.`, 'START_FAILED');
}

function declaresDifferentPort(snapshot: CommandSnapshot, expectedPort: number): boolean {
  const ports: number[] = [];
  if (snapshot.env.PORT && /^\d+$/.test(snapshot.env.PORT)) {
    ports.push(Number(snapshot.env.PORT));
  }
  for (let index = 0; index < snapshot.argv.length; index += 1) {
    const token = snapshot.argv[index] ?? '';
    const inline = /^(?:--port=|-p=)(\d+)$/.exec(token)?.[1];
    if (inline) {
      ports.push(Number(inline));
    }
    if ((token === '--port' || token === '-p' || token === 'http.server') && /^\d+$/.test(snapshot.argv[index + 1] ?? '')) {
      ports.push(Number(snapshot.argv[index + 1]));
    }
    if (/^PORT=\d+$/.test(token)) ports.push(Number(token.slice('PORT='.length)));
    if (token === '-S') {
      const phpPort = /:(\d+)$/.exec(snapshot.argv[index + 1] ?? '')?.[1];
      if (phpPort) ports.push(Number(phpPort));
    }
  }
  return ports.some((port) => port !== expectedPort);
}

async function waitForListenerGone(entry: ListenerEntry, collect: typeof collectListeners, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const listeners = await collect({strict: true});
    if (!listeners.some(({pid}) => pid === entry.pid)) {
      return true;
    }
    if (Date.now() >= deadline) return false;
    await delay(150);
  }
}
async function rollbackLaunchedProcess(
  pid: number | undefined,
  started: ListenerEntry | undefined,
  collect: typeof collectListeners,
): Promise<boolean> {
  await signalVerifiedRollbackTarget(started, collect, 'SIGTERM');
  terminateLaunchedProcessGroup(pid, 'SIGTERM');
  if (!started) {
    if (!pid) return false;
    if (await waitForLaunchedProcessGroupGone(pid, 750)) return true;
    terminateLaunchedProcessGroup(pid, 'SIGKILL');
    return waitForLaunchedProcessGroupGone(pid, 750);
  }
  if (await waitForSpecificListenerGone(started, collect, 750)) return true;

  await signalVerifiedRollbackTarget(started, collect, 'SIGKILL');
  terminateLaunchedProcessGroup(pid, 'SIGKILL');
  return waitForSpecificListenerGone(started, collect, 750);
}

async function signalVerifiedRollbackTarget(
  started: ListenerEntry | undefined,
  collect: typeof collectListeners,
  signal: StopSignal,
): Promise<void> {
  if (!started) return;
  try {
    const current = (await collect({strict: true})).find((entry) => sameListenerIdentity(entry, started));
    if (current) process.kill(current.pid, signal);
  } catch {
    // A failed revalidation must not prevent signalling the process group launched by Portwarden.
  }
}

async function waitForSpecificListenerGone(
  started: ListenerEntry,
  collect: typeof collectListeners,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const listeners = await collect({strict: true});
      if (!listeners.some((entry) => sameListenerIdentity(entry, started))) return true;
    } catch {
      return false;
    }
    await delay(100);
  }
  return false;
}

async function waitForLaunchedProcessGroupGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!launchedProcessGroupExists(pid)) return true;
    await delay(100);
  }
  return false;
}

function launchedProcessGroupExists(pid: number): boolean {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function withRollbackResult(
  error: unknown,
  fallbackCode: ActionError['code'],
  rolledBack: boolean,
): ActionError {
  const code = error instanceof ActionError ? error.code : fallbackCode;
  const rawMessage = sanitizeText(error instanceof Error ? error.message : String(error));
  const message = rawMessage.replace(/[.\s]+$/g, '');
  return new ActionError(
    `${message}. ${rollbackStatus(rolledBack)}`,
    code,
  );
}

function rollbackStatus(rolledBack: boolean): string {
  return rolledBack
    ? 'The new listener was stopped and rollback was verified.'
    : 'Rollback was requested for the new process; refresh to verify it exited.';
}

function terminateLaunchedProcessGroup(pid: number | undefined, signal: StopSignal): void {
  if (!pid) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      process.kill(pid, signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // The process may already have failed or exited.
  }
}

function sameListenerIdentity(current: ListenerEntry, expected: ListenerEntry): boolean {
  return current.pid === expected.pid &&
    current.pgid === expected.pgid &&
    current.port === expected.port &&
    canonicalHost(current.host) === canonicalHost(expected.host) &&
    current.startTime?.getTime() === expected.startTime?.getTime() &&
    current.executable === expected.executable &&
    current.uid === expected.uid &&
    current.args === expected.args &&
    current.cwd === expected.cwd;
}

async function belongsToLaunch(
  pid: number,
  launchedPid: number,
  processProvider: () => Promise<readonly ProcessInfo[]>,
): Promise<boolean> {
  if (pid === launchedPid) return true;
  try {
    const processes = await processProvider();
    const byPid = new Map(processes.map((processInfo) => [processInfo.pid, processInfo]));
    const seen = new Set<number>();
    let current = byPid.get(pid);
    while (current && !seen.has(current.pid)) {
      if (current.ppid === launchedPid) return true;
      seen.add(current.pid);
      current = byPid.get(current.ppid);
    }
  } catch {
    return false;
  }
  return false;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForExactPort(findPort: typeof getPort, port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await findPort({port}) === port) return true;
    if (attempt < 4) await delay(100);
  }
  return false;
}
