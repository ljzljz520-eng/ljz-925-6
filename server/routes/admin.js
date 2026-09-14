'use strict';

const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const db = require('../db');
const tokens = require('../tokens');
const { requireAdmin, rateLimit } = require('../middleware');

const router = express.Router();

const STATE_LABELS = {
  unused: '未使用',
  used: '已使用',
  expired: '已过期',
  banned: '已封禁',
};

function maskCode(code) {
  return code.replace(/(.{4})(?=.)/g, '$1-');
}

function genCode() {
  const alphabet = config.CODE_ALPHABET;
  let out = '';
  const bytes = crypto.randomBytes(config.CODE_LENGTH);
  for (let i = 0; i < config.CODE_LENGTH; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function toInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function codeRowToApi(row, now = Date.now()) {
  return {
    id: row.id,
    code: row.code,
    codeMasked: maskCode(row.code),
    rawStatus: row.status,
    state: db.effectiveState(row, now),
    batchId: row.batch_id,
    remark: row.remark || '',
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
  };
}

function regRowToApi(row) {
  return {
    id: row.id,
    code: maskCode(row.code_value),
    name: row.name,
    phone: row.phone,
    email: row.email,
    company: row.company,
    remark: row.remark,
    createdAt: row.created_at,
  };
}

// ---------- 认证 ----------
router.post(
  '/login',
  rateLimit({ windowMs: 60 * 1000, max: 8, prefix: 'admin-login' }),
  (req, res) => {
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    if (!username || !password) {
      return res.status(400).json({ ok: false, message: '请输入账号和密码' });
    }
    const admin = db.get('SELECT * FROM admins WHERE username = ?', [username]);
    if (!admin || !db.verifyPassword(password, admin.password_salt, admin.password_hash)) {
      return res.status(401).json({ ok: false, message: '账号或密码错误' });
    }
    const token = tokens.createAdminSession({ adminId: admin.id, username: admin.username });
    res.json({
      ok: true,
      token,
      username: admin.username,
      expiresInMs: config.ADMIN_TTL_MS,
    });
  }
);

router.post('/logout', requireAdmin, (req, res) => {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) tokens.revoke(auth.slice(7).trim());
  res.json({ ok: true });
});

router.get('/me', requireAdmin, (req, res) => {
  res.json({ ok: true, username: req.adminSession.username });
});

// ---------- 统计 ----------
router.get('/stats', requireAdmin, (req, res) => {
  const now = Date.now();
  const total = db.get('SELECT COUNT(*) AS c FROM invite_codes').c;
  const banned = db.get("SELECT COUNT(*) AS c FROM invite_codes WHERE status = 'banned'").c;
  const used = db.get('SELECT COUNT(*) AS c FROM invite_codes WHERE used_at IS NOT NULL').c;
  const expired = db.get(
    'SELECT COUNT(*) AS c FROM invite_codes WHERE status = ? AND used_at IS NULL AND expires_at IS NOT NULL AND expires_at < ?',
    ['active', now]
  ).c;
  const unused = total - banned - used - expired;
  const registered = db.get('SELECT COUNT(*) AS c FROM registrations').c;

  const recentDays = {};
  const since = now - 7 * 24 * 60 * 60 * 1000;
  const rows = db.all(
    'SELECT created_at FROM registrations WHERE created_at >= ?',
    [since]
  );
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(now - i * 24 * 60 * 60 * 1000);
    const key = `${d.getMonth() + 1}/${d.getDate()}`;
    recentDays[key] = 0;
  }
  for (const r of rows) {
    const d = new Date(r.created_at);
    const key = `${d.getMonth() + 1}/${d.getDate()}`;
    if (key in recentDays) recentDays[key] += 1;
  }

  res.json({
    ok: true,
    stats: {
      total,
      unused,
      used,
      expired,
      banned,
      registered,
      labels: STATE_LABELS,
      recentDays,
    },
  });
});

