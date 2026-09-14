'use strict';

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const crypto = require('crypto');
const config = require('./config');

let SQL, db;
let saveTimer = null;
let dirty = false;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS invite_codes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'active',   -- active | banned
  batch_id      TEXT NOT NULL,
  created_by    INTEGER,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER,                          -- NULL = 永久有效
  used_at       INTEGER,
  used_by       INTEGER,
  remark        TEXT DEFAULT '',
  FOREIGN KEY (created_by) REFERENCES admins(id)
);

CREATE TABLE IF NOT EXISTS registrations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code_id     INTEGER NOT NULL,
  code_value  TEXT NOT NULL,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,
  email       TEXT DEFAULT '',
  company     TEXT DEFAULT '',
  remark      TEXT DEFAULT '',
  ip          TEXT DEFAULT '',
  user_agent  TEXT DEFAULT '',
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (code_id) REFERENCES invite_codes(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_codes_code ON invite_codes(code);
CREATE INDEX IF NOT EXISTS idx_codes_batch ON invite_codes(batch_id);
CREATE INDEX IF NOT EXISTS idx_codes_status ON invite_codes(status);
CREATE INDEX IF NOT EXISTS idx_reg_phone ON registrations(phone);
CREATE INDEX IF NOT EXISTS idx_reg_created ON registrations(created_at);

CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
`;

function persist() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!dirty) return;
    try {
      const data = db.export();
      fs.mkdirSync(path.dirname(config.DB_FILE), { recursive: true });
      const tmp = config.DB_FILE + '.tmp';
      fs.writeFileSync(tmp, Buffer.from(data));
      fs.renameSync(tmp, config.DB_FILE);
      dirty = false;
    } catch (err) {
      console.error('[db] persist failed:', err.message);
    }
  }, 200);
}

// 立即落盘（用于关键操作）
function persistNow() {
  persist();
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const data = db.export();
  fs.mkdirSync(path.dirname(config.DB_FILE), { recursive: true });
  const tmp = config.DB_FILE + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(data));
  fs.renameSync(tmp, config.DB_FILE);
  dirty = false;
}

async function init() {
  // require.resolve('sql.js') 指向 dist/sql-wasm.js，wasm 与其同目录
  const SQL_DIST_DIR = path.dirname(require.resolve('sql.js'));
  SQL = await initSqlJs({
    locateFile: (file) => path.join(SQL_DIST_DIR, file),
  });

  if (fs.existsSync(config.DB_FILE)) {
    const fileBuffer = fs.readFileSync(config.DB_FILE);
    db = new SQL.Database(fileBuffer);
  } else {
    fs.mkdirSync(path.dirname(config.DB_FILE), { recursive: true });
    db = new SQL.Database();
  }

  db.run(SCHEMA);

  // 首次启动：创建默认管理员
  const row = get('SELECT COUNT(*) AS c FROM admins');
  if (row.c === 0) {
    const { salt, hash } = hashPassword(config.ADMIN_PASSWORD);
    run(
      'INSERT INTO admins (username, password_salt, password_hash, created_at) VALUES (?,?,?,?)',
      [config.ADMIN_USERNAME, salt, hash, Date.now()]
    );
    console.log(
      `[init] 已创建默认管理员: ${config.ADMIN_USERNAME} / ${config.ADMIN_PASSWORD}（请尽快修改）`
    );
  }

  persistNow();
  return db;
}

function run(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.run(params);
  } finally {
    stmt.free();
  }
  persist();
}

function tx(fn) {
  db.run('BEGIN');
  try {
    const result = fn();
    db.run('COMMIT');
    persist();
    return result;
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
}

// 事务内执行（不单独触发 persist）
function runTx(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.run(params);
  } finally {
    stmt.free();
  }
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  let row = null;
  try {
    stmt.bind(params);
    if (stmt.step()) row = stmt.getAsObject();
  } finally {
    stmt.free();
  }
  return row;
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  const rows = [];
  try {
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return rows;
}

// ---- 管理员密码 ----
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expected) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- 邀请码状态 ----
// 有效态: unused（未使用）；终态/拦截态: used / expired / banned
function effectiveState(codeRow, now = Date.now()) {
  if (!codeRow) return null;
  if (codeRow.status === 'banned') return 'banned';
  if (codeRow.used_at) return 'used';
  if (codeRow.expires_at != null && codeRow.expires_at < now) return 'expired';
  return 'unused';
}

module.exports = {
  init,
  run,
  tx,
  runTx,
  get,
  all,
  persistNow,
  hashPassword,
  verifyPassword,
  effectiveState,
};
