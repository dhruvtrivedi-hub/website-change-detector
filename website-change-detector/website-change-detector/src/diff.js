import { diffLines } from 'diff';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

// ---------- Text diff ----------

const withNl = (t) => (t && !t.endsWith('\n') ? t + '\n' : t || '');
const splitLines = (v) => v.replace(/\n$/, '').split('\n');

export function textDiff(a, b) {
  const parts = diffLines(withNl(a), withNl(b));
  const added = [];
  const removed = [];
  let changedChars = 0;
  for (const p of parts) {
    if (p.added) { added.push(...splitLines(p.value)); changedChars += p.value.length; }
    else if (p.removed) { removed.push(...splitLines(p.value)); changedChars += p.value.length; }
  }
  const ratio = changedChars / Math.max(a.length, b.length, 1);
  return { parts, added, removed, changedChars, ratio };
}

const squash = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Sensitivity setting:
 *  high   - any difference in the (already noise-filtered) text
 *  medium - ignore edits that only touch case, punctuation or whitespace
 *  low    - additionally require a bigger change (>= 3 lines or >= 2% of the text)
 */
export function isSignificant(prevText, newText, d, sensitivity) {
  if (!d.added.length && !d.removed.length) return false;
  if (sensitivity === 'high') return true;
  if (squash(prevText) === squash(newText)) return false;
  if (sensitivity === 'low') return d.added.length + d.removed.length >= 3 || d.ratio >= 0.02;
  return true;
}

// One-line, human summary (heuristic; swap in an LLM call here for the "AI summary" bonus).
export function summarize(d) {
  const a = d.added.length;
  const r = d.removed.length;
  let s = `${a} line${a === 1 ? '' : 's'} added, ${r} removed.`;
  const pick = d.added[0] ?? d.removed[0];
  if (pick) s += ` ${d.added[0] ? 'Now' : 'Was'}: “${pick.slice(0, 140)}”`;
  return s;
}

// Rows for a side-by-side view; long unchanged runs are collapsed.
export function sideBySide(parts, context = 3) {
  const rows = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.removed) {
      const L = splitLines(p.value);
      const next = parts[i + 1];
      if (next?.added) {
        const R = splitLines(next.value);
        const n = Math.max(L.length, R.length);
        for (let k = 0; k < n; k++) rows.push({ l: L[k] ?? null, r: R[k] ?? null, t: 'chg' });
        i++;
      } else L.forEach((x) => rows.push({ l: x, r: null, t: 'del' }));
    } else if (p.added) {
      splitLines(p.value).forEach((x) => rows.push({ l: null, r: x, t: 'add' }));
    } else {
      splitLines(p.value).forEach((x) => rows.push({ l: x, r: x, t: 'same' }));
    }
  }
  const out = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].t !== 'same') { out.push(rows[i++]); continue; }
    let j = i;
    while (j < rows.length && rows[j].t === 'same') j++;
    const run = j - i;
    if (run > context * 2 + 1) {
      for (let k = i; k < i + context; k++) out.push(rows[k]);
      out.push({ t: 'gap', n: run - context * 2 });
      for (let k = j - context; k < j; k++) out.push(rows[k]);
    } else for (let k = i; k < j; k++) out.push(rows[k]);
    i = j;
  }
  return out;
}

// ---------- Screenshot diff ----------

function fillRect(png, x, y, w, h, v) {
  const x0 = Math.max(0, x), y0 = Math.max(0, y);
  const x1 = Math.min(png.width, x + w), y1 = Math.min(png.height, y + h);
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const i = (yy * png.width + xx) * 4;
      png.data[i] = png.data[i + 1] = png.data[i + 2] = v;
      png.data[i + 3] = 255;
    }
  }
}

function padTo(png, w, h) {
  if (png.width === w && png.height === h) return png;
  const out = new PNG({ width: w, height: h });
  fillRect(out, 0, 0, w, h, 255);
  PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0);
  return out;
}

// ignore: rects painted flat grey; only: everything outside these rects is painted flat grey.
function applyMask(png, { ignore = [], only = [] } = {}) {
  let img = png;
  if (only.length) {
    img = new PNG({ width: png.width, height: png.height });
    fillRect(img, 0, 0, png.width, png.height, 235);
    for (const r of only) {
      const x = Math.max(0, r.x), y = Math.max(0, r.y);
      const w = Math.min(r.w, png.width - x), h = Math.min(r.h, png.height - y);
      if (w > 0 && h > 0) PNG.bitblt(png, img, x, y, w, h, x, y);
    }
  }
  for (const r of ignore) fillRect(img, r.x, r.y, r.w, r.h, 200);
  return img;
}

/** Highlighted diff image: changed pixels in red over a faded copy of the page. */
export function imageDiff(bufA, bufB, maskA, maskB) {
  let a = PNG.sync.read(bufA);
  let b = PNG.sync.read(bufB);
  const w = Math.max(a.width, b.width);
  const h = Math.max(a.height, b.height);
  a = applyMask(padTo(a, w, h), maskA);
  b = applyMask(padTo(b, w, h), maskB);
  const out = new PNG({ width: w, height: h });
  const changedPixels = pixelmatch(a.data, b.data, out.data, w, h, {
    threshold: 0.1,
    includeAA: false,
    alpha: 0.3,
    diffColor: [255, 0, 60],
  });
  return { png: PNG.sync.write(out), changedPixels, ratio: changedPixels / (w * h) };
}
