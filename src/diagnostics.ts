import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_BYTES = 1024 * 1024;

/** Best-effort, bounded diagnostics. Never retain scanned commands or env vars. */
export function createDiagnostics(directory = path.join(os.homedir(), '.portwarden', 'logs')) {
  const file = path.join(directory, 'runtime.jsonl');
  const session = `${process.pid}-${Date.now()}`;
  const record = (event: string, details: Record<string, unknown> = {}) => {
    try {
      fs.mkdirSync(directory, {recursive: true, mode: 0o700});
      if (fs.existsSync(file) && fs.statSync(file).size >= MAX_BYTES) {
        fs.renameSync(file, `${file}.1`);
      }
      fs.appendFileSync(file, `${JSON.stringify({
        ...details, time: new Date().toISOString(), session, pid: process.pid, event,
        uptimeSeconds: Math.round(process.uptime()), memory: process.memoryUsage(),
      })}\n`, {mode: 0o600});
      fs.chmodSync(file, 0o600);
    } catch {
      // A full disk or unavailable home directory must not crash the TUI.
    }
  };
  const error = (event: string, value: unknown) => {
    // Error messages can contain scanned command lines and credentials. Keep
    // only the error class, system error code, and stack locations.
    const failure = value instanceof Error ? value : undefined;
    const code = failure && 'code' in failure ? failure.code : undefined;
    record(event, {
      errorName: failure?.name ?? typeof value,
      code: typeof code === 'string' ? code : undefined,
      frames: failure?.stack?.split('\n').filter((line) => /^\s+at /.test(line)).slice(0, 12),
    });
  };
  return {record, error};
}

export function startDiagnostics(directory?: string) {
  const diagnostics = createDiagnostics(directory);
  diagnostics.record('start', {node: process.version, ppid: process.ppid});
  const timer = setInterval(() => diagnostics.record('heartbeat'), 60_000);
  timer.unref();
  process.on('uncaughtExceptionMonitor', (error, origin) => diagnostics.error(origin, error));
  process.once('exit', (code) => diagnostics.record('exit', {code}));
  return diagnostics;
}
