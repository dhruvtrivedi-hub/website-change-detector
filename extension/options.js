const $ = (s) => document.querySelector(s);

function cleanServer(v) {
  const u = new URL(v.trim());
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('The address must start with http:// or https://');
  return u.origin;
}

function warnIfInsecure() {
  let warn = '';
  try {
    const u = new URL($('#server').value.trim());
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol === 'http:' && !local) warn = 'This address uses http://, so your application password would travel unencrypted. Use https:// for anything that is not on this computer.';
  } catch { /* not a URL yet */ }
  $('#warn').hidden = !warn;
  $('#warn').textContent = warn;
}

(async () => {
  const { wcd_server, wcd_password } = await chrome.storage.local.get(['wcd_server', 'wcd_password']);
  $('#server').value = wcd_server || 'http://localhost:3000';
  $('#password').value = wcd_password || '';
  warnIfInsecure();
})();
$('#server').addEventListener('input', warnIfInsecure);

$('#save').addEventListener('click', async () => {
  const msg = $('#msg');
  msg.className = 'muted';
  let origin;
  try { origin = cleanServer($('#server').value); } catch (e) { msg.className = 'err'; msg.textContent = e.message.includes('Invalid URL') ? 'Enter a full address such as http://localhost:3000' : e.message; return; }
  const password = $('#password').value;
  if (!password) { msg.className = 'err'; msg.textContent = 'Enter the application password.'; return; }

  // Must be the first thing in the click handler: browsers only show this prompt in response to a user gesture.
  const granted = await chrome.permissions.request({ origins: [origin + '/*'] });
  if (!granted) { msg.className = 'err'; msg.textContent = 'Permission to contact that server was not granted, so the extension cannot reach it.'; return; }

  try {
    const r = await fetch(origin + '/api/me', { headers: { Authorization: 'Password ' + password } });
    if (r.status === 401) throw new Error('The server did not accept that password.');
    if (!r.ok) throw new Error('The server answered with HTTP ' + r.status + '.');
    const me = await r.json();
    await chrome.storage.local.set({ wcd_server: origin, wcd_password: password });
    await chrome.storage.local.remove('wcd_token');
    msg.textContent = 'Connected as ' + me.email + '. You can close this tab and use the toolbar button on any page.';
  } catch (e) {
    msg.className = 'err';
    msg.textContent = e instanceof TypeError ? 'Could not reach ' + origin + '. Is the server running?' : e.message;
  }
});
