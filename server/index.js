'use strict';

const path = require('path');
const express = require('express');
const config = require('./config');
const db = require('./db');
const middleware = require('./middleware');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');

async function main() {
  await db.init();

  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // 基础安全响应头
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  const jsonParser = express.json({ limit: '100kb' });
  app.use((req, res, next) => {
    jsonParser(req, res, (err) => {
      if (err) {
        return res
          .status(400)
          .json({ ok: false, message: '请求体不是合法的 JSON' });
      }
      next();
    });
  });
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  // 静态前端
  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      index: false,
      maxAge: '1h',
    })
  );

  // 路由
  app.use('/api', publicRoutes);
  app.use('/api/admin', adminRoutes);

  // 页面路由（前端入口）
  app.get('/', (req, res) =>
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'))
  );
  app.get('/register', (req, res) =>
    res.sendFile(path.join(__dirname, '..', 'public', 'register.html'))
  );
  app.get(['/admin', '/admin/'], (req, res) =>
    res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'))
  );

  app.use(middleware.notFound);
  app.use(middleware.errorHandler);

  app.listen(config.PORT, config.HOST, () => {
    console.log(`[server] 活动报名系统已启动: http://localhost:${config.PORT}`);
    console.log(`[server] 用户验码页: /   报名页: /register   管理后台: /admin`);
  });
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
