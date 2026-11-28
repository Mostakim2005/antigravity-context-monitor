import { existsSync, readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import {
  FIXED_LIMIT_TOKENS,
  ID_RE,
  buildHeatmapData,
  buildSpeedIndex,
  enrichSummaryWithSpeed,
  findAllBrainDirs,
  parseTranscriptDaily,
  parseTranscriptText,
  readTranscriptFile,
  resolveTranscriptFile,
  safeStat,
} from './lib.mjs';
import {
  parseQuotaSummary,
  parseUserStatusQuotaFallback,
  extractAICredits,
  isCustomOrByokModel,
} from './quotas.mjs';
import { extractActiveAccountSnapshot, extractPerModelQuotas, readLegacyMonitorSeed } from './accounts.mjs';
import { analyzeActiveDiagnostics, readLocalOrchestratorConfig } from './diagnostics.mjs';
import { computeContextBreakdown } from './breakdown.mjs';
import { calculateScopeCosts, getCatalogPricingList } from './pricing.mjs';
import {
  backfillLegacyAccountModelsOnce,
  buildProjectAndChatBreakdowns,
  deleteCustomPricingEntry,
  exportMonthArchive,
  getCostPrefs,
  getCustomPricingMap,
  getUiPrefs,
  importMonthArchive,
  listAccountSnapshots,
  listMonthsInDb,
  openContextDb,
  queryHeatmapSql,
  queryScopeRows,
  recordQuotaSamplesAndComputeRunway,
  removeAccountSnapshot,
  resolveDbPath,
  saveCostPrefs,
  saveCustomPricingEntry,
  saveUiPrefs,
  scanTranscriptIncremental,
  seedAccountsFromLegacyOnce,
  syncBrainIncremental,
  upsertActiveAccountSnapshot,
} from './db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

const STATIC = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/prefs.js': ['prefs.js', 'application/javascript; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'application/javascript; charset=utf-8'],
  '/quotas.js': ['quotas.js', 'application/javascript; charset=utf-8'],
  '/sections.js': ['sections.js', 'application/javascript; charset=utf-8'],
  '/accounts.js': ['accounts.js', 'application/javascript; charset=utf-8'],
  '/extras.js': ['extras.js', 'application/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

function safeJsonForScript(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const transcriptCache = new Map(); // path -> { mtimeMs, size, summary }
const heatmapFileCache = new Map(); // path -> { mtimeMs, size, convId, dailyMap }
const convSpeedCache = new Map(); // convId -> { mtimeMs, size, speedIndex }
const titleCache = new Map(); // convId -> { title, repoName, branch, fetchedAt }
const breakdownCache = new Map(); // convId -> { stepKey, payload }
const diagnosticsCache = new Map(); // convId -> { cacheKey, payload }
const activeModelByConv = new Map(); // convId -> { modelId, label, isCustomModel }
const TITLE_TTL_MS = 60_000;
const QUOTA_TTL_MS = 30_000;
const TRAJ_TTL_MS = 10_000;
const SCOPE_SYNC_TTL_MS = 5_000;
let quotaCache = { fetchedAt: 0, payload: null, modelQuotas: [] };
let trajCache = { fetchedAt: 0, list: [], byId: new Map() };
let lastBrainSyncAt = 0;
let currentAccountEmail = '';
let legacySeedChecked = false;
let dbInstance = null;

function getDb() {
  if (!dbInstance) {
    dbInstance = openContextDb(resolveDbPath());
  }
  if (!legacySeedChecked) {
    legacySeedChecked = true;
    try {
      const done = dbInstance.prepare("SELECT 1 FROM kv WHERE k = 'legacy_accounts_imported_ms'").get();
      const doneModels = dbInstance.prepare("SELECT 1 FROM kv WHERE k = 'legacy_account_models_seeded_v1'").get();
      if (!done || !doneModels) {
        const legacy = readLegacyMonitorSeed();
        if (legacy) {
          if (!done) seedAccountsFromLegacyOnce(dbInstance, legacy, Date.now());
          else backfillLegacyAccountModelsOnce(dbInstance, legacy);
        }
      }
    } catch {
      // Ignore optional legacy state migration failures
    }
  }
  return dbInstance;
}

function syncAccountFromUserStatus(statusRaw, now = Date.now()) {
  if (!statusRaw) return '';
  try {
    const snap = extractActiveAccountSnapshot(statusRaw, now);
    if (!snap) return '';
    currentAccountEmail = snap.email;
    upsertActiveAccountSnapshot(getDb(), snap, now);
    return snap.email;
  } catch {
    return '';
  }
}

function callLsRpc(method, payloadObj, timeoutMs = 1500) {
  const rawAddr = String(process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const csrf = String(process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (!rawAddr || !csrf) return Promise.resolve(null);

  const hasProto = /^https?:\/\//i.test(rawAddr);
  const candidates = hasProto ? [rawAddr] : [`https://${rawAddr}`, `http://${rawAddr}`];
  const body = JSON.stringify(payloadObj || {});

  const postOne = (baseUrl) =>
    new Promise((resolve) => {
      const mod = baseUrl.startsWith('https://') ? https : http;
      const url = `${baseUrl.replace(/\/$/, '')}/exa.language_server_pb.LanguageServerService/${method}`;
      const req = mod.request(
        url,
        {
          method: 'POST',
          rejectUnauthorized: false,
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': csrf,
          },
        },
        (res) => {
          let text = '';
          let bytes = 0;
          res.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > 16 * 1024 * 1024) {
              req.destroy();
              resolve(null);
              return;
            }
            text += chunk;
          });
          res.on('end', () => {
            if (res.statusCode !== 200) {
              resolve(null);
              return;
            }
            try {
              resolve(JSON.parse(text));
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        resolve(null);
      });
      req.on('error', () => resolve(null));
      req.end(body);
    });

  return (async () => {
    for (const base of candidates) {
      const res = await postOne(base);
      if (res) return res;
    }
    return null;
  })();
}

async function callLsGeneratorMetadata(convId) {
  const json = await callLsRpc('GetCascadeTrajectoryGeneratorMetadata', {
    cascadeId: convId,
    generatorMetadataOffset: 0,
    includeMessages: false,
  });
  return Array.isArray(json?.generatorMetadata) ? json.generatorMetadata : null;
}

function trackActiveConvModel(convId, genMeta) {
  if (!convId || !Array.isArray(genMeta) || genMeta.length === 0) return null;
  for (let i = genMeta.length - 1; i >= 0; i--) {
    const cm = genMeta[i]?.chatModel;
    if (!cm) continue;
    const rawId = String(cm.model || cm.responseModel || '').trim();
    const respId = String(cm.responseModel || '').trim();
    const label = String(cm.modelDisplayName || respId || rawId).trim();
    if (!rawId && !label) continue;
    const isCustom = isCustomOrByokModel(rawId, label) || (respId ? isCustomOrByokModel(respId, label) : false);
    const info = { modelId: respId || rawId, rawModelId: rawId, label, isCustomModel: isCustom };
    if (activeModelByConv.size > 64) activeModelByConv.clear();
    activeModelByConv.set(convId, info);
    return info;
  }
  return null;
}

async function getQuotasSnapshot(force = false, convId = '') {
  const now = Date.now();
  const activeModel = convId ? (activeModelByConv.get(convId) || null) : null;
  const applyActiveIsolation = (basePayload) => {
    if (!basePayload) return basePayload;
    const isCustom = Boolean(activeModel?.isCustomModel);
    const pools = isCustom
      ? (basePayload.pools || []).map((p) => ({
          ...p,
          runway: { status: 'custom_model_isolated', burnRatePctPerHour: null, estExhaustMin: null },
        }))
      : basePayload.pools;
    return {
      ...basePayload,
      pools,
      activeModel: activeModel ? { modelId: activeModel.modelId, label: activeModel.label, isCustomModel: isCustom } : null,
    };
  };

  if (!force && quotaCache.payload && now - quotaCache.fetchedAt < QUOTA_TTL_MS) {
    return applyActiveIsolation(quotaCache.payload);
  }
  const meta = { metadata: { ideName: 'antigravity', extensionName: 'antigravity' } };
  const [summaryRaw, statusRaw] = await Promise.all([
    callLsRpc('RetrieveUserQuotaSummary', meta, 3000),
    callLsRpc('GetUserStatus', meta, 3000),
  ]);
  syncAccountFromUserStatus(statusRaw, now);
  let parsed = parseQuotaSummary(summaryRaw, now);
  if (!parsed && statusRaw) {
    parsed = parseUserStatusQuotaFallback(statusRaw, now);
  }
  const aiCredits = extractAICredits(statusRaw);
  const modelQuotas = extractPerModelQuotas(statusRaw, parsed, now);
  let pools = parsed?.pools || [];
  if (pools.length > 0) {
    try {
      pools = recordQuotaSamplesAndComputeRunway(getDb(), pools, now);
    } catch {
      // Keep quotas functional even if SQLite runway history fails
    }
  }
  const payload = parsed || aiCredits.length > 0
    ? {
        available: true,
        updatedAt: new Date(now).toISOString(),
        source: parsed?.source || (aiCredits.length > 0 ? 'user_status' : null),
        pools,
        aiCredits,
      }
    : {
        available: false,
        updatedAt: new Date(now).toISOString(),
        source: null,
        pools: [],
        aiCredits: [],
      };
  quotaCache = { fetchedAt: now, payload, modelQuotas };
  return applyActiveIsolation(payload);
}

async function getSummary(convId) {
  const loc = resolveTranscriptFile(convId);
  if (!loc) return null;
  const st = safeStat(loc.path);
  if (!st) return null;
  const cached = transcriptCache.get(loc.path);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return { summary: cached.summary, etag: `${convId}|${st.mtimeMs}|${st.size}` };
  }
  let summary = parseTranscriptText(readTranscriptFile(loc.path));
  const genMeta = await callLsGeneratorMetadata(convId);
  if (genMeta) {
    trackActiveConvModel(convId, genMeta);
    const speedIndex = buildSpeedIndex(genMeta);
    if (convSpeedCache.size > 512) convSpeedCache.clear();
    convSpeedCache.set(convId, { mtimeMs: st.mtimeMs, size: st.size, speedIndex });
    summary = enrichSummaryWithSpeed(summary, speedIndex);
  }
  if (transcriptCache.size > 64) transcriptCache.clear();
  transcriptCache.set(loc.path, { mtimeMs: st.mtimeMs, size: st.size, summary });
  try {
    scanTranscriptIncremental(getDb(), {
      convId,
      transcriptPath: loc.path,
      appSource: loc.source || '',
      activeAccountEmail: currentAccountEmail,
    });
  } catch {
    // Non-critical live incremental DB attribution
  }
  return { summary, etag: `${convId}|${st.mtimeMs}|${st.size}` };
}

function getConvTitle(app, convId) {
  const now = Date.now();
  const cached = titleCache.get(convId);
  if (cached && now - cached.fetchedAt < TITLE_TTL_MS) {
    return { title: cached.title, repoName: cached.repoName, branch: cached.branch };
  }
  try {
    const md = app.getConversationMetadata(convId);
    const meta = md?.response?.conversationMetadata?.metadata || md?.response?.conversation_metadata?.metadata;
    const repoName = meta?.workspaces?.[0]?.repository?.computedName || '';
    const branch = meta?.workspaces?.[0]?.branchName || '';
    const title = md?.response?.conversationMetadata?.title || md?.title || '';
    const result = { title, repoName, branch };
    if (titleCache.size > 64) titleCache.clear();
    titleCache.set(convId, { ...result, fetchedAt: now });
    return result;
  } catch {
    return { title: '', repoName: '', branch: '' };
  }
}

const app = new SidecarApp();

app.page('/', () => new Response(readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf-8'), {
  contentType: 'text/html; charset=utf-8',
  headers: { 'Cache-Control': 'no-store' },
}));

for (const [route, [file, contentType]] of Object.entries(STATIC)) {
  app.api(
    route,
    () => new Response(readFileSync(join(PUBLIC_DIR, file), 'utf-8'), {
      contentType,
      headers: { 'Cache-Control': 'no-store' },
    }),
    'GET',
  );
}

app.api(
  '/ui-prefs.js',
  () => new Response(`globalThis.__CM_UI_PREFS__ = ${safeJsonForScript(getUiPrefs(getDb()))};\n`, {
    contentType: 'application/javascript; charset=utf-8',
    headers: { 'Cache-Control': 'no-store' },
  }),
  'GET',
);

app.api(
  '/api/ui-prefs',
  () => new Response(JSON.stringify({ prefs: getUiPrefs(getDb()) }), {
    contentType: 'application/json; charset=utf-8',
    headers: { 'Cache-Control': 'no-store' },
  }),
  'GET',
);

app.api(
  '/api/ui-prefs',
  (data) => ({ ok: true, prefs: saveUiPrefs(getDb(), data || {}) }),
  'POST',
);

app.api(
  '/api/context',
  async (data) => {
    const conv = String(data.conversationId || app.config.conversationId || '').trim();

    if (!conv || !ID_RE.test(conv)) {
      return {
        conversationId: conv || null,
        found: false,
        limitTokens: FIXED_LIMIT_TOKENS,
      };
    }

    const result = await getSummary(conv);
    if (!result) {
      return {
        conversationId: conv,
        found: false,
        limitTokens: FIXED_LIMIT_TOKENS,
      };
    }

    const limitTokens = result.summary.contextLimitTokens || FIXED_LIMIT_TOKENS;
    const etag = `${result.etag}|${limitTokens}`;
    if (data.etag && data.etag === etag) {
      return {
        conversationId: conv,
        found: true,
        unchanged: true,
        etag,
      };
    }

    const meta = getConvTitle(app, conv);
    return {
      conversationId: conv,
      found: true,
      etag,
      limitTokens,
      meta,
      ...result.summary,
    };
  },
  'GET',
);

function getHeatmapSnapshot(weeks = 16) {
  const brainDirs = findAllBrainDirs();
  const entries = [];
  const seenPaths = new Set();

  for (const brainDir of brainDirs) {
    let convDirs = [];
    try {
      convDirs = readdirSync(brainDir);
    } catch {
      continue;
    }
    for (const convId of convDirs) {
      if (!ID_RE.test(convId)) continue;
      const tp = join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
      if (!existsSync(tp)) continue;
      seenPaths.add(tp);
      const st = safeStat(tp);
      if (!st) continue;
      const cached = heatmapFileCache.get(tp);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        entries.push(cached);
        continue;
      }
      const dailyMap = parseTranscriptDaily(readTranscriptFile(tp));
      const item = { mtimeMs: st.mtimeMs, size: st.size, convId, dailyMap };
      heatmapFileCache.set(tp, item);
      entries.push(item);
    }
  }

  for (const p of heatmapFileCache.keys()) {
    if (!seenPaths.has(p)) heatmapFileCache.delete(p);
  }

  return {
    sourcesCount: brainDirs.length,
    ...buildHeatmapData(entries, { weeks }),
  };
}

