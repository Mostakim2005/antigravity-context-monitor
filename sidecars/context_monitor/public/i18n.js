(() => {
  const STORAGE_KEY = 'cm_lang';
  const SUPPORTED = new Set(['en', 'zh']);

  const EXACT_EN = {
    '上下文监控': 'Context Monitor',
    '每 1.2 秒自动轮询本地 transcript.jsonl': 'Polls local transcript.jsonl every 1.2s',
    '当前会话 ID': 'Current Conversation ID',
    '视图与压缩阈值': 'Views and compaction limit',
    '当前会话': 'Session',
    '费用': 'Cost',
    '多账号': 'Accounts',
    '历史热力图': 'Heatmap',
    '当前上下文窗口上限（来自 LanguageServerService，默认 512K）': 'Active context window limit (LanguageServerService, default 512K)',
    '等待当前会话记录…': 'Waiting for active session…',
    '当前会话还没有模型调用记录，发送第一条消息后这里会自动显示上下文占用与 Cache 命中情况。': 'No model calls recorded in this conversation yet. Context usage and prompt cache hits will appear after your first message.',
    '当前上下文占用': 'Context Used',
    '上下文余量': 'Remaining',
    '新增': 'Fresh',
    '余量': 'Free',
    'Cache 命中': 'Cache Hit',
    '命中率 0%': 'Hit rate 0%',
    '本步新增输入': 'Fresh Input',
    '未命中 Cache': 'Uncached',
    '本步输出': 'Output',
    '首字延迟 TTFT': 'TTFT',
    '均值 —': 'Avg —',
    '解码速度 TPS': 'Decode Speed',
    '含首字 —': 'E2E —',
    '本步耗时': 'Step Duration',
    '流式 —': 'Stream —',
    '本会话累计': 'Session Totals',
    '0 次调用': '0 calls',
    '累计 Cache 读取': 'Total Cache Read',
    '累计新增输入': 'Total Fresh Input',
    '累计输出': 'Total Output',
    '平均 Cache 命中': 'Avg Cache Hit',
    '上下文增长趋势': 'Context Growth',
    '最近调用': 'Recent calls',
    'Prompt 轮次 · 冷/热启动': 'Prompt Turns · Cold/Warm Start',
    '按最新倒序': 'Newest first',
    '近 16 周全量 Token': '16-Week Tokens',
    '活跃天数': 'Active Days',
    '— 个会话': '— sessions',
    '模型调用': 'Model Calls',
    '峰值 —': 'Peak —',
    '每日 Token 消耗（桌面端 + CLI）': 'Daily Tokens (App + CLI)',
    '少': 'Less',
    '多': 'More',
    '16周 Token 消耗热力图': '16-week token usage heatmap',
    '点击或悬停格子查看当日明细': 'Click or hover a cell to inspect daily breakdown',
    '暂无趋势数据': 'No trend data yet',
    '暂无 Prompt 记录': 'No prompts recorded yet',
    '等待响应': 'Pending',
    '等待首步模型响应…': 'Waiting for first model response…',
    '部分缓存': 'Partial Cache',
    '热启动': 'Warm Start',
    '冷启动 · 首轮': 'Cold Start · 1st Turn',
    '冷启动 · 缓存未命中': 'Cold Start · Cache Miss',
    '（空 Prompt）': '(Empty prompt)',
    '（会话初始指令）': '(Initial session instructions)',
    '无会话': 'No session',
    '未检测到 conversationId': 'No conversationId detected',
    '当前会话还没有完成的模型调用（PLANNER_RESPONSE），发送消息或执行一步后会自动更新。': 'No completed model calls (PLANNER_RESPONSE) yet. Updates automatically after sending a message or running a step.',
    '未从宿主接收到 conversationId，请在 Antigravity 对话右侧辅助面板中打开。': "No conversationId received from host. Open inside Antigravity's right-side auxiliary panel.",
    '暂无历史数据': 'No history data',
    '暂无模型 ID 记录': 'No model IDs recorded',
    '历史热力图加载失败': 'Failed to load heatmap',
    '模型：查询中…': 'Models: loading…',
    '重试中': 'Retrying',
    '近 16 周费用': '16-Week Cost',
    '峰值': 'Peak',
    '· 共': '· Total',
    '· 新增': '· Fresh',
    '· 输出': '· Output',
    '模型：': 'Models:',
    '首步 Cache': '1st step Cache',
    '结束': 'End',
  };

  const MONTHS_EN = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAYS_EN = { '一': 'Mon', '三': 'Wed', '五': 'Fri', '日': 'Sun' };

  const REGEX_EN = [
    [/^最近 (\d+) 次调用 · 峰值 (.+?) \/ (.+)$/, 'Last $1 calls · Peak $2 / $3'],
    [/^共 (\d+) 轮 · 倒序$/, '$1 turns · Newest first'],
    [/^上下文压缩\/截断：本轮净减少 (.+)$/, 'Context compacted/truncated: -$1 net change this turn'],
    [/^本轮上下文大幅增长 (.+)（≥ 20K）$/, 'Large context growth: $1 this turn (≥ 20K)'],
    [/^本轮上下文净变化 (.+)（< 20K）$/, 'Net context change: $1 this turn (< 20K)'],
    [/^(\d+) 次调用$/, '$1 calls'],
    [/^首步 Cache (.+?) \/ (.+)$/, '1st step Cache $1 / $2'],
    [/^结束 (.+)$/, 'End $1'],
    [/^(冷启动 · 首轮|冷启动 · 缓存未命中|部分缓存|热启动|等待响应)( · .+)?$/, (_, kind, pct) => `${EXACT_EN[kind] || kind}${pct || ''}`],
    [/^当前模型上下文上限（来自 LanguageServerService maxContextTokens: (.+)）$/, 'Active model context limit (LanguageServerService maxContextTokens: $1)'],
    [/^当前默认上下文上限：(.+) tokens$/, 'Default context limit: $1 tokens'],
    [/^超出 (.+)$/, 'Over by $1'],
    [/^按 (.+) 上限计算$/, 'Based on $1 limit'],
    [/^步后统计（含输出后下轮底数 ≥ ([^）]+)）( · 接近窗口上限，建议适时 \/compact)?$/, (_, minTok, warn) => `Post-step (next turn min ≥ ${minTok})${warn ? ' · Near limit — consider /compact' : ''}`],
    [/^命中率 (.+)$/, 'Hit rate $1'],
    [/^会话均值 (.+)$/, 'Avg $1'],
    [/^含首字 (.+)$/, 'E2E $1'],
    [/^均值 (.+)$/, 'Avg $1'],
    [/^流式 (.+)$/, 'Stream $1'],
    [/^(\d+) 次模型调用 · (\d+) 步$/, '$1 calls · $2 steps'],
    [/^(\d+) 天$/, '$1 days'],
    [/^(\d+) 个会话$/, '$1 sessions'],
    [/^峰值 (.+)$/, 'Peak $1'],
    [/^\((\d+) 次调用 · (\d+) 会话\)$/, '($1 calls · $2 sessions)'],
    [/^(\d+)次$/, '$1×'],
    [/^(1[0-2]|[1-9])月$/, (_, m) => MONTHS_EN[Number(m)] || `${m}`],
    [/^(\d{4}-\d{2}-\d{2}): (.+?) tokens \((\d+) 次调用\)$/, '$1: $2 tokens ($3 calls)'],
    [/^(\d{4}-\d{2}-\d{2}) · 无模型调用$/, '$1 · No model calls'],
    [/^· 共 (.+?) \((\d+) 次调用 · (\d+) 会话\)$/, '· Total $1 ($2 calls · $3 sessions)'],
    [/^Cache (.+?) · 新增 (.+?) · 输出 (.+)$/, 'Cache $1 · Fresh $2 · Output $3'],
    [/^模型：(.+)$/, (_, list) => {
      if (list === '查询中…') return 'Models: loading…';
      if (list === '暂无模型 ID 记录') return 'Models: No model IDs recorded';
      return `Models: ${list.replace(/\((\d+)次 · /g, '($1× · ')}`;
    }],
  ];

  function translateText(text, lang, ctx = {}) {
    if (lang !== 'en' || typeof text !== 'string') return text;
    const raw = text;
    const trimmed = raw.trim();
    if (!trimmed) return raw;

    let out = null;
    if (ctx.isWeekday && WEEKDAYS_EN[trimmed]) {
      out = WEEKDAYS_EN[trimmed];
    } else if (Object.prototype.hasOwnProperty.call(EXACT_EN, trimmed)) {
      out = EXACT_EN[trimmed];
    } else {
      for (const [re, repl] of REGEX_EN) {
        if (re.test(trimmed)) {
          out = trimmed.replace(re, repl);
          break;
        }
      }
    }
    if (out === null) return raw;
    const lead = raw.match(/^\s*/)?.[0] || '';
    const trail = raw.match(/\s*$/)?.[0] || '';
    return `${lead}${out}${trail}`;
  }

  let needsLangMigration = false;

  function readSavedLang() {
    const serverLang = globalThis.CM_PREFS?.getServerPrefs?.()?.lang;
    if (SUPPORTED.has(serverLang)) {
      globalThis.CM_PREFS?.writeLocal?.(STORAGE_KEY, serverLang);
      return serverLang;
    }
    try {
      const v = globalThis.CM_PREFS?.readLocal?.(STORAGE_KEY) ?? globalThis.localStorage?.getItem(STORAGE_KEY);
      if (SUPPORTED.has(v)) {
        if (globalThis.CM_PREFS?.hasServerBootstrap?.()) needsLangMigration = true;
        return v;
      }
      return 'en';
    } catch {
      return 'en';
    }
  }

  function saveLang(lang) {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, lang);
    } catch {
      // ignore storage failure
    }
    globalThis.CM_PREFS?.saveServerPatch?.({ lang });
  }

  let currentLang = readSavedLang();
  const origNodeText = new WeakMap();
  const origAttrs = new WeakMap();
  let observer = null;
  let applying = false;

  function shouldSkipElement(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE') return true;
    if (el.closest?.('#repo-line, #cm-lang-toggle, #quotas-card, #cm-sections-drawer, #cm-sections-btn, #switcher-bar, #scope-cost-card, #breakdown-card, #orchestrator-card, #retries-card, #model-dna-card, #view-cost, #view-accounts, #cm-accounts-pill, #cm-gauge-extra, #cm-hm-analytics')) return true;
    if (el.classList?.contains('turn-prompt')) return true;
    return false;
  }

  function applyToTextNode(node) {
    const parent = node.parentElement;
    if (!parent || shouldSkipElement(parent)) {
      // Allow translating exact placeholder strings inside .turn-prompt
      if (!parent?.classList?.contains('turn-prompt')) return;
      const val = node.nodeValue || '';
      const stored = origNodeText.get(node);
      const source = stored !== undefined ? stored : val;
      if (stored === undefined && (val.trim() === '（空 Prompt）' || val.trim() === '（会话初始指令）')) {
        origNodeText.set(node, val);
      }
      if (!origNodeText.has(node)) return;
      const next = currentLang === 'en' ? translateText(source, 'en') : source;
      if (node.nodeValue !== next) node.nodeValue = next;
      return;
    }

    const val = node.nodeValue || '';
    if (!val.trim()) return;
    let source = origNodeText.get(node);
    if (source === undefined || (val !== source && val !== translateText(source, 'en', { isWeekday: Boolean(parent.closest('.hm-weekdays')) }))) {
      source = val;
      origNodeText.set(node, source);
    }
    const isWeekday = Boolean(parent.closest('.hm-weekdays'));
    const next = currentLang === 'en' ? translateText(source, 'en', { isWeekday }) : source;
    if (node.nodeValue !== next) {
      node.nodeValue = next;
    }
  }

  function applyToAttributes(el) {
    if (!el || el.nodeType !== 1 || shouldSkipElement(el)) return;
    let map = origAttrs.get(el);
    if (!map) {
      map = {};
      origAttrs.set(el, map);
    }
    for (const attr of ['title', 'aria-label']) {
      if (!el.hasAttribute(attr)) continue;
      if (attr === 'title' && el.id === 'conv-badge' && el.getAttribute('title') !== '当前会话 ID' && el.getAttribute('title') !== '未检测到 conversationId' && el.getAttribute('title') !== 'Current Conversation ID' && el.getAttribute('title') !== 'No conversationId detected') {
        continue;
      }
      const val = el.getAttribute(attr) || '';
      if (!val.trim()) continue;
      let source = map[attr];
      if (source === undefined || (val !== source && val !== translateText(source, 'en'))) {
        source = val;
        map[attr] = source;
      }
      const next = currentLang === 'en' ? translateText(source, 'en') : source;
      if (el.getAttribute(attr) !== next) {
        el.setAttribute(attr, next);
      }
    }
  }

  function applySubtree(root) {
    if (!root || !globalThis.document) return;
    if (root.nodeType === 3) {
      applyToTextNode(root);
      return;
    }
    if (root.nodeType !== 1) return;
    if (shouldSkipElement(root) && !root.classList?.contains('turn-prompt')) return;

    applyToAttributes(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let cur = walker.nextNode();
    while (cur) {
      if (cur.nodeType === 3) {
        applyToTextNode(cur);
      } else if (cur.nodeType === 1) {
        applyToAttributes(cur);
      }
      cur = walker.nextNode();
    }
  }

  function updateToggleUi() {
    const wrap = document.getElementById('cm-lang-toggle');
    if (!wrap) return;
    for (const btn of wrap.querySelectorAll('.lang-btn')) {
      const active = btn.dataset.lang === currentLang;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    }
  }

  function applyAll() {
    if (!globalThis.document?.body) return;
    applying = true;
    try {
      document.documentElement.lang = currentLang === 'en' ? 'en' : 'zh-CN';
      applySubtree(document.body);
      updateToggleUi();
    } finally {
      applying = false;
    }
  }

  function mountToggle() {
    const headerActions = document.querySelector('.header-actions');
    const headerTop = document.querySelector('.header-top');
    const host = headerActions || headerTop;
    if (!host || document.getElementById('cm-lang-toggle')) return;

    const toggle = document.createElement('div');
    toggle.id = 'cm-lang-toggle';
    toggle.className = 'lang-toggle';
    toggle.setAttribute('role', 'group');
    toggle.setAttribute('aria-label', 'Language');

    const enBtn = document.createElement('button');
    enBtn.type = 'button';
    enBtn.className = 'lang-btn';
    enBtn.dataset.lang = 'en';
    enBtn.textContent = 'EN';

    const zhBtn = document.createElement('button');
    zhBtn.type = 'button';
    zhBtn.className = 'lang-btn';
    zhBtn.dataset.lang = 'zh';
    zhBtn.textContent = '中文';

    toggle.append(enBtn, zhBtn);
    toggle.addEventListener('click', (e) => {
      const btn = e.target.closest('.lang-btn[data-lang]');
      if (!btn) return;
      setLang(btn.dataset.lang);
    });

    host.append(toggle);
    updateToggleUi();
  }

  const listeners = new Set();

  function setLang(lang) {
    if (!SUPPORTED.has(lang) || lang === currentLang) return;
    currentLang = lang;
    saveLang(lang);
    applyAll();
    for (const fn of listeners) {
      try { fn(lang); } catch { /* ignore */ }
    }
  }

  function startObserver() {
    if (observer || !globalThis.MutationObserver || !globalThis.document?.body) return;
    observer = new MutationObserver((records) => {
      if (applying) return;
      applying = true;
      try {
        for (const rec of records) {
          if (rec.type === 'characterData') {
            applyToTextNode(rec.target);
          } else if (rec.type === 'attributes') {
            applyToAttributes(rec.target);
          } else if (rec.type === 'childList') {
            for (const added of rec.addedNodes) {
              applySubtree(added);
            }
          }
        }
      } finally {
        applying = false;
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['title', 'aria-label'],
    });
  }

  function boot() {
    if (needsLangMigration) {
      needsLangMigration = false;
      globalThis.CM_PREFS?.saveServerPatch?.({ lang: currentLang });
    }
    mountToggle();
    applyAll();
    startObserver();
  }

  if (globalThis.document) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  }

  globalThis.CM_I18N = {
    translateText,
    getLang: () => currentLang,
    setLang,
    onChange: (fn) => {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
})();
