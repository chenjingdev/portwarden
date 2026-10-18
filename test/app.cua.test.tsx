import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {cleanup, render} from 'ink-testing-library';
import React from 'react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';

import {ConfigRepository} from '../src/config.js';
import {PortwardenActions} from '../src/core/actions.js';
import {detectCuaConnections} from '../src/core/cuaConnections.js';
import type {CuaConnection} from '../src/core/types.js';
import {PortwardenApp} from '../src/tui/App.js';

const scanner = vi.hoisted(() => ({allListeners: [], listeners: [], browsers: [], zombies: [], cua: [] as CuaConnection[], loading: false, refreshing: false, error: '', updatedAt: new Date(), refresh: vi.fn()}));
vi.mock('../src/tui/useScanner.js', () => ({useScanner: () => scanner}));
let directory = '';
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portwarden-cua-ui-'));
  scanner.cua = detectCuaConnections([
    {pid: 600, ppid: 1, uid: process.getuid!(), name: 'claude', command: '/bin/claude', executable: '/bin/claude', startTime: new Date()},
    {pid: 601, ppid: 600, uid: process.getuid!(), name: 'python', command: 'python /test/claude-computer-use-plugin/mcp_stdio.py', executable: '/bin/python', startTime: new Date()},
  ]).map((entry) => ({...entry, cwd: '/dev/example', sessionId: 'session-example'}));
});
afterEach(() => {cleanup(); vi.restoreAllMocks(); fs.rmSync(directory, {recursive: true, force: true});});
const tick = () => new Promise((resolve) => setTimeout(resolve, 100));

it('shows a portless connection, details, and sends x to the CUA action instead of a parent listener', async () => {
  const stop = vi.spyOn(PortwardenActions.prototype, 'stopCua').mockResolvedValue({message: 'CUA disconnected'});
  const stopListener = vi.spyOn(PortwardenActions.prototype, 'stopListener');
  const config = ConfigRepository.open({configDirectory: directory});
  config.update({confirmActions: true});
  const app = render(<PortwardenApp configRepository={config} />);
  await tick();
  expect(app.lastFrame()).toContain('Claude CUA');
  expect(app.lastFrame()).toContain('session-example');
  expect(app.lastFrame()).toContain('tab owner unknown');
  app.stdin.write('x'); await tick();
  expect(app.lastFrame()).toContain('parent agent stays running');
  expect(stop).not.toHaveBeenCalled();
  app.stdin.write('y'); await tick();
  expect(stop).toHaveBeenCalledWith(scanner.cua[0], 'SIGTERM');
  expect(stopListener).not.toHaveBeenCalled();
});

it('blocks x on a shared transport', async () => {
  scanner.cua = [{...scanner.cua[0]!, agent: 'Shared', provider: 'chrome-extension', canStop: false}];
  const stop = vi.spyOn(PortwardenActions.prototype, 'stopCua');
  const app = render(<PortwardenApp configRepository={ConfigRepository.open({configDirectory: directory})} />);
  await tick(); app.stdin.write('x'); await tick();
  expect(app.lastFrame()).toContain('Shared CUA service');
  expect(stop).not.toHaveBeenCalled();
});

it('shows no-connection runtimes by default and optionally hides them with c', async () => {
  scanner.cua = scanner.cua.map((entry) => ({...entry, transportState: 'not-observed'}));
  const app = render(<PortwardenApp configRepository={ConfigRepository.open({configDirectory: directory})} />);
  await tick();
  expect(app.lastFrame()).toContain('runtimes shown');
  expect(app.lastFrame()).toContain('session-example');
  expect(app.lastFrame()).toContain('runtime only');
  app.stdin.write('c'); await tick();
  expect(app.lastFrame()).toContain('runtimes hidden');
  expect(app.lastFrame()).not.toContain('session-example');
});

it('expands an agent group and bulk-stops a collapsed all-CUA group while excluding shared services', async () => {
  const original = scanner.cua[0]!;
  scanner.cua = [original, {...original, pid: 602, members: [{...original.members[0]!, pid: 602}]},
    {...original, pid: 900, agent: 'Shared', canStop: false, members: [{...original.members[0]!, pid: 900}]}];
  const bulk = vi.spyOn(PortwardenActions.prototype, 'stopCuaGroup').mockResolvedValue({message: 'Stopped 2/2 CUA connections'});
  const single = vi.spyOn(PortwardenActions.prototype, 'stopCua');
  const config = ConfigRepository.open({configDirectory: directory});
  config.update({confirmActions: true});
  const app = render(<PortwardenApp configRepository={config} />);
  await tick();
  expect(app.lastFrame()).toContain('> All CUA');
  app.stdin.write('\r'); await tick();
  expect(app.lastFrame()).toContain('> Claude CUA');
  app.stdin.write('\u001B[B'); await tick(); app.stdin.write('\r'); await tick();
  app.stdin.write('\u001B[B'); await tick();
  expect(app.lastFrame()).toContain('session-example');
  app.stdin.write('\u001B[A'); await tick(); app.stdin.write('\u001B[A'); await tick(); app.stdin.write('\u001B[D'); await tick();
  app.stdin.write('x'); await tick();
  expect(app.lastFrame()).toContain('2 connections');
  expect(bulk).not.toHaveBeenCalled();
  app.stdin.write('y'); await tick();
  expect(bulk.mock.calls[0]?.[0].map(({pid}) => pid)).toEqual([601, 602]);
  expect(single).not.toHaveBeenCalled();
});
