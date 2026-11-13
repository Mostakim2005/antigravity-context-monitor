(() => {
  const POLL_MS = 1200;
  const FIXED_LIMIT_TOKENS = 262_144;
  const $ = (id) => document.getElementById(id);

  const params = new URLSearchParams(location.search);
  const currentConv = () => window.sidecar?.conversationId || params.get('conversationId') || '';

  const state = {
    etag: '',
    limitTokens: FIXED_LIMIT_TOKENS,
    lastData: null,
    timer: null,
    activeTab: 'session',
    heatmapData: null,
    selectedDate: null,
  };

  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
  }
  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  function fmtTokens(n) {
    const v = Number(n) || 0;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 10_000) return `${(v / 1_000).toFixed(1)}K`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(2)}K`;
    return String(Math.round(v));
  }

  function fmtExact(n) {
    return (Number(n) || 0).toLocaleString('en-US');
  }

  function fmtSec(s) {
    if (s == null || !Number.isFinite(Number(s))) return '—';
    return `${Number(s).toFixed(2)}s`;
  }

  function fmtTps(v) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    const n = Number(v);
    return n >= 100 ? `${Math.round(n)} tok/s` : `${n.toFixed(1)} tok/s`;
  }

  function fmtPct(ratio) {
    return `${(Math.max(0, ratio) * 100).toFixed(1)}%`;
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
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, { method: 'GET' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  function renderSparkline(series, limit) {
    const wrap = $('spark-wrap');
    if (!series || series.length === 0) {
      wrap.innerHTML = '<div class="empty-desc">暂无趋势数据</div>';
      return;
    }
    const w = 320;
    const h = 82;
    const padX = 4;
    const padY = 6;
    const maxVal = Math.max(
      1,
      ...series.map((s) => s.contextUsed),
    );
    const yScale = (v) => h - padY - ((v / maxVal) * (h - padY * 2));
    const xAt = (i) =>
      series.length === 1 ? w / 2 : padX + (i / (series.length - 1)) * (w - padX * 2);

    const totalPts = series.map((s, i) => `${xAt(i).toFixed(1)},${yScale(s.contextUsed).toFixed(1)}`);
    const cachePts = series.map((s, i) => `${xAt(i).toFixed(1)},${yScale(s.cacheReadTokens).toFixed(1)}`);

    const cacheArea = [
      `${xAt(0).toFixed(1)},${(h - padY).toFixed(1)}`,
      ...cachePts,
      `${xAt(series.length - 1).toFixed(1)},${(h - padY).toFixed(1)}`,
    ].join(' ');

    const totalArea = [
      `${xAt(0).toFixed(1)},${(h - padY).toFixed(1)}`,
      ...totalPts,
      `${xAt(series.length - 1).toFixed(1)},${(h - padY).toFixed(1)}`,
    ].join(' ');

    $('chart-range').textContent = `最近 ${series.length} 次调用 · 峰值 ${fmtTokens(maxVal)} / ${fmtTokens(limit)}`;

    wrap.innerHTML = `
      <svg class="spark-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
        <polygon points="${totalArea}" fill="var(--cm-fresh)" opacity="0.16"></polygon>
        <polygon points="${cacheArea}" fill="var(--cm-cache)" opacity="0.24"></polygon>
        <polyline points="${totalPts.join(' ')}" fill="none" stroke="var(--cm-fresh)" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"></polyline>
        <polyline points="${cachePts.join(' ')}" fill="none" stroke="var(--cm-cache)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"></polyline>
      </svg>
    `;
  }

  function renderTurns(turns, turnCount) {
    const list = $('turns-list');
    $('turns-count').textContent = turnCount ? `共 ${turnCount} 轮 · 倒序` : '按最新倒序';
    if (!turns || turns.length === 0) {
      list.innerHTML = '<div class="empty-desc">暂无 Prompt 记录</div>';
      return;
    }
    list.innerHTML = turns.map((t) => {
      const st = t.startup || { kind: 'pending', label: '等待响应', hitRate: 0 };
      const hitStr = st.kind === 'pending' ? '' : ` · ${fmtPct(st.hitRate)}`;
      const badgeText = `${st.label}${hitStr}`;
      const deltaSign = t.turnDelta >= 0 ? '+' : '';
      const bigDelta = t.turnDelta >= 20000 ? 'big' : '';
      const deltaBadge = t.firstCall
        ? `<span class="step-delta ${bigDelta}">${deltaSign}${fmtTokens(t.turnDelta)}</span>`
        : '';

      const speedParts = [];
      if (t.speed?.ttftSec != null) speedParts.push(`TTFT ${fmtSec(t.speed.ttftSec)}`);
      const turnTps = t.speed?.streamingTps ?? t.speed?.tps;
      if (turnTps != null) speedParts.push(fmtTps(turnTps));

      const statsLine = t.firstCall
        ? `<span>首步 Cache ${fmtTokens(t.firstCall.cacheReadTokens)} / ${fmtTokens(t.firstCall.contextUsed)}</span>` +
          `<span>结束 ${fmtTokens(t.endContextUsed)}</span>` +
          `<span>${t.modelCalls} 次调用</span>` +
          (speedParts.length > 0 ? `<span>${esc(speedParts.join(' · '))}</span>` : '')
        : '<span>等待首步模型响应…</span>';

      return `
        <div class="step-row">
          <div class="turn-head">
            <div class="turn-left">
              <span class="turn-num">#${t.turnIndex}</span>
              <span class="startup-badge ${esc(st.kind)}">${esc(badgeText)}</span>
            </div>
            ${deltaBadge}
          </div>
          <div class="turn-prompt" title="${esc(t.promptFull || t.promptPreview)}">${esc(t.promptPreview)}</div>
          <div class="step-nums">${statsLine}</div>
        </div>
      `;
    }).join('');
  }

  function render(data) {
    state.lastData = data;
    const conv = data.conversationId || currentConv();
    $('conv-badge').textContent = conv ? conv.slice(0, 8) : '无会话';
    $('conv-badge').title = conv || '未检测到 conversationId';

    const meta = data.meta || {};
    const repoLine = $('repo-line');
    if (meta.repoName || meta.branch || meta.title) {
      const parts = [meta.title, meta.repoName, meta.branch ? `@${meta.branch}` : ''].filter(Boolean);
      repoLine.textContent = parts.join(' · ');
      repoLine.classList.remove('hidden');
    } else {
      repoLine.classList.add('hidden');
    }

    if (!data.found || !data.latest) {
      $('empty-state').classList.remove('hidden');
      $('dashboard').classList.add('hidden');
      $('empty-desc').textContent = conv
        ? '当前会话还没有完成的模型调用（PLANNER_RESPONSE），发送消息或执行一步后会自动更新。'
        : '未从宿主接收到 conversationId，请在 Antigravity 对话右侧辅助面板中打开。';
      return;
    }

    $('empty-state').classList.add('hidden');
    $('dashboard').classList.remove('hidden');

    const latest = data.latest;
    const totals = data.totals;
    const limit = state.limitTokens;
    const used = latest.contextUsed;
    const remain = Math.max(0, limit - used);
    const usedRatio = limit > 0 ? used / limit : 0;
    const cacheBarPct = limit > 0 ? Math.min(100, (latest.cacheReadTokens / limit) * 100) : 0;
    const freshBarPct = limit > 0 ? Math.min(100 - cacheBarPct, (latest.inputTokens / limit) * 100) : 0;

    $('hero-used').textContent = fmtTokens(used);
    $('hero-used').title = `${fmtExact(used)} tokens`;

    const pctEl = $('hero-pct');
    pctEl.textContent = fmtPct(usedRatio);
    pctEl.className = 'pct-badge' + (usedRatio >= 0.9 ? ' danger' : usedRatio >= 0.75 ? ' warn' : '');

    $('hero-remain').textContent = used > limit ? `超出 ${fmtTokens(used - limit)}` : `${fmtTokens(remain)}`;
    $('hero-remain').title = `按 ${fmtExact(limit)} 上限计算`;

    const track = document.querySelector('.progress-track');
    track.setAttribute('aria-valuenow', String(Math.min(100, Math.round(usedRatio * 100))));

    $('bar-cache').style.width = `${cacheBarPct.toFixed(2)}%`;
    $('bar-fresh').style.width = `${freshBarPct.toFixed(2)}%`;

    $('leg-cache').textContent = fmtTokens(latest.cacheReadTokens);
    $('leg-fresh').textContent = fmtTokens(latest.inputTokens);
    $('leg-remain').textContent = fmtTokens(remain);

    const warnTip = usedRatio >= 0.85 ? ' · 接近窗口上限，建议适时 /compact' : '';
    $('gauge-note').textContent =
      `步后统计（含输出后下轮底数 ≥ ${fmtTokens(latest.projectedNextMin)}）${warnTip}`;

    $('m-cache').textContent = fmtTokens(latest.cacheReadTokens);
    $('m-cache').title = `${fmtExact(latest.cacheReadTokens)} tokens`;
    $('m-cache-rate').textContent = `命中率 ${fmtPct(latest.cacheHitRate)}`;

    $('m-fresh').textContent = fmtTokens(latest.inputTokens);
    $('m-fresh').title = `${fmtExact(latest.inputTokens)} tokens`;

    $('m-output').textContent = fmtTokens(latest.outputTokens);
    $('m-output').title = `${fmtExact(latest.outputTokens)} tokens`;
    $('m-step').textContent = `Step #${latest.stepIndex}`;

    const sp = latest.speed || {};
    const stats = data.speedStats || {};
    const displayTps = sp.streamingTps ?? sp.tps ?? null;
    $('m-ttft').textContent = fmtSec(sp.ttftSec);
    $('m-ttft-sub').textContent = stats.avgTtftSec != null ? `会话均值 ${fmtSec(stats.avgTtftSec)}` : '均值 —';
    $('m-tps').textContent = fmtTps(displayTps);
    $('m-tps-sub').textContent = sp.tps != null ? `含首字 ${fmtTps(sp.tps)}` : (stats.avgStreamingTps != null ? `均值 ${fmtTps(stats.avgStreamingTps)}` : '含首字 —');
    $('m-dur').textContent = fmtSec(sp.durationSec);
    $('m-dur-sub').textContent = sp.streamingSec != null ? `流式 ${fmtSec(sp.streamingSec)}` : '流式 —';

    $('tot-calls').textContent = `${data.modelCalls} 次模型调用 · ${data.totalSteps} 步`;
    $('tot-cache').textContent = fmtTokens(totals.cacheReadTokens);
    $('tot-fresh').textContent = fmtTokens(totals.inputTokens);
    $('tot-output').textContent = fmtTokens(totals.outputTokens);
    $('tot-rate').textContent = fmtPct(totals.avgCacheHitRate);

    renderSparkline(data.series, limit);
    renderTurns(data.recentTurns, data.turnCount);
  }

  function renderHeatmap(hm) {
    state.heatmapData = hm;
    const totals = hm.totals || {};
    $('hm-total').textContent = fmtTokens(totals.totalTokens);
    $('hm-total').title = `${fmtExact(totals.totalTokens)} tokens`;
    $('hm-range').textContent = `${hm.rangeStart?.slice(5) || ''} ~ ${hm.rangeEnd?.slice(5) || ''}`;
    $('hm-days').textContent = `${totals.activeDays ?? 0} 天`;
    $('hm-sessions').textContent = `${totals.sessions ?? 0} 个会话`;
    $('hm-calls').textContent = fmtExact(totals.calls ?? 0);
    $('hm-peak').textContent = `峰值 ${fmtTokens(hm.maxDayTokens)}`;

    const days = hm.days || [];
    const monthsEl = $('hm-months');
    const weeksCount = hm.weeks || 16;
    monthsEl.style.gridTemplateColumns = `repeat(${weeksCount}, minmax(0, 1fr))`;
    const monthLabels = [];
    let lastMonth = null;
    for (let w = 0; w < weeksCount; w++) {
      const cell = days[w * 7];
      const m = cell ? cell.month : null;
      if (m && m !== lastMonth) {
        monthLabels.push(`<span>${m}月</span>`);
        lastMonth = m;
      } else {
        monthLabels.push('<span></span>');
      }
    }
    monthsEl.innerHTML = monthLabels.join('');

    const defaultDay = days.find((d) => d.date === state.selectedDate) || days.find((d) => d.isToday) || days[days.length - 1];
    if (defaultDay) state.selectedDate = defaultDay.date;

    const gridEl = $('hm-grid');
    gridEl.innerHTML = days.map((d) => {
      const cls = [
        'hm-cell',
        `lv${d.level || 0}`,
        d.isFuture ? 'future' : '',
        d.isToday ? 'today' : '',
        d.date === state.selectedDate ? 'selected' : '',
      ].filter(Boolean).join(' ');
      const title = d.isFuture
        ? `${d.date}`
        : `${d.date}: ${fmtExact(d.totalTokens)} tokens (${d.calls} 次调用)`;
      return `<button type="button" class="${cls}" data-date="${d.date}" title="${esc(title)}" ${d.isFuture ? 'disabled' : ''}></button>`;
    }).join('');

    renderHeatmapDetail(defaultDay);
  }

  function renderHeatmapDetail(day) {
    const el = $('hm-detail');
    if (!day) {
      el.textContent = '暂无历史数据';
      return;
    }
    if (day.calls === 0) {
      el.textContent = `${day.date} · 无模型调用`;
      return;
    }
    el.innerHTML =
      `<strong>${esc(day.date)}</strong> · 共 ${fmtTokens(day.totalTokens)} (${day.calls} 次调用 · ${day.sessions} 会话)<br>` +
      `Cache ${fmtTokens(day.cacheReadTokens)} · 新增 ${fmtTokens(day.inputTokens)} · 输出 ${fmtTokens(day.outputTokens)}`;
  }

  async function refreshHeatmap() {
    try {
      const hm = await apiGet('/api/heatmap?weeks=16');
      renderHeatmap(hm);
    } catch {
      $('hm-detail').textContent = '历史热力图加载失败';
    }
  }

  function setTab(tab) {
    state.activeTab = tab;
    const isHeatmap = tab === 'heatmap';
    $('tab-session').classList.toggle('active', !isHeatmap);
    $('tab-session').setAttribute('aria-selected', String(!isHeatmap));
    $('tab-heatmap').classList.toggle('active', isHeatmap);
    $('tab-heatmap').setAttribute('aria-selected', String(isHeatmap));
    $('view-session').classList.toggle('hidden', isHeatmap);
    $('view-heatmap').classList.toggle('hidden', !isHeatmap);
    if (isHeatmap) {
      refreshHeatmap();
    }
  }

  async function poll() {
    const conv = currentConv();
    const qs = new URLSearchParams();
    if (conv) qs.set('conversationId', conv);
    if (state.etag) qs.set('etag', state.etag);

    try {
      const data = await apiGet(`/api/context?${qs.toString()}`);
      $('live-pill').classList.remove('stale');
      $('live-text').textContent = 'Live';

      if (data.limitTokens) {
        state.limitTokens = data.limitTokens;
      }

      if (data.unchanged) return;
      state.etag = data.etag || '';
      render(data);
    } catch {
      $('live-pill').classList.add('stale');
      $('live-text').textContent = '重试中';
    }
  }

  async function init() {
    $('tab-session').addEventListener('click', () => setTab('session'));
    $('tab-heatmap').addEventListener('click', () => setTab('heatmap'));
    $('hm-grid').addEventListener('click', (e) => {
      const btn = e.target.closest('.hm-cell[data-date]');
      if (!btn || !state.heatmapData) return;
      state.selectedDate = btn.dataset.date;
      const day = (state.heatmapData.days || []).find((d) => d.date === state.selectedDate);
      for (const el of $('hm-grid').querySelectorAll('.hm-cell.selected')) {
        el.classList.remove('selected');
      }
      btn.classList.add('selected');
      renderHeatmapDetail(day);
    });

    await poll();
    state.timer = setInterval(() => {
      if (state.activeTab === 'session') poll();
    }, POLL_MS);
  }

  init();
})();
