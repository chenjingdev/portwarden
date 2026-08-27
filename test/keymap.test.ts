import {describe, expect, it} from 'vitest';

import {normalizeShortcut} from '../src/tui/keymap.js';

describe('normalizeShortcut', () => {
  it.each([
    ['A', 'a'],
    ['?', '?'],
    ['ㅁ', 'a'],
    ['ㅃ', 'q'],
    ['ㅒ', 'o'],
    ['ㅖ', 'p'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeShortcut(input)).toBe(expected);
  });

  it('preserves j and k as ordinary unsupported shortcuts', () => {
    expect(normalizeShortcut('j')).toBe('j');
    expect(normalizeShortcut('k')).toBe('k');
  });

  it('does not treat a pasted text chunk as an action', () => {
    expect(normalizeShortcut('qrm')).toBe('');
  });

  it('does not turn navigation keys into shortcuts', () => {
    expect(normalizeShortcut('a', {upArrow: true})).toBe('');
    expect(normalizeShortcut('\u001b[A')).toBe('');
  });

  it('normalizes control bytes for explicit control handling', () => {
    expect(normalizeShortcut('\u0003', {ctrl: true})).toBe('c');
    expect(normalizeShortcut('\u000c', {ctrl: true})).toBe('l');
  });
});
