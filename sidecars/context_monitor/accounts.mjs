import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseResetMs } from './quotas.mjs';

function inferPoolKeyForAccount(label, modelId) {
  const s = `${label || ''} ${modelId || ''}`.toLowerCase();
  if (/claude|sonnet|opus|haiku|gpt-oss|openai/.test(s)) return 'claude_gpt';
  if (/gemini/.test(s)) return 'gemini';
  return 'other';
}

function resolveRemainingFraction(qi, resetMs) {
  if (!qi || typeof qi !== 'object') return null;
  if (qi.remainingFraction != null) {
    const n = Number(qi.remainingFraction);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
  }
  if (resetMs !== null && resetMs > 0) return 0;
  return 1;
}

export function extractActiveAccountSnapshot(rawUserStatus, nowMs = Date.now()) {
  const us = rawUserStatus?.userStatus;
  if (!us || typeof us !== 'object' || Array.isArray(us)) return null;

  const email = String(us.email || '').trim();
  const name = String(us.name || '').trim();
  const planInfo = us.planStatus?.planInfo;
  const userTier = us.userTier;
  const planName = String(planInfo?.planName || '').trim();
  const tierName = String(userTier?.name || '').trim();

  if (!email && !name && !planName && !tierName) return null;

  const configs = Array.isArray(us.cascadeModelConfigData?.clientModelConfigs)
    ? us.cascadeModelConfigData.clientModelConfigs
    : [];

  const poolsMap = new Map();
  for (const cfg of configs) {
    if (!cfg || typeof cfg !== 'object') continue;
    const label = String(cfg.label || '').trim();
    const modelId = String(cfg.modelId || cfg.modelOrAlias?.model || '').trim();
    const qi = cfg.quotaInfo;
    if (!qi || typeof qi !== 'object') continue;

    const resetMs = parseResetMs(qi.resetTime);
    const resetIso = resetMs !== null && resetMs > 0 ? String(qi.resetTime).trim() : '';
    const frac = resolveRemainingFraction(qi, resetMs);
    if (frac === null) continue;

    const family = inferPoolKeyForAccount(label, modelId);
    const groupKey = `${family}|${resetIso || 'idle'}`;
    let entry = poolsMap.get(groupKey);
    if (!entry) {
      entry = {
        family,
        resetTime: resetIso,
        modelLabels: [],
        modelIds: [],
        minFraction: frac,
        hasUsage: frac < 1.0,
      };
      poolsMap.set(groupKey, entry);
    }
    if (label && !entry.modelLabels.includes(label)) entry.modelLabels.push(label);
    if (modelId && !entry.modelIds.includes(modelId)) entry.modelIds.push(modelId);
    if (frac < entry.minFraction) entry.minFraction = frac;
    if (frac < 1.0) entry.hasUsage = true;
  }

  const resetPools = [...poolsMap.values()]
    .map((p) => ({
      family: p.family,
      resetTime: p.resetTime,
      modelLabels: p.modelLabels,
      modelIds: p.modelIds,
      hasUsage: p.hasUsage,
      remainingPercent: p.hasUsage ? Math.round(p.minFraction * 100) : 100,
    }))
    .sort((a, b) => {
      if (a.hasUsage !== b.hasUsage) return a.hasUsage ? -1 : 1;
      const ta = a.resetTime ? Date.parse(a.resetTime) || Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
      const tb = b.resetTime ? Date.parse(b.resetTime) || Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
      return ta - tb;
    });

  const credits = [];
  if (Array.isArray(userTier?.availableCredits)) {
    for (const c of userTier.availableCredits) {
      if (!c || typeof c.creditType !== 'string') continue;
      const amt = Number(c.creditAmount);
      if (!Number.isFinite(amt)) continue;
      credits.push({
        creditType: c.creditType.replace(/^CREDIT_TYPE_/, ''),
        amount: Math.round(amt),
      });
    }
  }

  return {
    email: email || name || 'unknown',
    name: name || email || 'Account',
    planName,
    tierName,
    lastSeenMs: nowMs,
    isActive: true,
    resetPools,
    credits,
  };
}

