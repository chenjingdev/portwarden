import fs from 'node:fs';

import {parse} from 'shell-quote';
import stripAnsi from 'strip-ansi';

export interface CommandSnapshot {
  argv: string[];
  env: Record<string, string>;
}

const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g;
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/;
const SENSITIVE_NAME = /(token|secret|password|passwd|api[_-]?key|private[_-]?key|credential|authorization|proxy[_-]?authorization|cookie|session|access[_-]?key|auth)/i;
const CREDENTIAL_URI = /\b[a-z][a-z\d+.-]*:\/\/[^/@\s]+@/i;
const CREDENTIAL_URI_GLOBAL = /\b([a-z][a-z\d+.-]*:\/\/)[^/@\s]+@/gi;
const SENSITIVE_HEADER = /^\s*(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)\s*[:=]\s*/i;
const BEARER_OR_BASIC_VALUE = /\b(?:bearer|basic)\s+[a-z\d._~+/=-]+/i;
const HEADER_VALUE_FLAGS = new Set(['-H', '--header', '--proxy-header', '--request-header']);
const SHELL_EXECUTABLES = new Set([
  'bash',
  'cmd',
  'cmd.exe',
  'csh',
  'dash',
  'env',
  'fish',
  'ksh',
  'powershell',
  'powershell.exe',
  'pwsh',
  'sh',
  'sudo',
  'doas',
  'tcsh',
  'zsh',
]);
const CODE_LOADING_ENVIRONMENT = /^(?:BASH_ENV|ENV|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|RUBYOPT|RUBYLIB|PERL5OPT|PERL5LIB|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS)$/i;

export function sanitizeText(value: unknown): string {
  return stripAnsi(String(value ?? ''))
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseCommandSnapshot(commandLine: string): CommandSnapshot | null {
  const command = String(commandLine || '').trim();
  if (!command || command.length > 32_768 || /[\r\n\u0000]/.test(command)) {
    return null;
  }

  let parsed: unknown[];
  try {
    parsed = parse(command, () => ({unsafeExpansion: true}));
  } catch {
    return null;
  }

  if (parsed.length === 0 || parsed.some((part) => typeof part !== 'string')) {
    return null;
  }

  const tokens = [...(parsed as string[])];
  if (tokens.length === 0 || tokens.some((token) => !token || /[\u0000-\u001F\u007F-\u009F]/.test(token))) {
    return null;
  }

  const env: Record<string, string> = {};
  while (tokens.length > 1) {
    const assignment = ENV_ASSIGNMENT.exec(tokens[0] ?? '');
    if (!assignment) {
      break;
    }
    env[assignment[1] ?? ''] = assignment[2] ?? '';
    tokens.shift();
  }

  if (tokens.length === 0) {
    return null;
  }

  tokens[0] = repairExecutableWithSpaces(tokens);
  return {argv: tokens, env};
}

export function isSnapshotPersistable(snapshot: CommandSnapshot): boolean {
  if (!isStructurallySafeSnapshot(snapshot)) {
    return false;
  }

  if (Object.entries(snapshot.env).some(([key, value]) =>
    SENSITIVE_NAME.test(key) || containsCredentialMaterial(value),
  )) return false;

  for (let index = 0; index < snapshot.argv.length; index += 1) {
    const token = snapshot.argv[index] ?? '';
    if (containsCredentialMaterial(token) || isSensitiveFlag(token)) return false;
    if (HEADER_VALUE_FLAGS.has(token) && containsCredentialMaterial(snapshot.argv[index + 1] ?? '')) return false;
    const inlineHeader = inlineHeaderValue(token);
    if (inlineHeader !== null && containsCredentialMaterial(inlineHeader)) return false;
  }
  return true;
}

/** A persistable snapshot can still be unsafe to execute (for example `sh -c`). */
export function isSnapshotReplaySafe(snapshot: CommandSnapshot): boolean {
  if (!isSnapshotPersistable(snapshot)) return false;
  if (Object.keys(snapshot.env).some((key) => CODE_LOADING_ENVIRONMENT.test(key))) return false;

  const executable = executableName(snapshot.argv[0] ?? '');
  if (!executable || SHELL_EXECUTABLES.has(executable)) return false;

  const flags = leadingInterpreterFlags(snapshot.argv);
  if ((executable === 'node' || executable === 'nodejs' || executable === 'bun') &&
    ['-e', '--eval', '-p', '--print', '-r', '--require', '--import'].some((flag) =>
      flags.some((argument) => matchesInterpreterFlag(argument, flag)),
    )) {
    return false;
  }
  if ((executable === 'python' || executable === 'python3' || executable === 'ruby' || executable === 'perl' || executable === 'php') &&
    ['-c', '-e', '-r'].some((flag) => flags.some((argument) => matchesInterpreterFlag(argument, flag)))) {
    return false;
  }
  return true;
}

export function formatCommandForDisplay(snapshot: CommandSnapshot): string {
  const redactedEnvironment = Object.entries(snapshot.env).map(([key, value]) =>
    `${key}=${SENSITIVE_NAME.test(key) || containsCredentialMaterial(value) ? '<redacted>' : redactSensitiveValue(value)}`,
  );
  const argv = [...snapshot.argv];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (isSensitiveFlag(token)) {
      if (token.includes('=')) {
        argv[index] = `${token.slice(0, token.indexOf('=') + 1)}<redacted>`;
      } else if (argv[index + 1]) {
        argv[index + 1] = '<redacted>';
      }
    } else if (HEADER_VALUE_FLAGS.has(token) && argv[index + 1]) {
      argv[index + 1] = redactSensitiveValue(argv[index + 1] ?? '');
    } else {
      const inlineHeader = inlineHeaderValue(token);
      argv[index] = inlineHeader === null
        ? redactSensitiveValue(token)
        : `${token.slice(0, token.length - inlineHeader.length)}${redactSensitiveValue(inlineHeader)}`;
    }
  }
  return sanitizeText([...redactedEnvironment, ...argv].join(' '));
}

