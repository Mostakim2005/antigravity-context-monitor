(() => {
  const REFRESH_MS = 30_000;
  let lastData = null;
  let loading = false;
  let expandedAcctModels = new Set();

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

  function fmtTok(n) {
    const v = Number(n) || 0;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 10_000) return `${(v / 1_000).toFixed(1)}K`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(2)}K`;
    return String(Math.round(v));
  }

  function fmtUsd(n) {
    const v = Number(n) || 0;
    if (v <= 0) return '$0.00';
    if (v < 0.01) return `$${v.toFixed(4)}`;
    if (v < 10) return `$${v.toFixed(3)}`;
    return `$${v.toFixed(2)}`;
  }

  function fmtRateStr(rate) {
    if (!rate) return '';
    return `$${rate.input}/$${rate.cacheRead}/$${rate.output}`;
  }

  function fmtCountdown(resetIso, nowMs, lang) {
    if (!resetIso) return '';
    const target = Date.parse(resetIso);
    if (!Number.isFinite(target)) return '';
    const diffMs = target - nowMs;
    if (diffMs <= 0) return null;
    const totalMin = Math.max(1, Math.round(diffMs / 60_000));
    const d = Math.floor(totalMin / 1440);
    const h = Math.floor((totalMin % 1440) / 60);
    const m = totalMin % 60;
    if (d > 0) return lang === 'en' ? `${d}d ${h}h` : `${d}天${h}时`;
    if (h > 0) return lang === 'en' ? `${h}h ${m}m` : `${h}时${m}分`;
    return lang === 'en' ? `${m}m` : `${m}分`;
  }

  function isEnabled(key) {
    return !globalThis.CM_SECTIONS || globalThis.CM_SECTIONS.isEnabled(key);
  }

  async function apiCall(path, opts = {}) {
    const f = globalThis.__cmOrigSidecarFetch || globalThis.__cmOrigFetch || globalThis.sidecar?.fetch?.bind(globalThis.sidecar) || fetch;
    const res = await f(path, opts);
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  function updateHeaderPill() {
    const pill = document.getElementById('cm-accounts-pill');
    if (!pill) return;
    const lang = getLang();
    const accts = lastData?.accounts || [];
    const active = accts.find((a) => a.isActive) || accts[0];
    const count = accts.length;

    if (!active) {
      pill.innerHTML = `<span class="acct-pill-dot"></span><span>${lang === 'en' ? 'Accounts' : '账号'}</span>`;
      pill.title = lang === 'en' ? 'View account quotas & total tokens' : '查看多账号配额与总 Token 用量';
      return;
    }

    const firstName = String(active.name || active.email).split(/[@\s]+/)[0].slice(0, 12);
    const tokLabel = fmtTok(active.usage?.totalTokens || 0);
    pill.innerHTML = `<span class="acct-pill-dot is-live"></span><span>${esc(firstName)}</span><span class="acct-pill-meta">${count > 1 ? `${count} · ` : ''}${tokLabel}</span>`;
    pill.title = `${active.email} · ${tokLabel} tokens`;
  }

  function renderPoolRow(pool, nowMs, lang) {
    const labels = Array.isArray(pool.modelLabels) ? pool.modelLabels : [];
    const maxShow = 3;
    const shown = labels.slice(0, maxShow);
    const extra = Math.max(0, labels.length - maxShow);
    const chipsHtml = shown.map((l) => `<span class="acct-model-chip">${esc(l)}</span>`).join('');
    const moreChip = extra > 0
      ? `<span class="acct-model-more" title="${esc(labels.slice(maxShow).join(', '))}">+${extra}</span>`
      : '';

    let statusHtml = '';
    if (pool.hasUsage === false) {
      statusHtml = `<span class="acct-status-tag is-idle">${lang === 'en' ? 'Idle' : '未使用'}</span>`;
    } else {
      const cd = fmtCountdown(pool.resetTime, nowMs, lang);
      if (cd === null) {
        statusHtml = `<span class="acct-status-tag is-ready">${lang === 'en' ? 'Ready' : '已就绪'}</span>`;
      } else {
        const pct = typeof pool.remainingPercent === 'number'
          ? Math.max(0, Math.min(100, Math.round(pool.remainingPercent)))
          : null;
        const tone = pct !== null && pct <= 20 ? ' is-danger' : pct !== null && pct <= 45 ? ' is-warn' : '';
        statusHtml = `
          <div class="acct-quota-box">
            ${cd ? `<span class="acct-cd">${esc(cd)}</span>` : ''}
            ${
              pct !== null
                ? `<span class="acct-qbar"><span class="acct-qfill${tone}" style="width:${pct}%"></span></span><span class="acct-qpct${tone}">${pct}%</span>`
                : ''
            }
          </div>
        `;
      }
    }

    return `
      <div class="acct-pool-row">
        <div class="acct-model-chips">${chipsHtml}${moreChip}</div>
        ${statusHtml}
      </div>
    `;
  }

  function renderWindowBar(winTag, w, lang) {
    if (!w || typeof w.remainingPct !== 'number') {
      return `<div class="mq-win"><span class="mq-win-tag">${esc(winTag)}</span><span class="mq-win-empty">—</span></div>`;
    }
    const pct = Math.max(0, Math.min(100, Math.round(w.remainingPct)));
    const tone = pct <= 20 ? ' is-danger' : pct <= 45 ? ' is-warn' : '';
    const cd = w.resetCountdown ? `${w.resetCountdown}` : (lang === 'en' ? 'Full' : '满额');
    return `
      <div class="mq-win">
        <div class="mq-win-top">
          <span class="mq-win-tag">${esc(winTag)}</span>
          <span class="mq-win-meta">${esc(cd)} · <strong>${pct}%</strong></span>
        </div>
        <div class="q-track"><div class="q-fill${tone}" style="width:${pct}%"></div></div>
      </div>
    `;
  }

  function renderAllModelsCard(allModels, totals, lang) {
    if (!isEnabled('accountsModels')) return '';
    const models = Array.isArray(allModels) ? allModels : [];
    const listHtml = models.length === 0
      ? `<div class="sc-empty">${lang === 'en' ? 'No model usage recorded yet.' : '暂无模型用量记录。'}</div>`
      : models.map((m) => `
          <div class="sc-model-row">
            <div class="sc-model-left">
              <span class="sc-model-name" title="${esc(m.modelKey)}">${esc(m.label)}</span>
              <span class="sc-model-meta">${m.calls} ${lang === 'en' ? 'calls' : '次'}${m.rate ? ` · ${fmtRateStr(m.rate)}/1M` : ''}</span>
            </div>
            <div class="sc-val-pills">
              <span class="cm-tok-pill">${fmtTok(m.totalTokens)}</span>
              <span class="cm-cost-pill">${m.priced ? fmtUsd(m.totalCost) : (lang === 'en' ? 'No rate' : '无单价')}</span>
            </div>
          </div>
        `).join('');

    return `
      <section id="acct-all-models-card" class="card">
        <div class="section-head">
          <span class="section-title">${lang === 'en' ? `All Models & API Rates (${models.length})` : `全模型用量与 API 费率 (${models.length})`}</span>
          <div class="sc-val-pills">
            <span class="cm-tok-pill">${fmtTok(totals?.totalTokens || 0)}</span>
            <span class="cm-cost-pill">${fmtUsd(totals?.totalCost || 0)}</span>
          </div>
        </div>
        <div class="sc-subcard">${listHtml}</div>
      </section>
    `;
  }

  function renderPerModelQuotasCard(modelQuotas, lang) {
    if (!isEnabled('accountsQuotas')) return '';
    const list = Array.isArray(modelQuotas) ? modelQuotas : [];
    const body = list.length === 0
      ? `<div class="sc-empty">${lang === 'en' ? 'Per-model quota data unavailable from LanguageServer.' : '暂未获取到单模型配额明细。'}</div>`
      : `<div class="mq-list">${list.map((m) => `
          <div class="mq-row">
            <div class="mq-label" title="${esc(m.modelId || m.label)}">${esc(m.label)}</div>
            <div class="mq-bars">
              ${renderWindowBar('5h', m.fiveHour, lang)}
              ${renderWindowBar('7d', m.weekly, lang)}
            </div>
          </div>
        `).join('')}</div>`;

    return `
      <section id="acct-model-quotas-card" class="card">
        <div class="section-head">
          <span class="section-title">${lang === 'en' ? `Per-Model Quotas (5h & 7d) (${list.length})` : `单模型 5h / 7d 剩余额度 (${list.length})`}</span>
        </div>
        ${body}
      </section>
    `;
  }

  function render() {
    updateHeaderPill();
    const container = document.getElementById('view-accounts');
    if (!container) return;
    const lang = getLang();

    const summary = lastData?.summary || { count: 0, totalTokens: 0, totalCalls: 0, totalCostUsd: 0 };
    const accounts = Array.isArray(lastData?.accounts) ? lastData.accounts : [];
    const allModels = Array.isArray(lastData?.allModels) ? lastData.allModels : [];
    const allModelsTotals = lastData?.allModelsTotals || { totalTokens: 0, totalCost: 0 };
    const modelQuotas = Array.isArray(lastData?.modelQuotas) ? lastData.modelQuotas : [];
    const nowMs = Date.now();

    const headerCard = `
      <section class="card acct-summary-card">
        <div class="section-head">
          <span class="section-title">${lang === 'en' ? `Accounts (${summary.count})` : `多账号状态 (${summary.count})`}</span>
          <button type="button" id="cm-acct-refresh" class="q-refresh-btn" title="${lang === 'en' ? 'Refresh accounts' : '刷新账号状态'}" ${loading ? 'disabled' : ''}>↻</button>
        </div>
        <div class="acct-kpi-grid">
          <div class="acct-kpi">
            <span class="acct-kpi-k">${lang === 'en' ? 'Accounts Ledger Tokens' : '多账号已记录 Token'}</span>
            <span class="cm-tok-pill">${fmtTok(summary.totalTokens)}</span>
          </div>
          <div class="acct-kpi">
            <span class="acct-kpi-k">${lang === 'en' ? 'API Rate Value' : '等效 API 费用'}</span>
            <span class="cm-cost-pill">${fmtUsd(summary.totalCostUsd)}</span>
          </div>
        </div>
      </section>
    `;

    let listHtml = '';
    if (!lastData && loading) {
      listHtml = `<section class="card"><div class="sc-empty">${lang === 'en' ? 'Loading accounts…' : '正在加载账号信息…'}</div></section>`;
    } else if (accounts.length === 0) {
      listHtml = `<section class="card"><div class="sc-empty">${lang === 'en' ? 'No active or cached accounts yet. Sign in to Antigravity to populate.' : '暂无账号记录，登录 Antigravity 后会自动记录。'}</div></section>`;
    } else {
      listHtml = accounts.map((a) => {
        const u = a.usage || {};
        const planText = a.tierName || a.planName || '';
        const credits = Array.isArray(a.credits) ? a.credits : [];
        const acctModels = Array.isArray(a.byModel) ? a.byModel : [];
        const isModelsOpen = expandedAcctModels.has(a.email);

        const creditsHtml = credits.length > 0
          ? `<div class="acct-credits">${credits.map((c) => `<span class="q-credit-pill">${esc(String(c.creditType).replace(/_/g, ' ').toLowerCase())}: <strong>${Number(c.amount || 0).toLocaleString('en-US')}</strong></span>`).join('')}</div>`
          : '';
        const poolsHtml = Array.isArray(a.resetPools) && a.resetPools.length > 0
          ? `<div class="acct-pools">${a.resetPools.map((p) => renderPoolRow(p, nowMs, lang)).join('')}</div>`
          : '';

        const acctModelsHtml = acctModels.length > 0
          ? `
            <div class="acct-models-wrap">
              <button type="button" class="ghost-btn sc-btn-xs${isModelsOpen ? ' is-on' : ''}" data-acct-models-toggle="${esc(a.email)}">
                ${lang === 'en' ? `Models (${acctModels.length})` : `模型明细 (${acctModels.length})`}
              </button>
              ${
                isModelsOpen
                  ? `<div class="sc-subcard">${acctModels.map((m) => `
                      <div class="sc-model-row">
                        <div class="sc-model-left">
                          <span class="sc-model-name">${esc(m.label)}</span>
                          <span class="sc-model-meta">${m.calls} ${lang === 'en' ? 'calls' : '次'}${m.rate ? ` · ${fmtRateStr(m.rate)}/1M` : ''}</span>
                        </div>
                        <div class="sc-val-pills">
                          <span class="cm-tok-pill">${fmtTok(m.totalTokens)}</span>
                          <span class="cm-cost-pill">${m.priced ? fmtUsd(m.totalCost) : (lang === 'en' ? 'No rate' : '无单价')}</span>
                        </div>
                      </div>
                    `).join('')}</div>`
                  : ''
              }
            </div>
          `
          : '';

        return `
          <section class="card acct-card${a.isActive ? ' is-active' : ''}">
            <div class="acct-card-top">
              <div class="acct-id-block">
                <div class="acct-name-row">
                  <span class="acct-dot${a.isActive ? ' is-active' : ''}"></span>
                  <strong class="acct-name">${esc(a.name)}</strong>
                  <span class="acct-state-badge${a.isActive ? ' is-active' : ''}">
                    ${a.isActive ? (lang === 'en' ? 'Active' : '当前在线') : (lang === 'en' ? 'Cached' : '已缓存')}
                  </span>
                </div>
                <div class="acct-email">${esc(a.email)}</div>
              </div>
              <div class="acct-actions-col">
                ${planText ? `<span class="acct-tier-pill">${esc(planText)}</span>` : ''}
                ${
                  !a.isActive
                    ? `<button type="button" class="acct-remove-btn" data-remove-email="${esc(a.email)}">${lang === 'en' ? 'Remove' : '移除'}</button>`
                    : ''
                }
              </div>
            </div>

            <div class="acct-usage-box">
              <div class="acct-usage-main">
                <div class="sc-val-pills">
                  <span class="cm-tok-pill">${lang === 'en' ? 'Tokens' : 'Token'}: ${fmtTok(u.totalTokens || 0)}</span>
                  <span class="cm-cost-pill">${lang === 'en' ? 'API Rate' : 'API 等值'}: ${fmtUsd(u.estimatedCostUsd || 0)}</span>
                </div>
              </div>
              <div class="acct-usage-sub">
                ${u.calls || 0} ${lang === 'en' ? 'calls' : '次'} · ${lang === 'en' ? 'In' : '输入'} ${fmtTok(u.inputTokens || 0)} · ${lang === 'en' ? 'Cache' : '缓存'} ${fmtTok(u.cacheReadTokens || 0)} · ${lang === 'en' ? 'Out' : '输出'} ${fmtTok(u.outputTokens || 0)}
              </div>
            </div>

            ${creditsHtml}
            ${acctModelsHtml}
            ${poolsHtml}
          </section>
        `;
      }).join('');
    }

    container.innerHTML = `
      ${headerCard}
      ${listHtml}
      ${renderAllModelsCard(allModels, allModelsTotals, lang)}
      ${renderPerModelQuotasCard(modelQuotas, lang)}
    `;
  }

  async function refresh(force = false) {
    if (globalThis.CM_SECTIONS && !globalThis.CM_SECTIONS.isEnabled('accountsTab')) return;
    if (loading) return;
    loading = true;
    render();
    try {
      lastData = await apiCall(`/api/accounts${force ? '?force=1' : ''}`);
    } catch {
      lastData = lastData || {
        accounts: [],
        allModels: [],
        modelQuotas: [],
        summary: { count: 0, totalTokens: 0, totalCalls: 0, totalCostUsd: 0 },
      };
    } finally {
      loading = false;
      render();
    }
  }

  function mount() {
    const view = document.getElementById('view-accounts');
    if (view) {
      view.addEventListener('click', async (e) => {
        if (e.target.closest('#cm-acct-refresh')) {
          refresh(true);
          return;
        }
        const mToggle = e.target.closest('[data-acct-models-toggle]');
        if (mToggle) {
          const email = mToggle.dataset.acctModelsToggle;
          if (email) {
            if (expandedAcctModels.has(email)) expandedAcctModels.delete(email);
            else expandedAcctModels.add(email);
            render();
          }
          return;
        }
        const rm = e.target.closest('[data-remove-email]');
        if (rm) {
          const email = rm.dataset.removeEmail;
          if (!email) return;
          try {
            lastData = await apiCall('/api/accounts/remove', {
              method: 'POST',
              body: JSON.stringify({ email }),
            });
            render();
          } catch {
            // ignore remove errors
          }
        }
      });
    }

    globalThis.CM_I18N?.onChange?.(() => render());
    globalThis.CM_SECTIONS?.onChange?.((p) => {
      if (p.accountsTab && !lastData) refresh(false);
      else render();
    });

    refresh(false);
    setInterval(() => {
      const tabAccts = document.getElementById('tab-accounts');
      if (tabAccts?.classList.contains('active')) {
        refresh(false);
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

  globalThis.CM_ACCOUNTS = {
    refresh,
    render,
  };
})();
