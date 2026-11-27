(() => {
  const STORAGE_KEY = 'cm_sections_v1';

  const SECTION_DEFS = [
    { key: 'switcher', en: 'Chat Switcher / Lock', zh: '会话切换 / 锁定主控', defaultOn: true },
    { key: 'quotas', en: 'Model Quotas (5h & 7d)', zh: '模型额度（5h / 周额度）', defaultOn: true },
    { key: 'gauge', en: 'Context Used', zh: '当前上下文占用', defaultOn: true },
    { key: 'breakdown', en: 'Context Breakdown', zh: '上下文构成', defaultOn: true },
    { key: 'tokenMetrics', en: 'Cache / Input / Output', zh: '缓存 / 输入 / 输出', defaultOn: true },
    { key: 'speedMetrics', en: 'TTFT / Speed / Duration', zh: '首字 / 速度 / 耗时', defaultOn: true },
    { key: 'totals', en: 'Session Totals', zh: '本会话累计', defaultOn: true },
    { key: 'orchestrator', en: 'Orchestrator vs Executor', zh: '编排器 vs 执行器', defaultOn: true },
    { key: 'retries', en: 'Retries & Errors', zh: '重试与报错', defaultOn: true },
    { key: 'modelDna', en: 'Model DNA', zh: '模型参数画像', defaultOn: true },
    { key: 'chart', en: 'Context Growth', zh: '上下文增长趋势', defaultOn: true },
    { key: 'turns', en: 'Prompt Turns', zh: 'Prompt 轮次', defaultOn: true },
    { key: 'costTab', en: 'Cost', zh: '费用', defaultOn: true },
    { key: 'accountsTab', en: 'Accounts', zh: '多账号', defaultOn: true },
    { key: 'accountsModels', en: 'All Models & API Rates', zh: '全模型用量与 API 费率', defaultOn: true },
    { key: 'accountsQuotas', en: 'Per-Model Quotas (5h & 7d)', zh: '单模型 5h / 7d 剩余额度', defaultOn: true },
    { key: 'heatmap', en: 'Heatmap', zh: '历史热力图', defaultOn: true },
  ];

  function loadPrefs() {
    const prefs = {};
    for (const d of SECTION_DEFS) prefs[d.key] = d.defaultOn;
    try {
      const raw = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) || '{}');
      if (raw && typeof raw === 'object') {
        for (const d of SECTION_DEFS) {
          if (typeof raw[d.key] === 'boolean') prefs[d.key] = raw[d.key];
        }
      }
    } catch {
      // ignore storage errors
    }
    return prefs;
  }

  function savePrefs(prefs) {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // ignore storage errors
    }
  }

  let prefs = loadPrefs();
  let drawerOpen = false;
  const listeners = new Set();

  function getLang() {
    return globalThis.CM_I18N?.getLang?.() || 'en';
  }

  function resolveTargets() {
    const dash = document.getElementById('dashboard');
    const grids = dash ? dash.querySelectorAll(':scope > .metrics-grid') : [];
    return {
      switcher: document.getElementById('switcher-bar'),
      quotas: document.getElementById('quotas-card'),
      gauge: dash?.querySelector(':scope > .gauge-card') || null,
      breakdown: document.getElementById('breakdown-card'),
      tokenMetrics: grids[0] || null,
      speedMetrics: grids[1] || null,
      totals: dash?.querySelector(':scope > .totals-card') || null,
      orchestrator: document.getElementById('orchestrator-card'),
      retries: document.getElementById('retries-card'),
      modelDna: document.getElementById('model-dna-card'),
      chart: dash?.querySelector(':scope > .chart-card') || null,
      turns: dash?.querySelector(':scope > .history-card') || null,
      costTab: document.getElementById('tab-cost'),
      accountsTab: document.getElementById('tab-accounts'),
      accountsModels: document.getElementById('acct-all-models-card'),
      accountsQuotas: document.getElementById('acct-model-quotas-card'),
      heatmap: document.getElementById('tab-heatmap'),
    };
  }

  function applyVisibility() {
    const targets = resolveTargets();
    for (const def of SECTION_DEFS) {
      const el = targets[def.key];
      if (!el) continue;
      el.classList.toggle('cm-sec-hidden', !prefs[def.key]);
    }
    const acctPill = document.getElementById('cm-accounts-pill');
    if (acctPill) acctPill.classList.toggle('cm-sec-hidden', !prefs.accountsTab);

    if (
      (!prefs.heatmap && document.getElementById('tab-heatmap')?.classList.contains('active')) ||
      (!prefs.costTab && document.getElementById('tab-cost')?.classList.contains('active')) ||
      (!prefs.accountsTab && document.getElementById('tab-accounts')?.classList.contains('active'))
    ) {
      document.getElementById('tab-session')?.click();
    }
  }

  function renderControls() {
    const lang = getLang();
    const btn = document.getElementById('cm-sections-btn');
    if (btn) {
      btn.textContent = lang === 'en' ? 'Sections' : '栏目';
      btn.title = lang === 'en' ? 'Show or hide monitor sections' : '显示或隐藏监控栏目';
      btn.setAttribute('aria-expanded', String(drawerOpen));
      btn.classList.toggle('active', drawerOpen);
    }

    const drawer = document.getElementById('cm-sections-drawer');
    if (!drawer) return;
    drawer.classList.toggle('hidden', !drawerOpen);

    const chipsHtml = SECTION_DEFS.map((d) => {
      const checked = Boolean(prefs[d.key]);
      const label = lang === 'en' ? d.en : d.zh;
      return `<label class="sec-chip${checked ? ' is-on' : ''}"><input type="checkbox" data-sec-key="${d.key}" ${checked ? 'checked' : ''}><span>${label}</span></label>`;
    }).join('');
    drawer.innerHTML = `<div class="sec-drawer-head"><span>${lang === 'en' ? 'Visible Sections' : '显示栏目'}</span><button type="button" id="cm-sec-reset" class="sec-reset-btn">${lang === 'en' ? 'Show All' : '全部显示'}</button></div><div class="sec-chip-grid">${chipsHtml}</div>`;
  }

  function mountUi() {
    const limitBar = document.querySelector('.limit-bar');
    const header = document.querySelector('.header');
    if (!limitBar || !header || document.getElementById('cm-sections-btn')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'cm-sections-btn';
    btn.className = 'preset-btn sec-toggle-btn';
    btn.addEventListener('click', () => {
      drawerOpen = !drawerOpen;
      renderControls();
    });

    const rightWrap = document.createElement('div');
    rightWrap.className = 'limit-bar-right';
    const limitBadge = document.getElementById('limit-badge');
    if (limitBadge && limitBadge.parentElement === limitBar) {
      limitBar.insertBefore(rightWrap, limitBadge);
      rightWrap.append(btn, limitBadge);
    } else {
      rightWrap.append(btn);
      limitBar.append(rightWrap);
    }

    const drawer = document.createElement('section');
    drawer.id = 'cm-sections-drawer';
    drawer.className = 'card sec-drawer hidden';
    drawer.addEventListener('change', (e) => {
      const input = e.target.closest('input[data-sec-key]');
      if (!input) return;
      const key = input.dataset.secKey;
      prefs[key] = Boolean(input.checked);
      savePrefs(prefs);
      applyVisibility();
      renderControls();
      for (const fn of listeners) {
        try { fn({ ...prefs }); } catch { /* ignore */ }
      }
    });
    drawer.addEventListener('click', (e) => {
      if (!e.target.closest('#cm-sec-reset')) return;
      for (const d of SECTION_DEFS) prefs[d.key] = true;
      savePrefs(prefs);
      applyVisibility();
      renderControls();
      for (const fn of listeners) {
        try { fn({ ...prefs }); } catch { /* ignore */ }
      }
    });

    header.appendChild(drawer);
    renderControls();
    applyVisibility();
  }

  function boot() {
    mountUi();
    globalThis.CM_I18N?.onChange?.(() => renderControls());
  }

  if (globalThis.document) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  }

  globalThis.CM_SECTIONS = {
    isEnabled: (key) => prefs[key] !== false,
    getPrefs: () => ({ ...prefs }),
    applyVisibility,
    onChange: (fn) => {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
})();
