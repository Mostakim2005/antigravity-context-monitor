(() => {
  const REFRESH_MS = 30_000;
  let lastData = null;
  let timer = null;
  let loading = false;

  function getLang() {
    return globalThis.CM_I18N?.getLang?.() || 'en';
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  async function apiGet(path) {
    const f = globalThis.sidecar?.fetch ? globalThis.sidecar.fetch.bind(globalThis.sidecar) : fetch;
    const res = await f(path, { method: 'GET' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  function toneClass(pct) {
    if (typeof pct !== 'number' || !Number.isFinite(pct)) return '';
    if (pct <= 20) return ' is-danger';
    if (pct <= 45) return ' is-warn';
    return '';
  }

  function renderWindowRow(tag, win, lang) {
    if (!win || typeof win.remainingPct !== 'number') {
      return `<div class="q-win"><span class="q-win-tag">${esc(tag)}</span><span class="q-win-empty">—</span></div>`;
    }
    const pct = Math.max(0, Math.min(100, Math.round(win.remainingPct)));
    const resetText = win.resetCountdown
      ? (lang === 'en' ? `↻ ${win.resetCountdown}` : `${win.resetCountdown} 后重置`)
      : '';
    return `
      <div class="q-win">
        <div class="q-win-top">
          <span class="q-win-tag">${esc(tag)}</span>
          <span class="q-win-meta">${resetText ? `<span class="q-reset">${esc(resetText)}</span> · ` : ''}<strong>${pct}%</strong></span>
        </div>
        <div class="q-track"><div class="q-fill${toneClass(pct)}" style="width:${pct}%"></div></div>
      </div>
    `;
  }

  function render() {
    const card = document.getElementById('quotas-card');
    if (!card) return;
    const lang = getLang();
    const titleText = lang === 'en' ? 'Model Quotas (5h & 7d)' : '模型额度（5h / 周额度）';
    const refreshLabel = lang === 'en' ? 'Refresh quotas' : '刷新额度';

    let bodyHtml = '';
    if (!lastData) {
      bodyHtml = `<div class="q-note">${lang === 'en' ? 'Loading quotas…' : '正在获取额度…'}</div>`;
    } else if (!lastData.available || !Array.isArray(lastData.pools) || lastData.pools.length === 0) {
      bodyHtml = `<div class="q-note">${lang === 'en' ? 'Quota telemetry unavailable from LanguageServer.' : '暂未获取到 LanguageServer 额度信息。'}</div>`;
    } else {
      bodyHtml = `<div class="q-pools">${lastData.pools.map((p) => `
        <div class="q-pool">
          <div class="q-pool-name">${esc(p.label)}</div>
          <div class="q-win-grid">
            ${renderWindowRow('5h', p.fiveHour, lang)}
            ${renderWindowRow('7d', p.weekly, lang)}
          </div>
        </div>
      `).join('')}</div>`;
    }

    card.innerHTML = `
      <div class="section-head">
        <span class="section-title">${titleText}</span>
        <button type="button" id="q-refresh-btn" class="q-refresh-btn" title="${refreshLabel}" ${loading ? 'disabled' : ''}>↻</button>
      </div>
      ${bodyHtml}
    `;
    globalThis.CM_SECTIONS?.applyVisibility?.();
  }

  async function fetchQuotas(force = false) {
    if (globalThis.CM_SECTIONS && !globalThis.CM_SECTIONS.isEnabled('quotas')) return;
    if (loading) return;
    loading = true;
    render();
    try {
      lastData = await apiGet(`/api/quotas${force ? '?force=1' : ''}`);
    } catch {
      lastData = lastData || { available: false, pools: [] };
    } finally {
      loading = false;
      render();
    }
  }

  function mount() {
    const viewSession = document.getElementById('view-session');
    if (!viewSession || document.getElementById('quotas-card')) return;
    const card = document.createElement('section');
    card.id = 'quotas-card';
    card.className = 'card quotas-card';
    card.addEventListener('click', (e) => {
      if (e.target.closest('#q-refresh-btn')) {
        fetchQuotas(true);
      }
    });
    const dash = document.getElementById('dashboard');
    if (dash) {
      viewSession.insertBefore(card, dash);
    } else {
      viewSession.appendChild(card);
    }

    render();
    globalThis.CM_I18N?.onChange?.(() => render());
    globalThis.CM_SECTIONS?.onChange?.((p) => {
      if (p.quotas && !lastData) fetchQuotas(false);
    });

    fetchQuotas(false);
    timer = setInterval(() => {
      const tabSession = document.getElementById('tab-session');
      if (tabSession?.classList.contains('active')) {
        fetchQuotas(false);
      }
    }, REFRESH_MS);
  }

  if (globalThis.document) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mount, { once: true });
    } else {
      mount();
    }
  }
})();