// ---------- 邀请码：批量生成 ----------
// 支持两个等价路径：POST /api/admin/codes/batch 与 POST /api/admin/batches
router.post(['/codes/batch', '/batches'], requireAdmin, (req, res) => {
  const body = req.body || {};
  const count = toInt(body.count, 0, 1, config.MAX_BATCH);
  if (!count) {
    return res
      .status(400)
      .json({ ok: false, message: `生成数量需为 1-${config.MAX_BATCH} 的整数` });
  }

  let validDays;
  if (body.validDays === null || body.validDays === '' || body.validDays === -1) {
    validDays = null; // 永久
  } else {
    validDays = toInt(body.validDays, config.DEFAULT_CODE_VALID_DAYS, 1, 3650);
  }
  const remark = String(body.remark || '').slice(0, 100);
  const batchId =
    'B' +
    Date.now().toString(36).toUpperCase() +
    crypto.randomBytes(3).toString('hex').toUpperCase();

  const now = Date.now();
  const expiresAt = validDays ? now + validDays * 24 * 60 * 60 * 1000 : null;

  const created = [];
  let collisions = 0;
  db.tx(() => {
    while (created.length < count) {
      const code = genCode();
      try {
        db.runTx(
          `INSERT INTO invite_codes (code, status, batch_id, created_by, created_at, expires_at, remark)
           VALUES (?, 'active', ?, ?, ?, ?, ?)`,
          [code, batchId, req.adminSession.adminId, now, expiresAt, remark]
        );
        created.push(code);
      } catch (e) {
        // UNIQUE 冲突则重试，异常比例过高直接报错
        collisions += 1;
        if (collisions > count * 3 + 10) throw e;
      }
    }
  });
  db.persistNow();

  res.status(201).json({
    ok: true,
    batchId,
    count: created.length,
    expiresAt,
    codes: created,
  });
});

// ---------- 邀请码：列表 / 查询 ----------
router.get('/codes', requireAdmin, (req, res) => {
  const page = toInt(req.query.page, 1, 1, 100000);
  const pageSize = toInt(req.query.pageSize, 20, 1, 200);
  const state = String(req.query.state || 'all');
  const batchId = String(req.query.batchId || '').trim();
  const keyword = String(req.query.keyword || '').trim().toUpperCase().replace(/[\s-]/g, '');
  const now = Date.now();

  const where = [];
  const params = [];
  if (batchId) {
    where.push('c.batch_id = ?');
    params.push(batchId);
  }
  if (keyword) {
    where.push('c.code LIKE ?');
    params.push(`%${keyword}%`);
  }
  if (state === 'banned') where.push("c.status = 'banned'");
  if (state === 'used') where.push('c.used_at IS NOT NULL');
  if (state === 'expired')
    where.push("c.status = 'active' AND c.used_at IS NULL AND c.expires_at IS NOT NULL AND c.expires_at < ?");
  if (state === 'unused')
    where.push("c.status = 'active' AND c.used_at IS NULL AND (c.expires_at IS NULL OR c.expires_at >= ?)");
  if (state === 'expired' || state === 'unused') params.push(now);

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.get(
    `SELECT COUNT(*) AS c FROM invite_codes c ${whereSql}`,
    params
  ).c;
  const rows = db.all(
    `SELECT c.*, r.name AS reg_name, r.phone AS reg_phone
       FROM invite_codes c
       LEFT JOIN registrations r ON r.id = c.used_by
       ${whereSql}
      ORDER BY c.id DESC
      LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]
  );

  res.json({
    ok: true,
    page,
    pageSize,
    total,
    items: rows.map((r) => ({
      ...codeRowToApi(r, now),
      registeredName: r.reg_name || null,
      registeredPhone: r.reg_phone || null,
    })),
  });
});

// ---------- 邀请码：封禁 / 解封 ----------
router.post('/codes/:id/ban', requireAdmin, (req, res) => {
  const id = toInt(req.params.id, 0, 1, Number.MAX_SAFE_INTEGER);
  const row = db.get('SELECT * FROM invite_codes WHERE id = ?', [id]);
  if (!row) return res.status(404).json({ ok: false, message: '邀请码不存在' });
  if (db.effectiveState(row) === 'used') {
    return res.status(400).json({ ok: false, message: '已使用的邀请码无需封禁' });
  }
  db.run("UPDATE invite_codes SET status = 'banned' WHERE id = ?", [id]);
  db.persistNow();
  tokens.revokeByCodeId(id);
  res.json({ ok: true, message: '已封禁' });
});

router.post('/codes/:id/unban', requireAdmin, (req, res) => {
  const id = toInt(req.params.id, 0, 1, Number.MAX_SAFE_INTEGER);
  const row = db.get('SELECT * FROM invite_codes WHERE id = ?', [id]);
  if (!row) return res.status(404).json({ ok: false, message: '邀请码不存在' });
  db.run("UPDATE invite_codes SET status = 'active' WHERE id = ?", [id]);
  db.persistNow();
  res.json({ ok: true, message: '已解封' });
});

// ---------- 批次列表 ----------
router.get('/batches', requireAdmin, (req, res) => {
  const rows = db.all(
    `SELECT c.batch_id,
            COUNT(*) AS total,
            SUM(CASE WHEN c.status = 'banned' THEN 1 ELSE 0 END) AS banned,
            SUM(CASE WHEN c.used_at IS NOT NULL THEN 1 ELSE 0 END) AS used,
            SUM(CASE WHEN c.status = 'active' AND c.used_at IS NULL
                      AND c.expires_at IS NOT NULL AND c.expires_at < ? THEN 1 ELSE 0 END) AS expired,
            MIN(c.created_at) AS created_at,
            MIN(c.expires_at) AS expires_at,
            MAX(c.remark) AS remark,
            a.username AS creator
       FROM invite_codes c
       LEFT JOIN admins a ON a.id = c.created_by
      GROUP BY c.batch_id
      ORDER BY created_at DESC
      LIMIT 100`,
    [Date.now()]
  );
  res.json({
    ok: true,
    items: rows.map((r) => ({
      batchId: r.batch_id,
      total: r.total,
      unused: r.total - r.banned - r.used - r.expired,
      used: r.used,
      expired: r.expired,
      banned: r.banned,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      remark: r.remark || '',
      creator: r.creator || '',
    })),
  });
});

// ---------- 报名名单 ----------
router.get('/registrations', requireAdmin, (req, res) => {
  const page = toInt(req.query.page, 1, 1, 100000);
  const pageSize = toInt(req.query.pageSize, 20, 1, 200);
  const keyword = String(req.query.keyword || '').trim();

  const where = [];
  const params = [];
  if (keyword) {
    where.push('(name LIKE ? OR phone LIKE ? OR email LIKE ? OR company LIKE ? OR code_value LIKE ?)');
    const like = `%${keyword}%`;
    params.push(like, like, like, like, `%${keyword.toUpperCase().replace(/[\s-]/g, '')}%`);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.get(`SELECT COUNT(*) AS c FROM registrations ${whereSql}`, params).c;
  const rows = db.all(
    `SELECT * FROM registrations ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]
  );
  res.json({ ok: true, page, pageSize, total, items: rows.map(regRowToApi) });
});

