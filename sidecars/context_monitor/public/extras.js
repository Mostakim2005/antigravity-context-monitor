(() => {
  const SWITCH_KEY = 'cm_switcher_v1';
  const SCOPE_KEY = 'cm_scope_v1';
  const TAB_KEY = 'cm_active_tab_v1';
  const VALID_SCOPES = ['conversation', 'project', '7d', '30d', 'all'];
  const VALID_TABS = ['session', 'cost', 'accounts', 'heatmap'];

  const HOST_CONV_ID =
    globalThis.sidecar?.conversationId ||
    new URLSearchParams(globalThis.location?.search || '').get('conversationId') ||
    '';

  function loadJson(key, fallback) {
    try {
      const raw = JSON.parse(globalThis.localStorage?.getItem(key) || 'null');
      return raw && typeof raw === 'object' ? { ...fallback, ...raw } : { ...fallback };
    } catch {
      return { ...fallback };
    }
  }

  function saveJson(key, val) {
    try {
      globalThis.localStorage?.setItem(key, JSON.stringify(val));
    } catch {
      // ignore storage errors
    }
  }

  const DEFAULT_SCOPE_STATE = {
    scope: 'conversation',
    breakdownView: 'models', // 'models' | 'projects' | 'chats' | ''
    showPricing: false,
    showArchive: false,
    showCurrency: false,
  };

  const serverBootPrefs = globalThis.CM_PREFS?.getServerPrefs?.();
  const hasServerBoot = Boolean(globalThis.CM_PREFS?.hasServerBootstrap?.());
  const switchState = loadJson(SWITCH_KEY, { pinnedConvId: '', lockMain: false });
  if (typeof serverBootPrefs?.switcher?.lockMain === 'boolean') {
    switchState.lockMain = serverBootPrefs.switcher.lockMain;
    saveJson(SWITCH_KEY, switchState);
  } else if (hasServerBoot && switchState.lockMain) {
    globalThis.CM_PREFS?.saveServerPatch?.({ switcher: { lockMain: true } });
  }

  let scopeState;
  if (serverBootPrefs?.scope && typeof serverBootPrefs.scope === 'object') {
    scopeState = { ...DEFAULT_SCOPE_STATE, ...serverBootPrefs.scope };
    saveJson(SCOPE_KEY, scopeState);
  } else {
    scopeState = loadJson(SCOPE_KEY, DEFAULT_SCOPE_STATE);
    const hasLocalScope = Boolean(globalThis.CM_PREFS?.readLocal?.(SCOPE_KEY));
    if (hasServerBoot && hasLocalScope) {
      globalThis.CM_PREFS?.saveServerPatch?.({ scope: scopeState });
    }
  }
  if (!VALID_SCOPES.includes(scopeState.scope)) scopeState.scope = 'conversation';

  function saveScopeState() {
    saveJson(SCOPE_KEY, scopeState);
    globalThis.CM_PREFS?.saveServerPatch?.({ scope: { ...scopeState } });
  }

  const runtime = {
    workspaceUris: [],
    conversations: null,
    scopeData: null,
    breakdownData: null,
    diagnosticsData: null,
    latestContext: null,
    heatmapAnalytics: null,
    hmMetric: 'tokens', // 'tokens' | 'cost'
    hmSource: 'all', // 'all' | 'app' | 'cli'
    expandedProjects: new Set(),
    expandedProjectsInit: false,
    pricingCatalog: null,
    selectedPriceKey: '',
    selectedArchiveMonth: '',
    statusMsg: '',
    copyStatus: '',
    lastContextSig: '',
    lastSentConvId: HOST_CONV_ID,
    pendingScopeTimer: null,
    scopeBusy: false,
    breakdownBusy: false,
    diagnosticsBusy: false,
    lastDiagCustomModel: null,
  };

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

  function getEffectiveConvId() {
    if (switchState.pinnedConvId) return switchState.pinnedConvId;
    if (switchState.lockMain && runtime.conversations?.recommendedMainId) {
      return runtime.conversations.recommendedMainId;
    }
    return HOST_CONV_ID;
  }

  async function rawApi(path, opts = {}) {
    const baseFetch = globalThis.__cmOrigSidecarFetch || globalThis.__cmOrigFetch || globalThis.fetch.bind(globalThis);
    const res = await baseFetch(path, opts);
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  function installContextInterceptor() {
    if (globalThis.__cmInterceptorInstalled) return;
    globalThis.__cmInterceptorInstalled = true;

    const wrap = (origFn, ctx) => {
      return async function wrappedFetch(input, init) {
        const urlStr = typeof input === 'string' ? input : input?.url || '';
        if (urlStr.startsWith('/api/context')) {
          const u = new URL(urlStr, globalThis.location?.origin || 'http://127.0.0.1');
          const eff = getEffectiveConvId();
          if (eff) {
            u.searchParams.set('conversationId', eff);
          }
          if (eff !== runtime.lastSentConvId) {
            u.searchParams.delete('etag');
            runtime.lastSentConvId = eff;
          }
          const rewritten = `${u.pathname}${u.search}`;
          const res = await origFn.call(ctx, rewritten, init);
          try {
            const clone = res.clone();
            clone.json().then((payload) => {
              if (payload && !payload.unchanged && payload.found) {
                runtime.latestContext = payload;
                renderGaugeExtra();
                const sig = `${payload.conversationId}|${payload.etag}|${payload.latest?.stepIndex || 0}`;
                if (sig !== runtime.lastContextSig) {
                  runtime.lastContextSig = sig;
                  scheduleRefreshOnStep();
                }
              }
            }).catch(() => {});
          } catch {
            // ignore clone errors
          }
          return res;
        }
        return origFn.call(ctx, input, init);
      };
    };

    if (globalThis.sidecar?.fetch) {
      globalThis.__cmOrigSidecarFetch = globalThis.sidecar.fetch.bind(globalThis.sidecar);
      globalThis.sidecar.fetch = wrap(globalThis.__cmOrigSidecarFetch, globalThis.sidecar);
    }
    if (typeof globalThis.fetch === 'function') {
      globalThis.__cmOrigFetch = globalThis.fetch.bind(globalThis);
      globalThis.fetch = wrap(globalThis.__cmOrigFetch, globalThis);
    }
  }

  function scheduleRefreshOnStep() {
    if (runtime.pendingScopeTimer) clearTimeout(runtime.pendingScopeTimer);
    runtime.pendingScopeTimer = setTimeout(() => {
      runtime.pendingScopeTimer = null;
      refreshScope(false);
      refreshBreakdown();
      refreshDiagnostics();
    }, 350);
  }

  function isSessionTabActive() {
    return document.getElementById('tab-session')?.classList.contains('active') !== false;
  }

  function isCostTabActive() {
    return Boolean(document.getElementById('tab-cost')?.classList.contains('active'));
  }

  function isSectionEnabled(key) {
    return !globalThis.CM_SECTIONS || globalThis.CM_SECTIONS.isEnabled(key);
  }

  function saveTabPref(tab) {
    try {
      globalThis.localStorage?.setItem(TAB_KEY, tab);
    } catch {
      // ignore
    }
    if (VALID_TABS.includes(tab) && globalThis.CM_PREFS?.getServerPrefs?.()?.activeTab !== tab) {
      globalThis.CM_PREFS?.saveServerPatch?.({ activeTab: tab });
    }
  }

  function loadTabPref() {
    const serverTab = globalThis.CM_PREFS?.getServerPrefs?.()?.activeTab;
    if (VALID_TABS.includes(serverTab)) {
      try { globalThis.localStorage?.setItem(TAB_KEY, serverTab); } catch { /* ignore */ }
      return serverTab;
    }
    try {
      const t = globalThis.localStorage?.getItem(TAB_KEY);
      return VALID_TABS.includes(t) ? t : 'session';
    } catch {
      return 'session';
    }
  }

  function setCustomTabState(tab) {
    saveTabPref(tab);
    const tabs = {
      session: document.getElementById('tab-session'),
      cost: document.getElementById('tab-cost'),
      accounts: document.getElementById('tab-accounts'),
      heatmap: document.getElementById('tab-heatmap'),
    };
    const views = {
      session: document.getElementById('view-session'),
      cost: document.getElementById('view-cost'),
      accounts: document.getElementById('view-accounts'),
      heatmap: document.getElementById('view-heatmap'),
    };
    for (const k of VALID_TABS) {
      const on = k === tab;
      if (tabs[k]) {
        tabs[k].classList.toggle('active', on);
        tabs[k].setAttribute('aria-selected', String(on));
      }
      if (views[k]) {
        views[k].classList.toggle('hidden', !on);
      }
    }
    const pill = document.getElementById('cm-accounts-pill');
    if (pill) pill.classList.toggle('active', tab === 'accounts');
  }

  function activateTab(tab) {
    if (!VALID_TABS.includes(tab)) return;
    if (tab === 'session' || tab === 'heatmap') {
      const btn = document.getElementById(`tab-${tab}`);
      setCustomTabState(tab);
      btn?.click();
      return;
    }
    setCustomTabState(tab);
    if (tab === 'cost') refreshScope(false);
    if (tab === 'accounts') globalThis.CM_ACCOUNTS?.refresh?.(false);
    if (tab === 'heatmap') refreshHeatmapAnalytics();
  }

  async function refreshConversations(force = false) {
    if (!isSectionEnabled('switcher') || !isSessionTabActive()) return;
    try {
      const qs = new URLSearchParams({
        hostConvId: HOST_CONV_ID,
        workspaceUris: JSON.stringify(runtime.workspaceUris),
      });
      if (force) qs.set('force', '1');
      const prevEff = getEffectiveConvId();
      runtime.conversations = await rawApi(`/api/conversations?${qs.toString()}`);
      renderSwitcher();
      const nextEff = getEffectiveConvId();
      if (nextEff !== prevEff) {
        onTargetConvChanged();
      }
    } catch {
      renderSwitcher();
    }
  }

  async function refreshScope(force = false) {
    if (!isSectionEnabled('costTab') || (!isCostTabActive() && !force) || runtime.scopeBusy) return;
    runtime.scopeBusy = true;
    try {
      const qs = new URLSearchParams({
        scope: scopeState.scope,
        conversationId: getEffectiveConvId(),
        workspaceUris: JSON.stringify(runtime.workspaceUris),
      });
      if (force) qs.set('force', '1');
      runtime.scopeData = await rawApi(`/api/scope?${qs.toString()}`);
      if (!runtime.selectedArchiveMonth && runtime.scopeData?.months?.length > 0) {
        runtime.selectedArchiveMonth = runtime.scopeData.months[0].monthKey;
      }
      renderScopeCost();
    } catch {
      renderScopeCost();
    } finally {
      runtime.scopeBusy = false;
    }
  }

  async function refreshBreakdown() {
    if (!isSectionEnabled('breakdown') || !isSessionTabActive() || runtime.breakdownBusy) return;
    const convId = getEffectiveConvId();
    if (!convId) return;
    runtime.breakdownBusy = true;
    try {
      runtime.breakdownData = await rawApi(`/api/breakdown?conversationId=${encodeURIComponent(convId)}`);
      renderBreakdown();
    } catch {
      renderBreakdown();
    } finally {
      runtime.breakdownBusy = false;
    }
  }

  function anyDiagnosticsEnabled() {
    return (
      isSectionEnabled('orchestrator') ||
      isSectionEnabled('retries') ||
      isSectionEnabled('modelDna')
    );
  }

  async function refreshDiagnostics() {
    if (!anyDiagnosticsEnabled() || !isSessionTabActive() || runtime.diagnosticsBusy) return;
    const convId = getEffectiveConvId();
    if (!convId) return;
    runtime.diagnosticsBusy = true;
    try {
      const payload = await rawApi(`/api/diagnostics?conversationId=${encodeURIComponent(convId)}`);
      runtime.diagnosticsData = payload;
      const isCustom = Boolean(payload?.activeModel?.isCustomModel);
      if (runtime.lastDiagCustomModel !== null && runtime.lastDiagCustomModel !== isCustom) {
        globalThis.CM_QUOTAS?.refresh?.(false);
      }
      runtime.lastDiagCustomModel = isCustom;
      renderDiagnostics();
    } catch {
      renderDiagnostics();
    } finally {
      runtime.diagnosticsBusy = false;
    }
  }

  async function refreshPricingCatalog() {
    try {
      const resp = await rawApi('/api/pricing');
      runtime.pricingCatalog = resp.catalog || [];
      if (!runtime.selectedPriceKey && runtime.pricingCatalog.length > 0) {
        runtime.selectedPriceKey = runtime.pricingCatalog[0].modelKey;
      }
      renderScopeCost();
    } catch {
      // ignore
    }
  }

  function onTargetConvChanged() {
    runtime.lastContextSig = '';
    if (globalThis.sidecar) {
      globalThis.sidecar.conversationId = getEffectiveConvId();
    }
    refreshScope(false);
    refreshBreakdown();
    refreshDiagnostics();
    globalThis.CM_QUOTAS?.refresh?.(false);
  }

  function renderSwitcher() {
    const bar = document.getElementById('switcher-bar');
    if (!bar) return;
    const lang = getLang();
    const convs = runtime.conversations?.conversations || [];
    const eff = getEffectiveConvId();
    const lockedSub =
      switchState.lockMain &&
      !switchState.pinnedConvId &&
      runtime.conversations?.hostIsSubagent &&
      eff !== HOST_CONV_ID;

    const options = [
      `<option value="">${
        lang === 'en'
          ? `Follow Active (${HOST_CONV_ID ? HOST_CONV_ID.slice(0, 8) : 'none'})`
          : `跟随当前会话 (${HOST_CONV_ID ? HOST_CONV_ID.slice(0, 8) : '无'})`
      }</option>`,
      ...convs.map((c) => {
        const tag = c.isSubagent ? (lang === 'en' ? '[Sub] ' : '[子] ') : '';
        const wsTag = c.inCurrentWorkspace ? '★ ' : '';
        const title = String(c.summary || c.cascadeId).slice(0, 36);
        const sel = switchState.pinnedConvId === c.cascadeId ? 'selected' : '';
        return `<option value="${esc(c.cascadeId)}" ${sel}>${esc(wsTag + tag + title)} (${esc(c.cascadeId.slice(0, 6))})</option>`;
      }),
    ].join('');

    const lockLabel = lang === 'en' ? 'Lock Main' : '锁定主控';
    const lockTitle = lang === 'en'
      ? 'Keep tracking the parent/main conversation even if a subagent is focused'
      : '即使切换到子代理，也锁定跟踪主对话';

    bar.innerHTML = `
      <div class="switcher-inline">
        <span class="section-title switcher-label">${lang === 'en' ? 'Chat Switcher / Lock' : '会话切换 / 锁定主控'}</span>
        <select id="cm-conv-select" class="cm-select" aria-label="${lang === 'en' ? 'Select conversation' : '选择会话'}">
          ${options}
        </select>
        <button type="button" id="cm-lock-main-btn" class="preset-btn cm-lock-btn${switchState.lockMain ? ' active' : ''}" title="${esc(lockTitle)}" aria-pressed="${switchState.lockMain}">
          ${lockLabel}
        </button>
      </div>
      ${
        lockedSub
          ? `<div class="switcher-note">${
              lang === 'en'
                ? `Subagent active (${esc(HOST_CONV_ID.slice(0, 8))}) — locked to main ${esc(eff.slice(0, 8))}`
                : `当前为子代理 (${esc(HOST_CONV_ID.slice(0, 8))}) — 已锁定主对话 ${esc(eff.slice(0, 8))}`
            }</div>`
          : ''
      }
    `;
    globalThis.CM_SECTIONS?.applyVisibility?.();
  }

  function renderScopeCost() {
    const card = document.getElementById('scope-cost-card');
    if (!card) return;
    const lang = getLang();
    const sc = runtime.scopeData;
    const scopeTabs = [
      { id: 'conversation', en: 'Active', zh: '当前' },
      { id: 'project', en: 'Project', zh: '项目' },
      { id: '7d', en: '7d', zh: '7天' },
      { id: '30d', en: '30d', zh: '30天' },
      { id: 'all', en: 'All', zh: '全部' },
    ];

    const pillsHtml = scopeTabs
      .map(
        (t) =>
          `<button type="button" class="preset-btn${scopeState.scope === t.id ? ' active' : ''}" data-cm-scope="${t.id}">${lang === 'en' ? t.en : t.zh}</button>`,
      )
      .join('');

    const totals = sc?.totals || {
      calls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      inputCost: 0,
      cacheCost: 0,
      outputCost: 0,
      totalCost: 0,
      cacheSavedUsd: 0,
    };
    const chatsCount = sc?.conversationsCount || 0;
    const byModel = Array.isArray(sc?.byModel) ? sc.byModel : [];
    const byProject = Array.isArray(sc?.byProject) ? sc.byProject : [];
    const byChat = Array.isArray(sc?.byChat) ? sc.byChat : [];
    const months = Array.isArray(sc?.months) ? sc.months : [];
    const archivedUsed = Array.isArray(sc?.archivedMonthsUsed) ? sc.archivedMonthsUsed : [];
    const costPrefs = sc?.costPrefs || { currency: 'USD', fxRate: 1, monthlyFee: 0 };

    if (!runtime.expandedProjectsInit && byProject.length > 0) {
      runtime.expandedProjectsInit = true;
      runtime.expandedProjects.add(byProject[0].projectKey);
    }

    const fmtMoney = (usd) => {
      const base = fmtUsd(usd);
      if (costPrefs.currency && costPrefs.currency !== 'USD' && costPrefs.fxRate > 0) {
        const conv = (Number(usd) || 0) * costPrefs.fxRate;
        const convStr = conv >= 100 ? conv.toFixed(0) : conv >= 10 ? conv.toFixed(1) : conv.toFixed(2);
        return `${base} (${convStr} ${costPrefs.currency})`;
      }
      return base;
    };

    const wsNotice =
      scopeState.scope === 'project' && runtime.workspaceUris.length === 0
        ? `<div class="sc-note">${
            lang === 'en'
              ? 'No workspace open — showing active conversation.'
              : '未检测到打开的工作区，当前仅统计本会话。'
          }</div>`
        : '';

    const archiveBadge =
      archivedUsed.length > 0
        ? `<div class="sc-note">${
            lang === 'en'
              ? `Includes ${archivedUsed.length} frozen monthly archive(s) (skipped rescanning).`
              : `已复用 ${archivedUsed.length} 个归档月份缓存（免重扫）。`
          }</div>`
        : '';

    let breakdownHtml = '';
    if (scopeState.breakdownView === 'models') {
      breakdownHtml = `<div class="sc-subcard">
        ${
          byModel.length === 0
            ? `<div class="sc-empty">${lang === 'en' ? 'No model usage in this scope.' : '当前范围暂无模型用量。'}</div>`
            : byModel
                .map(
                  (m) => `
                <div class="sc-model-row">
                  <div class="sc-model-left">
                    <span class="sc-model-name" title="${esc(m.modelKey)}">${esc(m.label)}</span>
                    <span class="sc-model-meta">${m.calls} ${lang === 'en' ? 'calls' : '次'}${m.rate ? ` · $${m.rate.input}/$${m.rate.cacheRead}/$${m.rate.output}` : ''}</span>
                  </div>
                  <div class="sc-val-pills">
                    <span class="cm-tok-pill">${fmtTok(m.totalTokens)}</span>
                    <span class="cm-cost-pill">${m.priced ? fmtUsd(m.totalCost) : (lang === 'en' ? 'No rate' : '无单价')}</span>
                  </div>
                </div>`,
                )
                .join('')
        }
      </div>`;
    } else if (scopeState.breakdownView === 'projects') {
      breakdownHtml = `<div class="sc-subcard">
        ${
          byProject.length === 0
            ? `<div class="sc-empty">${lang === 'en' ? 'No projects in this scope.' : '当前范围暂无项目记录。'}</div>`
            : byProject
                .map((p) => {
                  const isOpen = runtime.expandedProjects.has(p.projectKey);
                  const nested = isOpen
                    ? `<div class="sc-proj-chats">
                        ${p.chats
                          .map(
                            (ch) => `
                          <div class="sc-chat-row">
                            <div class="sc-model-left">
                              <span class="sc-chat-title" title="${esc(ch.convId)}">${esc(ch.title)}</span>
                              <span class="sc-model-meta">${ch.calls} ${lang === 'en' ? 'calls' : '次'}${ch.models?.length ? ` · ${esc(ch.models.slice(0, 2).join(', '))}` : ''}</span>
                            </div>
                            <div class="sc-val-pills">
                              <span class="cm-tok-pill">${fmtTok(ch.totalTokens)}</span>
                              <span class="cm-cost-pill">${fmtUsd(ch.totalCost)}</span>
                            </div>
                          </div>`,
                          )
                          .join('')}
                      </div>`
                    : '';
                  return `
                    <div class="sc-proj-item">
                      <button type="button" class="sc-proj-head" data-proj-toggle="${esc(p.projectKey)}">
                        <div class="sc-model-left">
                          <span class="sc-model-name">${isOpen ? '▾' : '▸'} ${esc(p.projectName)}</span>
                          <span class="sc-model-meta">${p.chatsCount} ${lang === 'en' ? 'chats' : '会话'} · ${p.calls} ${lang === 'en' ? 'calls' : '次'}</span>
                        </div>
                        <div class="sc-val-pills">
                          <span class="cm-tok-pill">${fmtTok(p.totalTokens)}</span>
                          <span class="cm-cost-pill">${fmtUsd(p.totalCost)}</span>
                        </div>
                      </button>
                      ${nested}
                    </div>`;
                })
                .join('')
        }
      </div>`;
    } else if (scopeState.breakdownView === 'chats') {
      breakdownHtml = `<div class="sc-subcard">
        ${
          byChat.length === 0
            ? `<div class="sc-empty">${lang === 'en' ? 'No conversations in this scope.' : '当前范围暂无会话记录。'}</div>`
            : byChat
                .slice(0, 60)
                .map(
                  (ch) => `
                <div class="sc-model-row">
                  <div class="sc-model-left">
                    <span class="sc-model-name" title="${esc(ch.convId)}">${esc(ch.title)}</span>
                    <span class="sc-model-meta">[${esc(ch.projectName)}] · ${ch.calls} ${lang === 'en' ? 'calls' : '次'}</span>
                  </div>
                  <div class="sc-val-pills">
                    <span class="cm-tok-pill">${fmtTok(ch.totalTokens)}</span>
                    <span class="cm-cost-pill">${fmtUsd(ch.totalCost)}</span>
                  </div>
                </div>`,
                )
                .join('')
        }
      </div>`;
    }

    let currencyPanelHtml = '';
    if (scopeState.showCurrency) {
      currencyPanelHtml = `
        <form id="cm-currency-form" class="sc-panel">
          <div class="sc-price-grid">
            <label><span>${lang === 'en' ? 'Currency' : '币种'}</span><input id="cm-fx-curr" type="text" maxlength="6" value="${esc(costPrefs.currency || 'USD')}"></label>
            <label><span>${lang === 'en' ? 'FX Rate / $1' : '汇率 (/ $1)'}</span><input id="cm-fx-rate" type="number" step="0.01" min="0.0001" value="${costPrefs.fxRate ?? 1}"></label>
            <label><span>${lang === 'en' ? 'Plan $/mo' : '订阅 $/月'}</span><input id="cm-fx-fee" type="number" step="0.5" min="0" value="${costPrefs.monthlyFee ?? 0}"></label>
          </div>
          <div class="sc-panel-actions">
            <button type="submit" class="apply-btn sc-btn-sm">${lang === 'en' ? 'Apply FX / ROI' : '保存汇率/订阅'}</button>
          </div>
        </form>
      `;
    }

    let pricingPanelHtml = '';
    if (scopeState.showPricing) {
      const cat = runtime.pricingCatalog || [];
      const selected = cat.find((c) => c.modelKey === runtime.selectedPriceKey) || cat[0];
      const opts = cat
        .map((c) => `<option value="${esc(c.modelKey)}" ${selected?.modelKey === c.modelKey ? 'selected' : ''}>${esc(c.label)}${c.isCustom ? ' *' : ''}</option>`)
        .join('');
      pricingPanelHtml = `
        <form id="cm-pricing-form" class="sc-panel">
          <div class="sc-panel-row">
            <select id="cm-price-model" class="cm-select">${opts}</select>
          </div>
          <div class="sc-price-grid">
            <label><span>${lang === 'en' ? 'Input' : '输入'} $/1M</span><input id="cm-p-in" type="number" step="0.001" min="0" value="${selected?.input ?? 0}"></label>
            <label><span>${lang === 'en' ? 'Cache' : '缓存'} $/1M</span><input id="cm-p-cache" type="number" step="0.001" min="0" value="${selected?.cacheRead ?? 0}"></label>
            <label><span>${lang === 'en' ? 'Output' : '输出'} $/1M</span><input id="cm-p-out" type="number" step="0.001" min="0" value="${selected?.output ?? 0}"></label>
          </div>
          <div class="sc-panel-actions">
            <button type="submit" class="apply-btn sc-btn-sm">${lang === 'en' ? 'Save Rate' : '保存单价'}</button>
            <button type="button" id="cm-price-reset" class="ghost-btn sc-btn-sm">${lang === 'en' ? 'Reset' : '恢复默认'}</button>
          </div>
        </form>
      `;
    }

    let archivePanelHtml = '';
    if (scopeState.showArchive) {
      const mOpts = months.length > 0
        ? months
            .map((m) => {
              const frozenTxt = m.archived ? (lang === 'en' ? ' [Frozen]' : ' [已冻结]') : '';
              const sel = runtime.selectedArchiveMonth === m.monthKey ? 'selected' : '';
              return `<option value="${esc(m.monthKey)}" ${sel}>${esc(m.monthKey)} · ${m.chats} ${lang === 'en' ? 'chats' : '会话'} · ${fmtTok(m.totalTokens)}${frozenTxt}</option>`;
            })
            .join('')
        : `<option value="">${lang === 'en' ? 'No monthly data yet' : '暂无月份记录'}</option>`;

      archivePanelHtml = `
        <div class="sc-panel">
          <div class="sc-panel-row">
            <select id="cm-archive-month" class="cm-select">${mOpts}</select>
          </div>
          <div class="sc-panel-actions">
            <button type="button" id="cm-archive-export" class="apply-btn sc-btn-sm" ${months.length === 0 ? 'disabled' : ''}>${lang === 'en' ? 'Export & Freeze' : '导出并冻结月份'}</button>
            <button type="button" id="cm-archive-import-btn" class="ghost-btn sc-btn-sm">${lang === 'en' ? 'Import JSON' : '导入归档'}</button>
            <input id="cm-archive-file" type="file" accept=".json,application/json" class="hidden">
          </div>
          ${runtime.statusMsg ? `<div class="sc-note">${esc(runtime.statusMsg)}</div>` : ''}
        </div>
      `;
    }

    const roiBadge =
      costPrefs.monthlyFee > 0 && totals.totalCost > 0
        ? `<span class="sc-roi-pill">${(totals.totalCost / costPrefs.monthlyFee).toFixed(1)}× ROI</span>`
        : '';

    card.innerHTML = `
      <div class="section-head">
        <span class="section-title">${lang === 'en' ? 'Usage & Cost' : '用量与费用'}</span>
        ${roiBadge}
      </div>
      <div class="sc-pills">${pillsHtml}</div>

      ${wsNotice}

      <div class="sc-hero">
        <div class="sc-hero-left">
          <div class="sc-cost-main">${esc(fmtMoney(totals.totalCost))}</div>
          <div class="sc-cost-sub">
            ${totals.calls} ${lang === 'en' ? 'calls' : '次'} · ${chatsCount} ${lang === 'en' ? 'chats' : '会话'} · <span class="cm-tok-pill sc-tok-inline">${fmtTok(totals.totalTokens)} tok</span>
          </div>
        </div>
        <div class="sc-saved-pill" title="${lang === 'en' ? 'Estimated savings vs uncached input pricing' : '相对未命中缓存节省的费用'}">
          ${lang === 'en' ? 'Saved' : '省'} ${fmtUsd(totals.cacheSavedUsd)}
        </div>
      </div>

      <div class="sc-rows">
        <div class="sc-row">
          <span class="sc-row-k">${lang === 'en' ? 'Input (cache miss)' : '输入（未命中缓存）'}</span>
          <span class="cm-tok-pill">${fmtTok(totals.inputTokens)}</span>
          <span class="cm-cost-pill">${fmtUsd(totals.inputCost)}</span>
        </div>
        <div class="sc-row">
          <span class="sc-row-k">${lang === 'en' ? 'Cache hit (read)' : '缓存读取'}</span>
          <span class="cm-tok-pill">${fmtTok(totals.cacheReadTokens)}</span>
          <span class="cm-cost-pill">${fmtUsd(totals.cacheCost)}</span>
        </div>
        <div class="sc-row">
          <span class="sc-row-k">${lang === 'en' ? 'Output' : '输出'}</span>
          <span class="cm-tok-pill">${fmtTok(totals.outputTokens)}</span>
          <span class="cm-cost-pill">${fmtUsd(totals.outputCost)}</span>
        </div>
      </div>

      <div class="sc-toolbar">
        <button type="button" class="ghost-btn sc-btn-xs${scopeState.breakdownView === 'models' ? ' is-on' : ''}" data-bd-view="models">
          ${lang === 'en' ? `Models (${byModel.length})` : `按模型 (${byModel.length})`}
        </button>
        <button type="button" class="ghost-btn sc-btn-xs${scopeState.breakdownView === 'projects' ? ' is-on' : ''}" data-bd-view="projects">
          ${lang === 'en' ? `Projects (${byProject.length})` : `按项目 (${byProject.length})`}
        </button>
        <button type="button" class="ghost-btn sc-btn-xs${scopeState.breakdownView === 'chats' ? ' is-on' : ''}" data-bd-view="chats">
          ${lang === 'en' ? `Chats (${byChat.length})` : `按会话 (${byChat.length})`}
        </button>
        <button type="button" id="cm-toggle-pricing" class="ghost-btn sc-btn-xs${scopeState.showPricing ? ' is-on' : ''}">
          ${lang === 'en' ? 'Edit Prices' : '自定义单价'}
        </button>
        <button type="button" id="cm-toggle-currency" class="ghost-btn sc-btn-xs${scopeState.showCurrency ? ' is-on' : ''}">
          ${lang === 'en' ? 'FX / Plan' : '汇率 / 订阅'}
        </button>
        <button type="button" id="cm-toggle-archive" class="ghost-btn sc-btn-xs${scopeState.showArchive ? ' is-on' : ''}">
          ${lang === 'en' ? 'Archive' : '月度归档'}
        </button>
      </div>

      ${breakdownHtml}
      ${currencyPanelHtml}
      ${pricingPanelHtml}
      ${archivePanelHtml}
      ${archiveBadge}
    `;
    globalThis.CM_SECTIONS?.applyVisibility?.();
  }

  function renderBreakdown() {
    const card = document.getElementById('breakdown-card');
    if (!card) return;
    const lang = getLang();
    const bd = runtime.breakdownData;
    const title = lang === 'en' ? 'Context Breakdown' : '上下文构成';

    if (!bd || !bd.available || !Array.isArray(bd.segments) || bd.segments.length === 0) {
      card.innerHTML = `
        <div class="section-head">
          <span class="section-title">${title}</span>
          <span class="section-meta">${lang === 'en' ? 'Waiting' : '等待数据'}</span>
        </div>
        <div class="sc-empty">${lang === 'en' ? 'No breakdown available yet.' : '当前会话暂无上下文构成明细。'}</div>
      `;
      globalThis.CM_SECTIONS?.applyVisibility?.();
      return;
    }

    const srcLabel =
      bd.source === 'prompt_sections' || bd.source === 'token_breakdown'
        ? (lang === 'en' ? 'Exact' : '精确统计')
        : bd.source === 'steps_estimated'
          ? (lang === 'en' ? 'Step Est.' : '步骤估算')
          : (lang === 'en' ? 'Summary' : '摘要估算');

    const barHtml = bd.segments
      .map(
        (s) =>
          `<div class="bd-bar-seg" style="width:${Math.max(0.5, s.pctOfLimit)}%;background:${esc(s.color)}" title="${esc(lang === 'en' ? s.en : s.zh)}: ${fmtTok(s.tokens)} (${s.pctOfUsed}%)"></div>`,
      )
      .join('');

    const segListHtml = bd.segments
      .map(
        (s) => `
        <div class="bd-item">
          <span class="bd-item-l">
            <i class="bd-dot" style="background:${esc(s.color)}"></i>
            <span class="bd-name">${esc(lang === 'en' ? s.en : s.zh)}</span>
          </span>
          <span class="bd-item-r"><strong>${fmtTok(s.tokens)}</strong> <span class="bd-pct">${s.pctOfUsed}%</span></span>
        </div>
      `,
      )
      .join('');

    const topItems = Array.isArray(bd.largestItems) ? bd.largestItems : [];
    const topHtml =
      topItems.length > 0
        ? `
        <div class="bd-top-head">${lang === 'en' ? 'Top 5 Largest Items' : '占用前 5 项'}</div>
        <div class="bd-top-list">
          ${topItems
            .map(
              (it) => `
              <div class="bd-top-row" title="${esc(it.title)}">
                <span class="bd-top-title">${esc(it.title)}</span>
                <span class="bd-top-val">${fmtTok(it.tokens)} · ${it.pctOfUsed}%</span>
              </div>`,
            )
            .join('')}
        </div>
      `
        : '';

    const copyBtns = `
      <div class="bd-actions">
        <button type="button" id="cm-copy-context" class="ghost-btn sc-btn-xs">${lang === 'en' ? 'Copy /context' : '复制 /context'}</button>
        <button type="button" id="cm-copy-handoff" class="ghost-btn sc-btn-xs">${lang === 'en' ? 'Copy Handoff' : '复制交接提示'}</button>
        ${runtime.copyStatus ? `<span class="bd-copy-ok">${esc(runtime.copyStatus)}</span>` : ''}
      </div>
    `;

    card.innerHTML = `
      <div class="section-head">
        <span class="section-title">${title}</span>
        <span class="section-meta">${srcLabel}</span>
      </div>
      <div class="bd-track">${barHtml}</div>
      <div class="bd-grid">${segListHtml}</div>
      ${topHtml}
      ${copyBtns}
    `;
    globalThis.CM_SECTIONS?.applyVisibility?.();
  }

  function renderOrchestratorCard(lang) {
    const card = document.getElementById('orchestrator-card');
    if (!card) return;
    const d = runtime.diagnosticsData;
    const orch = d?.orchestrator;
    const title = lang === 'en' ? 'Orchestrator vs Executor' : '编排器 vs 执行器';

    if (!d || !d.available || !orch) {
      card.innerHTML = `
        <div class="section-head">
          <span class="section-title">${title}</span>
          <span class="section-meta">${lang === 'en' ? 'Waiting' : '等待数据'}</span>
        </div>
        <div class="sc-empty">${lang === 'en' ? 'No generator telemetry yet.' : '当前会话暂无编排调度数据。'}</div>
      `;
      return;
    }

    const cfg = orch.configuredPair;
    const cfgPill = cfg
      ? `<span class="dna-chip" title="~/.gemini/config/config.json">${esc(cfg.planLabel)} → ${esc(cfg.executionLabel)}</span>`
      : '';

    if (!orch.active) {
      const direct = orch.roles?.direct || {};
      card.innerHTML = `
        <div class="section-head">
          <span class="section-title">${title}</span>
          <span class="section-meta">${lang === 'en' ? 'Single-model' : '单模型直连'}</span>
        </div>
        <div class="diag-pills">
          <span class="dna-chip">${direct.calls || 0} ${lang === 'en' ? 'direct calls' : '次直连调用'}</span>
          ${direct.cacheHitRate != null ? `<span class="cm-tok-pill">${lang === 'en' ? 'Cache' : '缓存'} ${direct.cacheHitRate}%</span>` : ''}
          ${cfgPill}
        </div>
      `;
      return;
    }

    const o = orch.roles.orchestrator || {};
    const e = orch.roles.executor || {};
    const sub = orch.roles.subagent || {};
    const coldClass = orch.coldCacheSwitchCount > 0 ? ' is-warn' : ' is-clean';

    card.innerHTML = `
      <div class="section-head">
        <span class="section-title">${title}</span>
        <div class="diag-pills">
          <span class="dna-chip">${lang === 'en' ? `Switches: ${orch.roleSwitchCount}` : `角色切换: ${orch.roleSwitchCount}`}</span>
          <span class="diag-badge${coldClass}">${
            orch.coldCacheSwitchCount > 0
              ? (lang === 'en' ? `Cold Reset ×${orch.coldCacheSwitchCount} (${fmtTok(orch.coldSwitchFreshInputTokens)})` : `冷缓存重置 ×${orch.coldCacheSwitchCount} (${fmtTok(orch.coldSwitchFreshInputTokens)})`)
              : (lang === 'en' ? '0 Cold Resets' : '0 次冷重置')
          }</span>
        </div>
      </div>
      <div class="diag-grid">
        <div class="diag-role-box">
          <div class="diag-k">${lang === 'en' ? 'Orchestrator' : '编排器'}</div>
          <div class="diag-v">${esc(o.labels?.[0] || o.models?.[0] || '—')}</div>
          <div class="diag-meta">${o.calls || 0} ${lang === 'en' ? 'calls' : '次'} · ${o.cacheHitRate != null ? `${o.cacheHitRate}%` : '—'}</div>
          <div class="diag-pills">
            <span class="cm-tok-pill">${fmtTok((o.inputTokens || 0) + (o.cacheReadTokens || 0) + (o.outputTokens || 0))}</span>
            <span class="cm-cost-pill">${fmtUsd(o.costUsd || 0)}</span>
          </div>
        </div>
        <div class="diag-role-box">
          <div class="diag-k">${lang === 'en' ? 'Executor' : '执行器'}</div>
          <div class="diag-v">${esc(e.labels?.[0] || e.models?.[0] || '—')}</div>
          <div class="diag-meta">${e.calls || 0} ${lang === 'en' ? 'calls' : '次'} · ${e.cacheHitRate != null ? `${e.cacheHitRate}%` : '—'}</div>
          <div class="diag-pills">
            <span class="cm-tok-pill">${fmtTok((e.inputTokens || 0) + (e.cacheReadTokens || 0) + (e.outputTokens || 0))}</span>
            <span class="cm-cost-pill">${fmtUsd(e.costUsd || 0)}</span>
          </div>
        </div>
      </div>
      ${(sub.calls > 0 || cfgPill) ? `<div class="diag-pills" style="margin-top:6px">${sub.calls > 0 ? `<span class="dna-chip">${lang === 'en' ? 'Subagent' : '子代理'}: ${sub.calls} (${fmtUsd(sub.costUsd || 0)})</span>` : ''}${cfgPill}</div>` : ''}
    `;
  }

  function renderRetriesCard(lang) {
    const card = document.getElementById('retries-card');
    if (!card) return;
    const d = runtime.diagnosticsData;
    const rt = d?.retries;
    const title = lang === 'en' ? 'Retries & Errors' : '重试与报错';

    if (!d || !d.available || !rt) {
      card.innerHTML = `
        <div class="section-head">
          <span class="section-title">${title}</span>
          <span class="section-meta">${lang === 'en' ? 'Waiting' : '等待数据'}</span>
        </div>
        <div class="sc-empty">${lang === 'en' ? 'No retry data yet.' : '暂无重试检测记录。'}</div>
      `;
      return;
    }

    if (rt.totalFailedRetries === 0 && rt.failedCallsCount === 0) {
      card.innerHTML = `
        <div class="section-head">
          <span class="section-title">${title}</span>
          <span class="diag-badge is-clean">${lang === 'en' ? 'Healthy · 0 Retries' : '正常 · 0 次重试'}</span>
        </div>
      `;
      return;
    }

    const codeChips = (rt.errorCodes || []).map((c) => `<span class="diag-badge is-danger">${esc(c.code)} ×${c.count}</span>`).join('');
    const errRows = (rt.recentErrors || []).slice(0, 4).map((e) => `
      <div class="diag-err-row">
        <span class="diag-err-meta">#${e.stepIndex} · ${esc(e.model)} · <strong>${esc(e.code)}</strong></span>
        <span class="diag-err-msg" title="${esc(e.message)}">${esc(e.message)}</span>
      </div>
    `).join('');

    card.innerHTML = `
      <div class="section-head">
        <span class="section-title">${title}</span>
        <span class="diag-badge is-warn">${rt.totalFailedRetries} ${lang === 'en' ? 'retries' : '次重试'}${rt.failedCallsCount > 0 ? ` · ${rt.failedCallsCount} ${lang === 'en' ? 'err' : '报错'}` : ''}</span>
      </div>
      <div class="diag-pills">
        <span class="cm-tok-pill">${lang === 'en' ? 'Wasted' : '浪费'}: ${fmtTok(rt.wastedTotalTokens)}</span>
        <span class="cm-cost-pill">${fmtUsd(rt.wastedCostUsd)}</span>
        ${codeChips}
      </div>
      ${errRows ? `<div class="diag-err-list">${errRows}</div>` : ''}
    `;
  }

  function renderModelDnaCard(lang) {
    const card = document.getElementById('model-dna-card');
    if (!card) return;
    const d = runtime.diagnosticsData;
    const list = Array.isArray(d?.modelDna) ? d.modelDna : [];
    const title = lang === 'en' ? 'Model DNA' : '模型参数画像';

    if (!d || !d.available || list.length === 0) {
      card.innerHTML = `
        <div class="section-head">
          <span class="section-title">${title}</span>
          <span class="section-meta">${lang === 'en' ? 'Waiting' : '等待数据'}</span>
        </div>
        <div class="sc-empty">${lang === 'en' ? 'No model DNA telemetry yet.' : '暂无模型参数画像。'}</div>
      `;
      return;
    }

    const itemsHtml = list.map((m) => {
      const cc = m.completionConfig;
      const chips = [];
      if (m.apiProvider) chips.push(m.apiProvider);
      if (cc?.temperature != null) chips.push(`temp ${cc.temperature}`);
      if (cc?.topP != null) chips.push(`topP ${cc.topP}`);
      if (cc?.topK > 0) chips.push(`topK ${cc.topK}`);
      if (cc?.maxTokens > 0) chips.push(`max ${fmtTok(cc.maxTokens)}`);
      if (m.toolCount > 0) chips.push(`${m.toolCount} tools`);
      if (m.hasSystemPrompt) chips.push(lang === 'en' ? 'SysPrompt' : '系统提示词');
      const chipHtml = chips.map((c) => `<span class="dna-chip">${esc(c)}</span>`).join('');
      const secHtml = (m.promptSectionTitles || []).slice(0, 6).map((t) => `<span class="dna-sec-chip">${esc(t)}</span>`).join('');
      return `
        <div class="dna-item">
          <div class="dna-head">
            <span class="sc-model-name">${esc(m.label)}</span>
            <div class="diag-pills">
              ${m.isCustomModel ? '<span class="diag-badge is-warn">BYOK</span>' : ''}
              <span class="sc-model-meta">${m.calls} ${lang === 'en' ? 'calls' : '次'}${m.responseModel ? ` · ${esc(m.responseModel)}` : ''}</span>
            </div>
          </div>
          ${chipHtml ? `<div class="dna-chips">${chipHtml}</div>` : ''}
          ${secHtml ? `<div class="dna-chips">${secHtml}</div>` : ''}
        </div>
      `;
    }).join('');

    card.innerHTML = `
      <div class="section-head">
        <span class="section-title">${title}</span>
        <span class="section-meta">${list.length} ${lang === 'en' ? 'models' : '模型'}</span>
      </div>
      <div class="dna-list">${itemsHtml}</div>
    `;
  }

  function renderDiagnostics() {
    const lang = getLang();
    renderOrchestratorCard(lang);
    renderRetriesCard(lang);
    renderModelDnaCard(lang);
    globalThis.CM_SECTIONS?.applyVisibility?.();
  }

  function renderGaugeExtra() {
    const gaugeCard = document.querySelector('#dashboard > .gauge-card');
    if (!gaugeCard) return;
    let strip = document.getElementById('cm-gauge-extra');
    if (!strip) {
      strip = document.createElement('div');
      strip.id = 'cm-gauge-extra';
      strip.className = 'cm-gauge-extra hidden';
      gaugeCard.appendChild(strip);
    }
    const ctx = runtime.latestContext;
    if (!ctx || !ctx.found) {
      strip.classList.add('hidden');
      return;
    }
    const lang = getLang();
    const pills = [];
    const used = ctx.latest?.contextUsed || 0;
    const limit = ctx.limitTokens || 512_000;
    const nativeLim = ctx.nativeLimitTokens || 0;
    if (nativeLim > limit) {
      const nPct = ((used / nativeLim) * 100).toFixed(1);
      pills.push(
        `<span class="cm-gauge-pill">${
          lang === 'en' ? `Native ${fmtTok(nativeLim)} (${nPct}%)` : `原生上限 ${fmtTok(nativeLim)} (${nPct}%)`
        }</span>`,
      );
    }
    const comps = Array.isArray(ctx.compactions) ? ctx.compactions : [];
    if (comps.length > 0) {
      const savedTotal = comps.reduce((s, c) => s + (c.savedTokens || 0), 0);
      pills.push(
        `<span class="cm-gauge-pill is-comp">${
          lang === 'en'
            ? `Compactions: ${comps.length} · Saved ${fmtTok(savedTotal)}`
            : `已压缩 ${comps.length} 次 · 释放 ${fmtTok(savedTotal)}`
        }</span>`,
      );
    }
    if (pills.length === 0) {
      strip.classList.add('hidden');
      strip.innerHTML = '';
    } else {
      strip.classList.remove('hidden');
      strip.innerHTML = pills.join('');
    }
  }

  function buildContextReportText() {
    const bd = runtime.breakdownData;
    const ctx = runtime.latestContext;
    const lines = [
      `Context Report (${getEffectiveConvId().slice(0, 8) || 'active'})`,
      `Model: ${ctx?.speedStats?.models?.join(', ') || ctx?.latest?.speed?.model || 'unknown'}`,
      `Used: ${fmtTok(bd?.usedTokens || ctx?.latest?.contextUsed || 0)} / ${fmtTok(bd?.limitTokens || ctx?.limitTokens || 512000)}`,
      '',
      'Categories:',
      ...(bd?.segments || []).map((s) => `  - ${s.en}: ${fmtTok(s.tokens)} (${s.pctOfUsed}%)`),
    ];
    if (bd?.largestItems?.length) {
      lines.push('', 'Largest Items:');
      bd.largestItems.forEach((it, idx) => lines.push(`  ${idx + 1}. ${it.title} — ${fmtTok(it.tokens)} (${it.pctOfUsed}%)`));
    }
    return lines.join('\n');
  }

  function buildHandoffText() {
    const bd = runtime.breakdownData;
    const ctx = runtime.latestContext;
    const title = ctx?.meta?.title || getEffectiveConvId().slice(0, 8);
    const repo = ctx?.meta?.repoName ? `${ctx.meta.repoName}${ctx.meta.branch ? ` @${ctx.meta.branch}` : ''}` : '';
    const lines = [
      '# HANDOFF — Continue Task',
      `- **Conversation:** ${title}`,
      ...(repo ? [`- **Workspace:** ${repo}`] : []),
      `- **Context:** ${fmtTok(bd?.usedTokens || 0)} / ${fmtTok(bd?.limitTokens || 512000)}`,
    ];
    if (bd?.largestItems?.length) {
      lines.push('- **Top Loaded Context:**');
      bd.largestItems.forEach((it) => lines.push(`  - ${it.title} (${fmtTok(it.tokens)})`));
    }
    lines.push('', 'Please continue from the latest state above without repeating completed steps.');
    return lines.join('\n');
  }

  async function refreshHeatmapAnalytics() {
    if (!isSectionEnabled('heatmap')) return;
    try {
      runtime.heatmapAnalytics = await rawApi(`/api/heatmap/analytics?weeks=16&source=${encodeURIComponent(runtime.hmSource)}`);
      renderHeatmapAnalytics();
    } catch {
      // ignore
    }
  }

  function renderHeatmapAnalytics() {
    const box = document.getElementById('cm-hm-analytics');
    if (!box) return;
    const lang = getLang();
    const ha = runtime.heatmapAnalytics;
    const streaks = ha?.streaks || { current: 0, longest: 0 };
    const p = ha?.periods || { week: {}, month: {}, year: {}, all: {} };

    box.innerHTML = `
      <div class="hm-ana-top">
        <div class="sc-pills" style="margin-bottom:0">
          <button type="button" class="preset-btn${runtime.hmMetric === 'tokens' ? ' active' : ''}" data-hm-metric="tokens">${lang === 'en' ? 'Tokens' : 'Token'}</button>
          <button type="button" class="preset-btn${runtime.hmMetric === 'cost' ? ' active' : ''}" data-hm-metric="cost">${lang === 'en' ? '$ Cost' : '$ 费用'}</button>
        </div>
        <div class="sc-pills" style="margin-bottom:0">
          <button type="button" class="preset-btn${runtime.hmSource === 'all' ? ' active' : ''}" data-hm-source="all">${lang === 'en' ? 'All' : '全部'}</button>
          <button type="button" class="preset-btn${runtime.hmSource === 'app' ? ' active' : ''}" data-hm-source="app">App</button>
          <button type="button" class="preset-btn${runtime.hmSource === 'cli' ? ' active' : ''}" data-hm-source="cli">CLI</button>
        </div>
      </div>
      <div class="hm-ana-stats">
        <span class="hm-ana-pill">${lang === 'en' ? 'Streak' : '连续'}: <strong>${streaks.current}d</strong> (${lang === 'en' ? 'Max' : '最长'} ${streaks.longest}d)</span>
        <span class="cm-tok-pill">7d: ${fmtTok(p.week?.tokens || 0)}</span>
        <span class="cm-tok-pill">30d: ${fmtTok(p.month?.tokens || 0)}</span>
        <span class="cm-cost-pill">${lang === 'en' ? 'Year' : '今年'}: ${fmtUsd(p.year?.cost || 0)}</span>
      </div>
    `;

    // Apply SQLite cost/source shading onto existing #hm-grid cells
    const daily = ha?.daily;
    const grid = document.getElementById('hm-grid');
    if (!grid || !daily) return;
    const cells = [...grid.querySelectorAll('.hm-cell[data-date]')];
    if (cells.length === 0) return;

    let maxVal = 0;
    for (const c of cells) {
      const rec = daily[c.dataset.date];
      const v = rec ? (runtime.hmMetric === 'cost' ? rec.totalCost : rec.totalTokens) : 0;
      if (v > maxVal) maxVal = v;
    }
    for (const c of cells) {
      const dk = c.dataset.date;
      const rec = daily[dk];
      const v = rec ? (runtime.hmMetric === 'cost' ? rec.totalCost : rec.totalTokens) : 0;
      for (const lv of ['lv0', 'lv1', 'lv2', 'lv3', 'lv4']) c.classList.remove(lv);
      let lv = 0;
      if (v > 0 && maxVal > 0) {
        const r = v / maxVal;
        if (r >= 0.75) lv = 4;
        else if (r >= 0.45) lv = 3;
        else if (r >= 0.18) lv = 2;
        else lv = 1;
      }
      c.classList.add(`lv${lv}`);
      if (rec && rec.calls > 0) {
        c.title = `${dk}: ${fmtTok(rec.totalTokens)} tok · ${fmtUsd(rec.totalCost)} (${rec.calls} calls)`;
      }
    }
  }

  function downloadJsonFile(filename, dataObj) {
    const blob = new Blob([JSON.stringify(dataObj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function bindEvents(switcherBar, scopeCard) {
    switcherBar.addEventListener('change', (e) => {
      const sel = e.target.closest('#cm-conv-select');
      if (!sel) return;
      switchState.pinnedConvId = sel.value || '';
      saveJson(SWITCH_KEY, switchState);
      renderSwitcher();
      onTargetConvChanged();
    });

    switcherBar.addEventListener('click', (e) => {
      if (!e.target.closest('#cm-lock-main-btn')) return;
      switchState.lockMain = !switchState.lockMain;
      if (switchState.lockMain) switchState.pinnedConvId = '';
      saveJson(SWITCH_KEY, switchState);
      globalThis.CM_PREFS?.saveServerPatch?.({ switcher: { lockMain: switchState.lockMain } });
      refreshConversations(true);
      onTargetConvChanged();
    });

    scopeCard.addEventListener('click', async (e) => {
      const scopeBtn = e.target.closest('[data-cm-scope]');
      if (scopeBtn) {
        const nextScope = scopeBtn.dataset.cmScope;
        if (VALID_SCOPES.includes(nextScope) && scopeState.scope !== nextScope) {
          scopeState.scope = nextScope;
          saveScopeState();
          renderScopeCost();
          refreshScope(true);
        }
        return;
      }

      if (e.target.closest('[data-bd-view]')) {
        const nextView = e.target.closest('[data-bd-view]').dataset.bdView;
        scopeState.breakdownView = scopeState.breakdownView === nextView ? '' : nextView;
        saveScopeState();
        renderScopeCost();
        return;
      }

      const projBtn = e.target.closest('[data-proj-toggle]');
      if (projBtn) {
        const pk = projBtn.dataset.projToggle;
        if (pk) {
          if (runtime.expandedProjects.has(pk)) runtime.expandedProjects.delete(pk);
          else runtime.expandedProjects.add(pk);
          renderScopeCost();
        }
        return;
      }

      if (e.target.closest('#cm-toggle-currency')) {
        scopeState.showCurrency = !scopeState.showCurrency;
        saveScopeState();
        renderScopeCost();
        return;
      }

      if (e.target.closest('#cm-toggle-pricing')) {
        scopeState.showPricing = !scopeState.showPricing;
        saveScopeState();
        if (scopeState.showPricing && !runtime.pricingCatalog) {
          await refreshPricingCatalog();
        } else {
          renderScopeCost();
        }
        return;
      }

      if (e.target.closest('#cm-toggle-archive')) {
        scopeState.showArchive = !scopeState.showArchive;
        saveScopeState();
        renderScopeCost();
        return;
      }

      if (e.target.closest('#cm-price-reset')) {
        const modelKey = document.getElementById('cm-price-model')?.value || runtime.selectedPriceKey;
        if (!modelKey) return;
        const resp = await rawApi('/api/pricing/reset', {
          method: 'POST',
          body: JSON.stringify({ modelKey }),
        });
        runtime.pricingCatalog = resp.catalog || [];
        renderScopeCost();
        refreshScope(false);
        return;
      }

      if (e.target.closest('#cm-archive-export')) {
        const monthKey = document.getElementById('cm-archive-month')?.value || runtime.selectedArchiveMonth;
        if (!monthKey) return;
        const resp = await rawApi('/api/archive/export', {
          method: 'POST',
          body: JSON.stringify({ monthKey, freeze: true }),
        });
        if (resp?.bundle) {
          downloadJsonFile(`context-monitor-archive-${monthKey}.json`, resp.bundle);
          runtime.statusMsg =
            getLang() === 'en'
              ? `Exported & froze ${monthKey} (${resp.bundle.rows?.length || 0} rows).`
              : `已导出并冻结 ${monthKey}（${resp.bundle.rows?.length || 0} 条记录）。`;
          if (runtime.scopeData) runtime.scopeData.months = resp.months || runtime.scopeData.months;
          renderScopeCost();
        }
        return;
      }

      if (e.target.closest('#cm-archive-import-btn')) {
        document.getElementById('cm-archive-file')?.click();
      }
    });

    scopeCard.addEventListener('change', async (e) => {
      const pm = e.target.closest('#cm-price-model');
      if (pm) {
        runtime.selectedPriceKey = pm.value;
        renderScopeCost();
        return;
      }
      const am = e.target.closest('#cm-archive-month');
      if (am) {
        runtime.selectedArchiveMonth = am.value;
        return;
      }
      const fileInput = e.target.closest('#cm-archive-file');
      if (fileInput?.files?.[0]) {
        try {
          const text = await fileInput.files[0].text();
          const bundle = JSON.parse(text);
          const resp = await rawApi('/api/archive/import', {
            method: 'POST',
            body: JSON.stringify({ bundle }),
          });
          runtime.statusMsg =
            getLang() === 'en'
              ? `Imported ${resp.monthKey} (${resp.rowsCount} rows).`
              : `已导入 ${resp.monthKey}（${resp.rowsCount} 条记录）。`;
          refreshScope(false);
        } catch (err) {
          runtime.statusMsg = String(err.message || 'Import failed');
          renderScopeCost();
        } finally {
          fileInput.value = '';
        }
      }
    });

    scopeCard.addEventListener('submit', async (e) => {
      if (e.target.closest('#cm-currency-form')) {
        e.preventDefault();
        const currency = String(document.getElementById('cm-fx-curr')?.value || 'USD').trim().toUpperCase();
        const fxRate = Number(document.getElementById('cm-fx-rate')?.value) || 1;
        const monthlyFee = Number(document.getElementById('cm-fx-fee')?.value) || 0;
        const resp = await rawApi('/api/cost-prefs', {
          method: 'POST',
          body: JSON.stringify({ currency, fxRate, monthlyFee }),
        });
        if (runtime.scopeData && resp?.prefs) runtime.scopeData.costPrefs = resp.prefs;
        renderScopeCost();
        return;
      }
      if (!e.target.closest('#cm-pricing-form')) return;
      e.preventDefault();
      const modelKey = document.getElementById('cm-price-model')?.value || '';
      const input = Number(document.getElementById('cm-p-in')?.value) || 0;
      const cacheRead = Number(document.getElementById('cm-p-cache')?.value) || 0;
      const output = Number(document.getElementById('cm-p-out')?.value) || 0;
      if (!modelKey) return;
      const resp = await rawApi('/api/pricing', {
        method: 'POST',
        body: JSON.stringify({ modelKey, input, cacheRead, output }),
      });
      runtime.pricingCatalog = resp.catalog || [];
      renderScopeCost();
      refreshScope(false);
    });
  }

  async function mount() {
    installContextInterceptor();

    const viewSession = document.getElementById('view-session');
    const viewCost = document.getElementById('view-cost');
    const dashboard = document.getElementById('dashboard');
    if (!viewSession || !dashboard) return;

    if (!document.getElementById('switcher-bar')) {
      const switcherBar = document.createElement('section');
      switcherBar.id = 'switcher-bar';
      switcherBar.className = 'card switcher-bar';
      viewSession.insertBefore(switcherBar, viewSession.firstChild);

      const scopeCard = document.createElement('section');
      scopeCard.id = 'scope-cost-card';
      scopeCard.className = 'card scope-cost-card';
      if (viewCost) {
        viewCost.appendChild(scopeCard);
      } else {
        viewSession.insertBefore(scopeCard, dashboard);
      }

      const bdCard = document.createElement('section');
      bdCard.id = 'breakdown-card';
      bdCard.className = 'card breakdown-card';
      const gaugeCard = dashboard.querySelector(':scope > .gauge-card');
      if (gaugeCard && gaugeCard.nextSibling) {
        dashboard.insertBefore(bdCard, gaugeCard.nextSibling);
      } else {
        dashboard.appendChild(bdCard);
      }

      const historyCard = dashboard.querySelector(':scope > .history-card');
      for (const [id, cls] of [
        ['orchestrator-card', 'card diag-card'],
        ['retries-card', 'card diag-card'],
        ['model-dna-card', 'card diag-card'],
      ]) {
        if (!document.getElementById(id)) {
          const sec = document.createElement('section');
          sec.id = id;
          sec.className = cls;
          if (historyCard) dashboard.insertBefore(sec, historyCard);
          else dashboard.appendChild(sec);
        }
      }

      bindEvents(switcherBar, scopeCard);

      bdCard.addEventListener('click', async (e) => {
        const isCtx = e.target.closest('#cm-copy-context');
        const isHandoff = e.target.closest('#cm-copy-handoff');
        if (!isCtx && !isHandoff) return;
        const text = isCtx ? buildContextReportText() : buildHandoffText();
        try {
          await navigator.clipboard?.writeText(text);
          runtime.copyStatus = getLang() === 'en' ? 'Copied!' : '已复制!';
          renderBreakdown();
          setTimeout(() => {
            runtime.copyStatus = '';
            renderBreakdown();
          }, 1500);
        } catch {
          // ignore clipboard denial
        }
      });

      const viewHeatmap = document.getElementById('view-heatmap');
      if (viewHeatmap && !document.getElementById('cm-hm-analytics')) {
        const ana = document.createElement('section');
        ana.id = 'cm-hm-analytics';
        ana.className = 'card hm-analytics-card';
        viewHeatmap.insertBefore(ana, viewHeatmap.firstChild);
        ana.addEventListener('click', (e) => {
          const mBtn = e.target.closest('[data-hm-metric]');
          if (mBtn) {
            runtime.hmMetric = mBtn.dataset.hmMetric || 'tokens';
            renderHeatmapAnalytics();
            return;
          }
          const sBtn = e.target.closest('[data-hm-source]');
          if (sBtn) {
            runtime.hmSource = sBtn.dataset.hmSource || 'all';
            refreshHeatmapAnalytics();
          }
        });
        renderHeatmapAnalytics();
      }
    }

    document.getElementById('tab-cost')?.addEventListener('click', () => activateTab('cost'));
    document.getElementById('tab-accounts')?.addEventListener('click', () => activateTab('accounts'));
    document.getElementById('cm-accounts-pill')?.addEventListener('click', () => activateTab('accounts'));
    document.getElementById('tab-session')?.addEventListener('click', () => setCustomTabState('session'));
    document.getElementById('tab-heatmap')?.addEventListener('click', () => {
      setCustomTabState('heatmap');
      setTimeout(() => refreshHeatmapAnalytics(), 250);
    });

    renderSwitcher();
    renderScopeCost();
    renderBreakdown();
    renderDiagnostics();

    try {
      const uris = await globalThis.sidecar?.getWorkspaceUris?.();
      if (Array.isArray(uris)) runtime.workspaceUris = uris;
    } catch {
      // ignore outside host
    }
    globalThis.sidecar?.onWorkspaceChange?.((uris) => {
      runtime.workspaceUris = Array.isArray(uris) ? uris : [];
      if (scopeState.scope === 'project' && isCostTabActive()) refreshScope(false);
    });

    globalThis.CM_I18N?.onChange?.(() => {
      renderSwitcher();
      renderScopeCost();
      renderBreakdown();
      renderDiagnostics();
    });

    globalThis.CM_SECTIONS?.onChange?.((prefs) => {
      if (prefs.switcher && !runtime.conversations) refreshConversations(false);
      if (prefs.costTab && isCostTabActive() && !runtime.scopeData) refreshScope(false);
      if (prefs.breakdown && !runtime.breakdownData) refreshBreakdown();
      if ((prefs.orchestrator || prefs.retries || prefs.modelDna) && !runtime.diagnosticsData) {
        refreshDiagnostics();
      }
    });

    const savedTab = loadTabPref();
    if (savedTab !== 'session' && isSectionEnabled(savedTab === 'cost' ? 'costTab' : savedTab === 'accounts' ? 'accountsTab' : 'heatmap')) {
      setTimeout(() => activateTab(savedTab), 0);
    }

    refreshConversations(false);
    refreshBreakdown();
    refreshDiagnostics();

    setInterval(() => refreshConversations(false), 15_000);
  }

  if (globalThis.document) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mount, { once: true });
    } else {
      mount();
    }
  }

  globalThis.CM_TABS = { activateTab, getActiveTab: loadTabPref };
  globalThis.CM_EXTRAS = {
    getEffectiveConvId,
  };
})();
