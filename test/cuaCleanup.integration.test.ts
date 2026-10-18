import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';

import {expect, it} from 'vitest';

import {ConfigRepository} from '../src/config.js';
import {PortwardenActions} from '../src/core/actions.js';
import {collectCuaConnections} from '../src/core/cuaConnections.js';
import {collectProcesses} from '../src/core/zombies.js';

it.each([1, 2])('disconnects %i real fixture runtime(s) and helpers while parent and sibling survive', async (count) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'portwarden-cua-integration-'));
  const bin = path.join(directory, '@oai/cua-repl/bin');
  await fs.mkdir(bin, {recursive: true});
  const runtimePath = path.join(bin, 'cua-repl.mjs');
  const readyPaths = Array.from({length: count}, (_, index) => path.join(directory, `ready-${index}.json`));
  await fs.writeFile(runtimePath, `
    import {spawn} from 'node:child_process';
    import fs from 'node:fs';
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
    const timer = setInterval(() => {}, 1000);
    process.on('SIGTERM', () => {child.kill('SIGTERM'); clearInterval(timer);});
    fs.writeFileSync(process.argv[2], JSON.stringify({pid: process.pid, child: child.pid}));
  `);
  const sibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
  const runtimes = readyPaths.map((readyPath) => spawn(process.execPath, [runtimePath, readyPath], {stdio: 'ignore'}));
  const helperPids: number[] = [];
  try {
    for (const readyPath of readyPaths) {
      let ready: {pid: number; child: number} | undefined;
      const deadline = Date.now() + 5000;
      while (!ready && Date.now() < deadline) {
        try {ready = JSON.parse(await fs.readFile(readyPath, 'utf8'));} catch {await new Promise((resolve) => setTimeout(resolve, 30));}
      }
      expect(ready).toBeDefined();
      helperPids.push(ready!.child);
    }
    const connections = await collectCuaConnections(await collectProcesses());
    const selected = runtimes.map((runtime) => connections.find(({pid}) => pid === runtime.pid)!);
    expect(selected.flatMap(({members}) => members.map(({pid}) => pid))).toEqual(expect.arrayContaining(helperPids));
    const actions = new PortwardenActions(ConfigRepository.open({configDirectory: path.join(directory, 'config')}));
    if (count === 1) await expect(actions.stopCua(selected[0]!, 'SIGTERM')).resolves.toMatchObject({pid: runtimes[0]!.pid});
    else await expect(actions.stopCuaGroup(selected, 'SIGTERM')).resolves.toMatchObject({message: expect.stringContaining('2/2')});
    const alive = new Set((await collectProcesses()).map(({pid}) => pid));
    for (const runtime of runtimes) expect(alive.has(runtime.pid!)).toBe(false);
    for (const helperPid of helperPids) expect(alive.has(helperPid)).toBe(false);
    expect(alive.has(sibling.pid!)).toBe(true);
    expect(alive.has(process.pid)).toBe(true);
  } finally {
    for (const runtime of runtimes) runtime.kill('SIGKILL');
    sibling.kill('SIGKILL');
    for (const helperPid of helperPids) {try {process.kill(helperPid, 'SIGKILL');} catch { /* exited */ }}
    await fs.rm(directory, {recursive: true, force: true});
  }
}, 20_000);
