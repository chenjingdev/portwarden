export type ListenerKind = 'dev' | 'app' | 'system';

/** A process snapshot. `command` is kept verbatim for safe PID revalidation. */
export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** OS user that owns this process. Required for destructive cleanup on Unix. */
  uid?: number;
  name: string;
  command: string;
  executable: string;
  startTime?: Date;
  ageMs?: number | null;
  cwd?: string;
  /** Resident memory in bytes; absent when the OS could not report it. */
  rssBytes?: number;
}

export interface BrowserSession extends ProcessInfo {
  family: ZombieFamily | 'chrome-automation';
  profile: string;
  parentName: string;
  parentState: 'running' | 'missing';
  ageSeconds: number | null;
  members: ProcessInfo[];
  /** Sum of member RSS, not a prediction of memory freed on exit. */
  memoryBytes: number | null;
  reason: string;
}

export interface RawListener {
  pid: number;
  command: string;
  endpoint: string;
}

/** One observed development launch and its descendants, never a whole PGID. */
export interface ProcessTask {
  key: string;
  root: ProcessInfo;
  members: ProcessInfo[];
  ports: number[];
  label: string;
  memoryBytes: number | null;
  blockedReason?: string;
}

export interface ListenerEntry {
  task?: ProcessTask;
  pid: number;
  ppid: number | null;
  /** POSIX job-control group that owns this listener. */
  pgid?: number;
  /** Portwarden's own group at collection time, used to prevent self-termination. */
  collectorPgid?: number;
  uid?: number;
  executable?: string;
  port: number;
  /** The first address reported by lsof. */
  host: string;
  /** Every equivalent address reported for this PID/port. */
  listenerHosts: string[];
  displayHost: string;
  command: string;
  /** The byte-for-byte command line returned by the process provider. */
  args: string;
  cwd: string;
  elapsed: string;
  kind: ListenerKind;
  appFamily: string;
  projectName: string;
  displayProject: string;
  displayCommand: string;
  displayCwd: string;
  startTime?: Date;
}

export interface ListenerSelectionOptions {
  all?: boolean;
  pinnedListenerKeys?: readonly string[];
  orderedEntryKeys?: readonly string[];
}

export type ZombieFamily = 'playwright' | 'puppeteer' | 'headless-chrome';

export interface ZombieCandidate extends ProcessInfo {
  family: ZombieFamily;
  ageMs: number | null;
  ageSeconds: number | null;
  /** Candidates younger than the configured threshold remain visible but cannot be reaped. */
  reapable: boolean;
  reason: string;
}

export interface CommandResult {
  stdout: string;
  stderr?: string;
  exitCode: number;
}
