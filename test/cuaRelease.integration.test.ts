import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {expect, it} from 'vitest';
import {releaseCuaTabs} from '../src/core/cuaRelease.js';
import {collectCuaConnections} from '../src/core/cuaConnections.js';
import {collectProcesses} from '../src/core/zombies.js';
import {PortwardenActions} from '../src/core/actions.js';
import {ConfigRepository} from '../src/config.js';

const relay = fileURLToPath(new URL('../scripts/cua-runtime-proxy.mjs', import.meta.url));
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pw-release-'));
  const bin = path.join(dir, '@oai/cua-repl/bin');
  await fs.mkdir(bin, {recursive: true});
  const log = path.join(dir, 'cleanup.jsonl'), native = path.join(dir, 'native.mjs');
  await fs.writeFile(native, `#!/usr/bin/env node
import readline from 'node:readline';
import fs from 'node:fs';
for await (const line of readline.createInterface({input:process.stdin})) {
 const m=JSON.parse(line); let result={};
 if(m.method==='tools/list') result={tools:[{name:'turn_ended',inputSchema:{required:['hook_event_name','session_id','turn_id']}}]};
 if(m.method==='tools/call' && m.params.name==='turn_ended') {
  fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(m.params)+'\\n');
  result={content:[],isError:process.env.FIXTURE_REFUSE==='1'};
 }
 if(m.method==='tools/call' && m.params.name==='js') result={content:[{type:'text',text:m.params.arguments.code}]};
 if(m.method==='tools/call' && m.params.name==='hang') continue;
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
}
`);
  await fs.chmod(native, 0o700);
  const launcher = path.join(bin, 'cua-repl.mjs');
  await fs.writeFile(launcher, `import {spawn} from 'node:child_process';
const c=spawn(process.execPath,[${JSON.stringify(relay)}],{stdio:'inherit',env:process.env});
process.on('SIGTERM',()=>c.kill('SIGTERM')); c.on('exit',code=>process.exit(code??1));
`);
  const start = (extra = {}) => spawn(process.execPath, [launcher], {env: {...process.env,
    PORTWARDEN_CUA_NATIVE_RUNTIME: native, PORTWARDEN_CUA_STATE_DIR: path.join(dir, 'state'), FIXTURE_LOG: log, ...extra}, stdio: ['pipe', 'pipe', 'pipe']});
  return {dir, log, start};
}
function client(p: ChildProcessWithoutNullStreams) {
  let buffer = '', seq = 0;
  const pending = new Map<number, (value: unknown) => void>();
  const lines: Record<string, any>[] = [];
  p.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const m = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); lines.push(m);
      pending.get(m.id)?.(m); pending.delete(m.id);
    }
  });
  const send = (method: string, params: unknown) => {
    const id = ++seq;
    const promise = new Promise<any>(resolve => pending.set(id, resolve));
    p.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');
    return promise;
  };
  return {send, lines};
}
async function stopFixture(p: ChildProcessWithoutNullStreams) {
  if (p.exitCode !== null || p.signalCode !== null) return;
  const done = new Promise<void>(resolve => p.once('exit', () => resolve()));
  p.kill('SIGTERM');
  await Promise.race([done, new Promise(resolve => setTimeout(resolve, 5500))]);
  if (p.exitCode === null && p.signalCode === null) {p.kill('SIGKILL'); await done;}
}
async function candidate(pid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const c = (await collectCuaConnections(await collectProcesses())).find(c => c.pid === pid);
    if (c && c.members.some(m => m.command.includes('cua-runtime-proxy.mjs'))) return c;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('fixture relay not ready');
}
const params = (session_id: string, turn_id: string) => ({name: 'js', arguments: {code: 'original-code'},
  _meta: {'x-codex-turn-metadata': {session_id, turn_id}}});

it('releases the selected runtime before SIGKILL, uses latest trusted scope, and preserves another runtime', async () => {
  const f = await fixture();
  const a = f.start(), b = f.start();
  try {
    const ac = client(a), bc = client(b);
    await ac.send('initialize', {}); await ac.send('tools/list', {});
    await ac.send('tools/call', params('selected', 'old'));
    await ac.send('tools/call', params('selected', 'latest'));
    await bc.send('tools/call', params('other', 'untouched'));
    const c = await candidate(a.pid!);
    const actions = new PortwardenActions(ConfigRepository.open({configDirectory: path.join(f.dir, 'config')}), {
      releaseCuaTabs: c => releaseCuaTabs(c, path.join(f.dir, 'state')),
    });
    const outcome = await actions.stopCua(c, 'SIGKILL');
    expect(outcome.cuaCleanup).toEqual({released: true, scopeCount: 1});
    const cleanups = (await fs.readFile(f.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(cleanups).toHaveLength(1);
    expect(cleanups[0]).toEqual({name: 'turn_ended', arguments: {hook_event_name: 'Stop', session_id: 'selected', turn_id: 'latest'},
      _meta: {'x-codex-turn-metadata': {session_id: 'selected', turn_id: 'latest'}}});
    expect(ac.lines.some(m => typeof m.id === 'string' && m.id.startsWith('portwarden-cleanup-'))).toBe(false);
    expect((await bc.send('tools/call', params('other', 'still-works'))).result.content[0].text).toBe('original-code');
  } finally {await stopFixture(a); await stopFixture(b); await fs.rm(f.dir, {recursive: true, force: true, maxRetries: 3});}
}, 20_000);

it.each(['missing-context', 'refused-cleanup'])('does not claim cleanup success for %s', async mode => {
  const f = await fixture(), a = f.start(mode === 'refused-cleanup' ? {FIXTURE_REFUSE: '1'} : {});
  try {
    const c = client(a);
    await c.send('tools/list', {});
    await c.send('tools/call', mode === 'missing-context' ? {name: 'js', arguments: {code: 'original-code'}} : params('selected', 'turn'));
    expect((await releaseCuaTabs(await candidate(a.pid!), path.join(f.dir, 'state'))).released).toBe(false);
  } finally {await stopFixture(a); await fs.rm(f.dir, {recursive: true, force: true, maxRetries: 3});}
}, 10_000);
