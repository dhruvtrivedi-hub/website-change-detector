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
    if (u.protocol === 'http:' && !local) warn = 'This address uses http://, so your password would travel unencrypted. Use https:// for anything that is not on this computer.';
  } catch { /* not a URL yet */ }
  $('#warn').hidden = !warn;
  $('#warn').textContent = warn;
}

(async () => {
  const { wcd_server, wcd_email } = await chrome.storage.local.get(['wcd_server', 'wcd_email']);
  $('#server').value = wcd_server || 'http://localhost:3000';
  $('#email').value = wcd_email || '';
  warnIfInsecure();
})();
$('#server').addEventListener('input', warnIfInsecure);

$('#save').addEventListener('click', async () => {
  const msg = $('#msg');
  msg.className = 'muted';
  let origin;
  try { origin = cleanServer($('#server').value); } catch (e) { msg.className = 'err'; msg.textContent = e.message.includes('Invalid URL') ? 'Enter a full address such as http://localhost:3000' : e.message; return; }
  const email = $('#email').value.trim();
  const password = $('#password').value;
  if (!email || !password) { msg.className = 'err'; msg.textContent = 'Enter your account email and password.'; return; }

  // Must be the first thing in the click handler: browsers only show this prompt in response to a user gesture.
  const granted = await chrome.permissions.request({ origins: [origin + '/*'] });
  if (!granted) { msg.className = 'err'; msg.textContent = 'Permission to contact that server was not granted, so the extension cannot reach it.'; return; }

  try {
    const login = await fetch(origin + '/api/login', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (login.status === 401) throw new Error('Email or password is incorrect.');
    if (!login.ok) throw new Error('The server answered with HTTP ' + login.status + '.');
    const r = await fetch(origin + '/api/me', { credentials: 'include' });
    if (!r.ok) throw new Error('Could not verify the sign-in session. Try again.');
    const me = await r.json();
    await chrome.storage.local.set({ wcd_server: origin, wcd_email: email });
    await chrome.storage.local.remove(['wcd_token', 'wcd_password']);
    msg.textContent = 'Connected as ' + me.email + '. You can close this tab and use the toolbar button on any page.';
  } catch (e) {
    msg.className = 'err';
    msg.textContent = e instanceof TypeError ? 'Could not reach ' + origin + '. Is the server running?' : e.message;
  }
});
