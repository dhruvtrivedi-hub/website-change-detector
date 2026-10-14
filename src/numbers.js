// Parses the first number in a piece of text, the way a person would read it.
// Handles currency symbols, thousands separators (1,299.00 / 1.299,00 / 1 299,00 / 1'299.00),
// decimals, percentages and a leading minus. Returns null when there is no number.

const TOKEN =
  /(?:(?<![\p{L}\p{N}])[-\u2212])?(?:\d{1,3}(?:[,.\s\u00a0\u202f'\u2019]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)/u;

function toNumber(token) {
  const neg = /^[-\u2212]/.test(token);
  const s = token.replace(/^[-\u2212]/, '').replace(/[\s\u00a0\u202f'\u2019]/g, '');
  const dot = s.lastIndexOf('.');
  const comma = s.lastIndexOf(',');
  let clean;
  if (dot >= 0 && comma >= 0) {
    // Both present: whichever comes last is the decimal separator.
    const dec = dot > comma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    clean = s.split(thou).join('').replace(dec, '.');
  } else if (dot >= 0 || comma >= 0) {
    const sep = dot >= 0 ? '.' : ',';
    const idx = Math.max(dot, comma);
    const count = s.split(sep).length - 1;
    const after = s.length - idx - 1;
    const before = s.slice(0, idx);
    // "1,299" / "12.345.678" read as thousands; "12,5" / "0,125" / "1234,567" read as decimals.
    const thousands = count > 1 || (after === 3 && before.length <= 3 && !before.startsWith('0'));
    clean = thousands ? s.split(sep).join('') : s.replace(sep, '.');
  } else {
    clean = s;
  }
  const n = Number(clean);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

export function parseNumber(text) {
  if (typeof text !== 'string') return null;
  const m = TOKEN.exec(text);
  return m ? toNumber(m[0]) : null;
}

export function formatNumber(n) {
  if (n === null || n === undefined) return '—';
  return Number.isInteger(n) ? String(n) : String(+n.toFixed(4));
}
