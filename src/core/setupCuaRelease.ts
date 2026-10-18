import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const begin = '# BEGIN Portwarden CUA release';
const end = '# END Portwarden CUA release';
function toml(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return '[' + value.map(toml).join(', ') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).map(([k, v]) => `${JSON.stringify(k)} = ${toml(v)}`).join(', ') + '}';
  throw new Error('Unsupported CUA configuration value.');
}

/** User config override, never modification of a bundled plugin cache. */
export async function setupCuaRelease(options: {home?: string; nativeConfig?: string; relayPath?: string; remove?: boolean} = {}): Promise<string> {
  const home = options.home ?? os.homedir();
  const config = path.join(home, '.codex/config.toml');
  const configInfo = await fs.lstat(config);
  if (!configInfo.isFile() || configInfo.uid !== process.getuid?.()) throw new Error('Codex config must be a regular file owned by this user. No configuration changed.');
  const original = await fs.readFile(config, 'utf8');
  const own = new RegExp(`\\n?${begin}[\\s\\S]*?${end}\\n?`, 'g');
  const without = original.replace(own, '');
  if (/^\s*\[\s*mcp_servers\s*\.\s*["']?cua_repl["']?\s*(?:\.|\])/m.test(without) ||
      /^\s*mcp_servers\s*=/m.test(without) || /^\s*cua_repl\s*=/m.test(without)) {
    throw new Error('An existing CUA MCP override was found. It was not replaced.');
  }
  let next = without;
  if (!options.remove) {
    const cache = path.join(home, '.codex/plugins/cache/openai-bundled/unified-computer-use');
    const versions = options.nativeConfig ? [] : (await fs.readdir(cache, {withFileTypes: true}))
      .filter(entry => entry.isDirectory() && /^\d+(?:\.\d+)*$/.test(entry.name)).map(entry => entry.name)
      .sort((a, b) => b.localeCompare(a, 'en', {numeric: true}));
    const nativeConfig = options.nativeConfig ?? path.join(cache, versions[0] ?? 'missing', '.mcp.json');
    const data = JSON.parse(await fs.readFile(nativeConfig, 'utf8'));
    const server = data.mcpServers?.cua_repl;
    if (!server || typeof server.command !== 'string' || !Array.isArray(server.args) || typeof server.env?.CUA_REPL_NODE_REPL_PATH !== 'string') {
      throw new Error('The original bundled CUA transport was not found. No configuration changed.');
    }
    let relay = options.relayPath ?? fileURLToPath(new URL('../scripts/cua-runtime-proxy.mjs', import.meta.url));
    if (!options.relayPath && !await fs.stat(relay).catch(() => null)) relay = fileURLToPath(new URL('../../scripts/cua-runtime-proxy.mjs', import.meta.url));
    const relayInfo = await fs.stat(relay);
    if (!relayInfo.isFile() || relayInfo.mode & 0o022) throw new Error('The CUA relay must be a regular file without group/other write access.');
    server.env = {...server.env, PORTWARDEN_CUA_NATIVE_RUNTIME: server.env.CUA_REPL_NODE_REPL_PATH, CUA_REPL_NODE_REPL_PATH: relay};
    // Dynamic source paths are copied from the installed native transport unchanged.
    const lines = Object.entries(server).map(([key, value]) => `${JSON.stringify(key)} = ${toml(value)}`);
    next = without.trimEnd() + `\n\n${begin}\n[mcp_servers.cua_repl]\n${lines.join('\n')}\n${end}\n`;
  }
  if (next === original) return 'CUA release configuration is unchanged.';
  const backups = path.join(home, '.codex/backups/portwarden-cua');
  await fs.mkdir(backups, {recursive: true, mode: 0o700});
  await fs.writeFile(path.join(backups, `config-${Date.now()}.toml`), original, {mode: 0o600, flag: 'wx'});
  // Refuse a concurrent config update instead of silently overwriting it.
  if (await fs.readFile(config, 'utf8') !== original) throw new Error('Codex configuration changed during setup. Retry after it settles.');
  const temp = `${config}.portwarden-${process.pid}`;
  await fs.writeFile(temp, next, {mode: 0o600, flag: 'wx'});
  await fs.rename(temp, config);
  return options.remove ? 'Removed the Portwarden CUA override. Restart the CUA connection to apply.' :
    'Installed CUA release before process stop. Restart Codex once to apply it to new CUA connections.';
}
