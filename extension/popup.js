// Popup: add the current tab to the Change Detector server, optionally with regions / numbers picked on the page.
const $ = (s, r = document) => r.querySelector(s);
const root = $('#root');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Same normalisation the server applies, so "already watching" matches reliably.
const norm = (u) => { const x = new URL(u); x.hash = ''; return x.toString(); };

const state = { server: '', token: '', tab: null, existing: null, picks: { watch: [], ignore: [], track: [] }, error: '' };

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(state.server + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) throw new Error('The server did not accept your token. Check the extension settings.');
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}

const savePicks = () => chrome.storage.local.set({ wcd_picks: { url: norm(state.tab.url), at: Date.now(), ...state.picks } });

function message(html) { root.innerHTML = html; }

async function init() {
  const s = await chrome.storage.local.get(['wcd_server', 'wcd_token', 'wcd_picks']);
  state.server = s.wcd_server || '';
  state.token = s.wcd_token || '';
  if (!state.server || !state.token) {
    message(`<h1>Change Detector Helper</h1><p class="muted">Connect the extension to your server first.</p><button class="primary" id="open">Open settings</button>`);
    $('#open').onclick = () => { chrome.runtime.openOptionsPage(); window.close(); };
    return;
  }
  if (!(await chrome.permissions.contains({ origins: [state.server + '/*'] }))) {
    message(`<h1>Change Detector Helper</h1><p class="muted">Allow the extension to contact <b>${esc(state.server)}</b>.</p><button class="primary" id="grant">Grant access</button>`);
    $('#grant').onclick = async () => { if (await chrome.permissions.request({ origins: [state.server + '/*'] })) init(); };
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:\/\//.test(tab.url)) {
    message(`<h1>Watch this page</h1><p class="muted">Open a normal web page (http or https) and click the button again.</p>`);
    return;
  }
  state.tab = tab;

  const p = s.wcd_picks;
  if (p && p.url === norm(tab.url)) {
    state.picks = { watch: p.watch || [], ignore: p.ignore || [], track: (p.track || []).map((t) => ({ label: '', mode: 'any', threshold: '', ...t })) };
    state.picks.track.forEach((t, i) => { if (!t.label) t.label = 'Number ' + (i + 1); });
  }

  try {
    const watches = await api('/watches');
    state.existing = watches.find((w) => norm(w.url) === norm(tab.url)) || null;
  } catch (e) {
    const net = e instanceof TypeError;
    message(`<h1>Change Detector Helper</h1><p class="err">${esc(net ? 'Could not reach ' + state.server + '. Is the server running?' : e.message)}</p><button id="open">Open settings</button>`);
    $('#open').onclick = () => { chrome.runtime.openOptionsPage(); window.close(); };
    return;
  }
  render();
}

