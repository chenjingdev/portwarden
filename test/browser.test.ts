import {describe, expect, it} from 'vitest';

import {buildBrowserUrl} from '../src/browser.js';

describe('buildBrowserUrl', () => {
  it.each(['*', '0.0.0.0', '::', '::1', '127.0.0.1'])('opens wildcard and loopback host %s through localhost', (host) => {
    expect(buildBrowserUrl({host, port: 3000})).toBe('http://localhost:3000');
  });

  it('brackets IPv6 hosts and infers explicit HTTPS servers', () => {
    expect(buildBrowserUrl({host: 'fe80::1', port: 8443, commandLine: 'vite --https'})).toBe('https://[fe80::1]:8443');
  });
});