async function getConvSpeedIndex(convId, mtimeMs, size) {
  const cached = convSpeedCache.get(convId);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.speedIndex;
  }
  const genMeta = await callLsGeneratorMetadata(convId);
  if (!genMeta) return null;
  const speedIndex = buildSpeedIndex(genMeta);
  if (convSpeedCache.size > 512) convSpeedCache.clear();
  convSpeedCache.set(convId, { mtimeMs, size, speedIndex });
  return speedIndex;
}

async function getHeatmapDayModels(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) {
    return { date: dateKey || '', models: [] };
  }
  // Ensure heatmapFileCache is warm
  if (heatmapFileCache.size === 0) {
    getHeatmapSnapshot(16);
  }
  const dayItems = [];
  for (const item of heatmapFileCache.values()) {
    const bucket = item.dailyMap.get(dateKey);
    if (bucket && bucket.calls > 0) {
      dayItems.push({ convId: item.convId, mtimeMs: item.mtimeMs, size: item.size, bucket });
    }
  }
  const modelAgg = new Map(); // model -> { model, calls, totalTokens }
  await Promise.all(
    dayItems.map(async ({ convId, mtimeMs, size, bucket }) => {
      const speedIndex = await getConvSpeedIndex(convId, mtimeMs, size);
      if (!speedIndex || speedIndex.size === 0) return;
      for (const st of bucket.stepTokens || []) {
        const model = speedIndex.get(st.stepIndex)?.model || '';
        if (!model) continue;
        let agg = modelAgg.get(model);
        if (!agg) {
          agg = { model, calls: 0, totalTokens: 0 };
          modelAgg.set(model, agg);
        }
        agg.calls += 1;
        agg.totalTokens += st.totalTokens;
      }
    }),
  );
  const models = [...modelAgg.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  return { date: dateKey, models };
}

