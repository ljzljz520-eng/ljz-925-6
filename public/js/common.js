'use strict';

window.Api = (function () {
  function request(method, url, body, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    const token = opts.token;
    if (token) headers.Authorization = 'Bearer ' + token;

    let payload;
    if (body !== undefined && body !== null) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    return fetch(url, { method, headers, body: payload }).then(async (res) => {
      let data = null;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        data = await res.json();
      } else {
        data = { ok: res.ok, raw: await res.text() };
      }
      if (!res.ok) {
        const err = new Error(data.message || '请求失败 (' + res.status + ')');
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    });
  }

  return {
    get: (url, opts) => request('GET', url, null, opts),
    post: (url, body, opts) => request('POST', url, body, opts),
  };
})();

window.Store = {
  get(k) {
    try { return localStorage.getItem(k); } catch (e) { return null; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch (e) {}
  },
  del(k) {
    try { localStorage.removeItem(k); } catch (e) {}
  },
};

window.fmtTime = function (ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

window.escapeHtml = function (s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
};

window.showAlert = function (el, message, type) {
  el.textContent = message;
  el.className = 'alert show ' + (type || 'error');
};
window.hideAlert = function (el) {
  el.className = 'alert';
  el.textContent = '';
};

let toastTimer = null;
window.toast = function (message) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
};
