export function padDisplayText(value: string, width: number): string {
  const text = truncateDisplayText(value, width);
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

export function truncateDisplayText(value: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(value) <= width) return value;
  if (width === 1) return '…';
  const target = width - 1;
  let result = '';
  let used = 0;
  for (const character of value) {
    const characterWidth = displayCharacterWidth(character);
    if (used + characterWidth > target) break;
    result += character;
    used += characterWidth;
  }
  return `${result}…`;
}

function displayWidth(value: string): number {
  let width = 0;
  for (const character of value) width += displayCharacterWidth(character);
  return width;
}

function displayCharacterWidth(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f || codePoint === 0x2329 || codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) ? 2 : 1;
}
