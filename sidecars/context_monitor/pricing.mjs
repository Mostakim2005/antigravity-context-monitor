// Official published API reference rates (USD per 1M tokens).
// Supports Google AI / Vertex AI, Anthropic Claude, OpenRouter, and user overrides.

export const DEFAULT_MODEL_PRICING = {
  'gemini-4-neon': { label: 'Gemini 4 Neon', input: 3.0, output: 15.0, cacheRead: 0.15, cacheWrite: 0 },
  'gemini-4-hydrogen': { label: 'Gemini 4 Hydrogen', input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 },
  'gemini-4-carbon': { label: 'Gemini 4 Carbon', input: 2.0, output: 10.0, cacheRead: 0.10, cacheWrite: 0, afterDate: '2026-12-01', after: { input: 4.0, output: 20.0, cacheRead: 0.20, cacheWrite: 0 } },
  'gemini-4-argon': { label: 'Gemini 4 Argon', input: 2.0, output: 10.0, cacheRead: 0.10, cacheWrite: 0, afterDate: '2026-12-01', after: { input: 4.0, output: 20.0, cacheRead: 0.20, cacheWrite: 0 } },
  'gemini-3.8-flash': { label: 'Gemini 3.8 Flash', input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.9375, afterDate: '2027-01-01', after: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 1.875 } },
  'gemini-3.7-flash': { label: 'Gemini 3.7 Flash', input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.9375, afterDate: '2027-01-01', after: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 1.875 } },
  'gemini-3.6-flash': { label: 'Gemini 3.6 Flash', input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.9375, afterDate: '2027-01-01', after: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 1.875 } },
  'gemini-3.5-flash': { label: 'Gemini 3.5 Flash', input: 1.5, output: 9.0, cacheRead: 0.15, cacheWrite: 1.875 },
  'gemini-3-flash': { label: 'Gemini 3 Flash', input: 0.5, output: 3.0, cacheRead: 0.05, cacheWrite: 0.625 },
  'gemini-3.1-pro': { label: 'Gemini 3.1 Pro', input: 2.0, output: 12.0, cacheRead: 0.20, cacheWrite: 2.5 },
  'claude-opus-5-5': { label: 'Claude Opus 5.5', input: 4.0, output: 20.0, cacheRead: 0.20, cacheWrite: 5.0 },
  'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5', input: 2.0, output: 10.0, cacheRead: 0.10, cacheWrite: 2.5 },
  'claude-opus-4-6': { label: 'Claude Opus 4.6', input: 5.0, output: 25.0, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-sonnet-4-6': { label: 'Claude Sonnet 4.6', input: 3.0, output: 15.0, cacheRead: 0.30, cacheWrite: 3.75 },
  'gpt-oss-120b': { label: 'GPT-OSS 120B', input: 0.09, output: 0.36, cacheRead: 0, cacheWrite: 0 },
  'deepseek-v4.1-flash': { label: 'DeepSeek v4.1 Flash', input: 0.15, output: 0.60, cacheRead: 0.003, cacheWrite: 0 },
};

const ALIAS_MAP = {
  m537: 'gemini-4-neon',
  m667: 'gemini-4-carbon',
  m681: 'gemini-4-argon',
  m669: 'gemini-4-hydrogen',
  m530: 'gemini-4-hydrogen',
  m531: 'gemini-4-hydrogen',
  m532: 'gemini-4-neon',
  m133: 'gemini-3-flash',
  m84: 'gemini-3.5-flash',
  m20: 'gemini-3.5-flash',
  m187: 'gemini-3.5-flash',
  m264: 'gemini-3.6-flash',
  m265: 'gemini-3.6-flash',
  m266: 'gemini-3.6-flash',
  m16: 'gemini-3.1-pro',
  m37: 'gemini-3.1-pro',
};

