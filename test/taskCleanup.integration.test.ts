import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

import {expect, it} from 'vitest';

import {ConfigRepository} from '../src/config.js';
import {PortwardenActions} from '../src/core/actions.js';
import {collectListeners} from '../src/core/listeners.js';
import {collectProcesses} from '../src/core/zombies.js';
import {buildVisibleRows} from '../src/tui/rows.js';

it('terminates a real npm launcher, server, and worker while a separate server sharing their PGID stays alive', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'portwarden-task-integration-'));
  const serverCode = (name: string, child = '') => `
    const fs = require('node:fs');
    const http = require('node:http');
    ${child ? `require('node:child_process').spawn(process.execPath, [${JSON.stringify(child)}], {stdio: 'ignore'});` : ''}
    const server = http.createServer((req, res) => res.end('ok'));
    server.listen(0, '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(`${name}.json`)}, JSON.stringify({pid: process.pid, port: server.address().port})));
  `;
  await Promise.all([
    fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({scripts: {dev: 'node vite-server.cjs'}})),
    fs.writeFile(path.join(directory, 'vite-server.cjs'), serverCode('server', 'worker.cjs')),
    fs.writeFile(path.join(directory, 'worker.cjs'), serverCode('worker')),
    fs.writeFile(path.join(directory, 'other.cjs'), serverCode('other')),
    fs.writeFile(path.join(directory, 'host.cjs'), `
      const {spawn} = require('node:child_process');
      const npm = spawn('npm', ['run', 'dev'], {stdio: 'ignore'});
      spawn(process.execPath, ['other.cjs'], {stdio: 'ignore'});
      require('node:fs').writeFileSync('launcher.json', JSON.stringify({pid: npm.pid}));
    `),
  ]);
  const host = spawn(process.execPath, ['host.cjs'], {cwd: directory, detached: true, stdio: 'ignore'});
  const exited = once(host, 'exit');
  try {
    const ready = async (name: string): Promise<{pid: number; port: number}> => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try { return JSON.parse(await fs.readFile(path.join(directory, `${name}.json`), 'utf8')); } catch { await new Promise((resolve) => setTimeout(resolve, 30)); }
      }
      throw new Error(`Fixture ${name} did not start`);
    };
    const [server, worker, other, launcher] = await Promise.all(['server', 'worker', 'other', 'launcher'].map(ready));
    const all = await collectListeners({strict: true});
    const selected = all.find(({pid}) => pid === server!.pid)!;
    const unrelated = all.find(({pid}) => pid === other!.pid)!;
    expect(selected.task?.root.pid).toBe(launcher!.pid);
    expect(selected.task?.members.map(({pid}) => pid)).toEqual(expect.arrayContaining([server!.pid, worker!.pid, launcher!.pid]));
    expect(selected.pgid).toBe(unrelated.pgid);
    expect(selected.task?.members.some(({pid}) => pid === other!.pid || pid === host.pid)).toBe(false);
    const rows = buildVisibleRows([selected], [], {all: false, expandedGroups: new Set(), pinnedListenerKeys: [], allListeners: all});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({type: 'process'});

    const actions = new PortwardenActions(ConfigRepository.open({configDirectory: path.join(directory, 'config')}));
    await actions.stopListener(selected, 'SIGTERM');
    const remaining = await collectProcesses();
    for (const member of selected.task!.members) expect(remaining.some(({pid}) => pid === member.pid), `PID ${member.pid}`).toBe(false);
    expect(remaining.some(({pid}) => pid === other!.pid)).toBe(true);
    expect((await collectListeners({strict: true})).some(({port}) => port === other!.port)).toBe(true);
  } finally {
    if (host.pid) { try { process.kill(-host.pid, 'SIGKILL'); } catch {} }
    await exited;
    await fs.rm(directory, {recursive: true, force: true});
  }
}, 15000);