const INTERVALS = [[15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [120, '2 hours'], [360, '6 hours'], [720, '12 hours'], [1440, '24 hours']];
const TRK_MODES = [['any', 'Any change'], ['below', 'Drops below'], ['above', 'Rises above'], ['none', 'Chart only']];

function render() {
  const { tab, existing, picks } = state;
  const total = picks.watch.length + picks.ignore.length + picks.track.length;
  root.innerHTML = `
  <h1>Watch this page</h1>
  <div class="page"><b>${esc(tab.title || '')}</b><div class="url">${esc(tab.url)}</div></div>
  ${existing ? `<div class="ok">Already watching as <b>${esc(existing.name)}</b>. Picks below are added to it.</div>` : ''}
  <div class="panel">
    <div class="h">Regions and numbers <span class="muted">(optional)</span></div>
    <div class="muted">Click parts of the page to watch, ignore, or track as a number. Without any picks the whole page is watched.</div>
    <button id="pick">${total ? 'Pick more on the page…' : 'Pick on the page…'}</button>
    <div class="chips">
      ${picks.watch.map((s, i) => `<span class="chip watch" data-l="watch" data-i="${i}" title="${esc(s)} (click to remove)">watch ${esc(s)} ×</span>`).join('')}
      ${picks.ignore.map((s, i) => `<span class="chip ignore" data-l="ignore" data-i="${i}" title="${esc(s)} (click to remove)">ignore ${esc(s)} ×</span>`).join('')}
    </div>
    ${picks.track.map((t, i) => `<div class="trk">
      <input type="text" data-k="label" data-i="${i}" maxlength="60" aria-label="Name" value="${esc(t.label)}">
      <select data-k="mode" data-i="${i}" aria-label="Alert type">${TRK_MODES.map(([v, l]) => `<option value="${v}" ${t.mode === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      ${t.mode === 'below' || t.mode === 'above' ? `<input type="number" step="any" data-k="threshold" data-i="${i}" aria-label="Threshold" placeholder="Value" value="${esc(t.threshold)}">` : '<span></span>'}
      <button class="small" data-rm="${i}" aria-label="Remove">×</button>
      <div class="sel">${esc(t.selector)}${t.text ? ' — “' + esc(t.text) + '”' : ''}</div>
    </div>`).join('')}
  </div>
  ${existing ? '' : `
  <label>Name <input type="text" id="name" maxlength="100" value="${esc((tab.title || new URL(tab.url).hostname).slice(0, 100))}"></label>
  <div class="row">
    <label>Check every <select id="interval">${INTERVALS.map(([v, l]) => `<option value="${v}" ${v === 60 ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>Sensitivity <select id="sens"><option value="high">High</option><option value="medium" selected>Medium</option><option value="low">Low</option></select></label>
  </div>`}
  <div class="err" id="err" role="alert">${esc(state.error)}</div>
  <div class="actions">
    <button class="primary" id="go" ${existing && !total ? 'disabled' : ''}>${existing ? 'Add picks to this watch' : 'Start watching'}</button>
    <a href="#" id="dash">Open dashboard</a>
  </div>`;

  $('#pick').onclick = async () => {
    try {
      await savePicks();
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      window.close();
    } catch (e) {
      state.error = "Can't pick on this page: " + e.message;
      render();
    }
  };
  root.querySelectorAll('.chip').forEach((c) => (c.onclick = () => { picks[c.dataset.l].splice(Number(c.dataset.i), 1); savePicks(); render(); }));
  root.querySelectorAll('.trk [data-k]').forEach((inp) => {
    inp.oninput = () => { picks.track[Number(inp.dataset.i)][inp.dataset.k] = inp.value; savePicks(); };
    if (inp.dataset.k === 'mode') inp.onchange = () => { picks.track[Number(inp.dataset.i)].mode = inp.value; savePicks(); render(); };
  });
  root.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { picks.track.splice(Number(b.dataset.rm), 1); savePicks(); render(); }));
  $('#go').onclick = submit;
  $('#dash').onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: state.server }); };
}

const union = (a, b) => [...new Set([...a, ...b])];
const toTracker = (t) => ({
  label: String(t.label || '').trim() || 'Number',
  selector: t.selector,
  mode: t.mode || 'any',
  threshold: t.mode === 'below' || t.mode === 'above' ? t.threshold : null,
});

async function submit() {
  const { tab, existing, picks } = state;
  state.error = '';
  const newTrackers = picks.track.map(toTracker);
  const needsThreshold = (t) => t.mode === 'below' || t.mode === 'above';
  const bad = newTrackers.find((t) => needsThreshold(t) && (t.threshold === '' || t.threshold == null || !Number.isFinite(Number(t.threshold))));
  if (bad) { state.error = `"${bad.label}" needs a threshold value.`; render(); return; }

  $('#go').disabled = true;
  try {
    if (existing) {
      // Merge into the existing watch: new picks win over older ones for the same element.
      const watch = union(existing.watch_selectors.filter((s) => !picks.ignore.includes(s)), picks.watch);
      const ignore = union(existing.ignore_selectors.filter((s) => !picks.watch.includes(s)), picks.ignore);
      const have = new Set(existing.trackers.map((t) => t.selector));
      const trackers = [
        ...existing.trackers.map((t) => ({ id: t.id, label: t.label, selector: t.selector, mode: t.mode, threshold: t.threshold })),
        ...newTrackers.filter((t) => !have.has(t.selector)),
      ];
      await api('/watches/' + existing.id, { method: 'PUT', body: { watch_selectors: watch, ignore_selectors: ignore, trackers } });
    } else {
      await api('/watches', {
        method: 'POST',
        body: {
          url: tab.url,
          name: $('#name').value,
          interval_min: Number($('#interval').value),
          sensitivity: $('#sens').value,
          watch_selectors: picks.watch,
          ignore_selectors: picks.ignore,
          trackers: newTrackers,
        },
      });
    }
    await chrome.storage.local.remove('wcd_picks');
    message(`<h1>${existing ? 'Watch updated' : 'Now watching this page'}</h1>
      <p class="muted">${existing ? 'The next check captures a fresh baseline silently, then changes are reported.' : 'The first check runs within a minute or two and saves the baseline. Alerts start with the next real change.'}
      Tracked numbers show up in the dashboard after that first check.</p>
      <button class="primary" id="dash2">Open dashboard</button>`);
    $('#dash2').onclick = () => chrome.tabs.create({ url: state.server });
  } catch (e) {
    state.error = e instanceof TypeError ? 'Could not reach the server.' : e.message;
    render();
  }
}

init().catch((e) => message(`<p class="err">${esc(e.message)}</p>`));
