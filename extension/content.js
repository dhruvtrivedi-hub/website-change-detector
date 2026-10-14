// On-page picker. Injected by the popup (chrome.scripting.executeScript) when you press "Pick on the page".
// It never talks to the server: picks are saved to extension storage and finished in the popup.
(() => {
  if (window.__wcdPicker) { window.__wcdPicker.focus(); return; }

  const norm = (u) => { const x = new URL(u); x.hash = ''; return x.toString(); };
  const picks = { watch: [], ignore: [], track: [] }; // watch/ignore: selector strings; track: { selector, text, ...popup fields }
  const keyOf = (k, p) => (k === 'track' ? p.selector : p);
  let mode = 'watch';
  let hover = null;
  let trail = []; // elements below `hover` after pressing ArrowUp, so ArrowDown can go back
  let raf = 0;
  let done = false;

  // ----- selectors (same strategy as the server's visual picker, verified against the live page) -----
  const stableId = (n) => n.id && !/\d{4,}/.test(n.id) && document.querySelectorAll('#' + CSS.escape(n.id)).length === 1;
  function selectorFor(el) {
    const parts = [];
    let anchored = false;
    for (let n = el; n && n.nodeType === 1 && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (stableId(n)) { parts.unshift('#' + CSS.escape(n.id)); anchored = true; break; }
      const tag = n.tagName.toLowerCase();
      const sibs = [...n.parentElement.children].filter((c) => c.tagName === n.tagName);
      parts.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${sibs.indexOf(n) + 1})` : tag);
    }
    if (!parts.length) return null;
    const sel = (anchored ? '' : 'body > ') + parts.join(' > ');
    try { return document.querySelector(sel) === el ? sel : null; } catch { return null; }
  }
  const query = (sel) => { try { return document.querySelector(sel); } catch { return null; } };
  const textOf = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();

  // ----- UI (shadow DOM so the page's CSS cannot touch it, and ours cannot leak) -----
  const host = document.createElement('div');
  host.id = 'wcd-picker-host';
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647';
  const root = host.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet(); // constructable stylesheet: not blocked by the page's CSP
  sheet.replaceSync(`
    .box{position:fixed;pointer-events:none;box-sizing:border-box;border:2px solid transparent}
    .box.hover{border-color:#2b4acb;background:rgba(43,74,203,.12)}
    .box.watch{border-color:#13794a;background:rgba(19,121,74,.18)}
    .box.ignore{border-color:#b42318;background:rgba(180,35,24,.2)}
    .box.track{border-color:#b25e00;background:rgba(178,94,0,.22)}
    #bar{position:fixed;top:12px;right:12px;width:300px;box-sizing:border-box;background:#fff;color:#1a1d24;border:1px solid #cfd5df;border-radius:10px;
      box-shadow:0 8px 30px rgba(20,25,40,.25);padding:12px;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
    #bar.left{right:auto;left:12px}
    .t{font-weight:600;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center}
    .modes{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin-bottom:8px}
    button{font:inherit;color:inherit;border:1px solid #cfd5df;background:#fff;border-radius:6px;padding:5px 6px;cursor:pointer}
    button.on.watch{background:#e3f4ea;border-color:#13794a}button.on.ignore{background:#fde8e8;border-color:#b42318}button.on.track{background:#fff1d6;border-color:#b25e00}
    button.primary{background:#2b4acb;border-color:#2b4acb;color:#fff}button:focus-visible{outline:2px solid #2b4acb;outline-offset:2px}
    .hint{color:#667085;font-size:12px;min-height:32px;word-break:break-all}.counts{margin:6px 0;color:#344054}
    .msg{color:#9a5b00;font-size:12px;min-height:16px}.row{display:flex;gap:6px;justify-content:flex-end;margin-top:8px}
  `);
  root.adoptedStyleSheets = [sheet];
  const layer = document.createElement('div');
  const bar = document.createElement('div');
  bar.id = 'bar';
  bar.setAttribute('role', 'dialog');
  bar.setAttribute('aria-label', 'Change Detector picker');
  bar.innerHTML = `
    <div class="t"><span>Change Detector picker</span><button id="side" title="Move this panel" aria-label="Move panel">⇄</button></div>
    <div class="modes" role="group" aria-label="What a click does">
      <button data-m="watch" class="watch">Watch</button><button data-m="ignore" class="ignore">Ignore</button><button data-m="track" class="track">Track number</button>
    </div>
    <div class="hint" id="hint">Hover an area and click it. Click again to remove. ↑ / ↓ picks a larger / smaller area. Esc cancels.</div>
    <div class="counts" id="counts"></div>
    <div class="msg" id="msg" role="status"></div>
    <div class="row"><button id="cancel">Cancel</button><button id="save" class="primary">Save picks</button></div>`;
  root.append(layer, bar);
  document.documentElement.appendChild(host);

  const $ = (s) => bar.querySelector(s);
  function paintBar() {
    bar.querySelectorAll('[data-m]').forEach((b) => b.classList.toggle('on', b.dataset.m === mode));
    $('#counts').textContent = `${picks.watch.length} to watch · ${picks.ignore.length} to ignore · ${picks.track.length} number${picks.track.length === 1 ? '' : 's'}`;
  }
  const say = (t) => { $('#msg').textContent = t; };

  function draw() {
    raf = 0;
    layer.textContent = '';
    const add = (el, cls) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      const d = document.createElement('div');
      d.className = 'box ' + cls;
      d.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
      layer.appendChild(d);
    };
    for (const k of ['watch', 'ignore', 'track']) for (const p of picks[k]) { const el = query(keyOf(k, p)); if (el) add(el, k); }
    if (hover) add(hover, 'hover');
    paintBar();
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(draw); };

  // ----- picking -----
  const inHost = (e) => e.composedPath().includes(host);
  const describe = (el) => el.tagName.toLowerCase() + ': ' + (textOf(el).slice(0, 70) || '(no text)');

  function toggle(el) {
    const sel = selectorFor(el);
    if (!sel) { say('Could not build a reliable selector for that element. Try a different one.'); return; }
    say('');
    for (const k of Object.keys(picks)) if (k !== mode) picks[k] = picks[k].filter((p) => keyOf(k, p) !== sel);
    const list = picks[mode];
    const i = list.findIndex((p) => keyOf(mode, p) === sel);
    if (i >= 0) { list.splice(i, 1); }
    else if (mode === 'track') {
      const text = textOf(el);
      if (!/\d/.test(text)) { say('No digits in that element. Use ↑ / ↓ to select the one that shows the number.'); return; }
      list.push({ selector: sel, text: text.slice(0, 60) });
    } else list.push(sel);
    schedule();
  }

  function onMove(e) {
    if (inHost(e)) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    hover = el && el !== document.documentElement && el !== document.body ? el : null;
    trail = [];
    $('#hint').textContent = hover ? describe(hover) : '';
    schedule();
  }
  function onClick(e) {
    if (inHost(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (hover) toggle(hover);
  }
  function swallow(e) { if (!inHost(e)) { e.preventDefault(); e.stopImmediatePropagation(); } }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(false); return; }
    if (e.key === 'ArrowUp' && hover?.parentElement && hover.parentElement !== document.body) {
      e.preventDefault(); trail.push(hover); hover = hover.parentElement;
    } else if (e.key === 'ArrowDown' && trail.length) {
      e.preventDefault(); hover = trail.pop();
    } else return;
    $('#hint').textContent = describe(hover);
    schedule();
  }

  const BLOCKED = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'dblclick', 'submit'];
  const cap = { capture: true };
  const pickListeners = [['mousemove', onMove], ['click', onClick], ['keydown', onKey], ...BLOCKED.map((t) => [t, swallow])];
  const stopPicking = () => pickListeners.forEach(([t, f]) => window.removeEventListener(t, f, cap));
  pickListeners.forEach(([t, f]) => window.addEventListener(t, f, cap));
  window.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.addEventListener('resize', schedule);

  function teardown() {
    stopPicking();
    window.removeEventListener('scroll', schedule, { capture: true });
    window.removeEventListener('resize', schedule);
    cancelAnimationFrame(raf);
    host.remove();
    delete window.__wcdPicker;
  }

  async function finish(save) {
    if (done) return;
    done = true;
    if (!save) { teardown(); return; }
    try {
      await chrome.storage.local.set({ wcd_picks: { url: norm(location.href), at: Date.now(), ...picks } });
      // stop picking, but leave the panel up briefly so the person knows what to do next
      stopPicking();
      layer.textContent = '';
      bar.innerHTML = '<div class="t">Picks saved</div><div class="hint">Click the Change Detector toolbar button to finish adding this page.</div>';
      setTimeout(teardown, 3500);
    } catch (e) {
      done = false;
      say('Could not save: ' + e.message);
    }
  }

  bar.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => { mode = b.dataset.m; say(''); paintBar(); }));
  $('#side').onclick = () => bar.classList.toggle('left');
  $('#cancel').onclick = () => finish(false);
  $('#save').onclick = () => finish(true);

  window.__wcdPicker = { focus: () => $('#save').focus() };

  // continue from earlier picks for this same page
  chrome.storage.local.get('wcd_picks').then(({ wcd_picks: p }) => {
    if (p && p.url === norm(location.href)) {
      picks.watch = [...(p.watch || [])];
      picks.ignore = [...(p.ignore || [])];
      picks.track = [...(p.track || [])];
    }
    schedule();
  }).catch(() => schedule());
})();
