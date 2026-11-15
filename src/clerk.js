'use strict';

// ChristianMingle session access client (Clerk FAPI flow, mirrors the recorded browser traffic)

const CLERK_FAPI = 'https://clerk.christianmingle.com';
const CLERK_PROXY = 'https://christianmingle.com/__clerk';
const CLERK_QUERY = '__clerk_api_version=2025-11-10&_clerk_js_version=5.128.2';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';

const FAPI_HOST = 'clerk.christianmingle.com';
const PROXY_HOST = 'christianmingle.com';
const SITE_ORIGIN = 'https://www.christianmingle.com';
const APP_ORIGIN = 'https://app.christianmingle.com';

// ---------------------------------------------------------------------------
// Cookie jar: captures EVERY Set-Cookie from every response with full attributes
// ---------------------------------------------------------------------------

class CookieJar {
  constructor() {
    this.cookies = new Map(); // key: domain|path|name
  }

  capture(response, requestHost) {
    let list = [];
    if (typeof response.headers.getSetCookie === 'function') {
      list = response.headers.getSetCookie() || [];
    } else {
      const raw = response.headers.get('set-cookie');
      if (raw) list = [raw];
    }
    for (const sc of list) this.setFromHeader(sc, requestHost);
  }

  setFromHeader(setCookie, requestHost) {
    const parts = setCookie.split(';');
    const nameValue = parts[0];
    const eq = nameValue.indexOf('=');
    if (eq < 0) return;
    const name = nameValue.slice(0, eq).trim();
    const value = nameValue.slice(eq + 1).trim();
    if (!name) return;

    let domain = null;
    let path = '/';
    let expires = null;
    let maxAge = null;
    let httpOnly = false;
    let secure = false;
    let sameSite = null;

    for (let i = 1; i < parts.length; i++) {
      const attr = parts[i];
      const aeq = attr.indexOf('=');
      const key = (aeq >= 0 ? attr.slice(0, aeq) : attr).trim().toLowerCase();
      const v = aeq >= 0 ? attr.slice(aeq + 1).trim() : '';
      if (key === 'domain') domain = v.toLowerCase();
      else if (key === 'path') path = v || '/';
      else if (key === 'expires') expires = v;
      else if (key === 'max-age') maxAge = parseInt(v, 10);
      else if (key === 'httponly') httpOnly = true;
      else if (key === 'secure') secure = true;
      else if (key === 'samesite') sameSite = v;
    }

    let hostOnly = false;
    if (domain) {
      if (domain.startsWith('.')) domain = domain.slice(1);
    } else {
      domain = requestHost;
      hostOnly = true;
    }

    let expiresTs = null;
    if (maxAge !== null && !Number.isNaN(maxAge)) {
      expiresTs = maxAge <= 0 ? 0 : Date.now() + maxAge * 1000;
    } else if (expires) {
      const parsed = Date.parse(expires);
      if (!Number.isNaN(parsed)) expiresTs = parsed;
    }

    const key = domain + '|' + path + '|' + name;
    if (expiresTs !== null && expiresTs <= Date.now()) {
      this.cookies.delete(key);
      return;
    }
    this.cookies.set(key, { name, value, domain, path, expires: expiresTs, httpOnly, secure, sameSite, hostOnly });
  }

  matchesHost(cookie, host) {
    if (cookie.hostOnly) return cookie.domain === host;
    return host === cookie.domain || host.endsWith('.' + cookie.domain);
  }

  headerFor(hosts, requestPath = '/') {
    const now = Date.now();
    const picked = new Map();
    for (const c of this.cookies.values()) {
      if (c.expires && c.expires <= now) continue;
      if (!hosts.some((h) => this.matchesHost(c, h))) continue;
      const cp = c.path || '/';
      if (requestPath !== '/' && !requestPath.startsWith(cp)) continue;
      picked.set(c.name, c.value);
    }
    const arr = [];
    for (const [n, v] of picked) arr.push(n + '=' + v);
    return arr.join('; ');
  }

  toArray() {
    const now = Date.now();
    const out = [];
    for (const c of this.cookies.values()) {
      if (c.expires && c.expires <= now) continue;
      out.push({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires ? new Date(c.expires).toISOString() : null,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
        hostOnly: c.hostOnly
      });
    }
    return out;
  }

