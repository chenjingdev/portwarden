import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {it,expect} from 'vitest';
import {setupCuaRelease} from '../src/core/setupCuaRelease.js';
it('preserves other configuration, backs it up privately, and removes only its own override',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'pw-setup-cua-'));
 try{
  await fs.mkdir(path.join(home,'.codex'));
  const original='model = "original"\n[mcp_servers.unrelated]\ncommand = "keep-this"\n';
  await fs.writeFile(path.join(home,'.codex/config.toml'),original);
  const native=path.join(home,'native.json'),relay=path.join(home,'relay.mjs');
  await fs.writeFile(relay,'fixture',{mode:0o700});
  await fs.writeFile(native,JSON.stringify({mcpServers:{cua_repl:{command:'/original/node',args:['/original/cua-repl.mjs'],env:{CUA_REPL_NODE_REPL_PATH:'/original/node_repl',OTHER:'unchanged'}}}}));
  await setupCuaRelease({home,nativeConfig:native,relayPath:relay});
  const installed=await fs.readFile(path.join(home,'.codex/config.toml'),'utf8');
  expect(installed).toContain(original.trim());expect(installed).toContain('PORTWARDEN_CUA_NATIVE_RUNTIME');
  expect(installed).toContain('"OTHER" = "unchanged"');
  const backupdir=path.join(home,'.codex/backups/portwarden-cua');
  const backups=await fs.readdir(backupdir);
  expect(await fs.readFile(path.join(backupdir,backups[0]!),'utf8')).toBe(original);
  expect((await fs.stat(path.join(backupdir,backups[0]!))).mode&0o077).toBe(0);
  await setupCuaRelease({home,remove:true});
  expect((await fs.readFile(path.join(home,'.codex/config.toml'),'utf8')).trim()).toBe(original.trim());
  await fs.writeFile(path.join(home,'.codex/config.toml'),original+'\n[mcp_servers.cua_repl]\ncommand="custom"\n');
  await expect(setupCuaRelease({home,nativeConfig:native,relayPath:relay})).rejects.toThrow('not replaced');
 }finally{await fs.rm(home,{recursive:true,force:true});}
});