function parseWorkspaceUrisParam(raw) {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  const str = String(raw || '').trim();
  if (!str) return [];
  if (str.startsWith('[')) {
    try {
      const parsed = JSON.parse(str);
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return str.split('|').map((s) => s.trim()).filter(Boolean);
}

function normalizeWsUri(uri) {
  return decodeURIComponent(String(uri || '').trim())
    .replace(/^file:\/\/localhost\//i, '/')
    .replace(/^file:\/\/\//i, '/')
    .replace(/^file:\/\//i, '')
    .replace(/\\/g, '/')
    .replace(/^\/+([a-zA-Z]:)/, '$1')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function inferSubagentMeta(data) {
  const bags = [data.metadata, data.cascadeMetadata, data.swarmMetadata, data.trajectoryMetadata].filter(
    (b) => b && typeof b === 'object',
  );
  const merged = Object.assign({}, ...bags);
  const parentCascadeId = String(
    data.parentCascadeId || data.parentConversationId || merged.parentCascadeId || merged.parentConversationId || '',
  ).trim();
  const trajectoryType = String(data.trajectoryType || merged.trajectoryType || '').toLowerCase();
  const role = String(data.role || data.agentRole || data.swarmRole || merged.role || merged.agentRole || merged.swarmRole || '').trim();
  const isSubagent = Boolean(
    data.isSubagent === true ||
    data.isChild === true ||
    merged.isSubagent === true ||
    merged.isChild === true ||
    parentCascadeId ||
    data.parentTrajectoryId ||
    merged.parentTrajectoryId ||
    trajectoryType.includes('subagent') ||
    (role && role.toLowerCase() !== 'main' && role.toLowerCase() !== 'coordinator'),
  );
  return { isSubagent, parentCascadeId, role };
}

async function fetchTrajectoriesCached(force = false) {
  const now = Date.now();
  if (!force && trajCache.list.length > 0 && now - trajCache.fetchedAt < TRAJ_TTL_MS) {
    return trajCache;
  }
  const resp = await callLsRpc(
    'GetAllCascadeTrajectories',
    { metadata: { ideName: 'antigravity', extensionName: 'antigravity' } },
    2500,
  );
  const summaries = resp?.trajectorySummaries;
  if (!summaries || typeof summaries !== 'object') {
    return trajCache;
  }
  const list = [];
  const byId = new Map();
  for (const [cascadeId, raw] of Object.entries(summaries)) {
    if (!ID_RE.test(cascadeId) || !raw || typeof raw !== 'object') continue;
    const workspaces = Array.isArray(raw.workspaces) ? raw.workspaces : [];
    const workspaceUris = workspaces.map((w) => w?.workspaceFolderAbsoluteUri).filter(Boolean);
    const { isSubagent, parentCascadeId, role } = inferSubagentMeta(raw);
    const item = {
      cascadeId,
      summary: String(raw.summary || '').trim() || cascadeId.slice(0, 8),
      stepCount: Number(raw.stepCount) || 0,
      status: String(raw.status || ''),
      lastModifiedTime: String(raw.lastModifiedTime || raw.createdTime || ''),
      workspaceUris,
      workspaceUri: workspaceUris[0] || '',
      isSubagent,
      parentCascadeId,
      role,
    };
    list.push(item);
    byId.set(cascadeId, item);
  }
  list.sort((a, b) => {
    const ta = Date.parse(a.lastModifiedTime) || 0;
    const tb = Date.parse(b.lastModifiedTime) || 0;
    return tb - ta;
  });
  trajCache = { fetchedAt: now, list, byId };
  return trajCache;
}

async function getConversationsSnapshot(data) {
  const hostConvId = String(data.hostConvId || app.config.conversationId || '').trim();
  const wsUris = parseWorkspaceUrisParam(data.workspaceUris);
  const wsNorms = new Set(wsUris.map(normalizeWsUri).filter(Boolean));
  const trajs = await fetchTrajectoriesCached(data.force === '1');
  const hostEntry = hostConvId ? trajs.byId.get(hostConvId) || null : null;

  let recommendedMainId = hostConvId;
  if (hostEntry?.isSubagent) {
    if (hostEntry.parentCascadeId && trajs.byId.has(hostEntry.parentCascadeId)) {
      recommendedMainId = hostEntry.parentCascadeId;
    } else {
      const hostWs = new Set(hostEntry.workspaceUris.map(normalizeWsUri).filter(Boolean));
      const candidate = trajs.list.find(
        (t) => !t.isSubagent && (hostWs.size === 0 || t.workspaceUris.some((u) => hostWs.has(normalizeWsUri(u)))),
      );
      if (candidate) recommendedMainId = candidate.cascadeId;
    }
  }

  return {
    hostConvId,
    hostIsSubagent: Boolean(hostEntry?.isSubagent),
    recommendedMainId,
    conversations: trajs.list.slice(0, 60).map((t) => ({
      ...t,
      inCurrentWorkspace: wsNorms.size > 0 && t.workspaceUris.some((u) => wsNorms.has(normalizeWsUri(u))),
    })),
  };
}

async function getBreakdownSnapshot(convId) {
  if (!convId || !ID_RE.test(convId)) {
    return { available: false, conversationId: convId || null };
  }
  const [summaryRes, genMeta] = await Promise.all([
    getSummary(convId),
    callLsGeneratorMetadata(convId),
  ]);
  const summary = summaryRes?.summary;
  const usedTokens = summary?.latest?.contextUsed || 0;
  const limitTokens = summary?.contextLimitTokens || FIXED_LIMIT_TOKENS;
  const stepKey = `${summaryRes?.etag || convId}|${genMeta?.length || 0}`;
  const cached = breakdownCache.get(convId);
  if (cached && cached.stepKey === stepKey) {
    return cached.payload;
  }

  const sectionTokenCount = (sec) =>
    Number(sec?.numTokens ?? sec?.tokens ?? sec?.tokenCount ?? sec?.estimatedTokens ?? sec?.contentLen) || 0;

  let hasSubstantialSections = false;
  if (Array.isArray(genMeta)) {
    for (let i = genMeta.length - 1; i >= 0; i--) {
      const cm = genMeta[i]?.chatModel;
      if (!cm) continue;
      const secSum = Array.isArray(cm.promptSections)
        ? cm.promptSections.reduce((s, x) => s + Math.max(0, sectionTokenCount(x)), 0)
        : 0;
      const grpSum = Array.isArray(cm.tokenBreakdownGroups)
        ? cm.tokenBreakdownGroups.reduce((s, x) => s + Math.max(0, Number(x?.numTokens ?? x?.tokens ?? x?.tokenCount) || 0), 0)
        : 0;
      if (secSum + grpSum > Math.max(100, usedTokens * 0.5)) {
        hasSubstantialSections = true;
        break;
      }
    }
  }

  let steps = [];
  if (!hasSubstantialSections) {
    const targetSteps = Math.max(500, (summary?.latest?.stepIndex || 0) + 50);
    for (let batch = 0; batch < 4; batch++) {
      const start = steps.length;
      const end = Math.min(targetSteps, start + 500);
      const stepsResp = await callLsRpc(
        'GetCascadeTrajectorySteps',
        { cascadeId: convId, startIndex: start, endIndex: end, stepOffset: start },
        3500,
      );
      const page = Array.isArray(stepsResp?.steps) ? stepsResp.steps : [];
      if (page.length === 0) break;
      steps.push(...page);
      if (steps.length >= targetSteps || page.length < 200) break;
    }
  }

  const breakdown = computeContextBreakdown({
    generatorMetadata: genMeta || [],
    steps,
    usedTokens,
    limitTokens,
  });
  const payload = {
    available: breakdown.segments.length > 0,
    conversationId: convId,
    ...breakdown,
  };
  if (breakdownCache.size > 64) breakdownCache.clear();
  breakdownCache.set(convId, { stepKey, payload });
  return payload;
}

async function getDiagnosticsSnapshot(convId) {
  if (!convId || !ID_RE.test(convId)) {
    return { available: false, conversationId: convId || null };
  }
  const genMeta = await callLsGeneratorMetadata(convId);
  if (genMeta) trackActiveConvModel(convId, genMeta);
  const localConfig = readLocalOrchestratorConfig();
  const customPricing = getCustomPricingMap(getDb());
  const isSubagentConversation = Boolean(trajCache.byId.get(convId)?.isSubagent);
  const cacheKey = `${convId}|${genMeta?.length || 0}|${isSubagentConversation ? 1 : 0}|${localConfig?.orchestratorModel || ''}|${localConfig?.orchestratorExecutorModel || ''}|${JSON.stringify(customPricing)}`;
  const cached = diagnosticsCache.get(convId);
  if (cached && cached.cacheKey === cacheKey) {
    return cached.payload;
  }

  const diag = analyzeActiveDiagnostics({
    generatorMetadata: genMeta || [],
    localConfig,
    customPricing,
    isSubagentConversation,
  });
  const payload = {
    conversationId: convId,
    activeModel: activeModelByConv.get(convId) || null,
    ...diag,
  };
  if (diagnosticsCache.size > 16) diagnosticsCache.clear();
  diagnosticsCache.set(convId, { cacheKey, payload });
  return payload;
}

async function ensureActiveAccountEmail() {
  if (currentAccountEmail) return currentAccountEmail;
  await getQuotasSnapshot(false);
  return currentAccountEmail;
}

async function getAccountsSnapshot(force = false) {
  const now = Date.now();
  if (force || !currentAccountEmail || !quotaCache.payload || now - quotaCache.fetchedAt >= QUOTA_TTL_MS) {
    await getQuotasSnapshot(force);
  }
  const db = getDb();
  const activeAccountEmail = currentAccountEmail;
  if (now - lastBrainSyncAt > SCOPE_SYNC_TTL_MS || force) {
    try {
      const trajs = await fetchTrajectoriesCached(false);
      const workspaceByConv = new Map();
      for (const t of trajs.list) {
        workspaceByConv.set(t.cascadeId, { workspaceUri: t.workspaceUri || '', title: t.summary || '' });
      }
      syncBrainIncremental(db, { workspaceByConv, activeAccountEmail });
      lastBrainSyncAt = now;
    } catch {
      // ignore non-critical sync
    }
  }
  const customPricing = getCustomPricingMap(db);
  const { rows } = queryScopeRows(db, { scope: 'all', nowMs: now });
  const allModelsCost = calculateScopeCosts(rows, customPricing);

  return {
    updatedAt: new Date(now).toISOString(),
    ...listAccountSnapshots(db),
    allModels: allModelsCost.byModel,
    allModelsTotals: allModelsCost.totals,
    modelQuotas: quotaCache.modelQuotas || [],
    costPrefs: getCostPrefs(db),
  };
}

async function getScopeSnapshot(data) {
  const scope = String(data.scope || 'conversation').trim();
  const convId = String(data.conversationId || app.config.conversationId || '').trim();
  const workspaceUris = parseWorkspaceUrisParam(data.workspaceUris);
  const force = data.force === '1' || data.force === 'true';

  const db = getDb();
  const activeAccountEmail = await ensureActiveAccountEmail();
  const trajs = await fetchTrajectoriesCached(false);
  const workspaceByConv = new Map();
  for (const t of trajs.list) {
    workspaceByConv.set(t.cascadeId, {
      workspaceUri: t.workspaceUri || '',
      title: t.summary || '',
    });
  }

  if (convId && ID_RE.test(convId)) {
    const loc = resolveTranscriptFile(convId);
    if (loc) {
      const wsMeta = workspaceByConv.get(convId);
      const title = wsMeta?.title || getConvTitle(app, convId).title || '';
      scanTranscriptIncremental(db, {
        convId,
        transcriptPath: loc.path,
        appSource: loc.source || '',
        workspaceUri: wsMeta?.workspaceUri || workspaceUris[0] || '',
        title,
        activeAccountEmail,
      });
    }
  }

  const now = Date.now();
  if (scope !== 'conversation' && (force || now - lastBrainSyncAt > SCOPE_SYNC_TTL_MS)) {
    syncBrainIncremental(db, { workspaceByConv, activeAccountEmail });
    lastBrainSyncAt = now;
  }

  const { rows, conversationsCount, archivedMonthsUsed } = queryScopeRows(db, {
    scope,
    convId,
    workspaceUris,
    nowMs: now,
  });
  const customPricing = getCustomPricingMap(db);
  const cost = calculateScopeCosts(rows, customPricing);
  const { byProject, byChat } = buildProjectAndChatBreakdowns(rows, customPricing);
  const months = listMonthsInDb(db);

  return {
    scope,
    conversationId: convId || null,
    conversationsCount,
    archivedMonthsUsed,
    months,
    customPricingCount: Object.keys(customPricing).length,
    costPrefs: getCostPrefs(db),
    byProject,
    byChat,
    ...cost,
  };
}

app.api(
  '/api/quotas',
  (data) => getQuotasSnapshot(
    data.force === '1' || data.force === 'true',
    String(data.conversationId || app.config.conversationId || '').trim(),
  ),
  'GET',
);

app.api(
  '/api/diagnostics',
  (data) => getDiagnosticsSnapshot(String(data.conversationId || app.config.conversationId || '').trim()),
  'GET',
);

app.api('/api/conversations', (data) => getConversationsSnapshot(data), 'GET');

app.api(
  '/api/breakdown',
  (data) => getBreakdownSnapshot(String(data.conversationId || app.config.conversationId || '').trim()),
  'GET',
);

app.api('/api/scope', (data) => getScopeSnapshot(data), 'GET');

app.api(
  '/api/accounts',
  (data) => getAccountsSnapshot(data.force === '1' || data.force === 'true'),
  'GET',
);

app.api(
  '/api/accounts/remove',
  (data) => {
    const db = getDb();
    const removed = removeAccountSnapshot(db, data.email);
    return { ok: removed, ...listAccountSnapshots(db) };
  },
  'POST',
);

app.api(
  '/api/pricing',
  () => ({ catalog: getCatalogPricingList(getCustomPricingMap(getDb())) }),
  'GET',
);

app.api(
  '/api/pricing',
  (data) => {
    const modelKey = String(data.modelKey || '').trim().toLowerCase();
    if (!modelKey) return { error: 'modelKey required' };
    const db = getDb();
    saveCustomPricingEntry(db, {
      modelKey,
      label: String(data.label || modelKey),
      input: Number(data.input) || 0,
      output: Number(data.output) || 0,
      cacheRead: Number(data.cacheRead) || 0,
      cacheWrite: Number(data.cacheWrite) || 0,
    });
    return { ok: true, catalog: getCatalogPricingList(getCustomPricingMap(db)) };
  },
  'POST',
);

app.api(
  '/api/pricing/reset',
  (data) => {
    const db = getDb();
    deleteCustomPricingEntry(db, String(data.modelKey || '').trim().toLowerCase());
    return { ok: true, catalog: getCatalogPricingList(getCustomPricingMap(db)) };
  },
  'POST',
);

app.api(
  '/api/archive/export',
  (data) => {
    const db = getDb();
    const bundle = exportMonthArchive(db, String(data.monthKey || ''), {
      freeze: data.freeze !== false,
    });
    return { ok: true, bundle, months: listMonthsInDb(db) };
  },
  'POST',
);

app.api(
  '/api/archive/import',
  (data) => {
    const db = getDb();
    const bundle = data?.bundle && typeof data.bundle === 'object' ? data.bundle : data;
    const res = importMonthArchive(db, bundle);
    return { ok: true, ...res, months: listMonthsInDb(db) };
  },
  'POST',
);

app.api(
  '/api/cost-prefs',
  () => ({ prefs: getCostPrefs(getDb()) }),
  'GET',
);

app.api(
  '/api/cost-prefs',
  (data) => ({ ok: true, prefs: saveCostPrefs(getDb(), data || {}) }),
  'POST',
);

app.api(
  '/api/heatmap/analytics',
  (data) => {
    const db = getDb();
    try {
      syncBrainIncremental(db, { activeAccountEmail: currentAccountEmail });
    } catch {
      // ignore non-critical sync
    }
    return queryHeatmapSql(db, {
      weeks: data.weeks,
      sourceFilter: String(data.source || 'all').trim().toLowerCase(),
    });
  },
  'GET',
);

app.api(
  '/api/heatmap',
  (data) => getHeatmapSnapshot(data.weeks),
  'GET',
);

app.api(
  '/api/heatmap/day',
  (data) => getHeatmapDayModels(data.date),
  'GET',
);

app.run();
