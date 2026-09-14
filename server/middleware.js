'use strict';

const tokens = require('./tokens');

function getBearer(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  // 也支持 query（仅导出场景）
  return (req.query && req.query.token) || null;
}

// 邀请码会话：报名相关接口必须
function requireInvite(req, res, next) {
  const session = tokens.getSession(getBearer(req));
  if (!session || session.type !== 'invite') {
    return res.status(401).json({
      ok: false,
      code: 'NO_INVITE',
      message: '请先输入有效的邀请码',
    });
  }
  req.inviteSession = session;
  next();
}

// 管理员会话：后台接口必须
function requireAdmin(req, res, next) {
  const session = tokens.getSession(getBearer(req));
  if (!session || session.type !== 'admin') {
    return res.status(401).json({
      ok: false,
      code: 'NO_ADMIN',
      message: '管理员未登录或会话已过期',
    });
  }
  req.adminSession = session;
  next();
}

// 简易内存限流：按 IP + key 维度
function rateLimit({ windowMs, max, prefix = '' }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) {
      if (v.reset < now) hits.delete(k);
    }
  }, 5 * 60 * 1000).unref();

  return function (req, res, next) {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${prefix}:${ip}`;
    const now = Date.now();
    let rec = hits.get(key);
    if (!rec || rec.reset < now) {
      rec = { count: 0, reset: now + windowMs };
      hits.set(key, rec);
    }
    rec.count += 1;
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - rec.count));
    if (rec.count > max) {
      return res.status(429).json({
        ok: false,
        code: 'TOO_MANY_REQUESTS',
        message: '操作过于频繁，请稍后再试',
      });
    }
    next();
  };
}

function notFound(req, res) {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ ok: false, message: '接口不存在' });
  }
  res.status(404).type('text/plain; charset=utf-8').send('404 Not Found');
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  console.error('[error]', err);
  if (res.headersSent) return;
  res.status(500).json({ ok: false, message: '服务器内部错误' });
}

module.exports = {
  requireInvite,
  requireAdmin,
  rateLimit,
  notFound,
  errorHandler,
};