export function resolveLegacyMonitorStatePath(env = process.env, platform = process.platform) {
  if (env.ANTIGRAVITY_CONTEXT_MONITOR_STATE_PATH?.trim()) {
    return env.ANTIGRAVITY_CONTEXT_MONITOR_STATE_PATH.trim();
  }
  if (platform === 'win32' && env.APPDATA) {
    return join(env.APPDATA, 'Antigravity Context Monitor', 'state-v1.json');
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Antigravity Context Monitor', 'state-v1.json');
  }
  const xdg = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(xdg, 'antigravity-context-monitor', 'state-v1.json');
}

function addLedgerBucket(accMap, email, bucket) {
  if (!email || !bucket || typeof bucket !== 'object') return;
  let cur = accMap.get(email);
  if (!cur) {
    cur = {
      calls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    accMap.set(email, cur);
  }
  cur.calls += Math.max(0, Math.round(Number(bucket.totalCalls) || 0));
  cur.inputTokens += Math.max(0, Math.round(Number(bucket.totalInputTokens) || 0));
  cur.cacheReadTokens += Math.max(0, Math.round(Number(bucket.totalCacheRead) || 0));
  cur.cacheWriteTokens += Math.max(0, Math.round(Number(bucket.totalCacheCreation) || 0));
  cur.outputTokens += Math.max(0, Math.round(Number(bucket.totalOutputTokens) || 0));
  const estCost = Number(bucket.totalEstimatedCost);
  if (Number.isFinite(estCost) && estCost > 0) cur.costUsd += estCost;
}

export function readLegacyMonitorSeed(statePath = resolveLegacyMonitorStatePath()) {
  if (!statePath || !existsSync(statePath)) return null;
  let parsed;
  try {
    const raw = readFileSync(statePath, 'utf8').replace(/^\uFEFF/, '');
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const g = parsed?.global;
  if (!g || typeof g !== 'object') return null;

  const ledgerByEmail = new Map();
  const dl = g.dailyLedgerState;
  if (dl && typeof dl === 'object') {
    if (dl.accounts && typeof dl.accounts === 'object') {
      for (const [email, bucket] of Object.entries(dl.accounts)) {
        addLedgerBucket(ledgerByEmail, email, bucket);
      }
    }
    if (Array.isArray(dl.settled)) {
      for (const item of dl.settled) {
        addLedgerBucket(ledgerByEmail, item?.accountEmail, item);
      }
    }
  }

  const snaps = Array.isArray(g.accountSnapshots) ? g.accountSnapshots : [];
  const accounts = [];
  const seenEmails = new Set();

  for (const s of snaps) {
    const email = String(s?.email || '').trim();
    if (!email || seenEmails.has(email)) continue;
    seenEmails.add(email);
    const seed = ledgerByEmail.get(email) || {
      calls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    const lastSeenMs = s.lastSeen ? Date.parse(s.lastSeen) || Date.now() : Date.now();
    accounts.push({
      email,
      name: String(s.name || email),
      planName: String(s.planName || ''),
      tierName: String(s.tierName || ''),
      isActive: Boolean(s.isActive),
      lastSeenMs,
      resetPools: Array.isArray(s.resetPools) ? s.resetPools : [],
      credits: Array.isArray(s.credits) ? s.credits : [],
      seed,
    });
  }

  for (const [email, seed] of ledgerByEmail.entries()) {
    if (seenEmails.has(email)) continue;
    accounts.push({
      email,
      name: email,
      planName: '',
      tierName: '',
      isActive: false,
      lastSeenMs: Date.now(),
      resetPools: [],
      credits: [],
      seed,
    });
  }

  return accounts.length > 0 ? { accounts } : null;
}
