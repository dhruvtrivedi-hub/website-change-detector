// Text-level noise filtering. Applied per line after the DOM has been reduced to text.
// Removes things that change on every load: timestamps, relative times, counters, random tokens.

const MONTH =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

// Social/traffic counters only. Stock counts ("3 left") are deliberately NOT here: people watch those.
const UNITS =
  '(?:views?|likes?|comments?|shares?|visitors?|users?|online|viewing|watching|followers?|readers?|reads?|downloads?|replies|votes?)';

// Always stripped, at every sensitivity.
const ALWAYS = [
  /\b\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?(?:Z|UTC|GMT|[+-]\d{2}:?\d{2}))?/gi, // ISO datetime
  /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:[ap]\.?m\.?)?/gi, // clock times
  /\b(?:\d+|an?|few)\s+(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s+ago\b/gi, // "5 minutes ago"
  /\b(?:just now|moments? ago|yesterday)\b/gi,
  new RegExp(`\\b\\d[\\d,.]*\\s?[kKmM]?\\+?\\s+${UNITS}\\b`, 'gi'), // "1,234 views"
  new RegExp(`\\b${UNITS}\\s*[:\\-]?\\s*\\d[\\d,.]*[kKmM]?\\b`, 'gi'), // "Views: 1,234"
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // UUID
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g, // random tokens / nonces / csrf
  /\b[0-9a-f]{16,}\b/gi, // long hex (hashes, ids)
  /\b\d{10,13}\b/g, // epoch timestamps
  /(?:©|\(c\)|copyright)\s*\d{4}(?:\s?[-–]\s?\d{4})?/gi, // © 2026
];

// Calendar dates: stripped for low/medium, kept at "high" (someone watching "sale ends Oct 5" wants them).
const DATES = [
  /\b\d{4}[/.-]\d{1,2}[/.-]\d{1,2}\b/g,
  /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g,
  new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, 'gi'),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\.?(?:,?\\s+\\d{4})?\\b`, 'gi'),
];

export function normalizeLine(raw, sensitivity = 'medium') {
  let s = raw.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  for (const re of ALWAYS) s = s.replace(re, ' ');
  if (sensitivity !== 'high') for (const re of DATES) s = s.replace(re, ' ');
  s = s
    .replace(/\s+/g, ' ')
    .replace(/^[\s|·•,:;\-–—/]+|[\s|·•,:;\-–—/]+$/g, '')
    .trim();
  return /[\p{L}\p{N}]/u.test(s) ? s : '';
}
