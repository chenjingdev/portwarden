import open from 'open';

import {sanitizeText} from './core/commands.js';

export interface BrowserTarget {
  host: string;
  port: number;
  commandLine?: string;
}

export function buildBrowserUrl(target: BrowserTarget): string {
  const host = normalizeBrowserHost(target.host);
  const command = sanitizeText(target.commandLine).toLowerCase();
  const protocol = /(^|\s)(--https|https:\/\/|ssl|tls|certificate|cert=)/.test(command) ? 'https' : 'http';
  return `${protocol}://${formatUrlHost(host)}:${target.port}`;
}

export async function openInBrowser(target: BrowserTarget, browser = ''): Promise<string> {
  const url = buildBrowserUrl(target);
  const name = sanitizeText(browser);
  if (name) {
    await open(url, {app: {name}});
  } else {
    await open(url);
  }
  return url;
}

function normalizeBrowserHost(host: string): string {
  const normalized = sanitizeText(host).replace(/^\[|\]$/g, '');
  if (!normalized || normalized === '*' || normalized === '0.0.0.0' || normalized === '::' || normalized === '::1' || normalized === '127.0.0.1') {
    return 'localhost';
  }
  return normalized;
}

function formatUrlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}
