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

  const switchState = loadJson(SWITCH_KEY, { pinnedConvId: '', lockMain: false });
  const scopeState = loadJson(SCOPE_KEY, {
    scope: 'conversation',
    showModels: true,
    showPricing: false,
    showArchive: false,
  });
  if (!VALID_SCOPES.includes(scopeState.scope)) scopeState.scope = 'conversation';

  const runtime = {
    workspaceUris: [],
    conversations: null,
    scopeData: null,
    breakdownData: null,
    pricingCatalog: null,
    selectedPriceKey: '',
    selectedArchiveMonth: '',
    statusMsg: '',
    lastContextSig: '',
    lastSentConvId: HOST_CONV_ID,
    pendingScopeTimer: null,
    scopeBusy: false,
    breakdownBusy: false,
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
  }

  function loadTabPref() {
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
      <div class="section-head switcher-head">
        <span class="section-title">${lang === 'en' ? 'Chat Switcher / Lock' : '会话切换 / 锁定主控'}</span>
        <button type="button" id="cm-lock-main-btn" class="preset-btn cm-lock-btn${switchState.lockMain ? ' active' : ''}" title="${esc(lockTitle)}" aria-pressed="${switchState.lockMain}">
          ${lockLabel}
        </button>
      </div>
      <div class="switcher-row">
        <select id="cm-conv-select" class="cm-select" aria-label="${lang === 'en' ? 'Select conversation' : '选择会话'}">
          ${options}
        </select>
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
    const months = Array.isArray(sc?.months) ? sc.months : [];
    const archivedUsed = Array.isArray(sc?.archivedMonthsUsed) ? sc.archivedMonthsUsed : [];

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

    const modelRowsHtml = scopeState.showModels
      ? `<div class="sc-subcard">
          ${
            byModel.length === 0
              ? `<div class="sc-empty">${lang === 'en' ? 'No model usage in this scope.' : '当前范围暂无模型用量。'}</div>`
              : byModel
                  .map(
                    (m) => `
                  <div class="sc-model-row">
                    <div class="sc-model-left">
                      <span class="sc-model-name" title="${esc(m.modelKey)}">${esc(m.label)}</span>
                      <span class="sc-model-meta">${m.calls} ${lang === 'en' ? 'calls' : '次'} · ${fmtTok(m.totalTokens)}</span>
                    </div>
                    <span class="sc-model-cost">${m.priced ? fmtUsd(m.totalCost) : (lang === 'en' ? 'No rate' : '无单价')}</span>
                  </div>`,
                  )
                  .join('')
          }
        </div>`
      : '';

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

    card.innerHTML = `
      <div class="section-head">
        <span class="section-title">${lang === 'en' ? 'Usage & Cost' : '用量与费用'}</span>
      </div>
      <div class="sc-pills">${pillsHtml}</div>

      ${wsNotice}

      <div class="sc-hero">
        <div class="sc-hero-left">
          <div class="sc-cost-main">${fmtUsd(totals.totalCost)}</div>
          <div class="sc-cost-sub">${totals.calls} ${lang === 'en' ? 'calls' : '次调用'} · ${chatsCount} ${lang === 'en' ? 'chats' : '个会话'} · ${fmtTok(totals.totalTokens)} tok</div>
        </div>
        <div class="sc-saved-pill" title="${lang === 'en' ? 'Estimated savings vs uncached input pricing' : '相对未命中缓存节省的费用'}">
          ${lang === 'en' ? 'Saved' : '省'} ${fmtUsd(totals.cacheSavedUsd)}
        </div>
      </div>

      <div class="sc-rows">
        <div class="sc-row">
          <span class="sc-row-k">${lang === 'en' ? 'Input (cache miss)' : '输入（未命中缓存）'}</span>
          <span class="sc-row-v">${fmtTok(totals.inputTokens)}</span>
          <span class="sc-row-usd">${fmtUsd(totals.inputCost)}</span>
        </div>
        <div class="sc-row">
          <span class="sc-row-k">${lang === 'en' ? 'Cache hit (read)' : '缓存读取'}</span>
          <span class="sc-row-v">${fmtTok(totals.cacheReadTokens)}</span>
          <span class="sc-row-usd">${fmtUsd(totals.cacheCost)}</span>
        </div>
        <div class="sc-row">
          <span class="sc-row-k">${lang === 'en' ? 'Output' : '输出'}</span>
          <span class="sc-row-v">${fmtTok(totals.outputTokens)}</span>
          <span class="sc-row-usd">${fmtUsd(totals.outputCost)}</span>
        </div>
      </div>

      <div class="sc-toolbar">
        <button type="button" id="cm-toggle-models" class="ghost-btn sc-btn-xs${scopeState.showModels ? ' is-on' : ''}">
          ${lang === 'en' ? `Models (${byModel.length})` : `按模型 (${byModel.length})`}
        </button>
        <button type="button" id="cm-toggle-pricing" class="ghost-btn sc-btn-xs${scopeState.showPricing ? ' is-on' : ''}">
          ${lang === 'en' ? 'Edit Prices' : '自定义单价'}
        </button>
        <button type="button" id="cm-toggle-archive" class="ghost-btn sc-btn-xs${scopeState.showArchive ? ' is-on' : ''}">
          ${lang === 'en' ? 'Monthly Archive' : '月度归档'}
        </button>
      </div>

      ${modelRowsHtml}
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

    card.innerHTML = `
      <div class="section-head">
        <span class="section-title">${title}</span>
        <span class="section-meta">${srcLabel}</span>
      </div>
      <div class="bd-track">${barHtml}</div>
      <div class="bd-grid">${segListHtml}</div>
      ${topHtml}
    `;
    globalThis.CM_SECTIONS?.applyVisibility?.();
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
      refreshConversations(true);
      onTargetConvChanged();
    });

    scopeCard.addEventListener('click', async (e) => {
      const scopeBtn = e.target.closest('[data-cm-scope]');
      if (scopeBtn) {
        const nextScope = scopeBtn.dataset.cmScope;
        if (VALID_SCOPES.includes(nextScope) && scopeState.scope !== nextScope) {
          scopeState.scope = nextScope;
          saveJson(SCOPE_KEY, scopeState);
          renderScopeCost();
          refreshScope(true);
        }
        return;
      }

      if (e.target.closest('#cm-toggle-models')) {
        scopeState.showModels = !scopeState.showModels;
        saveJson(SCOPE_KEY, scopeState);
        renderScopeCost();
        return;
      }

      if (e.target.closest('#cm-toggle-pricing')) {
        scopeState.showPricing = !scopeState.showPricing;
        saveJson(SCOPE_KEY, scopeState);
        if (scopeState.showPricing && !runtime.pricingCatalog) {
          await refreshPricingCatalog();
        } else {
          renderScopeCost();
        }
        return;
      }

      if (e.target.closest('#cm-toggle-archive')) {
        scopeState.showArchive = !scopeState.showArchive;
        saveJson(SCOPE_KEY, scopeState);
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

      bindEvents(switcherBar, scopeCard);
    }

    document.getElementById('tab-cost')?.addEventListener('click', () => activateTab('cost'));
    document.getElementById('tab-accounts')?.addEventListener('click', () => activateTab('accounts'));
    document.getElementById('cm-accounts-pill')?.addEventListener('click', () => activateTab('accounts'));
    document.getElementById('tab-session')?.addEventListener('click', () => setCustomTabState('session'));
    document.getElementById('tab-heatmap')?.addEventListener('click', () => setCustomTabState('heatmap'));

    renderSwitcher();
    renderScopeCost();
    renderBreakdown();

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
    });

    globalThis.CM_SECTIONS?.onChange?.((prefs) => {
      if (prefs.switcher && !runtime.conversations) refreshConversations(false);
      if (prefs.costTab && isCostTabActive() && !runtime.scopeData) refreshScope(false);
      if (prefs.breakdown && !runtime.breakdownData) refreshBreakdown();
    });

    const savedTab = loadTabPref();
    if (savedTab !== 'session' && isSectionEnabled(savedTab === 'cost' ? 'costTab' : savedTab === 'accounts' ? 'accountsTab' : 'heatmap')) {
      setTimeout(() => activateTab(savedTab), 0);
    }

    refreshConversations(false);
    refreshBreakdown();

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