  static fromArray(arr) {
    const jar = new CookieJar();
    for (const c of arr || []) {
      jar.cookies.set(c.domain + '|' + c.path + '|' + c.name, {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        expires: c.expires ? Date.parse(c.expires) : null,
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
        sameSite: c.sameSite || null,
        hostOnly: !!c.hostOnly
      });
    }
    return jar;
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function baseHeaders({ origin, referer }) {
  const h = {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'user-agent': USER_AGENT,
    'sec-ch-ua': '"Not-A.Brand";v="99", "Google Chrome";v="157", "Chromium";v="157"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site'
  };
  if (origin) h.origin = origin;
  if (referer) h.referer = referer;
  return h;
}

async function clerkFetch(url, { method = 'GET', body, origin, referer, jar, hosts, requestPath = '/' }) {
  const headers = baseHeaders({ origin, referer });
  if (body !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
  const cookie = jar.headerFor(hosts, requestPath);
  if (cookie) headers.cookie = cookie;
  const res = await fetch(url, { method, headers, body, redirect: 'manual' });
  jar.capture(res, new URL(url).hostname);
  return res;
}

function friendlyClerkError(data, fallback) {
  const err = data && data.errors && data.errors[0];
  if (!err) return fallback;
  const map = {
    form_identifier_not_found: 'No account was found with this email address.',
    form_param_format_invalid: 'Please check the email address and try again.',
    form_not_found: 'This verification has expired. Please start again.',
    strategy_email_code_invalid: 'The verification code is incorrect. Please try again.',
    strategy_email_code_expired: 'The verification code has expired. Please start again.',
    session_not_found: 'This session is no longer valid.',
    too_many_attempts: 'Too many attempts. Please wait a minute and try again.'
  };
  return map[err.code] || err.message || fallback;
}

// ---------------------------------------------------------------------------
// Login flow (exactly mirrors the recorded browser traffic)
// ---------------------------------------------------------------------------

async function startLogin(email) {
  const jar = new CookieJar();

  // 1) Initialize client state (obtains the __client cookie)
  await clerkFetch(CLERK_FAPI + '/v1/client?' + CLERK_QUERY, {
    origin: SITE_ORIGIN,
    referer: SITE_ORIGIN + '/',
    jar,
    hosts: [FAPI_HOST]
  });

  // 2) Create sign-in attempt
  const res = await clerkFetch(CLERK_FAPI + '/v1/client/sign_ins?' + CLERK_QUERY, {
    method: 'POST',
    body: 'locale=en-US&identifier=' + encodeURIComponent(email),
    origin: SITE_ORIGIN,
    referer: SITE_ORIGIN + '/',
    jar,
    hosts: [FAPI_HOST]
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(friendlyClerkError(data, 'Could not start sign-in (HTTP ' + res.status + ').'));
  }
  const signIn = data.response || {};
  const factor = (signIn.supported_first_factors || []).find((f) => f.strategy === 'email_code');
  if (!factor || !factor.email_address_id) {
    throw new Error('Email code sign-in is not available for this account.');
  }

  // 3) Request the email verification code
  const pres = await clerkFetch(
    CLERK_FAPI + '/v1/client/sign_ins/' + signIn.id + '/prepare_first_factor?' + CLERK_QUERY,
    {
      method: 'POST',
      body: 'email_address_id=' + encodeURIComponent(factor.email_address_id) + '&strategy=email_code',
      origin: SITE_ORIGIN,
      referer: SITE_ORIGIN + '/',
      jar,
      hosts: [FAPI_HOST]
    }
  );
  const pdata = await pres.json().catch(() => ({}));
  if (!pres.ok) {
    throw new Error(friendlyClerkError(pdata, 'Could not send the verification code (HTTP ' + pres.status + ').'));
  }

  return { sign_in_id: signIn.id, email_address_id: factor.email_address_id, email, jar };
}

async function attemptLogin(pending, code) {
  const jar = pending.jar;

  // 4) Submit the verification code
  const res = await clerkFetch(
    CLERK_FAPI + '/v1/client/sign_ins/' + pending.sign_in_id + '/attempt_first_factor?' + CLERK_QUERY,
    {
      method: 'POST',
      body: 'strategy=email_code&code=' + encodeURIComponent(code),
      origin: SITE_ORIGIN,
      referer: SITE_ORIGIN + '/',
      jar,
      hosts: [FAPI_HOST]
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(friendlyClerkError(data, 'Code verification failed (HTTP ' + res.status + ').'));
  }
  const sessionId = (data.response && data.response.created_session_id) || null;
  if (!sessionId) {
    throw new Error('Sign-in did not complete. Please try again.');
  }
  const clientObj = data.client || {};
  const sessionObj = (clientObj.sessions || []).find((s) => s.id === sessionId) || (clientObj.sessions || [])[0] || {};
  const user = sessionObj.user || {};

  // 5) Activate the session — the touch response itself contains the JWT
  const tres = await clerkFetch(CLERK_FAPI + '/v1/client/sessions/' + sessionId + '/touch?' + CLERK_QUERY, {
    method: 'POST',
    body: 'active_organization_id=&intent=select_session',
    origin: SITE_ORIGIN,
    referer: SITE_ORIGIN + '/',
    jar,
    hosts: [FAPI_HOST]
  });
  if (!tres.ok) {
    const tdata = await tres.json().catch(() => ({}));
    throw new Error(friendlyClerkError(tdata, 'Could not activate the session (HTTP ' + tres.status + ').'));
  }
  const touchData = await tres.json().catch(() => ({}));

  // 6) Obtain the session token (JWT):
  //    a) app-audience token from the /__clerk proxy (needed by api-bf)
  //    b) directly from the touch / attempt response bodies (last_active_token.jwt)
  //    c) fallback chain in fetchSessionToken
  let jwt = await fetchAppAudienceToken(jar, sessionId);
  if (!jwt) {
    jwt = extractTokenFromBody(touchData, sessionId) || extractTokenFromBody(data, sessionId);
  }
  if (!jwt) {
    jwt = await fetchSessionToken(jar, sessionId);
  }
  // Store the JWT as the cross-subdomain __session cookie (for api-bf calls) and
  // mirror the __client_uat=1 cookie the site sets after sign-in.
  setSessionCookie(jar, jwt);
  jar.cookies.set('christianmingle.com|/|__client_uat', {
    name: '__client_uat',
    value: '1',
    domain: 'christianmingle.com',
    path: '/',
    expires: null,
    httpOnly: false,
    secure: true,
    sameSite: 'Lax',
    hostOnly: false
  });

  return {
    session_id: sessionId,
    client_id: clientObj.id || null,
    user: {
      id: user.id || null,
      username: user.username || null,
      first_name: user.first_name || null,
      last_name: user.last_name || null,
      image_url: user.image_url || null,
      banned: user.banned === true,
      locked: user.locked === true,
      created_at: user.created_at || null,
      last_sign_in_at: user.last_sign_in_at || null,
      public_metadata: user.public_metadata || {}
    },
    jar,
    jwt
  };
}

// Extract a JWT from a Clerk client-shaped response body.
// Clerk responses look like {response: ..., client: {sessions: [...]}} —
// sessions[i].last_active_token.jwt holds the token. The touch response also
// exposes it on the top-level response object.
function extractTokenFromBody(data, sessionId) {
  if (!data) return null;
  const client = data.client || data;
  const sessions = (client && client.sessions) || [];
  let session = null;
  if (sessionId) session = sessions.find((s) => s && s.id === sessionId);
  if (!session && sessions.length) session = sessions[0];
  if (session && session.last_active_token && session.last_active_token.jwt) {
    return session.last_active_token.jwt;
  }
  if (data.response && data.response.last_active_token && data.response.last_active_token.jwt) {
    return data.response.last_active_token.jwt;
  }
  return null;
}

// Store the JWT as the __session cookie (cross-subdomain) so calls to
// api-bf.christianmingle.com carry __session=<JWT>, which is how the
// ChristianMingle backend authenticates requests.
function setSessionCookie(jar, jwt) {
  if (!jwt) return;
  jar.cookies.set('christianmingle.com|/|__session', {
    name: '__session',
    value: jwt,
    domain: 'christianmingle.com',
    path: '/',
    expires: null,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    hostOnly: false
  });
}

// Fetch the app-audience token (azp=app.christianmingle.com) from the /__clerk
// proxy. This is the token the ChristianMingle backend (api-bf) expects in the
// __session cookie. The token is parsed from the response BODY
// (client.sessions[].last_active_token.jwt), not from Set-Cookie.
async function fetchAppAudienceToken(jar, sessionId) {
  try {
    const res = await clerkFetch(CLERK_PROXY + '/v1/client?' + CLERK_QUERY, {
      origin: APP_ORIGIN,
      referer: APP_ORIGIN + '/',
      jar,
      hosts: [PROXY_HOST, FAPI_HOST]
    });
    const data = await res.json().catch(() => null);
    return extractTokenFromBody(data, sessionId);
  } catch (e) {
    return null;
  }
}

async function fetchSessionToken(jar, sessionId) {
  const errors = [];

  // Method 1: FAPI GET /v1/client (same host as the login calls, uses the __client cookie)
  try {
    const res = await clerkFetch(CLERK_FAPI + '/v1/client?' + CLERK_QUERY, {
      origin: SITE_ORIGIN,
      referer: SITE_ORIGIN + '/',
      jar,
      hosts: [FAPI_HOST, PROXY_HOST]
    });
    const data = await res.json().catch(() => null);
    const jwt = extractTokenFromBody(data, sessionId);
    if (jwt) return jwt;
    errors.push('fapi /v1/client HTTP ' + res.status + ' (no token)');
  } catch (e) {
    errors.push('fapi /v1/client: ' + e.message);
  }

  // Method 2: the /__clerk proxy — parse the body AND check the __session cookie
  try {
    const res = await clerkFetch(CLERK_PROXY + '/v1/client?' + CLERK_QUERY, {
      origin: APP_ORIGIN,
      referer: APP_ORIGIN + '/',
      jar,
      hosts: [PROXY_HOST, FAPI_HOST]
    });
    const data = await res.json().catch(() => null);
    const jwt = extractTokenFromBody(data, sessionId);
    if (jwt) return jwt;
    let cookieJwt = null;
    for (const c of jar.cookies.values()) {
      if (c.name === '__session' && c.value) cookieJwt = c.value;
    }
    if (cookieJwt) return cookieJwt;
    errors.push('proxy /__clerk/v1/client HTTP ' + res.status + ' (no token)');
  } catch (e) {
    errors.push('proxy /__clerk/v1/client: ' + e.message);
  }

  // Method 3: the Clerk token endpoint (GET) returns { jwt: "..." }
  try {
    const res = await clerkFetch(CLERK_FAPI + '/v1/client/sessions/' + sessionId + '/tokens?' + CLERK_QUERY, {
      origin: APP_ORIGIN,
      referer: APP_ORIGIN + '/',
      jar,
      hosts: [FAPI_HOST, PROXY_HOST]
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.jwt) return data.jwt;
    errors.push('tokens GET HTTP ' + res.status);
  } catch (e) {
    errors.push('tokens GET: ' + e.message);
  }

  // Method 4: the Clerk token endpoint (POST)
  try {
    const res = await clerkFetch(CLERK_FAPI + '/v1/client/sessions/' + sessionId + '/tokens?' + CLERK_QUERY, {
      method: 'POST',
      body: '',
      origin: APP_ORIGIN,
      referer: APP_ORIGIN + '/',
      jar,
      hosts: [FAPI_HOST, PROXY_HOST]
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.jwt) return data.jwt;
    errors.push('tokens POST HTTP ' + res.status);
  } catch (e) {
    errors.push('tokens POST: ' + e.message);
  }

  console.error('[clerk] fetchSessionToken failed:', errors.join(' | '));
  throw new Error('Could not obtain a session token for this account.');
}

// ---------------------------------------------------------------------------
// Session refresh: keeps the session alive and generates fresh cookies + JWT
// ---------------------------------------------------------------------------

async function refreshSession(record) {
  const jar = CookieJar.fromArray(record.cookies);

  // Touch extends session activity; its response carries a fresh token
  const tres = await clerkFetch(CLERK_FAPI + '/v1/client/sessions/' + record.session_id + '/touch?' + CLERK_QUERY, {
    method: 'POST',
    body: 'active_organization_id=&intent=select_session',
    origin: SITE_ORIGIN,
    referer: SITE_ORIGIN + '/',
    jar,
    hosts: [FAPI_HOST, PROXY_HOST]
  });
  if (!tres.ok) {
    const terr = await tres.json().catch(() => ({}));
    throw new Error(friendlyClerkError(terr, 'Session refresh failed (HTTP ' + tres.status + ').'));
  }
  const touchData = await tres.json().catch(() => ({}));

  // Fresh token -> new cookies. Prefer the app-audience token (api-bf compat).
  let jwt = await fetchAppAudienceToken(jar, record.session_id);
  if (!jwt) {
    jwt = extractTokenFromBody(touchData, record.session_id);
  }
  if (!jwt) {
    jwt = await fetchSessionToken(jar, record.session_id);
  }
  setSessionCookie(jar, jwt);

  record.cookies = jar.toArray();
  record.jwt = jwt;
  record.jwt_payload = decodeJwt(jwt);
  record.last_refresh_at = new Date().toISOString();
  record.status = 'ACTIVE';
  return record;
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function decodeJwt(jwt) {
  try {
    const parts = String(jwt).split('.');
    if (parts.length < 2) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload);
  } catch (e) {
    return null;
  }
}

function jarFromRecord(record) {
  return CookieJar.fromArray(record.cookies);
}

function cookieHeaderFor(record) {
  const jar = CookieJar.fromArray(record.cookies);
  return jar.headerFor(['christianmingle.com', 'clerk.christianmingle.com', 'api-bf.christianmingle.com']);
}

module.exports = {
  CookieJar,
  USER_AGENT,
  startLogin,
  attemptLogin,
  fetchSessionToken,
  refreshSession,
  decodeJwt,
  jarFromRecord,
  cookieHeaderFor
};