export function redactCommandLine(commandLine: string): string {
  const snapshot = parseCommandSnapshot(commandLine);
  if (snapshot) {
    return formatCommandForDisplay(snapshot);
  }
  return redactSensitiveValue(sanitizeText(commandLine))
    .replace(/((?:token|secret|password|passwd|api[_-]?key|authorization|cookie|session|access[_-]?key|auth)\s*[=:]\s*)\S+/gi, '$1<redacted>')
    .replace(/((?:--?)[^\s=]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|session|access[_-]?key|auth)[^\s=]*(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi, '$1<redacted>');
}

function isStructurallySafeSnapshot(snapshot: CommandSnapshot): boolean {
  if (!Array.isArray(snapshot.argv) || snapshot.argv.length === 0 || snapshot.argv.length > 1_024) return false;
  if (snapshot.argv.some((token) => typeof token !== 'string' || !token || token.length > 32_768 || UNSAFE_CONTROL_CHARACTERS.test(token))) {
    return false;
  }
  return Object.entries(snapshot.env).every(([key, value]) =>
    ENV_ASSIGNMENT.test(`${key}=`) && value.length <= 32_768 && !UNSAFE_CONTROL_CHARACTERS.test(value),
  );
}

function containsCredentialMaterial(value: string): boolean {
  return CREDENTIAL_URI.test(value) || SENSITIVE_HEADER.test(value) || BEARER_OR_BASIC_VALUE.test(value) ||
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value) && SENSITIVE_NAME.test(value.slice(0, value.indexOf('='))));
}

function isSensitiveFlag(token: string): boolean {
  if (!/^--?/.test(token)) return false;
  return SENSITIVE_NAME.test(token.slice(0, Math.max(0, token.indexOf('=') >= 0 ? token.indexOf('=') : token.length)));
}

function inlineHeaderValue(token: string): string | null {
  for (const flag of HEADER_VALUE_FLAGS) {
    if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
    if (flag === '-H' && token.startsWith(flag) && token.length > flag.length) return token.slice(flag.length);
  }
  return null;
}

function redactSensitiveValue(value: string): string {
  const header = SENSITIVE_HEADER.exec(value);
  if (header) return `${value.slice(0, header[0].length)}<redacted>`;
  return value
    .replace(CREDENTIAL_URI_GLOBAL, '$1<redacted>@')
    .replace(/\b((?:proxy-)?authorization|cookie|set-cookie|x-api-key|api-key)(\s*[:=]\s*)(?:(?:bearer|basic)\s+)?[^,\s]+/gi, '$1$2<redacted>')
    .replace(/\b(?:bearer|basic)\s+[a-z\d._~+/=-]+/gi, '<redacted>');
}

function executableName(file: string): string {
  return file.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
}

function leadingInterpreterFlags(argv: readonly string[]): string[] {
  const result: string[] = [];
  for (const argument of argv.slice(1)) {
    if (!argument.startsWith('-') || argument === '--') break;
    result.push(argument);
  }
  return result;
}

function matchesInterpreterFlag(argument: string, flag: string): boolean {
  return argument === flag || argument.startsWith(`${flag}=`) || (flag.length === 2 && argument.startsWith(flag));
}

function repairExecutableWithSpaces(tokens: string[]): string {
  const first = tokens[0] ?? '';
  if (!first.startsWith('/') || fs.existsSync(first)) {
    return first;
  }

  for (let end = Math.min(tokens.length, 10); end > 1; end -= 1) {
    const candidate = tokens.slice(0, end).join(' ');
    try {
      if (fs.statSync(candidate).isFile()) {
        tokens.splice(0, end, candidate);
        return candidate;
      }
    } catch {
      // Keep trying shorter prefixes. A failed stat must never make a snapshot unsafe.
    }
  }

  return first;
}

