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

  function fmtMin(min, lang) {
    const m = Math.max(1, Math.round(Number(min) || 0));
    if (m >= 60) {
      const h = Math.floor(m / 60);
      const r = m % 60;
      return lang === 'en' ? `${h}h ${r}m` : `${h}小时${r}分`;
    }
    return lang === 'en' ? `${m}m` : `${m}分钟`;
  }

  function renderRunwayPill(runway, lang) {
    if (!runway || !runway.status || runway.status === 'insufficient_data') return '';
    if (runway.status === 'exhausted') {
      return `<span class="q-runway is-danger">${lang === 'en' ? 'Exhausted' : '已耗尽'}</span>`;
    }
    if (runway.status === 'safe_until_reset') {
      const txt = lang === 'en'
        ? `Safe · ${runway.burnRatePctPerHour}%/h`
        : `可撑到重置 · ${runway.burnRatePctPerHour}%/h`;
      return `<span class="q-runway is-safe">${esc(txt)}</span>`;
    }
    if (runway.status === 'custom_model_isolated') {
      return `<span class="q-runway is-isolated">${lang === 'en' ? 'BYOK · Isolated' : 'BYOK · 已隔离'}</span>`;
    }
    if (runway.status === 'at_risk' && runway.estExhaustMin != null) {
      const txt = lang === 'en'
        ? `~${fmtMin(runway.estExhaustMin, 'en')} left · ${runway.burnRatePctPerHour}%/h`
        : `约 ${fmtMin(runway.estExhaustMin, 'zh')} · ${runway.burnRatePctPerHour}%/h`;
      return `<span class="q-runway is-risk">${esc(txt)}</span>`;
    }
    return '';
  }

  function renderCreditsRow(aiCredits, lang) {
    if (!Array.isArray(aiCredits) || aiCredits.length === 0) return '';
    const pills = aiCredits.map((c) => {
      const name = String(c.creditType || 'CREDITS').replace(/_/g, ' ').toLowerCase();
      return `<span class="q-credit-pill">${esc(name)}: <strong>${Number(c.amount || 0).toLocaleString('en-US')}</strong></span>`;
    }).join('');
    return `<div class="q-credits-row"><span class="q-credits-label">${lang === 'en' ? 'AI Credits' : 'AI 积分'}</span><div class="q-credits-pills">${pills}</div></div>`;
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
    } else if (!lastData.available || (!lastData.pools?.length && !lastData.aiCredits?.length)) {
      bodyHtml = `<div class="q-note">${lang === 'en' ? 'Quota telemetry unavailable from LanguageServer.' : '暂未获取到 LanguageServer 额度信息。'}</div>`;
    } else {
      const poolsHtml = (lastData.pools || []).length > 0
        ? `<div class="q-pools">${lastData.pools.map((p) => `
          <div class="q-pool">
            <div class="q-pool-head">
              <span class="q-pool-name">${esc(p.label)}</span>
              ${renderRunwayPill(p.runway, lang)}
            </div>
            <div class="q-win-grid">
              ${renderWindowRow('5h', p.fiveHour, lang)}
              ${renderWindowRow('7d', p.weekly, lang)}
            </div>
          </div>
        `).join('')}</div>`
        : '';
      const byokBanner = lastData.activeModel?.isCustomModel
        ? `<div class="q-byok-note">${
            lang === 'en'
              ? `Active model (${esc(lastData.activeModel.label || lastData.activeModel.modelId)}) is BYOK / custom — Google quota burn tracking is isolated.`
              : `当前模型 (${esc(lastData.activeModel.label || lastData.activeModel.modelId)}) 为 BYOK / 自定义模型，已隔离 Google 额度消耗统计。`
          }</div>`
        : '';
      bodyHtml = byokBanner + poolsHtml + renderCreditsRow(lastData.aiCredits, lang);
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
      const qs = new URLSearchParams();
      if (force) qs.set('force', '1');
      const convId = globalThis.CM_EXTRAS?.getEffectiveConvId?.() || '';
      if (convId) qs.set('conversationId', convId);
      const qStr = qs.toString();
      lastData = await apiGet(`/api/quotas${qStr ? `?${qStr}` : ''}`);
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

  globalThis.CM_QUOTAS = { refresh: fetchQuotas };
  if (globalThis.document) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mount, { once: true });
    } else {
      mount();
    }
  }
})();
