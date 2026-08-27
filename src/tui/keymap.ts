/** Same physical shortcut keys when a Korean 두벌식 input source is active. */
export const DUBEOLSIK_POSITION_ALIASES: ReadonlyMap<string, string> = new Map([
  ['ㅁ', 'a'],
  ['ㄴ', 's'],
  ['ㅂ', 'q'],
  ['ㅃ', 'q'],
  ['ㅐ', 'o'],
  ['ㅒ', 'o'],
  ['ㅔ', 'p'],
  ['ㅖ', 'p'],
  ['ㅡ', 'm'],
  ['ㅌ', 'x'],
  ['ㄹ', 'f'],
  ['ㅎ', 'g'],
  ['ㅋ', 'z'],
  ['ㄱ', 'r'],
  ['ㅇ', 'd'],
]);

export interface ShortcutKeyDescriptor {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  return?: boolean;
  escape?: boolean;
  backspace?: boolean;
  delete?: boolean;
  tab?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

/**
 * Return one shortcut character, or an empty string for navigation, control,
 * text chunks, and other input that must never accidentally trigger an action.
 */
export function normalizeShortcut(input: string, key: ShortcutKeyDescriptor = {}): string {
  if (
    key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.return || key.escape ||
    key.backspace || key.delete || key.tab || key.meta
  ) {
    return '';
  }
  if (input === '\u0003') return 'c';
  if (input === '\u000c') return 'l';
  if (input === '\u0015') return 'u';

  const normalized = input.normalize('NFKC');
  if (Array.from(normalized).length !== 1 || /[\u0000-\u001F\u007F]/.test(normalized)) {
    return '';
  }
  const lowered = normalized.toLocaleLowerCase('en-US');
  return DUBEOLSIK_POSITION_ALIASES.get(input) ?? DUBEOLSIK_POSITION_ALIASES.get(lowered) ?? lowered;
}