// ---------- 导出名单 CSV ----------
router.get('/export/registrations.csv', requireAdmin, (req, res) => {
  const keyword = String(req.query.keyword || '').trim();
  const where = [];
  const params = [];
  if (keyword) {
    where.push('(name LIKE ? OR phone LIKE ? OR email LIKE ? OR company LIKE ? OR code_value LIKE ?)');
    const like = `%${keyword}%`;
    params.push(like, like, like, like, `%${keyword.toUpperCase().replace(/[\s-]/g, '')}%`);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.all(
    `SELECT r.*, c.batch_id FROM registrations r
       LEFT JOIN invite_codes c ON c.id = r.code_id
       ${whereSql} ORDER BY r.id ASC`,
    params
  );

  const headers = ['报名ID', '邀请码', '批次', '姓名', '手机号', '邮箱', '单位', '备注', '报名时间', 'IP'];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const fmtTime = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  const lines = [headers.map(esc).join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        maskCode(r.code_value),
        r.batch_id || '',
        r.name,
        r.phone,
        r.email,
        r.company,
        r.remark,
        fmtTime(r.created_at),
        r.ip,
      ]
        .map(esc)
        .join(',')
    );
  }

  // UTF-8 BOM，保证 Excel 打开中文不乱码
  const csv = '﻿' + lines.join('\r\n');
  const filename = `registrations_${Date.now()}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

// ---------- 导出某批次/全部未用邀请码（便于线下发放） ----------
router.get('/export/codes.csv', requireAdmin, (req, res) => {
  const batchId = String(req.query.batchId || '').trim();
  const state = String(req.query.state || 'all');
  const now = Date.now();
  const where = [];
  const params = [];
  if (batchId) {
    where.push('batch_id = ?');
    params.push(batchId);
  }
  if (state === 'unused')
    where.push("status = 'active' AND used_at IS NULL AND (expires_at IS NULL OR expires_at >= ?)");
  if (state === 'used') where.push('used_at IS NOT NULL');
  if (state === 'banned') where.push("status = 'banned'");
  if (state === 'expired')
    where.push("status = 'active' AND used_at IS NULL AND expires_at IS NOT NULL AND expires_at < ?");
  if (state === 'unused' || state === 'expired') params.push(now);

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.all(`SELECT * FROM invite_codes ${whereSql} ORDER BY id ASC`, params);

  const headers = ['邀请码', '批次', '状态', '创建时间', '过期时间', '使用时间', '备注'];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const fmtTime = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const lines = [headers.map(esc).join(',')];
  for (const r of rows) {
    lines.push(
      [
        maskCode(r.code),
        r.batch_id,
        STATE_LABELS[db.effectiveState(r, now)],
        fmtTime(r.created_at),
        fmtTime(r.expires_at),
        fmtTime(r.used_at),
        r.remark || '',
      ]
        .map(esc)
        .join(',')
    );
  }
  const csv = '﻿' + lines.join('\r\n');
  const filename = `codes_${batchId || 'all'}_${Date.now()}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

module.exports = router;
