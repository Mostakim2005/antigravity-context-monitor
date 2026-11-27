(() => {
  const STORAGE_KEY = 'cm_sections_v1';

  const SECTION_DEFS = [
    { key: 'quotas', en: '5h / 7d Quotas', zh: '5h / 7d 额度', defaultOn: true },
    { key: 'gauge', en: 'Context Gauge', zh: '上下文占用条', defaultOn: true },
    { key: 'tokenMetrics', en: 'Cache / Input / Out', zh: '缓存 / 新增 / 输出', defaultOn: true },
    { key: 'speedMetrics', en: 'TTFT / TPS / Time', zh: '首字 / 速度 / 耗时', defaultOn: true },
    { key: 'totals', en: 'Session Totals', zh: '本会话累计', defaultOn: true },
    { key: 'chart', en: 'Growth Chart', zh: '增长趋势图', defaultOn: true },
    { key: 'turns', en: 'Prompt Turns', zh: 'Prompt 轮次', defaultOn: true },
    { key: 'heatmap', en: 'Heatmap Tab', zh: '历史热力图页', defaultOn: true },
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
      quotas: document.getElementById('quotas-card'),
      gauge: dash?.querySelector(':scope > .gauge-card') || null,
      tokenMetrics: grids[0] || null,
      speedMetrics: grids[1] || null,
      totals: dash?.querySelector(':scope > .totals-card') || null,
      chart: dash?.querySelector(':scope > .chart-card') || null,
      turns: dash?.querySelector(':scope > .history-card') || null,
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
    if (!prefs.heatmap) {
      const hmTab = document.getElementById('tab-heatmap');
      if (hmTab?.classList.contains('active')) {
        document.getElementById('tab-session')?.click();
      }
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
