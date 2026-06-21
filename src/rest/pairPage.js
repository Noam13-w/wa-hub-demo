/**
 * Self-contained live pairing page served at GET /pair (public).
 *
 * The HTML shell carries no secret. The browser asks for the HUB_TOKEN once
 * (pasted, or read from the URL #fragment which is never sent to the server)
 * and then polls the token-gated /api/instance/status + /qr endpoints with an
 * Authorization header — so the QR data itself stays behind the token, exactly
 * like the existing qr.png route. The page auto-refreshes the QR (Baileys mints
 * a new one every ~20 s) and flips to "Linked" the moment pairing completes.
 *
 * A per-request nonce locks the inline <style>/<script> to the CSP so we don't
 * need 'unsafe-inline'.
 */
export function pairPageHtml(nonce) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link WhatsApp · wa-hub</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: #0b141a; color: #e9edef; padding: 24px; }
  main { width: 100%; max-width: 360px; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  .sub { color: #8696a0; margin: 0 0 1.25rem; font-size: .9rem; }
  #qrBox { background: #fff; border-radius: 16px; padding: 16px; display: inline-block;
    min-width: 240px; min-height: 240px; }
  #qr { width: 240px; height: 240px; display: block; image-rendering: pixelated; }
  #status { margin-top: 1rem; min-height: 1.5em; font-weight: 600; }
  #hint { color: #8696a0; font-size: .82rem; margin-top: .4rem; }
  #tokenRow { display: flex; gap: 8px; margin-bottom: 1rem; }
  input { flex: 1; padding: 10px 12px; border-radius: 10px; border: 1px solid #2a3942;
    background: #1f2c34; color: #e9edef; font: inherit; }
  button { padding: 10px 16px; border: 0; border-radius: 10px; background: #00a884;
    color: #04130d; font: inherit; font-weight: 700; cursor: pointer; }
  .ok { color: #00d68f; }
  .err { color: #ff6b6b; }
</style>
</head>
<body>
<main>
  <h1>Link your WhatsApp</h1>
  <p class="sub">WhatsApp → Settings → Linked Devices → Link a Device</p>
  <div id="tokenRow" hidden>
    <input id="token" type="password" autocomplete="off" placeholder="Paste HUB_TOKEN">
    <button id="go" type="button">Connect</button>
  </div>
  <div id="qrBox" hidden><img id="qr" alt="Pairing QR code" width="240" height="240"></div>
  <div id="status">Starting…</div>
  <div id="hint">The code refreshes automatically. Keep this open until it links.</div>
</main>
<script nonce="${nonce}">
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var token = '';
  var h = location.hash.replace(/^#/, '');
  if (h) { try { token = decodeURIComponent(h.replace(/^token=/, '')); } catch (e) { token = h.replace(/^token=/, ''); } }
  var timer = null;

  function setStatus(t, cls) { var s = $('status'); s.textContent = t; s.className = cls || ''; }
  function showToken(show) { $('tokenRow').hidden = !show; }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  function api(path) {
    return fetch(path, { headers: { 'Authorization': 'Bearer ' + token }, cache: 'no-store' });
  }

  function linked(num) {
    $('qrBox').hidden = true;
    setStatus('✅ Linked' + (num ? ' as ' + num : ''), 'ok');
    $('hint').textContent = 'Done — you can close this tab.';
    stop();
  }

  async function tick() {
    if (!token) { showToken(true); setStatus('Enter your token to begin.'); return; }
    try {
      var s = await api('/api/instance/status');
      if (s.status === 401) { showToken(true); setStatus('Invalid token.', 'err'); return; }
      var st = await s.json();
      if (st.connection === 'connected') { linked(st.me && st.me.number); return; }
      showToken(false);
      var q = await api('/api/instance/qr');
      if (q.status === 200) {
        var j = await q.json();
        $('qr').src = j.dataUrl;
        $('qrBox').hidden = false;
        var secs = j.expiresAt ? Math.max(0, Math.round((j.expiresAt - Date.now()) / 1000)) : null;
        setStatus('Scan this code' + (secs != null ? ' · ' + secs + 's' : ''));
      } else if (q.status === 409) {
        var jj = await q.json();
        linked(jj.me && jj.me.number);
      } else {
        setStatus('Waiting for a fresh QR…');
      }
    } catch (e) {
      setStatus('Connection issue, retrying…');
    }
  }

  $('go').addEventListener('click', function () {
    token = $('token').value.trim();
    if (token) { showToken(false); tick(); }
  });
  showToken(!token);
  tick();
  timer = setInterval(tick, 2500);
})();
</script>
</body>
</html>`;
}
