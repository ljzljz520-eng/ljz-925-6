'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');

module.exports = {
  PORT: parseInt(process.env.PORT, 10) || 3000,
  HOST: process.env.HOST || '0.0.0.0',
  DATA_DIR: process.env.DATA_DIR || path.join(ROOT, 'data'),
  DB_FILE: process.env.DB_FILE || path.join(ROOT, 'data', 'app.db'),

  // 邀请码参数：12 位，4-4-4 分组展示
  CODE_LENGTH: 12,
  CODE_GROUP: 4,
  // 排除易混字符 0/1/O/I/L
  CODE_ALPHABET: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
  MAX_BATCH: 1000,
  DEFAULT_CODE_VALID_DAYS: 30,

  // Token 有效期
  INVITE_TTL_MS: 2 * 60 * 60 * 1000,       // 验码成功后 2 小时内可提交报名表
  ADMIN_TTL_MS: 12 * 60 * 60 * 1000,       // 管理员会话 12 小时

  // 初始管理员（首次启动自动创建，生产环境请用环境变量覆盖）
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin123456',

  ACTIVITY: {
    name: '2026 秋季创新峰会',
    fields: {
      nameMax: 30,
      phonePattern: '^1[3-9]\\d{9}$',
      emailMax: 100,
      companyMax: 80,
      remarkMax: 300,
    },
  },
};
