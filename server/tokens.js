'use strict';

const crypto = require('crypto');
const config = require('./config');

// 内存会话表（重启后需重新验码/登录）
// key: token -> { type, codeId, code, adminId?, username?, exp }
const sessions = new Map();

function setSession(type, payload, ttlMs) {
  const token = crypto.randomBytes(32).toString('hex');
  const session = {
    type,
    ...payload,
    exp: Date.now() + ttlMs,
  };
  sessions.set(token, session);
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s;
}

function revokeByCodeId(codeId) {
  for (const [token, s] of sessions) {
    if (s.type === 'invite' && s.codeId === codeId) sessions.delete(token);
  }
}

function revoke(token) {
  sessions.delete(token);
}

function createInviteSession({ codeId, code }) {
  return setSession('invite', { codeId, code }, config.INVITE_TTL_MS);
}

function createAdminSession({ adminId, username }) {
  return setSession('admin', { adminId, username }, config.ADMIN_TTL_MS);
}

// 周期性清理过期会话
setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (s.exp < now) sessions.delete(token);
  }
}, 10 * 60 * 1000).unref();

module.exports = {
  getSession,
  createInviteSession,
  createAdminSession,
  revokeByCodeId,
  revoke,
};