export function rewriteCommandPort(snapshot: CommandSnapshot, newPort: number): CommandSnapshot | null {
  if (!isSnapshotReplaySafe(snapshot) || !Number.isInteger(newPort) || newPort < 1 || newPort > 65_535) {
    return null;
  }

  const argv = [...snapshot.argv];
  const env = {...snapshot.env};
  const port = String(newPort);
  const identity = commandIdentity(snapshot);

  if (Object.hasOwn(env, 'PORT')) {
    env.PORT = port;
    return {argv, env};
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (/^--port=\d+$/.test(token)) {
      argv[index] = `--port=${port}`;
      return {argv, env};
    }
    if (identity === 'next' && /^-p=\d+$/.test(token)) {
      argv[index] = `-p=${port}`;
      return {argv, env};
    }
    if (token === '--port' && /^\d+$/.test(argv[index + 1] ?? '')) {
      argv[index + 1] = port;
      return {argv, env};
    }
    if (identity === 'next' && token === '-p' && /^\d+$/.test(argv[index + 1] ?? '')) {
      argv[index + 1] = port;
      return {argv, env};
    }
    if (identity === 'http.server' && token === 'http.server' && /^\d+$/.test(argv[index + 1] ?? '')) {
      argv[index + 1] = port;
      return {argv, env};
    }
    if (identity === 'php' && token === '-S' && /^[^\s:]+:\d+$/.test(argv[index + 1] ?? '')) {
      argv[index + 1] = String(argv[index + 1]).replace(/:\d+$/, `:${port}`);
      return {argv, env};
    }
  }

  if (identity === 'next') {
    argv.push('-p', port);
    return {argv, env};
  }
  if (identity === 'http.server') {
    argv.push(port);
    return {argv, env};
  }
  if (identity && new Set(['vite', 'astro', 'nuxt', 'storybook', 'webpack', 'parcel', 'uvicorn', 'flask']).has(identity)) {
    argv.push('--port', port);
    return {argv, env};
  }
  if (identity === 'rails') {
    env.PORT = port;
    return {argv, env};
  }

  return null;
}

function commandIdentity(snapshot: CommandSnapshot): string {
  const executable = executableName(snapshot.argv[0] ?? '').replace(/\.(?:cmd|exe)$/i, '');
  if (new Set(['vite', 'astro', 'nuxt', 'storybook', 'webpack', 'webpack-dev-server', 'parcel', 'uvicorn', 'flask', 'next', 'rails', 'php']).has(executable)) {
    return executable === 'webpack-dev-server' ? 'webpack' : executable;
  }
  if ((executable === 'python' || executable === 'python3') && snapshot.argv.some((token, index) => token === '-m' && snapshot.argv[index + 1] === 'http.server')) {
    return 'http.server';
  }
  if (executable === 'node' || executable === 'nodejs' || executable === 'ruby') {
    const script = snapshot.argv.slice(1).find((token) => token && !token.startsWith('-'))?.toLowerCase().replace(/\\/g, '/') ?? '';
    const patterns: Array<[RegExp, string]> = [
      [/(?:^|\/)vite(?:\/bin\/vite(?:\.js)?|\.js)$/, 'vite'],
      [/(?:^|\/)next(?:\/dist\/bin\/next|\.js)$/, 'next'],
      [/(?:^|\/)astro(?:\/astro\.js|\.js)$/, 'astro'],
      [/(?:^|\/)nuxt(?:\/bin\/nuxt\.mjs|\.mjs|\.js)$/, 'nuxt'],
      [/(?:^|\/)storybook(?:\/bin\/index\.cjs|\.cjs|\.js)$/, 'storybook'],
      [/(?:^|\/)webpack(?:-dev-server)?(?:\/bin\/[^/]+|\.js)$/, 'webpack'],
      [/(?:^|\/)parcel(?:\/lib\/bin\.js|\.js)$/, 'parcel'],
      [/(?:^|\/)rails$/, 'rails'],
    ];
    return patterns.find(([pattern]) => pattern.test(script))?.[1] ?? '';
  }
  return '';
}

export function normalizeCommandForComparison(snapshot: CommandSnapshot): string {
  return snapshot.argv
    .map((token, index, argv) => {
      if (/^(--port=|-p=)\d+$/.test(token)) {
        return token.replace(/\d+$/, '<port>');
      }
      if ((argv[index - 1] === '--port' || argv[index - 1] === '-p' || argv[index - 1] === 'http.server') && /^\d+$/.test(token)) {
        return '<port>';
      }
      if (/^PORT=\d+$/.test(token)) return 'PORT=<port>';
      if (argv[index - 1] === '-S' && /^[^\s:]+:\d+$/.test(token)) return token.replace(/:\d+$/, ':<port>');
      return token;
    })
    .join('\u0000');
}
