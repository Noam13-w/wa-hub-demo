/**
 * Self-contained live pairing page + post-pairing console, served at GET /pair.
 *
 * BEFORE linking: shows the live, self-refreshing QR (the browser supplies the
 * HUB_TOKEN via the URL #fragment or a paste, then polls the token-gated
 * /api/instance/status + /qr endpoints — the QR data never leaves the token gate).
 *
 * AFTER linking: the same page flips to a console that (a) offers a one-click
 * smoke test (POST /api/instance/smoketest → the API messages your own number so
 * you SEE it work), (b) shows your API base URL with a clear "this Quick Tunnel
 * URL is temporary — connect a subdomain for production" warning, and (c) gives
 * copy-paste curl examples (send text, check number, set webhook) pre-filled with
 * your base URL + token, plus the webhook signature/event reference.
 *
 * A per-request nonce locks the inline <style>/<script> to the CSP so we never
 * need 'unsafe-inline'. Everything is same-origin (connect-src 'self'); no remote
 * resources are loaded. The whole document is one template literal, so the inline
 * browser script deliberately avoids backticks / ${...} interpolation.
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
  main { width: 100%; max-width: 560px; }
  #pairView { max-width: 360px; margin: 0 auto; text-align: center; }
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
  button:disabled { opacity: .55; cursor: default; }
  .ok { color: #00d68f; }
  .err { color: #ff6b6b; }
  .muted { color: #8696a0; font-size: .82rem; }
  /* Console */
  #console h1 { text-align: center; }
  .card { background: #111b21; border: 1px solid #222d34; border-radius: 12px;
    padding: 14px 16px; margin: 12px 0; }
  .card.warn { border-color: #5b4a1f; background: #1c1810; }
  .card strong { display: block; margin-bottom: 8px; font-size: .95rem; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px;
    margin-bottom: 0; }
  pre.ex { margin: 0 0 4px; padding: 10px 12px; background: #0b1014; border: 1px solid #222d34;
    border-radius: 8px; overflow-x: auto; font: 12.5px/1.5 ui-monospace, Menlo, Consolas, monospace;
    color: #cfe3d8; white-space: pre; }
  code { background: #0b1014; border: 1px solid #222d34; border-radius: 5px; padding: 1px 5px;
    font: 12px ui-monospace, Menlo, Consolas, monospace; color: #ffd479; }
</style>
</head>
<body>
<main>
  <div id="pairView">
    <h1 id="title">Link your WhatsApp</h1>
    <p class="sub" id="sub">WhatsApp &rarr; Settings &rarr; Linked Devices &rarr; Link a Device</p>
    <div id="tokenRow" hidden>
      <input id="token" type="password" autocomplete="off" placeholder="Paste HUB_TOKEN">
      <button id="go" type="button">Connect</button>
    </div>
    <div id="qrBox" hidden><img id="qr" alt="Pairing QR code" width="240" height="240"></div>
    <div id="status">Starting&hellip;</div>
    <div id="hint">The code refreshes automatically. Keep this open until it links.</div>
  </div>

  <section id="console" hidden>
    <h1>&#9989; Connected</h1>
    <p class="sub" id="cSub" style="text-align:center"></p>

    <div class="card">
      <div class="row">
        <strong style="margin:0">Smoke test</strong>
        <button id="smoke" type="button">Send test message to me</button>
      </div>
      <div id="smokeOut" class="muted" style="margin-top:8px">Click to have the API message your own number &mdash; proof it works end to end.</div>
    </div>

    <div class="card warn">
      <strong>Your API base URL</strong>
      <pre class="ex" id="baseUrl">__BASE__</pre>
      <div class="muted">&#9888; This is a free Cloudflare <b>Quick Tunnel</b> &mdash; the URL is <b>temporary and changes every restart</b>. Fine for trying it out; for production connect a Cloudflare <b>Named Tunnel</b> to your own <b>subdomain</b> (stable URL, TLS, no open ports). See <code>docs/SUBDOMAIN.md</code> (one command: <code>sudo deploy/cloudflared-setup.sh named</code>).</div>
    </div>

    <div class="card">
      <strong>Send a text message</strong>
      <pre class="ex">curl -X POST __BASE__/api/messages/send/text -H "Authorization: Bearer __TOKEN__" -H "Content-Type: application/json" -d '{"to":"&lt;recipient-number&gt;","text":"hello from wa-hub"}'</pre>
    </div>

    <div class="card">
      <strong>Check if a number is on WhatsApp</strong>
      <pre class="ex">curl -X POST __BASE__/api/check/number -H "Authorization: Bearer __TOKEN__" -H "Content-Type: application/json" -d '{"numbers":["&lt;number&gt;"]}'</pre>
    </div>

    <div class="card">
      <strong>Receive messages &mdash; set a webhook</strong>
      <pre class="ex">curl -X PUT __BASE__/api/instance/webhook -H "Authorization: Bearer __TOKEN__" -H "Content-Type: application/json" -d '{"url":"https://your-server.com/hook","events":["message.incoming"]}'</pre>
      <div class="muted">Every delivery is signed: header <code>x-hub-signature: sha256=HMAC_SHA256(WEBHOOK_SECRET, rawBody)</code> &mdash; verify it before trusting the payload. Events: <code>message.incoming</code>, <code>message.outgoing</code>, <code>message.status</code>, <code>instance.connected</code>, <code>instance.disconnected</code>, <code>instance.qr</code>.</div>
    </div>

    <div class="card">
      <strong>Everything else it can do</strong>
      <div class="muted">Send image / file / audio / location / reaction, mark-as-read, list &amp; manage groups (add/remove/promote/demote), instance status &amp; self-diagnose. Full reference: <code>docs/API.md</code> in the repository.</div>
    </div>
  </section>
</main>
<script nonce="${nonce}">
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var token = '';
  var h = location.hash.replace(/^#/, '');
  if (h) { try { token = decodeURIComponent(h.replace(/^token=/, '')); } catch (e) { token = h.replace(/^token=/, ''); } }
  var timer = null;
  var consoleShown = false;

  function setStatus(t, cls) { var s = $('status'); s.textContent = t; s.className = cls || ''; }
  function showToken(show) { $('tokenRow').hidden = !show; }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  function api(path) {
    return fetch(path, { headers: { 'Authorization': 'Bearer ' + token }, cache: 'no-store' });
  }

  function showConsole(num) {
    if (consoleShown) return;
    consoleShown = true;
    $('cSub').textContent = num ? ('Linked as ' + num) : 'Linked';
    var origin = location.origin;
    var exs = document.querySelectorAll('.ex');
    for (var i = 0; i < exs.length; i++) {
      exs[i].textContent = exs[i].textContent.replace(/__BASE__/g, origin).replace(/__TOKEN__/g, token);
    }
    $('pairView').hidden = true;
    $('console').hidden = false;
  }

  function linked(num) { stop(); showConsole(num); }

  function runSmoke() {
    var b = $('smoke'); b.disabled = true;
    var out = $('smokeOut'); out.className = 'muted'; out.textContent = 'Sending…';
    fetch('/api/instance/smoketest', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token }, cache: 'no-store' })
      .then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
      .then(function (o) {
        if (o.s === 200 && o.j && o.j.ok) {
          out.className = 'ok';
          out.textContent = '✅ Sent to ' + (o.j.sentTo || 'you') + ' — check your WhatsApp.';
        } else {
          out.className = 'err';
          out.textContent = '✗ ' + ((o.j && o.j.message) || ('HTTP ' + o.s));
        }
      })
      .catch(function () { out.className = 'err'; out.textContent = '✗ Network error, try again.'; })
      .then(function () { b.disabled = false; });
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
        setStatus('Refreshing code…');
      }
    } catch (e) {
      setStatus('Connection issue, retrying…');
    }
  }

  $('go').addEventListener('click', function () {
    token = $('token').value.trim();
    if (token) { showToken(false); tick(); }
  });
  $('smoke').addEventListener('click', runSmoke);
  showToken(!token);
  tick();
  timer = setInterval(tick, 2500);
})();
</script>
</body>
</html>`;
}
