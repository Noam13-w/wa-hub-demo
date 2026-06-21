import { existsSync, mkdirSync, readFileSync, writeFileSync, accessSync, constants as FS } from 'node:fs';
import { join } from 'node:path';
import { request } from 'undici';
import { config } from './config.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'diagnostics' });

const WEBHOOK_FAILURES_FILE = join(config.DATA_DIR, 'webhook-failures.json');
const MAX_WEBHOOK_FAILURES = 100;
const MAX_ERRORS = 50;

// ─── In-memory ring buffers ──────────────────────────────────────────────
// Errors: last N unhandled / route errors. Kept in memory only.
const errors = [];
// Webhook failures: last N failed attempts. Mirrored to disk so they survive a restart.
let webhookFailures = loadWebhookFailures();
// Counter for in-flight deliveries (incremented at start of deliver(), decremented at end).
let pendingDeliveries = 0;

export function incrPending() { pendingDeliveries += 1; }
export function decrPending() { pendingDeliveries = Math.max(0, pendingDeliveries - 1); }
export function getPending() { return pendingDeliveries; }

// ─── Error buffer ────────────────────────────────────────────────────────
export function recordError(err, ctx = {}) {
  const entry = {
    timestamp: Date.now(),
    message: typeof err === 'string' ? err : (err?.message || String(err)),
    name: err?.name,
    // Trim stacks to keep the buffer small.
    stack: err?.stack ? String(err.stack).split('\n').slice(0, 8).join('\n') : null,
    ctx,
  };
  errors.push(entry);
  if (errors.length > MAX_ERRORS) errors.splice(0, errors.length - MAX_ERRORS);
}

export function getErrors() {
  return errors.slice().reverse(); // newest first
}

// ─── Webhook failure buffer (disk-backed) ────────────────────────────────
function loadWebhookFailures() {
  try {
    if (!existsSync(WEBHOOK_FAILURES_FILE)) return [];
    const raw = readFileSync(WEBHOOK_FAILURES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(-MAX_WEBHOOK_FAILURES) : [];
  } catch (err) {
    log.warn({ err: err.message }, 'failed to load webhook-failures.json');
    return [];
  }
}

function persistWebhookFailures() {
  try {
    mkdirSync(config.DATA_DIR, { recursive: true });
    writeFileSync(WEBHOOK_FAILURES_FILE, JSON.stringify(webhookFailures, null, 2), 'utf8');
  } catch (err) {
    // Don't crash if we can't persist; just warn.
    log.warn({ err: err.message }, 'failed to persist webhook-failures.json');
  }
}

export function recordWebhookFailure({ event, url, attempts, lastStatus, lastError, totalMs }) {
  webhookFailures.push({
    timestamp: Date.now(),
    event,
    url,
    attempts,
    lastStatus: lastStatus ?? null,
    lastError: lastError ?? null,
    totalMs,
  });
  if (webhookFailures.length > MAX_WEBHOOK_FAILURES) {
    webhookFailures = webhookFailures.slice(-MAX_WEBHOOK_FAILURES);
  }
  persistWebhookFailures();
}

export function getWebhookFailures() {
  return webhookFailures.slice().reverse(); // newest first
}

// ─── Self-test for /api/instance/diagnose ────────────────────────────────
const REQUIRED_ENV = ['HUB_TOKEN', 'WEBHOOK_SECRET', 'HUB_PORT', 'WS_PORT', 'DATA_DIR'];

async function checkPublicInternet() {
  const start = Date.now();
  try {
    const { statusCode, body } = await request('https://ifconfig.me/ip', {
      method: 'GET',
      headersTimeout: 5000,
      bodyTimeout: 5000,
    });
    const text = await body.text();
    return {
      ok: statusCode === 200,
      statusCode,
      publicIp: text.trim().slice(0, 64) || null,
      ms: Date.now() - start,
    };
  } catch (err) {
    return { ok: false, error: err.message, ms: Date.now() - start };
  }
}

function checkAuthDir() {
  const authDir = join(config.DATA_DIR, 'auth');
  try {
    if (!existsSync(authDir)) {
      // not fatal — may not yet exist on first boot
      return { ok: false, exists: false, writable: false, path: authDir, message: 'auth dir does not exist yet' };
    }
    accessSync(authDir, FS.R_OK | FS.W_OK);
    return { ok: true, exists: true, writable: true, path: authDir };
  } catch (err) {
    return { ok: false, exists: existsSync(authDir), writable: false, path: authDir, error: err.message };
  }
}

function checkEnv() {
  const missing = REQUIRED_ENV.filter((k) => !config[k]);
  return {
    ok: missing.length === 0,
    missing,
    hubName: config.HUB_NAME,
    dataDir: config.DATA_DIR,
    rateLimit: config.RATE_LIMIT_PER_MIN,
    // NB: don't echo HUB_TOKEN / WEBHOOK_SECRET — even their presence/length.
    // Just `missing` already says whether they're set.
  };
}

/**
 * Run a series of quick health checks. Returns a structured JSON.
 * Total wall-clock budget ≤ ~6s (public-internet probe is the slow part).
 */
export async function runDiagnose({ socketOpen, webhookConfigured, connection }) {
  const [internet, authDir] = await Promise.all([
    checkPublicInternet(),
    Promise.resolve(checkAuthDir()),
  ]);
  const env = checkEnv();

  const all = [
    internet.ok,
    authDir.ok,
    env.ok,
    socketOpen,
  ];
  const summary = all.every(Boolean) ? 'pass' : (all.some(Boolean) ? 'degraded' : 'fail');

  return {
    summary,
    timestamp: Date.now(),
    connection,
    checks: {
      internet,
      authDir,
      env,
      socket: { ok: !!socketOpen, open: !!socketOpen, connection },
      webhook: { ok: true, configured: !!webhookConfigured },
    },
    counters: {
      pendingDeliveries,
      recentErrors: errors.length,
      recentWebhookFailures: webhookFailures.length,
    },
  };
}
