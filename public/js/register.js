'use strict';

(function () {
  const token = Store.get('invite_token');

  // 没有邀请码会话，直接拒绝并回到验码页
  function kickOut(message) {
    Store.del('invite_token');
    const back = encodeURIComponent('/register');
    // 给出短暂提示后跳回
    document.body.innerHTML =
      '<main class="page"><div class="card" style="text-align:center;padding:40px 28px">' +
      '<div style="font-size:40px">🔒</div>' +
      '<h1 style="font-size:18px;margin:14px 0 8px">请先输入邀请码</h1>' +
      '<p class="muted">' + (message || '报名需要有效的邀请码，正在返回验证页…') + '</p>' +
      '</div></main>';
    setTimeout(() => {
      window.location.href = '/?next=' + back;
    }, 1600);
  }

  if (!token) return kickOut();

  const form = document.getElementById('regForm');
  const btn = document.getElementById('submitBtn');
  const alertEl = document.getElementById('alert');
  const codeTip = document.getElementById('codeTip');
  const formCard = document.getElementById('formCard');
  const successCard = document.getElementById('successCard');

  function setFieldError(field, msg) {
    const el = document.querySelector(`.field-error[data-for="${field}"]`);
    const input = document.getElementById(field);
    if (msg) {
      el.textContent = msg;
      el.classList.add('show');
      input.classList.add('invalid');
    } else {
      el.classList.remove('show');
      input.classList.remove('invalid');
    }
  }

  async function loadInfo() {
    try {
      const data = await Api.get('/api/register/info', { token });
      document.getElementById('activityName').textContent = data.activity;
      codeTip.textContent = '邀请码 ' + data.code + ' 验证有效，请在 2 小时内完成报名';
    } catch (err) {
      const code = err.data && err.data.code;
      if (err.status === 401) return kickOut('邀请码缺失或已失效，正在返回验证页…');
      if (code === 'USED') return kickOut('该邀请码已完成报名');
      if (code === 'BANNED') return kickOut('该邀请码已被封禁');
      if (code === 'EXPIRED') return kickOut('该邀请码已过期');
      codeTip.className = 'alert show error';
      codeTip.textContent = err.message;
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert(alertEl);
    ['name', 'phone', 'email', 'company', 'remark'].forEach((f) => setFieldError(f, ''));

    const payload = {
      name: document.getElementById('name').value.trim(),
      phone: document.getElementById('phone').value.trim(),
      email: document.getElementById('email').value.trim(),
      company: document.getElementById('company').value.trim(),
      remark: document.getElementById('remark').value.trim(),
    };

    let bad = false;
    if (!payload.name) { setFieldError('name', '请输入姓名'); bad = true; }
    if (!/^1[3-9]\d{9}$/.test(payload.phone)) { setFieldError('phone', '请输入有效的 11 位手机号'); bad = true; }
    if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
      setFieldError('email', '请输入有效的邮箱'); bad = true;
    }
    if (bad) return;

    btn.disabled = true;
    btn.textContent = '提交中…';
    try {
      const data = await Api.post('/api/register', payload, { token });
      Store.del('invite_token');
      formCard.style.display = 'none';
      successCard.style.display = 'block';
      document.getElementById('successMsg').textContent = data.message;
      document.getElementById('regId').textContent = String(data.registrationId).padStart(6, '0');
      window.scrollTo(0, 0);
    } catch (err) {
      const code = err.data && err.data.code;
      if (err.status === 401) return kickOut('邀请码缺失或已失效，正在返回验证页…');
      if (code === 'VALIDATION' && Array.isArray(err.data.errors)) {
        err.data.errors.forEach((x) => setFieldError(x.field, x.message));
        showAlert(alertEl, '请检查表单中标红的字段', 'error');
      } else if (code === 'USED') {
        showAlert(alertEl, '该邀请码已被使用', 'error');
      } else if (code === 'BANNED') {
        showAlert(alertEl, '该邀请码已被封禁', 'error');
      } else if (code === 'EXPIRED') {
        showAlert(alertEl, '该邀请码已过期', 'error');
      } else {
        showAlert(alertEl, err.message, 'error');
      }
    } finally {
      btn.disabled = false;
      btn.textContent = '提交报名';
    }
  });

  loadInfo();
})();
