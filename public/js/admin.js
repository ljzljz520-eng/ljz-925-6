'use strict';

(function () {
  const TOKEN_KEY = 'admin_token';
  const USER_KEY = 'admin_username';
  let token = Store.get(TOKEN_KEY);
  let currentTab = 'dashboard';

  // 码列表状态
  let codePage = 1;
  const codePageSize = 20;
  let lastBatchId = '';

  // 名单状态
  let regPage = 1;
  const regPageSize = 20;

  const STATE_TEXT = { unused: '未使用', used: '已使用', expired: '已过期', banned: '已封禁' };

  const $ = (id) => document.getElementById(id);

  // ---------- 工具 ----------
  function api(method, url, body) {
    return Api[method](url, body, { token });
  }

  function downloadWithToken(url) {
    // CSV 导出：用隐藏表单或带 token 的 fetch 下载
    return fetch(url, { headers: { Authorization: 'Bearer ' + token } })
      .then((res) => {
        if (!res.ok) throw new Error('导出失败 (' + res.status + ')');
        return res.blob().then((blob) => ({ blob, cd: res.headers.get('content-disposition') || '' }));
      })
      .then(({ blob, cd }) => {
        const m = cd.match(/filename="?([^";]+)"?/);
        const name = m ? m[1] : 'export.csv';
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(a.href);
      });
  }

  function showLogin(clearToken) {
    if (clearToken) {
      Store.del(TOKEN_KEY);
      Store.del(USER_KEY);
      token = null;
    }
    $('dashView').style.display = 'none';
    $('loginView').style.display = '';
  }

  function showDash() {
    $('loginView').style.display = 'none';
    $('dashView').style.display = 'block';
    $('currentUser').textContent = Store.get(USER_KEY) || '';
    switchTab('dashboard');
  }

  function badge(state) {
    return `<span class="badge ${state}">${STATE_TEXT[state] || state}</span>`;
  }

  // ---------- 登录 / 退出 ----------
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const alertEl = $('loginAlert');
    hideAlert(alertEl);
    const btn = $('loginBtn');
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      const data = await Api.post('/api/admin/login', {
        username: $('loginUser').value.trim(),
        password: $('loginPass').value,
      });
      token = data.token;
      Store.set(TOKEN_KEY, token);
      Store.set(USER_KEY, data.username);
      $('loginPass').value = '';
      showDash();
    } catch (err) {
      showAlert(alertEl, err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '登 录';
    }
  });

  $('logoutBtn').addEventListener('click', async () => {
    try { await api('post', '/api/admin/logout'); } catch (e) {}
    showLogin(true);
  });

  // ---------- Tab 切换 ----------
  function switchTab(name) {
    currentTab = name;
    document.querySelectorAll('#tabs .tab').forEach((t) =>
      t.classList.toggle('active', t.dataset.tab === name)
    );
    ['dashboard', 'codes', 'batches', 'registrations'].forEach((n) => {
      $('tab-' + n).style.display = n === name ? 'block' : 'none';
    });
    if (name === 'dashboard') loadStats();
    if (name === 'codes') { codePage = 1; loadCodes(); }
    if (name === 'batches') loadBatches();
    if (name === 'registrations') { regPage = 1; loadRegistrations(); }
  }
  document.querySelectorAll('#tabs .tab').forEach((t) =>
    t.addEventListener('click', () => switchTab(t.dataset.tab))
  );

  // ---------- 统计 ----------
  async function loadStats() {
    try {
      const { stats } = await api('get', '/api/admin/stats');
      $('stTotal').textContent = stats.total;
      $('stUnused').textContent = stats.unused;
      $('stUsed').textContent = stats.used;
      $('stExpired').textContent = stats.expired;
      $('stBanned').textContent = stats.banned;
      $('stReg').textContent = stats.registered;

      const entries = Object.entries(stats.recentDays);
      const max = Math.max(1, ...entries.map(([, v]) => v));
      $('trendChart').innerHTML = entries
        .map(([day, num]) => {
          const h = Math.round((num / max) * 100);
          return `<div class="bar-col">
            <span class="bar-num">${num}</span>
            <div class="bar" style="height:${h}%"></div>
            <span class="bar-label">${escapeHtml(day)}</span>
          </div>`;
        })
        .join('');
    } catch (err) {
      if (err.status === 401) return showLogin(true);
      toast(err.message);
    }
  }
  $('refreshStats').addEventListener('click', loadStats);

  // ---------- 邀请码列表 ----------
  function codeQuery(page) {
    const q = new URLSearchParams({ page, pageSize: codePageSize });
    const state = $('codeState').value;
    const batch = $('codeBatch').value.trim();
    const kw = $('codeKeyword').value.trim();
    if (state !== 'all') q.set('state', state);
    if (batch) q.set('batchId', batch);
    if (kw) q.set('keyword', kw);
    return '/api/admin/codes?' + q.toString();
  }

  async function loadCodes() {
    try {
      const data = await api('get', codeQuery(codePage));
      const tbody = $('codesTbody');
      if (!data.total) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-sub);padding:28px">暂无数据</td></tr>';
      } else {
        tbody.innerHTML = data.items
          .map((c) => {
            const regInfo = c.registeredName
              ? `${escapeHtml(c.registeredName)}<br><span class="muted">${escapeHtml(c.registeredPhone || '')}</span>`
              : '—';
            const action =
              c.state === 'banned'
                ? `<button class="btn ghost" data-act="unban" data-id="${c.id}">解封</button>`
                : c.state === 'used'
                ? '<span class="muted">—</span>'
                : `<button class="btn ghost danger-text" data-act="ban" data-id="${c.id}">封禁</button>`;
            return `<tr>
              <td class="code-mono">${escapeHtml(c.codeMasked)}</td>
              <td>${badge(c.state)}</td>
              <td><span class="muted">${escapeHtml(c.batchId)}</span></td>
              <td>${fmtTime(c.createdAt)}</td>
              <td>${c.expiresAt ? fmtTime(c.expiresAt) : '永久'}</td>
              <td>${c.usedAt ? fmtTime(c.usedAt) : '—'}</td>
              <td>${regInfo}</td>
              <td>${action}</td>
            </tr>`;
          })
          .join('');
      }
      const start = data.total ? (codePage - 1) * codePageSize + 1 : 0;
      const end = Math.min(codePage * codePageSize, data.total);
      $('codesInfo').textContent = `第 ${start}-${end} 条 / 共 ${data.total} 条`;
      $('codesPrev').disabled = codePage <= 1;
      $('codesNext').disabled = end >= data.total;
    } catch (err) {
      if (err.status === 401) return showLogin(true);
      toast(err.message);
    }
  }

  $('codesTbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    const label = act === 'ban' ? '封禁后该码将无法用于报名，确认封禁？' : '确认解封该邀请码？';
    if (!window.confirm(label)) return;
    try {
      await api('post', `/api/admin/codes/${id}/${act}`);
      toast(act === 'ban' ? '已封禁' : '已解封');
      loadCodes();
      loadStats();
    } catch (err) {
      toast(err.message);
    }
  });

  $('codeSearchBtn').addEventListener('click', () => { codePage = 1; loadCodes(); });
  $('codeResetBtn').addEventListener('click', () => {
    $('codeState').value = 'all';
    $('codeBatch').value = '';
    $('codeKeyword').value = '';
    codePage = 1;
    loadCodes();
  });
  $('codeKeyword').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { codePage = 1; loadCodes(); }
  });
  $('codesPrev').addEventListener('click', () => { if (codePage > 1) { codePage -= 1; loadCodes(); } });
  $('codesNext').addEventListener('click', () => { codePage += 1; loadCodes(); });
  $('codeState').addEventListener('change', () => { codePage = 1; loadCodes(); });

  $('exportCodesBtn').addEventListener('click', () => {
    const q = new URLSearchParams();
    const state = $('codeState').value;
    const batch = $('codeBatch').value.trim();
    const kw = $('codeKeyword').value.trim();
    if (state !== 'all') q.set('state', state);
    if (batch) q.set('batchId', batch);
    if (kw) q.set('keyword', kw);
    // keyword 不支持于导出接口，忽略以免误导；按状态+批次导出
    q.delete('keyword');
    toast('正在导出…');
    downloadWithToken('/api/admin/export/codes.csv?' + q.toString()).catch((e) => toast(e.message));
  });

  // ---------- 批量生成 ----------
  $('genBtn').addEventListener('click', async () => {
    const count = parseInt($('genCount').value, 10);
    const rawDays = $('genDays').value.trim();
    const validDays = rawDays === '-1' ? null : parseInt(rawDays, 10);
    const remark = $('genRemark').value.trim();

    if (!count || count < 1 || count > 1000) return toast('生成数量需在 1-1000 之间');
    if (validDays !== null && (Number.isNaN(validDays) || validDays < 1)) return toast('有效期需为正整数，或填 -1 表示永久');
    if (!window.confirm(`确认生成 ${count} 个邀请码？`)) return;

    const btn = $('genBtn');
    btn.disabled = true;
    try {
      const data = await api('post', '/api/admin/batches', { count, validDays, remark });
      openBatchModal(data.batchId, data.codes);
      toast(`成功生成 ${data.count} 个码`);
      loadStats();
    }  catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  function maskCode(c) {
    return c.replace(/(.{4})(?=.)/g, '$1-');
  }

  function openBatchModal(batchId, codes) {
    lastBatchId = batchId;
    $('batchModalId').textContent = batchId;
    $('batchModalCodes').textContent = codes.map(maskCode).join('\n');
    $('batchModal').classList.add('show');
  }
  $('batchModalClose').addEventListener('click', () => $('batchModal').classList.remove('show'));
  $('batchModal').addEventListener('click', (e) => {
    if (e.target === $('batchModal')) $('batchModal').classList.remove('show');
  });
  $('copyCodesBtn').addEventListener('click', async () => {
    const text = $('batchModalCodes').textContent;
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制 ' + text.split('\n').length + ' 个邀请码');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('已复制');
    }
  });
  $('exportBatchBtn').addEventListener('click', () => {
    downloadWithToken('/api/admin/export/codes.csv?batchId=' + encodeURIComponent(lastBatchId))
      .catch((e) => toast(e.message));
  });

  // ---------- 批次列表 ----------
  async function loadBatches() {
    try {
      const { items } = await api('get', '/api/admin/batches');
      const tbody = $('batchesTbody');
      if (!items.length) {
        tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--text-sub);padding:28px">暂无批次，先生成一批吧</td></tr>';
        return;
      }
      tbody.innerHTML = items
        .map((b) => `<tr>
          <td class="code-mono" style="font-size:12px">${escapeHtml(b.batchId)}</td>
          <td>${escapeHtml(b.remark || '—')}</td>
          <td>${escapeHtml(b.creator || '—')}</td>
          <td><strong>${b.total}</strong></td>
          <td><span class="badge unused">${b.unused}</span></td>
          <td><span class="badge used">${b.used}</span></td>
          <td><span class="badge expired">${b.expired}</span></td>
          <td><span class="badge banned">${b.banned}</span></td>
          <td>${fmtTime(b.createdAt)}</td>
          <td>${b.expiresAt ? fmtTime(b.expiresAt) : '永久'}</td>
          <td>
            <button class="btn ghost" data-viewbatch="${escapeHtml(b.batchId)}">查看码 / 过滤</button>
          </td>
        </tr>`)
        .join('');
    } catch (err) {
      if (err.status === 401) return showLogin(true);
      toast(err.message);
    }
  }
  $('batchesTbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-viewbatch]');
    if (!btn) return;
    const batchId = btn.dataset.viewbatch;
    // 切到邀请码管理并按批次过滤
    $('codeBatch').value = batchId;
    $('codeState').value = 'all';
    $('codeKeyword').value = '';
    switchTab('codes');
  });

  // ---------- 报名名单 ----------
  function regQuery(page) {
    const q = new URLSearchParams({ page, pageSize: regPageSize });
    const kw = $('regKeyword').value.trim();
    if (kw) q.set('keyword', kw);
    return '/api/admin/registrations?' + q.toString();
  }

  async function loadRegistrations() {
    try {
      const data = await api('get', regQuery(regPage));
      const tbody = $('regsTbody');
      if (!data.total) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-sub);padding:28px">暂无报名记录</td></tr>';
      } else {
        tbody.innerHTML = data.items
          .map((r) => `<tr>
            <td>${r.id}</td>
            <td class="code-mono">${escapeHtml(r.code)}</td>
            <td>${escapeHtml(r.name)}</td>
            <td>${escapeHtml(r.phone)}</td>
            <td>${escapeHtml(r.email || '—')}</td>
            <td>${escapeHtml(r.company || '—')}</td>
            <td class="wrap">${escapeHtml(r.remark || '—')}</td>
            <td>${fmtTime(r.createdAt)}</td>
          </tr>`)
          .join('');
      }
      const start = data.total ? (regPage - 1) * regPageSize + 1 : 0;
      const end = Math.min(regPage * regPageSize, data.total);
      $('regsInfo').textContent = `第 ${start}-${end} 条 / 共 ${data.total} 条`;
      $('regsPrev').disabled = regPage <= 1;
      $('regsNext').disabled = end >= data.total;
    } catch (err) {
      if (err.status === 401) return showLogin(true);
      toast(err.message);
    }
  }

  $('regSearchBtn').addEventListener('click', () => { regPage = 1; loadRegistrations(); });
  $('regResetBtn').addEventListener('click', () => { $('regKeyword').value = ''; regPage = 1; loadRegistrations(); });
  $('regKeyword').addEventListener('keydown', (e) => { if (e.key === 'Enter') { regPage = 1; loadRegistrations(); } });
  $('regsPrev').addEventListener('click', () => { if (regPage > 1) { regPage -= 1; loadRegistrations(); } });
  $('regsNext').addEventListener('click', () => { regPage += 1; loadRegistrations(); });

  $('exportRegBtn').addEventListener('click', () => {
    const kw = $('regKeyword').value.trim();
    const q = new URLSearchParams();
    if (kw) q.set('keyword', kw);
    toast('正在导出…');
    downloadWithToken('/api/admin/export/registrations.csv?' + q.toString()).catch((e) => toast(e.message));
  });

  // ---------- 启动：校验已有 token ----------
  if (token) {
    Api.get('/api/admin/me', { token })
      .then(showDash)
      .catch(() => showLogin(true));
  } else {
    showLogin(false);
  }
})();
