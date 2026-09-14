'use strict';

(function () {
  const form = document.getElementById('verifyForm');
  const input = document.getElementById('codeInput');
  const btn = document.getElementById('submitBtn');
  const alertEl = document.getElementById('alert');
  const codeError = document.getElementById('codeError');

  // 输入时按 4-4-4 分组展示
  input.addEventListener('input', () => {
    let v = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    input.value = v.replace(/(.{4})(?=.)/g, '$1-');
    input.classList.remove('invalid');
    codeError.classList.remove('show');
    hideAlert(alertEl);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert(alertEl);
    codeError.classList.remove('show');

    const raw = input.value.replace(/[\s-]/g, '');
    if (raw.length !== 12) {
      input.classList.add('invalid');
      codeError.textContent = '请输入完整的 12 位邀请码';
      codeError.classList.add('show');
      return;
    }

    btn.disabled = true;
    btn.textContent = '验证中…';
    try {
      const data = await Api.post('/api/verify', { code: raw });
      Store.set('invite_token', data.token);
      // 直接跳转报名页
      window.location.href = '/register';
    } catch (err) {
      const code = err.data && err.data.code;
      const map = {
        NOT_FOUND: '邀请码无效，请核对后重试',
        BANNED: '该邀请码已被封禁，如有疑问请联系主办方',
        USED: '该邀请码已被使用，一码仅限报名一次',
        EXPIRED: '该邀请码已过期',
        BAD_FORMAT: '邀请码格式不正确',
        TOO_MANY_REQUESTS: '尝试次数过多，请稍后再试',
      };
      showAlert(alertEl, map[code] || err.message, code === 'BANNED' || code === 'EXPIRED' ? 'info' : 'error');
      input.classList.add('invalid');
    } finally {
      btn.disabled = false;
      btn.textContent = '验证并进入报名';
    }
  });

  input.focus();
})();
