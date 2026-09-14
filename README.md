# 活动报名邀请码系统

邀请制活动报名：用户**必须凭有效邀请码**才能进入报名表并提交报名；管理员后台支持
**批量生成 12 位邀请码、状态统计（未使用 / 已使用 / 已过期 / 已封禁）、封禁解封、导出报名名单 CSV**。

技术栈：Node.js + Express 5 + sql.js（SQLite，文件持久化）+ 原生前端，无额外构建步骤。

## 快速开始

```bash
npm install        # 工作区已含 express / sql.js
npm start          # http://localhost:3000
```

- 用户验码页：http://localhost:3000/
- 报名页（需验码）：http://localhost:3000/register
- 管理后台：http://localhost:3000/admin ，默认账号 `admin` / `admin123456`

管理员账号可用环境变量覆盖（见 `.env.example`，可用 `env $(cat .env | xargs) npm start` 方式注入）：

```
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-strong-password
PORT=3000
```

> 首次启动自动建库建表（`data/app.db`）并创建默认管理员。**生产部署请务必修改默认密码。**

## 核心业务规则

### 邀请码

- 12 位，字符集 `ABCDEFGHJKMNPQRSTUVWXYZ23456789`（去除易混字符 0/1/O/I/L），
  前端按 `XXXX-XXXX-XXXX` 分组展示；校验时自动转大写、忽略连字符与空格。
- 生成时按批次管理，可设置有效期（天）或永久有效；单批最多 1000 个，数据库唯一约束防碰撞。
- 状态机（按优先级）：
  - `banned` 已封禁（管理员手动，可解封）
  - `used` 已使用（报名成功后置位，终态）
  - `expired` 已过期（超过 `expires_at` 动态判定，不入库冗余）
  - `unused` 未使用（可报名）

### 访问控制（重点）

- `POST /api/verify` 校验邀请码：无效 / 已用 / 过期 / 封禁分别返回明确错误码。
- 验码通过后颁发**短期会话 token（2 小时）**；前端只把它存于 localStorage，
  **直接访问 `/register` 或直接调用报名 API 而无 token，一律 `401 NO_INVITE` 拒绝并跳回验码页**。
- 报名 `POST /api/register` 双重防护：
  1. `requireInvite` 中间件强制校验 Bearer token；
  2. 数据库事务内重新校验码状态 + 查重，提交成功立即置 `used_at` 并吊销该码全部会话，
     防止并发 / 重放导致一码多报。
- 所有 `/api/admin/*` 接口均需管理员 Bearer token（登录后 12 小时有效），
  包括 CSV 导出接口——未登录直接请求导出同样 401。

### 管理员功能

- 概览：总数 / 未使用 / 已使用 / 已过期 / 已封禁 / 报名人数 + 近 7 天报名趋势。
- 批量生成：数量、有效期、备注；生成后可一键复制或导出该批次。
- 邀请码管理：按状态、批次、码片段筛选；单码封禁 / 解封（封禁后该码已发会话立即失效）。
- 报名名单：按姓名 / 手机 / 邮箱 / 单位 / 码搜索，分页浏览。
- 导出：
  - `GET /api/admin/export/registrations.csv` 报名名单（含码、批次、时间、IP，UTF-8 BOM 兼容 Excel）
  - `GET /api/admin/export/codes.csv?batchId=&state=` 邀请码清单

## API 一览

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/verify` | 无 | 校验邀请码，返回 invite token |
| GET | `/api/register/info` | invite | 获取报名页上下文（无 token 即 401） |
| POST | `/api/register` | invite | 提交报名，成功后码置为已用、token 吊销 |
| POST | `/api/admin/login` | 无 | 管理员登录（限流） |
| POST | `/api/admin/logout` | admin | 退出登录 |
| GET | `/api/admin/me` | admin | 当前会话 |
| GET | `/api/admin/stats` | admin | 状态统计 |
| POST | `/api/admin/batches` | admin | 批量生成 `{count, validDays, remark}` |
| GET | `/api/admin/batches` | admin | 批次列表 |
| GET | `/api/admin/codes` | admin | 码列表 `?state=&batchId=&keyword=&page=` |
| POST | `/api/admin/codes/:id/ban` / `/unban` | admin | 封禁 / 解封 |
| GET | `/api/admin/registrations` | admin | 报名名单 |
| GET | `/api/admin/export/registrations.csv` | admin | 导出报名 CSV |
| GET | `/api/admin/export/codes.csv` | admin | 导出邀请码 CSV |

## 其他安全措施

- 管理员密码：`scrypt + 随机 salt` 存储，登录常量时间比较；登录 / 验码 / 报名接口有基于 IP 的限流。
- 全部 SQL 使用参数化绑定；安全响应头 `X-Frame-Options / X-Content-Type-Options / Referrer-Policy`。
- SQLite 通过 `sql.js` 写内存 + 防抖落盘（关键操作立即 fsync 式落盘，临时文件 rename 原子替换）。

## 目录结构

```
server/
  index.js          Express 入口
  config.js         配置（码长度、字符集、TTL、初始管理员）
  db.js             sql.js 初始化 / 建表 / 持久化 / 密码哈希 / 状态判定
  tokens.js         内存会话（invite / admin token）
  middleware.js     鉴权、限流、错误处理
  routes/public.js  验码 + 报名
  routes/admin.js   登录 + 统计 + 批次 + 码管理 + 名单 + CSV 导出
public/
  index.html        用户验码页
  register.html     报名表（无 token 自动踢回）
  admin.html        管理后台
  css/style.css
  js/{common,verify,register,admin}.js
data/app.db         运行后生成（已被 .gitignore 忽略，注意备份）
```
