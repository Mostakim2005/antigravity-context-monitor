const STRICT_ISO_RESET_RE =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i;

export function parseResetMs(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || !STRICT_ISO_RESET_RE.test(s)) return null;
  const day = s.slice(0, 10);
  const cal = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(cal.getTime()) || cal.toISOString().slice(0, 10) !== day) {
    return null;
  }
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function resolveRemainingFraction(obj, parsedResetMs) {
  if (obj?.remainingFraction != null) {
    const raw =
      typeof obj.remainingFraction === 'string' && obj.remainingFraction.trim() !== ''
        ? Number(obj.remainingFraction)
        : obj.remainingFraction;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1) {
      return raw;
    }
    return null;
  }
  // Proto3 omits float 0.0: untouched quota has no/epoch-0 resetTime -> 1.0,
  // exhausted quota has a valid non-epoch resetTime -> 0.0.
  if (obj?.resetTime == null) return 1;
  if (typeof obj.resetTime !== 'string') return null;
  if (!obj.resetTime.trim()) return 1;
  if (parsedResetMs === null || parsedResetMs < 0) return null;
  return parsedResetMs === 0 ? 1 : 0;
}

export function formatResetCountdown(resetAtMs, nowMs = Date.now()) {
  if (!Number.isFinite(resetAtMs) || resetAtMs <= 0) return null;
  const diffSec = Math.max(0, Math.floor((resetAtMs - nowMs) / 1000));
  if (diffSec === 0) return '0m';
  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${Math.max(1, mins)}m`;
}

function inferPoolKey(displayName, buckets) {
  const ids = (buckets || []).map((b) => String(b.bucketId || '').toLowerCase());
  if (ids.some((id) => id.startsWith('gemini')) || /\bgemini\b/i.test(displayName)) {
    return 'gemini';
  }
  if (
    ids.some((id) => id.startsWith('3p') || id.startsWith('claude') || id.startsWith('gpt')) ||
    /\b(?:claude|gpt)\b/i.test(displayName)
  ) {
    return 'premium';
  }
  return 'other';
}

export function parseQuotaSummary(raw, nowMs = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const payload =
    raw.response && typeof raw.response === 'object' && !Array.isArray(raw.response)
      ? raw.response
      : raw;
  const rawGroups = Array.isArray(payload.groups) ? payload.groups : [];
  const pools = [];

  for (const g of rawGroups) {
    if (!g || typeof g !== 'object' || Array.isArray(g)) continue;
    const displayName = typeof g.displayName === 'string' ? g.displayName.trim() : '';
    const rawBuckets = Array.isArray(g.buckets) ? g.buckets : [];
    const buckets = [];

    for (const b of rawBuckets) {
      if (!b || typeof b !== 'object' || Array.isArray(b)) continue;
      const bucketId = typeof b.bucketId === 'string' ? b.bucketId.trim() : '';
      const rawWin = typeof b.window === 'string' ? b.window.trim().toLowerCase() : '';
      const window =
        rawWin ||
        (bucketId.toLowerCase().endsWith('-weekly')
          ? 'weekly'
          : bucketId.toLowerCase().endsWith('-5h')
            ? '5h'
            : '');
      if (!bucketId && !window) continue;
      const parsedMs = parseResetMs(b.resetTime);
      const resetAtMs = parsedMs !== null && parsedMs > 0 ? parsedMs : null;
      const remainingFraction = resolveRemainingFraction(b, parsedMs);
      buckets.push({
        bucketId,
        window,
        remainingPct: remainingFraction === null ? null : Math.round(remainingFraction * 100),
        resetTime: resetAtMs ? String(b.resetTime).trim() : null,
        resetCountdown: formatResetCountdown(resetAtMs, nowMs),
      });
    }

    if (!displayName && buckets.length === 0) continue;
    const pool = inferPoolKey(displayName, buckets);
    const fiveHour = buckets.find((b) => b.window === '5h') || null;
    const weekly = buckets.find((b) => b.window === 'weekly') || null;
    pools.push({
      pool,
      label:
        pool === 'gemini'
          ? 'Gemini'
          : pool === 'premium'
            ? 'Claude / GPT'
            : displayName || 'Models',
      fiveHour,
      weekly,
    });
  }

  return pools.length > 0 ? { source: 'summary', pools } : null;
}

export function parseUserStatusQuotaFallback(raw, nowMs = Date.now()) {
  const userStatus = raw?.userStatus;
  if (!userStatus || typeof userStatus !== 'object' || Array.isArray(userStatus)) return null;
  const rawConfigs = userStatus.cascadeModelConfigData?.clientModelConfigs;
  if (!Array.isArray(rawConfigs) || rawConfigs.length === 0) return null;

  const byPool = new Map();
  for (const cfg of rawConfigs) {
    if (!cfg || typeof cfg !== 'object') continue;
    const label = String(cfg.label || '').trim();
    const modelId = String(cfg.modelId || cfg.modelOrAlias?.model || '').trim().toLowerCase();
    const qi = cfg.quotaInfo;
    if (!qi || typeof qi !== 'object') continue;

    const pool =
      /claude|sonnet|opus|haiku|gpt-oss/i.test(`${label} ${modelId}`)
        ? 'premium'
        : /gemini/i.test(`${label} ${modelId}`)
          ? 'gemini'
          : null;
    if (!pool) continue;

    const parsedMs = parseResetMs(qi.resetTime);
    const resetAtMs = parsedMs !== null && parsedMs > 0 ? parsedMs : null;
    const rem = resolveRemainingFraction(qi, parsedMs);
    if (rem === null) continue;

    const prev = byPool.get(pool);
    if (!prev || rem < prev.remainingFraction) {
      byPool.set(pool, {
        pool,
        label: pool === 'gemini' ? 'Gemini' : 'Claude / GPT',
        remainingFraction: rem,
        fiveHour: {
          bucketId: `${pool}-fallback`,
          window: '5h',
          remainingPct: Math.round(rem * 100),
          resetTime: resetAtMs ? String(qi.resetTime).trim() : null,
          resetCountdown: formatResetCountdown(resetAtMs, nowMs),
        },
        weekly: null,
      });
    }
  }

  if (byPool.size === 0) return null;
  const pools = ['gemini', 'premium']
    .map((k) => byPool.get(k))
    .filter(Boolean)
    .map(({ pool, label, fiveHour, weekly }) => ({ pool, label, fiveHour, weekly }));
  return { source: 'user_status', pools };
}
