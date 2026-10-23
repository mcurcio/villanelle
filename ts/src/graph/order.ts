/**
 * Compare two strings by Unicode code point, the one include ordering both languages share (vil-bgz.1).
 * Unlike `<` on JS strings (UTF-16 code units) and localeCompare (locale-dependent), it agrees with Python's
 * default str ordering. Returns a negative number, 0 or a positive number.
 */
export function compareCodePoints(a: string, b: string): number {
  // Up to the first difference both strings hold the same code units, so one index walks both.
  for (let i = 0; i < a.length && i < b.length; ) {
    const x = a.codePointAt(i) ?? 0;
    const y = b.codePointAt(i) ?? 0;
    if (x !== y) return x - y;
    i += x > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}