export function normalizeModelKey(rawModel) {
  const s = String(rawModel || '').trim().toLowerCase();
  if (!s) return 'unknown';

  const ph = s.match(/model_placeholder_(m\d+)/i);
  if (ph && ALIAS_MAP[ph[1]]) return ALIAS_MAP[ph[1]];

  const stripped = s
    .replace(/^(?:openrouter|google|anthropic|openai|deepseek-ai)\//, '')
    .replace(/[-_](?:low|medium|high|xhigh|extra[-_]high)$/i, '')
    .replace(/[_\s]+/g, '-');

  for (const key of Object.keys(DEFAULT_MODEL_PRICING)) {
    if (stripped === key || stripped.includes(key)) return key;
  }
  return stripped || 'unknown';
}

export function resolveModelPricing(rawModel, customOverrides = {}, dateKey = '') {
  const key = normalizeModelKey(rawModel);
  const custom = customOverrides?.[key] || customOverrides?.[rawModel];
  if (custom && Number.isFinite(Number(custom.input))) {
    return {
      key,
      label: custom.label || DEFAULT_MODEL_PRICING[key]?.label || rawModel || key,
      input: Number(custom.input) || 0,
      output: Number(custom.output) || 0,
      cacheRead: Number(custom.cacheRead) || 0,
      cacheWrite: Number(custom.cacheWrite) || 0,
      isCustom: true,
    };
  }

  const base = DEFAULT_MODEL_PRICING[key];
  if (!base) return null;

  let active = base;
  if (base.afterDate && base.after) {
    const day = /^\d{4}-\d{2}-\d{2}/.test(dateKey)
      ? dateKey.slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    if (day >= base.afterDate) {
      active = { ...base, ...base.after };
    }
  }
  return {
    key,
    label: base.label || rawModel || key,
    input: active.input,
    output: active.output,
    cacheRead: active.cacheRead,
    cacheWrite: active.cacheWrite || 0,
    isCustom: false,
  };
}

export function calculateScopeCosts(rows, customOverrides = {}) {
  const totals = {
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
    unpricedTokens: 0,
  };

  const byModelMap = new Map();

  for (const r of rows || []) {
    const inputTok = Math.max(0, Number(r.inputTokens) || 0);
    const cacheReadTok = Math.max(0, Number(r.cacheReadTokens) || 0);
    const cacheWriteTok = Math.max(0, Number(r.cacheWriteTokens) || 0);
    const outputTok = Math.max(0, Number(r.outputTokens) || 0);
    const calls = Math.max(0, Number(r.calls) || 0);
    const rowTok = inputTok + cacheReadTok + cacheWriteTok + outputTok;

    const rate = resolveModelPricing(r.model || '', customOverrides, r.dateKey || '');
    const modelKey = rate?.key || normalizeModelKey(r.model || '');
    const label = rate?.label || r.model || 'Unknown';

    const inputCost = rate ? (inputTok * rate.input) / 1e6 : 0;
    const cacheCost = rate
      ? (cacheReadTok * rate.cacheRead + cacheWriteTok * (rate.cacheWrite || 0)) / 1e6
      : 0;
    const outputCost = rate ? (outputTok * rate.output) / 1e6 : 0;
    const totalCost = inputCost + cacheCost + outputCost;
    const cacheSaved = rate ? Math.max(0, (cacheReadTok * (rate.input - rate.cacheRead)) / 1e6) : 0;

    totals.calls += calls;
    totals.inputTokens += inputTok;
    totals.cacheReadTokens += cacheReadTok;
    totals.cacheWriteTokens += cacheWriteTok;
    totals.outputTokens += outputTok;
    totals.totalTokens += rowTok;
    totals.inputCost += inputCost;
    totals.cacheCost += cacheCost;
    totals.outputCost += outputCost;
    totals.totalCost += totalCost;
    totals.cacheSavedUsd += cacheSaved;
    if (!rate) totals.unpricedTokens += rowTok;

    let entry = byModelMap.get(modelKey);
    if (!entry) {
      entry = {
        modelKey,
        label,
        priced: Boolean(rate),
        isCustom: Boolean(rate?.isCustom),
        rate: rate ? { input: rate.input, output: rate.output, cacheRead: rate.cacheRead } : null,
        calls: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        inputCost: 0,
        cacheCost: 0,
        outputCost: 0,
        totalCost: 0,
        cacheSavedUsd: 0,
      };
      byModelMap.set(modelKey, entry);
    }
    entry.calls += calls;
    entry.inputTokens += inputTok;
    entry.cacheReadTokens += cacheReadTok;
    entry.outputTokens += outputTok;
    entry.totalTokens += rowTok;
    entry.inputCost += inputCost;
    entry.cacheCost += cacheCost;
    entry.outputCost += outputCost;
    entry.totalCost += totalCost;
    entry.cacheSavedUsd += cacheSaved;
  }

  const byModel = [...byModelMap.values()].sort((a, b) => b.totalCost - a.totalCost || b.totalTokens - a.totalTokens);
  return { totals, byModel };
}

export function getCatalogPricingList(customOverrides = {}) {
  const keys = new Set([...Object.keys(DEFAULT_MODEL_PRICING), ...Object.keys(customOverrides || {})]);
  return [...keys].sort().map((key) => {
    const rate = resolveModelPricing(key, customOverrides);
    return {
      modelKey: key,
      label: rate?.label || key,
      input: rate?.input ?? 0,
      output: rate?.output ?? 0,
      cacheRead: rate?.cacheRead ?? 0,
      cacheWrite: rate?.cacheWrite ?? 0,
      isCustom: Boolean(rate?.isCustom),
    };
  });
}
