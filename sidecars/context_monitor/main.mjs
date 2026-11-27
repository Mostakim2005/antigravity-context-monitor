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

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

const STATIC = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'application/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

const transcriptCache = new Map(); // path -> { mtimeMs, size, summary }
const heatmapFileCache = new Map(); // path -> { mtimeMs, size, convId, dailyMap }
const convSpeedCache = new Map(); // convId -> { mtimeMs, size, speedIndex }
const titleCache = new Map(); // convId -> { title, fetchedAt }
const TITLE_TTL_MS = 60_000;

function callLsGeneratorMetadata(convId) {
  const rawAddr = String(process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const csrf = String(process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (!rawAddr || !csrf) return Promise.resolve(null);

  const hasProto = /^https?:\/\//i.test(rawAddr);
  const candidates = hasProto ? [rawAddr] : [`https://${rawAddr}`, `http://${rawAddr}`];
  const body = JSON.stringify({
    cascadeId: convId,
    generatorMetadataOffset: 0,
    includeMessages: false,
  });

  const postOne = (baseUrl) =>
    new Promise((resolve) => {
      const mod = baseUrl.startsWith('https://') ? https : http;
      const url = `${baseUrl.replace(/\/$/, '')}/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata`;
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
              const json = JSON.parse(text);
              resolve(Array.isArray(json?.generatorMetadata) ? json.generatorMetadata : null);
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.setTimeout(1500, () => {
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
    const speedIndex = buildSpeedIndex(genMeta);
    if (convSpeedCache.size > 512) convSpeedCache.clear();
    convSpeedCache.set(convId, { mtimeMs: st.mtimeMs, size: st.size, speedIndex });
    summary = enrichSummaryWithSpeed(summary, speedIndex);
  }
  if (transcriptCache.size > 64) transcriptCache.clear();
  transcriptCache.set(loc.path, { mtimeMs: st.mtimeMs, size: st.size, summary });
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
