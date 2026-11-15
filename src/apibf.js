'use strict';

// api-bf.christianmingle.com account status calls (authenticated via the captured __session cookie)

const { USER_AGENT } = require('./clerk');

const API_BF = 'https://api-bf.christianmingle.com';

function randomHex(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

function traceparent() {
  return '00-' + randomHex(32) + '-' + randomHex(16) + '-01';
}

async function apiBfGet(pathname, jar) {
  const cookie = jar.headerFor(['api-bf.christianmingle.com', 'christianmingle.com']);
  const headers = {
    accept: 'application/json',
    'accept-language': 'en-US,en;q=0.9',
    locale: 'en-US',
    origin: 'https://app.christianmingle.com',
    referer: 'https://app.christianmingle.com/',
    traceparent: traceparent(),
    'user-agent': USER_AGENT,
    'x-brand-id': 'cm',
    'x-browser-information': JSON.stringify({
      user_agent: USER_AGENT,
      accept_language: 'en-US',
      content_language: 'en-US',
      device_timezone: 'Asia/Jakarta'
    })
  };
  if (cookie) headers.cookie = cookie;

  const res = await fetch(API_BF + pathname, { headers });
  jar.capture(res, 'api-bf.christianmingle.com');
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch (e) {
    /* keep raw text */
  }
  return { http: res.status, body };
}

async function accountStatus(jar) {
  const enrollment = await apiBfGet('/enrollment/v1/status', jar);
  const userStatus = await apiBfGet('/users/v1/me/status', jar);
  const appeal = await apiBfGet('/profiles/v1/me/appeal/eligibility', jar);
  return { enrollment, user_status: userStatus, appeal };
}

module.exports = { accountStatus };
