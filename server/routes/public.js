'use strict';

const express = require('express');
const config = require('../config');
const db = require('../db');
const tokens = require('../tokens');
const { requireInvite, rateLimit } = require('../middleware');

const router = express.Router();

// 邀请码标准化：大写、去空格/连字符，只保留 12 位
function normalizeCode(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[\s-]+/g, '');
}

function maskCode(code) {
  return code.replace(/(.{4})(?=.)/g, '$1-');
}

// POST /api/verify  校验邀请码，通过则下发报名会话 token
router.post(
  '/verify',
  rateLimit({ windowMs: 60 * 1000, max: 10, prefix: 'verify' }),
  (req, res) => {
    const code = normalizeCode(req.body && req.body.code);

    if (!new RegExp(`^[A-Z0-9]{${config.CODE_LENGTH}}$`).test(code)) {
      return res.status(400).json({
        ok: false,
        code: 'BAD_FORMAT',
        message: `邀请码应为 ${config.CODE_LENGTH} 位字符`,
      });
    }

    const row = db.get('SELECT * FROM invite_codes WHERE code = ?', [code]);
    const state = db.effectiveState(row);

    if (!row || state === null) {
      return res.status(404).json({
        ok: false,
        code: 'NOT_FOUND',
        message: '邀请码无效，请核对后重试',
      });
    }
    if (state === 'banned') {
      return res.status(403).json({
        ok: false,
        code: 'BANNED',
        message: '该邀请码已被封禁，如有疑问请联系主办方',
      });
    }
    if (state === 'used') {
      return res.status(400).json({
        ok: false,
        code: 'USED',
        message: '该邀请码已被使用，一码仅限报名一次',
      });
    }
    if (state === 'expired') {
      return res.status(410).json({
        ok: false,
        code: 'EXPIRED',
        message: '该邀请码已过期',
      });
    }

    const token = tokens.createInviteSession({ codeId: row.id, code: row.code });

    res.json({
      ok: true,
      token,
      expiresInMs: config.INVITE_TTL_MS,
      code: maskCode(row.code),
      activity: config.ACTIVITY.name,
      message: '验证通过，请填写报名信息',
    });
  }
);

// GET /api/register/info  凭有效邀请码会话获取报名页上下文
router.get('/register/info', requireInvite, (req, res) => {
  const row = db.get('SELECT * FROM invite_codes WHERE id = ?', [
    req.inviteSession.codeId,
  ]);
  const state = db.effectiveState(row);
  if (state !== 'unused') {
    return res.status(403).json({
      ok: false,
      code: state.toUpperCase(),
      message: '邀请码状态已变更，无法继续报名',
    });
  }

  const reg = db.get('SELECT id FROM registrations WHERE code_id = ?', [row.id]);
  if (reg) {
    return res.status(400).json({
      ok: false,
      code: 'USED',
      message: '该邀请码已完成报名',
    });
  }

  res.json({
    ok: true,
    activity: config.ACTIVITY.name,
    code: maskCode(row.code),
    fields: config.ACTIVITY.fields,
  });
});

// POST /api/register  提交报名表（必须携带有效邀请码 token）
router.post(
  '/register',
  requireInvite,
  rateLimit({ windowMs: 60 * 1000, max: 6, prefix: 'register' }),
  (req, res) => {
    const { codeId } = req.inviteSession;

    const body = req.body || {};
    const f = config.ACTIVITY.fields;

    const name = String(body.name || '').trim();
    const phone = String(body.phone || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const company = String(body.company || '').trim();
    const remark = String(body.remark || '').trim();

    const errors = [];
    if (!name || name.length > f.nameMax) {
      errors.push({ field: 'name', message: `请输入姓名（最多 ${f.nameMax} 字）` });
    }
    if (!new RegExp(f.phonePattern).test(phone)) {
      errors.push({ field: 'phone', message: '请输入有效的 11 位手机号' });
    }
    if (email && (email.length > f.emailMax || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      errors.push({ field: 'email', message: '请输入有效的邮箱地址' });
    }
    if (company.length > f.companyMax) {
      errors.push({ field: 'company', message: `单位名称最多 ${f.companyMax} 字` });
    }
    if (remark.length > f.remarkMax) {
      errors.push({ field: 'remark', message: `备注最多 ${f.remarkMax} 字` });
    }
    if (errors.length) {
      return res.status(422).json({ ok: false, code: 'VALIDATION', errors });
    }

    // 事务：再次校验码状态 -> 写报名 -> 标记已用，防止并发重复报名
    let result;
    try {
      result = db.tx(() => {
        const codeRow = db.get('SELECT * FROM invite_codes WHERE id = ?', [codeId]);
        const state = db.effectiveState(codeRow);
        if (!codeRow) {
          const e = new Error('邀请码不存在');
          e.httpStatus = 404;
          e.apiCode = 'NOT_FOUND';
          throw e;
        }
        if (state === 'banned') {
          const e = new Error('邀请码已被封禁');
          e.httpStatus = 403;
          e.apiCode = 'BANNED';
          throw e;
        }
        if (state === 'used') {
          const e = new Error('邀请码已使用');
          e.httpStatus = 400;
          e.apiCode = 'USED';
          throw e;
        }
        if (state === 'expired') {
          const e = new Error('邀请码已过期');
          e.httpStatus = 410;
          e.apiCode = 'EXPIRED';
          throw e;
        }

        const dup = db.get('SELECT id FROM registrations WHERE code_id = ?', [codeId]);
        if (dup) {
          const e = new Error('邀请码已使用');
          e.httpStatus = 400;
          e.apiCode = 'USED';
          throw e;
        }

        const now = Date.now();
        db.runTx(
          `INSERT INTO registrations
             (code_id, code_value, name, phone, email, company, remark, ip, user_agent, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            codeRow.id,
            codeRow.code,
            name,
            phone,
            email,
            company,
            remark,
            (req.ip || '').slice(0, 64),
            (req.headers['user-agent'] || '').slice(0, 300),
            now,
          ]
        );
        const regId = db.get('SELECT last_insert_rowid() AS id').id;

        db.runTx(
          'UPDATE invite_codes SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL',
          [now, regId, codeRow.id]
        );

        return { regId, code: codeRow.code };
      });
    } catch (e) {
      if (e.httpStatus) {
        // 状态变更后，该邀请会话立即失效
        tokens.revokeByCodeId(codeId);
        return res
          .status(e.httpStatus)
          .json({ ok: false, code: e.apiCode, message: e.message });
      }
      throw e;
    }

    db.persistNow();
    // 报名完成后撤销该邀请会话，防止 token 复用
    tokens.revokeByCodeId(codeId);

    res.json({
      ok: true,
      message: '报名成功！我们会通过短信/邮件通知后续安排',
      registrationId: result.regId,
    });
  }
);

module.exports = router;
