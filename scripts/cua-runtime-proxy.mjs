#!/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
// Stdio relay for the original CUA runtime. No tool arguments/results are saved.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn, execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

const native = process.env.PORTWARDEN_CUA_NATIVE_RUNTIME;
if (!native || !path.isAbsolute(native) || native === process.argv[1]) {
  process.stderr.write('Portwarden CUA: an absolute original runtime is required.\n');
  process.exit(1);
}
const root = process.env.PORTWARDEN_CUA_STATE_DIR || path.join(os.homedir(), 'Library/Caches/portwarden-cua');
const info = async (file, type) => {
  const s = await fs.lstat(file);
  if (s.uid !== process.getuid() || (s.mode & 0o077) || !s[type]()) throw new Error('private ownership required');
};
await fs.mkdir(root, {recursive: true, mode: 0o700});
await info(root, 'isDirectory');
const directory = await fs.mkdtemp(path.join(root, 'relay-'));
await fs.chmod(directory, 0o700);
const control = path.join(directory, 'control.sock');
const child = spawn(native, process.argv.slice(2), {env: process.env, stdio: ['pipe', 'pipe', 'inherit']});
const birth = pid => new Date(execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {encoding: 'utf8'}).trim()).getTime();
const record = {schemaVersion: 1, relayPid: process.pid, relayStartedAt: birth(process.pid),
  runtimePid: child.pid, rootPid: process.ppid, controlPath: control};
await fs.writeFile(path.join(directory, 'relay.json'), JSON.stringify(record), {mode: 0o600});

const scopes = new Map();
const external = new Set();
const owned = new Map();
const prefix = `portwarden-cleanup-${randomUUID()}-`;
let input = '', output = '', cleaning = false, shutdown = false, next = 0, stopPromise;
let catalogue;
const emit = object => process.stdout.write(JSON.stringify(object) + '\n');
const send = object => child.stdin.write(JSON.stringify(object) + '\n');
const key = id => JSON.stringify(id);
function scopeOf(message) {
  let m = message.params?._meta?.['x-codex-turn-metadata'];
  if (typeof m === 'string') {try {m = JSON.parse(m);} catch {return;}}
  if (!m || typeof m !== 'object' || Array.isArray(m)) return;
  const session = m.thread_source === 'subagent' ? m.thread_id : m.session_id;
  if (typeof session !== 'string' || !session || typeof m.turn_id !== 'string' || !m.turn_id) return;
  return {session_id: session, turn_id: m.turn_id};
}
function consume(chunk, which, receive) {
  if (which === 'input') input += chunk; else output += chunk;
  let buffer = which === 'input' ? input : output;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const raw = buffer.slice(0, end + 1); buffer = buffer.slice(end + 1);
    receive(raw);
  }
  if (which === 'input') input = buffer; else output = buffer;
}
function receiveInput(raw) {
  let m;
  try {m = JSON.parse(raw);} catch {child.stdin.write(raw); return;}
  if (cleaning) {
    if (m.id != null && m.method) emit({jsonrpc: '2.0', id: m.id,
      error: {code: -32001, message: 'CUA is being stopped by Portwarden.'}});
    return;
  }
  if (m.method === 'tools/call') {
    const s = scopeOf(m);
    // Only context supplied by the host is recorded. Never accept tool code as scope.
    if (s && m.params?.name !== 'turn_ended') scopes.set(s.session_id, s);
  }
  if (m.id != null && m.method) external.add(key(m.id));
  child.stdin.write(raw);
}
function receiveOutput(raw) {
  let m;
  try {m = JSON.parse(raw);} catch {process.stdout.write(raw); return;}
  const k = key(m.id), pending = owned.get(k);
  if (pending && !m.method) {
    owned.delete(k); clearTimeout(pending.timer);
    m.error || m.result?.isError ? pending.reject(new Error('original cleanup refused')) : pending.resolve(m.result);
    return;
  }
  if (!m.method && typeof m.id === 'string' && m.id.startsWith(prefix)) return;
  if (m.id != null && !m.method) external.delete(k);
  // Keep tool discovery byte-for-byte transparent; cache only the cleanup schema.
  if (Array.isArray(m.result?.tools)) catalogue = m.result.tools.find(t => t.name === 'turn_ended');
  process.stdout.write(raw);
}
function request(method, params, timeout = 3000) {
  const id = prefix + (++next);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {owned.delete(key(id)); reject(new Error('cleanup deadline'));}, timeout);
    owned.set(key(id), {resolve, reject, timer});
    send({jsonrpc: '2.0', id, method, params});
  });
}
async function release() {
  if (cleaning) return {released: false, reason: 'already_stopping'};
  cleaning = true;
  try {
    const deadline = Date.now() + 2500;
    while (external.size && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
    if (external.size) return {released: false, reason: 'request_in_flight'};
    if (!scopes.size) return {released: false, reason: 'no_trusted_scope'};
    if (!catalogue) {
      const listed = await request('tools/list', {});
      catalogue = listed?.tools?.find(t => t.name === 'turn_ended');
    }
    const required = catalogue?.inputSchema?.required;
    if (!Array.isArray(required) || !['hook_event_name', 'session_id', 'turn_id'].every(k => required.includes(k))) {
      return {released: false, reason: 'cleanup_tool_unavailable'};
    }
    let count = 0;
    for (const s of scopes.values()) {
      await request('tools/call', {name: 'turn_ended', arguments: {hook_event_name: 'Stop', ...s},
        _meta: {'x-codex-turn-metadata': s}}, 4000);
      count++;
    }
    scopes.clear();
    return {released: true, scopeCount: count};
  } catch {return {released: false, reason: 'cleanup_not_confirmed'};}
  finally {if (!shutdown) cleaning = false;}
}
const server = net.createServer(socket => {
  socket.setTimeout(12_000, () => socket.destroy());
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', async chunk => {
    buffer += chunk;
    if (buffer.length > 1024) {socket.destroy(); return;}
    if (!buffer.includes('\n')) return;
    socket.removeAllListeners('data');
    let m;
    try {m = JSON.parse(buffer);} catch {socket.destroy(); return;}
    if (m.action !== 'release' || m.relayPid !== process.pid || m.rootPid !== process.ppid) {socket.destroy(); return;}
    const result = await release();
    // Remain quiescent after successful cleanup until Portwarden sends the stop signal.
    if (result.released) {shutdown = true; cleaning = true;}
    socket.end(JSON.stringify(result) + '\n');
  });
  socket.on('error', () => {});
});
await new Promise((resolve, reject) => {server.once('error', reject); server.listen(control, resolve);});
await fs.chmod(control, 0o600);
process.stdin.setEncoding('utf8'); child.stdout.setEncoding('utf8');
process.stdin.on('data', chunk => consume(chunk, 'input', receiveInput));
child.stdout.on('data', chunk => consume(chunk, 'output', receiveOutput));
async function stop(signal = 'SIGTERM') {
  if (!stopPromise) stopPromise = (async () => {
    if (!shutdown) await release();
    shutdown = true; cleaning = true;
    child.kill(signal);
  })();
  return stopPromise;
}
process.stdin.on('end', () => {void stop();});
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {void stop(signal);});
child.on('error', () => {process.stderr.write('Portwarden CUA: original runtime unavailable.\n'); void dispose(1);});
child.on('exit', (code, signal) => {void dispose(code ?? (signal ? 1 : 0));});
async function dispose(code) {
  server.close();
  for (const p of owned.values()) {clearTimeout(p.timer); p.reject(new Error('runtime exited'));}
  await fs.rm(directory, {recursive: true, force: true});
  process.exit(code);
}
