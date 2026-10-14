import * as cheerio from 'cheerio';
import { normalizeLine } from './noise.js';

const STRIP = 'script,style,noscript,template,iframe,svg,canvas,link,meta,head,object,embed';

// Ads, rotating banners/carousels, tickers, cookie banners: stripped from the text unless the user
// explicitly picks a region that sits inside one of them.
export const DEFAULT_NOISE = [
  '.ad', '.ads', '.advert', '.advertisement', '[class*="advert"]', '[id*="advert"]',
  '[id^="ad-"]', '[id^="ad_"]', '[class^="ad-"]', 'ins.adsbygoogle', '[id*="google_ads"]',
  '[data-ad]', '[data-ad-slot]', '[class*="sponsor"]', '[aria-label="advertisement" i]',
  '[class*="carousel"]', '[class*="slider"]', '[class*="rotat"]', '.swiper', '.slick-slider',
  '[class*="marquee"]', '[role="marquee"]', '[class*="ticker"]',
  '[class*="cookie"]', '[id*="cookie"]', '[id*="consent"]',
].join(',');

const BLOCK =
  'p,div,li,ul,ol,h1,h2,h3,h4,h5,h6,tr,section,article,header,footer,nav,aside,main,table,pre,blockquote,dt,dd,form,fieldset,figure,figcaption,button,option,details,summary';

/**
 * Reduce rendered HTML to normalised, line-oriented text.
 * - ignoreSelectors are removed from the DOM first
 * - if watchSelectors are given, only those regions are read; otherwise the whole <body>
 */
export function extractText(html, { watchSelectors = [], ignoreSelectors = [] }, sensitivity = 'medium') {
  const $ = cheerio.load(html);
  $(STRIP).remove();
  for (const s of ignoreSelectors) {
    try { $(s).remove(); } catch { /* invalid selector: skip */ }
  }

  const roots = [];
  if (watchSelectors.length) {
    for (const s of watchSelectors) {
      try {
        $(s).each((_, el) => { if (!roots.includes(el)) roots.push(el); });
      } catch { /* invalid selector: skip */ }
    }
  } else {
    const body = $('body').get(0);
    if (body) roots.push(body);
  }

  const lines = [];
  for (const el of roots) {
    const $el = $(el);
    $el.find(DEFAULT_NOISE).remove();
    $el.find('br').replaceWith('\n');
    $el.find(BLOCK).append('\n');
    $el.find('td,th').append(' ');
    for (const raw of $el.text().split('\n')) {
      const line = normalizeLine(raw, sensitivity);
      if (line) lines.push(line);
    }
  }
  return { text: lines.length ? lines.join('\n') + '\n' : '', matched: roots.length };
}
