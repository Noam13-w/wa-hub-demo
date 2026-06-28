// Runtime smoke test for the audit-fix changes. Hermetic: sets its own env, binds
// the app on an ephemeral loopback port, and never touches WhatsApp. Run:
//   node deploy/test/_smoke.mjs
import http from 'node:http';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = await mkdtemp(join(tmpdir(), 'wahub-smoke-'));
process.env.HUB_TOKEN = 'smoke-token-0123456789abcdef';
process.env.WEBHOOK_SECRET = 'smoke-secret-0123456789abcdef';
process.env.DATA_DIR = DATA;
process.env.HUB_PORT = '3999';
process.env.WS_PORT = '3998';
process.env.LOG_LEVEL = 'fatal';
process.env.SEND_QUEUE_MAX = '2';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  \x1b[32mok\x1b[0m', m); };
const bad = (m) => { fail++; console.log('  \x1b[31mFAIL\x1b[0m', m); };
const eq = (m, a, b) => (a === b ? ok(`${m} (=${a})`) : bad(`${m}: expected ${b}, got ${a}`));

const { buildApp } = await import('../../src/rest/server.js');
const { currentSock } = await import('../../src/baileys/socket.js');
const { pacedSend, pacedRun } = await import('../../src/baileys/sendQueue.js');
const { EgressError } = await import('../../src/net/egress.js');
const { useAtomicMultiFileAuthState } = await import('../../src/baileys/authState.js');

const app = buildApp();
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function req(method, path, { body, auth } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth) headers['authorization'] = `Bearer ${process.env.HUB_TOKEN}`;
  const res = await fetch(base + path, { method, headers, body, redirect: 'manual' });
  let json = null; try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

console.log('── HTTP: middleware order (auth before parse), body limits, guard ──');
eq('GET /healthz → 200', (await req('GET', '/healthz')).status, 200);
eq('GET / → 302 redirect', (await req('GET', '/')).status, 302);

// Unauthenticated POST is rejected at auth — BEFORE any body parser runs.
eq('POST send/text no auth → 401', (await req('POST', '/api/messages/send/text', { body: '{}' })).status, 401);

// Authed + tiny valid body → 503 not_connected (no live socket in the smoke env).
const tiny = JSON.stringify({ to: '972500000000', text: 'hi' });
eq('POST send/text authed, tiny body → 503 not_connected',
  (await req('POST', '/api/messages/send/text', { body: tiny, auth: true })).status, 503);

// >256kb body to a NON-media route → 413 (jsonSmall cap).
const big = JSON.stringify({ to: '972500000000', text: 'x'.repeat(300 * 1024) });
const bigRes = await req('POST', '/api/messages/send/text', { body: big, auth: true });
eq('POST send/text 300kb → 413 payload_too_large', bigRes.status, 413);

// Same >256kb size to a MEDIA route is accepted by the 20MB parser → reaches
// requireConnected → 503 (proves media gets the larger limit, small routes don't).
const bigMedia = JSON.stringify({ to: '972500000000', imageBase64: 'x'.repeat(300 * 1024) });
const mediaRes = await req('POST', '/api/messages/send/image', { body: bigMedia, auth: true });
eq('POST send/image 300kb → not 413 (media parser allows it)', mediaRes.status !== 413, true);

eq('unknown route → 404', (await req('POST', '/api/nope', { body: '{}', auth: true })).status, 404);

console.log('── currentSock(): throws a 503 when not connected ──');
try { currentSock(); bad('currentSock should have thrown'); }
catch (e) { eq('currentSock status', e.status, 503); eq('currentSock code', e.code, 'not_connected'); }

console.log('── EgressError: file_too_large is 413, default is 400 ──');
eq('file_too_large status', new EgressError('file_too_large', 'm', 413).status, 413);
eq('default egress status', new EgressError('bad').status, 400);

console.log('── pacedRun: serializes and returns the value ──');
const order = [];
const [a, b] = await Promise.all([
  pacedRun(async () => { order.push('a-start'); await new Promise(r => setTimeout(r, 20)); order.push('a-end'); return 1; }),
  pacedRun(async () => { order.push('b-start'); return 2; }),
]);
eq('pacedRun returns first value', a, 1);
eq('pacedRun returns second value', b, 2);
eq('pacedRun serialized (a fully ran before b started)', order.join(','), 'a-start,a-end,b-start');

console.log('── send queue cap: SEND_QUEUE_MAX=2 → 3rd concurrent enqueue sheds 503 ──');
let shed = null;
const slow = () => pacedSend('972500000000', () => new Promise(r => setTimeout(() => r('done'), 50)));
const p1 = slow(); const p2 = slow();
try { slow(); } catch (e) { shed = e; }
eq('3rd enqueue threw', !!shed, true);
eq('shed status 503', shed?.status, 503);
eq('shed code', shed?.code, 'send_queue_full');
await Promise.allSettled([p1, p2]);

console.log('── atomic auth state: atomic write + .bak + corrupt-creds recovery ──');
{
  const dir = join(DATA, 'authtest');
  const a1 = await useAtomicMultiFileAuthState(dir);
  await a1.saveCreds();                       // first write — no .bak yet
  await a1.saveCreds();                       // second write — should create .bak
  const files = await readdir(dir);
  eq('creds.json written', files.includes('creds.json'), true);
  eq('creds.json.bak written on 2nd save', files.includes('creds.json.bak'), true);
  eq('no leftover .tmp', files.some(f => f.endsWith('.tmp')), false);
  // Corrupt the primary; a fresh load must fall back to the (valid) .bak, NOT mint new creds.
  const goodId = a1.state.creds.me ?? JSON.stringify(a1.state.creds).slice(0, 40);
  await writeFile(join(dir, 'creds.json'), '{ this is not valid json');
  const a2 = await useAtomicMultiFileAuthState(dir);
  const recoveredId = a2.state.creds.me ?? JSON.stringify(a2.state.creds).slice(0, 40);
  eq('recovered creds from .bak (not a fresh identity)', recoveredId, goodId);
}

server.close();
await rm(DATA, { recursive: true, force: true });
console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
