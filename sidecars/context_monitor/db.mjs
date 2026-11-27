import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ID_RE, findAllBrainDirs } from './lib.mjs';

function toLocalDateKey(isoStr) {
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

export function resolveDbPath(env = process.env) {
  const dataDir = env.ANTIGRAVITY_EXECUTABLE_DATA_DIR?.trim();
  if (dataDir) {
    return join(dataDir, 'data', 'context_monitor.db');
  }
  return join(process.cwd(), '.data', 'context_monitor.db');
}

export function openContextDb(dbPath = resolveDbPath()) {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS conversations (
      conv_id TEXT PRIMARY KEY,
      app_source TEXT NOT NULL DEFAULT '',
      transcript_path TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      workspace_uri TEXT NOT NULL DEFAULT '',
      mtime_ms INTEGER NOT NULL DEFAULT 0,
      file_size INTEGER NOT NULL DEFAULT 0,
      byte_offset INTEGER NOT NULL DEFAULT 0,
      last_step_index INTEGER NOT NULL DEFAULT -1,
      month_key TEXT NOT NULL DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS conv_daily (
      conv_id TEXT NOT NULL,
      date_key TEXT NOT NULL,
      month_key TEXT NOT NULL,
      model TEXT NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      thinking_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (conv_id, date_key, model)
    );
    CREATE INDEX IF NOT EXISTS idx_conv_daily_month ON conv_daily(month_key);
    CREATE INDEX IF NOT EXISTS idx_conv_daily_date ON conv_daily(date_key);
    CREATE TABLE IF NOT EXISTS archived_months (
      month_key TEXT PRIMARY KEY,
      exported_at TEXT NOT NULL,
      frozen_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS quota_samples (
      pool_key TEXT NOT NULL,
      ts_ms INTEGER NOT NULL,
      remaining_fraction REAL NOT NULL,
      reset_at_ms INTEGER,
      PRIMARY KEY (pool_key, ts_ms)
    );
    CREATE TABLE IF NOT EXISTS custom_pricing (
      model_key TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      input REAL NOT NULL DEFAULT 0,
      output REAL NOT NULL DEFAULT 0,
      cache_read REAL NOT NULL DEFAULT 0,
      cache_write REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
  `);
  return db;
}

function readSliceUtf8(filePath, startOffset, length) {
  if (length <= 0) return { text: '', nextOffset: startOffset };
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buf, 0, length, startOffset);
    if (bytesRead <= 0) return { text: '', nextOffset: startOffset };
    const slice = buf.subarray(0, bytesRead);
    const lastNl = slice.lastIndexOf(0x0a);
    if (lastNl === -1) {
      // Incomplete line still streaming; wait until newline arrives
      return { text: '', nextOffset: startOffset };
    }
    const completeBuf = slice.subarray(0, lastNl + 1);
    return {
      text: completeBuf.toString('utf8'),
      nextOffset: startOffset + completeBuf.length,
    };
  } finally {
    closeSync(fd);
  }
}

export function scanTranscriptIncremental(db, {
  convId,
  transcriptPath,
  appSource = '',
  workspaceUri = '',
  title = '',
} = {}) {
  if (!convId || !transcriptPath || !existsSync(transcriptPath)) {
    return { scanned: false, addedCalls: 0 };
  }
  let st;
  try {
    st = statSync(transcriptPath);
  } catch {
    return { scanned: false, addedCalls: 0 };
  }

  const prev = db.prepare('SELECT * FROM conversations WHERE conv_id = ?').get(convId);
  if (prev?.archived === 1) {
    return { scanned: false, skippedArchived: true, addedCalls: 0 };
  }
  if (prev && prev.mtime_ms === Math.round(st.mtimeMs) && prev.file_size === st.size) {
    if ((workspaceUri && prev.workspace_uri !== workspaceUri) || (title && prev.title !== title)) {
      db.prepare("UPDATE conversations SET workspace_uri = COALESCE(NULLIF(?, ''), workspace_uri), title = COALESCE(NULLIF(?, ''), title) WHERE conv_id = ?")
        .run(workspaceUri, title, convId);
    }
    return { scanned: false, cached: true, addedCalls: 0 };
  }

  let offset = prev ? prev.byte_offset : 0;
  let lastStep = prev ? prev.last_step_index : -1;
  let resetNeeded = false;
  if (prev && st.size < offset) {
    // Transcript rewound or truncated -> clean re-index this single chat
    offset = 0;
    lastStep = -1;
    resetNeeded = true;
  }

  const { text, nextOffset } = readSliceUtf8(transcriptPath, offset, st.size - offset);
  const deltas = new Map();
  let maxStep = lastStep;
  let latestMonth = prev?.month_key || '';
  let addedCalls = 0;

  if (text) {
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const stepIdx = Number(obj?.step_index);
      if (Number.isFinite(stepIdx) && stepIdx <= lastStep && !resetNeeded) continue;
      if (Number.isFinite(stepIdx) && stepIdx > maxStep) maxStep = stepIdx;

      if (obj?.type !== 'PLANNER_RESPONSE') continue;
      const dateKey = toLocalDateKey(obj.created_at) || toLocalDateKey(new Date(st.mtimeMs).toISOString());
      if (!dateKey) continue;
      const monthKey = dateKey.slice(0, 7);
      if (monthKey > latestMonth) latestMonth = monthKey;

      const model = String(obj.model || obj.response_model || 'unknown').trim() || 'unknown';
      const key = `${dateKey}|${model}`;
      let b = deltas.get(key);
      if (!b) {
        b = { dateKey, monthKey, model, calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0 };
        deltas.set(key, b);
      }
      b.calls += 1;
      b.input += toInt(obj.input_tokens);
      b.cacheRead += toInt(obj.cache_read_tokens);
      b.cacheWrite += toInt(obj.cache_creation_tokens);
      b.output += toInt(obj.output_tokens);
      b.thinking += toInt(obj.thinking_tokens);
      addedCalls += 1;
    }
  }

  // Skip scanning if its primary month was already exported & frozen
  const isArchivedMonth = latestMonth
    ? Boolean(db.prepare('SELECT 1 FROM archived_months WHERE month_key = ?').get(latestMonth))
    : false;

  db.exec('BEGIN');
  try {
    if (resetNeeded) {
      db.prepare('DELETE FROM conv_daily WHERE conv_id = ?').run(convId);
    }
    const upsertDaily = db.prepare(`
      INSERT INTO conv_daily (conv_id, date_key, month_key, model, calls, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, thinking_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conv_id, date_key, model) DO UPDATE SET
        calls = calls + excluded.calls,
        input_tokens = input_tokens + excluded.input_tokens,
        cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
        cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        thinking_tokens = thinking_tokens + excluded.thinking_tokens
    `);
    for (const b of deltas.values()) {
      upsertDaily.run(convId, b.dateKey, b.monthKey, b.model, b.calls, b.input, b.cacheRead, b.cacheWrite, b.output, b.thinking);
    }
    db.prepare(`
      INSERT INTO conversations (conv_id, app_source, transcript_path, title, workspace_uri, mtime_ms, file_size, byte_offset, last_step_index, month_key, archived, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conv_id) DO UPDATE SET
        app_source = COALESCE(NULLIF(excluded.app_source, ''), app_source),
        transcript_path = excluded.transcript_path,
        title = COALESCE(NULLIF(excluded.title, ''), title),
        workspace_uri = COALESCE(NULLIF(excluded.workspace_uri, ''), workspace_uri),
        mtime_ms = excluded.mtime_ms,
        file_size = excluded.file_size,
        byte_offset = excluded.byte_offset,
        last_step_index = excluded.last_step_index,
        month_key = COALESCE(NULLIF(excluded.month_key, ''), month_key),
        archived = CASE WHEN excluded.archived = 1 THEN 1 ELSE archived END,
        updated_at_ms = excluded.updated_at_ms
    `).run(
      convId,
      appSource,
      transcriptPath,
      title,
      workspaceUri,
      Math.round(st.mtimeMs),
      st.size,
      nextOffset,
      maxStep,
      latestMonth,
      isArchivedMonth ? 1 : 0,
      Date.now(),
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { scanned: true, addedCalls };
}

export function syncBrainIncremental(db, {
  env = process.env,
  onlyConvIds = null,
  workspaceByConv = null,
} = {}) {
  const brainDirs = findAllBrainDirs(env);
  let scannedFiles = 0;
  let totalAddedCalls = 0;

  for (const brainDir of brainDirs) {
    let convDirs = [];
    try {
      convDirs = readdirSync(brainDir);
    } catch {
      continue;
    }
    const appSource = dirname(brainDir).split(/[/\\]/).pop() || '';
    for (const convId of convDirs) {
      if (!ID_RE.test(convId)) continue;
      if (onlyConvIds && !onlyConvIds.has(convId)) continue;
      const tp = join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
      if (!existsSync(tp)) continue;
      const wsMeta = workspaceByConv?.get(convId);
      const res = scanTranscriptIncremental(db, {
        convId,
        transcriptPath: tp,
        appSource,
        workspaceUri: wsMeta?.workspaceUri || '',
        title: wsMeta?.title || '',
      });
      if (res.scanned) scannedFiles += 1;
      totalAddedCalls += res.addedCalls || 0;
    }
  }
  return { scannedFiles, totalAddedCalls };
}

function normalizeWs(uri) {
  return decodeURIComponent(String(uri || '').trim()).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function queryScopeRows(db, {
  scope = 'conversation',
  convId = '',
  workspaceUris = [],
  nowMs = Date.now(),
} = {}) {
  const cleanScope = ['conversation', 'project', '7d', '30d', 'all'].includes(scope) ? scope : 'conversation';
  let sql = `
    SELECT d.conv_id, d.date_key, d.month_key, d.model, d.calls,
           d.input_tokens, d.cache_read_tokens, d.cache_write_tokens,
           d.output_tokens, d.thinking_tokens
    FROM conv_daily d
    LEFT JOIN conversations c ON c.conv_id = d.conv_id
  `;
  const params = [];

  if (cleanScope === 'conversation') {
    if (!convId) return { rows: [], conversationsCount: 0, archivedMonthsUsed: [] };
    sql += ' WHERE d.conv_id = ?';
    params.push(convId);
  } else if (cleanScope === 'project') {
    const norms = new Set((workspaceUris || []).map(normalizeWs).filter(Boolean));
    const allRows = db.prepare(`${sql}`).all();
    const convRows = db.prepare('SELECT conv_id, workspace_uri FROM conversations').all();
    const matchedIds = new Set();
    for (const c of convRows) {
      const cNorm = normalizeWs(c.workspace_uri);
      if (cNorm && norms.has(cNorm)) matchedIds.add(c.conv_id);
    }
    if (convId) matchedIds.add(convId);
    const filtered = allRows.filter((r) => matchedIds.has(r.conv_id));
    return mapRowsAndSummary(filtered, []);
  } else if (cleanScope === '7d' || cleanScope === '30d') {
    const days = cleanScope === '7d' ? 7 : 30;
    const cutoff = toLocalDateKey(new Date(nowMs - (days - 1) * 86_400_000).toISOString());
    sql += ' WHERE d.date_key >= ?';
    params.push(cutoff);
  }

  const rows = db.prepare(sql).all(...params);
  const archivedRows =
    cleanScope === 'all' || cleanScope === '30d'
      ? db.prepare('SELECT month_key, exported_at, frozen_json FROM archived_months ORDER BY month_key DESC').all()
      : [];

  // Merge any imported standalone monthly archives whose month isn't already represented in conv_daily
  const activeMonthsInDb = new Set(rows.map((r) => r.month_key));
  const extraRows = [];
  const archivedMonthsUsed = [];
  for (const am of archivedRows) {
    archivedMonthsUsed.push({ monthKey: am.month_key, exportedAt: am.exported_at });
    if (activeMonthsInDb.has(am.month_key)) continue;
    try {
      const parsed = JSON.parse(am.frozen_json);
      if (Array.isArray(parsed?.rows)) {
        for (const r of parsed.rows) extraRows.push(r);
      }
    } catch {
      // ignore corrupt archive json
    }
  }

  return mapRowsAndSummary([...rows, ...extraRows], archivedMonthsUsed);
}

function mapRowsAndSummary(rawRows, archivedMonthsUsed) {
  const convSet = new Set();
  const rows = rawRows.map((r) => {
    if (r.conv_id || r.convId) convSet.add(r.conv_id || r.convId);
    return {
      convId: r.conv_id || r.convId || '',
      dateKey: r.date_key || r.dateKey || '',
      monthKey: r.month_key || r.monthKey || '',
      model: r.model || 'unknown',
      calls: toInt(r.calls),
      inputTokens: toInt(r.input_tokens ?? r.inputTokens),
      cacheReadTokens: toInt(r.cache_read_tokens ?? r.cacheReadTokens),
      cacheWriteTokens: toInt(r.cache_write_tokens ?? r.cacheWriteTokens),
      outputTokens: toInt(r.output_tokens ?? r.outputTokens),
      thinkingTokens: toInt(r.thinking_tokens ?? r.thinkingTokens),
    };
  });
  return { rows, conversationsCount: convSet.size, archivedMonthsUsed };
}

export function listMonthsInDb(db) {
  const live = db.prepare(`
    SELECT month_key, COUNT(DISTINCT conv_id) AS chats, SUM(calls) AS calls,
           SUM(input_tokens + cache_read_tokens + output_tokens) AS total_tokens
    FROM conv_daily
    GROUP BY month_key
    ORDER BY month_key DESC
  `).all();
  const frozen = new Set(
    db.prepare('SELECT month_key FROM archived_months').all().map((r) => r.month_key),
  );
  return live.map((r) => ({
    monthKey: r.month_key,
    chats: toInt(r.chats),
    calls: toInt(r.calls),
    totalTokens: toInt(r.total_tokens),
    archived: frozen.has(r.month_key),
  }));
}

export function exportMonthArchive(db, monthKey, { freeze = true, nowIso = new Date().toISOString() } = {}) {
  if (!/^\d{4}-\d{2}$/.test(String(monthKey || ''))) {
    throw new Error('Invalid monthKey (expected YYYY-MM)');
  }
  const rows = db.prepare(`
    SELECT conv_id, date_key, month_key, model, calls,
           input_tokens, cache_read_tokens, cache_write_tokens,
           output_tokens, thinking_tokens
    FROM conv_daily
    WHERE month_key = ?
    ORDER BY date_key ASC
  `).all(monthKey);

  const bundle = {
    version: 1,
    monthKey,
    exportedAt: nowIso,
    rows,
  };

  if (freeze) {
    db.exec('BEGIN');
    try {
      db.prepare(`
        INSERT INTO archived_months (month_key, exported_at, frozen_json)
        VALUES (?, ?, ?)
        ON CONFLICT(month_key) DO UPDATE SET exported_at = excluded.exported_at, frozen_json = excluded.frozen_json
      `).run(monthKey, nowIso, JSON.stringify(bundle));
      // Freeze conversations that have NO activity outside this month and are older than this month
      db.prepare(`
        UPDATE conversations SET archived = 1
        WHERE conv_id IN (
          SELECT conv_id FROM conv_daily GROUP BY conv_id HAVING MAX(month_key) <= ?
        )
      `).run(monthKey);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return bundle;
}

export function importMonthArchive(db, bundle) {
  if (!bundle || typeof bundle !== 'object' || !/^\d{4}-\d{2}$/.test(String(bundle.monthKey || '')) || !Array.isArray(bundle.rows)) {
    throw new Error('Invalid archive bundle');
  }
  const nowIso = bundle.exportedAt || new Date().toISOString();
  db.prepare(`
    INSERT INTO archived_months (month_key, exported_at, frozen_json)
    VALUES (?, ?, ?)
    ON CONFLICT(month_key) DO UPDATE SET exported_at = excluded.exported_at, frozen_json = excluded.frozen_json
  `).run(bundle.monthKey, nowIso, JSON.stringify(bundle));
  return { monthKey: bundle.monthKey, rowsCount: bundle.rows.length };
}

export function recordQuotaSamplesAndComputeRunway(db, pools, nowMs = Date.now()) {
  const WINDOW_MS = 45 * 60 * 1000;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO quota_samples (pool_key, ts_ms, remaining_fraction, reset_at_ms)
    VALUES (?, ?, ?, ?)
  `);
  const pruneBefore = nowMs - 2 * 60 * 60 * 1000;
  db.prepare('DELETE FROM quota_samples WHERE ts_ms < ?').run(pruneBefore);

  return (pools || []).map((p) => {
    const win = p.fiveHour || p.weekly;
    if (!win || typeof win.remainingPct !== 'number') return p;
    const remFrac = Math.max(0, Math.min(1, win.remainingPct / 100));
    const resetMs = win.resetTime ? Date.parse(win.resetTime) : null;
    insert.run(p.pool, nowMs, remFrac, Number.isFinite(resetMs) ? resetMs : null);

    const rows = db.prepare(
      'SELECT ts_ms, remaining_fraction, reset_at_ms FROM quota_samples WHERE pool_key = ? AND ts_ms >= ? ORDER BY ts_ms ASC',
    ).all(p.pool, nowMs - WINDOW_MS);

    let runway = { status: 'insufficient_data', burnRatePctPerHour: null, estExhaustMin: null };
    if (remFrac <= 0) {
      runway = { status: 'exhausted', burnRatePctPerHour: null, estExhaustMin: 0 };
    } else if (rows.length >= 2) {
      // Find earliest sample in same reset cycle without recovery jump
      let first = rows[0];
      for (let i = 1; i < rows.length; i++) {
        if (rows[i].remaining_fraction - rows[i - 1].remaining_fraction >= 0.05) {
          first = rows[i];
        }
      }
      const spanMs = nowMs - first.ts_ms;
      const drop = first.remaining_fraction - remFrac;
      if (spanMs >= 10_000 && drop > 0.001) {
        const ratePerHour = (drop * 100) / (spanMs / 3_600_000);
        const estExhaustMs = (remFrac * 100 / ratePerHour) * 3_600_000;
        const timeToResetMs = Number.isFinite(resetMs) && resetMs > nowMs ? resetMs - nowMs : null;
        if (timeToResetMs !== null && estExhaustMs >= timeToResetMs) {
          runway = {
            status: 'safe_until_reset',
            burnRatePctPerHour: Number(ratePerHour.toFixed(1)),
            estExhaustMin: null,
          };
        } else {
          runway = {
            status: 'at_risk',
            burnRatePctPerHour: Number(ratePerHour.toFixed(1)),
            estExhaustMin: Math.max(1, Math.round(estExhaustMs / 60_000)),
          };
        }
      }
    }
    return { ...p, runway };
  });
}

export function getCustomPricingMap(db) {
  const rows = db.prepare('SELECT * FROM custom_pricing').all();
  const out = {};
  for (const r of rows) {
    out[r.model_key] = {
      label: r.label,
      input: r.input,
      output: r.output,
      cacheRead: r.cache_read,
      cacheWrite: r.cache_write,
    };
  }
  return out;
}

export function saveCustomPricingEntry(db, { modelKey, label = '', input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }) {
  db.prepare(`
    INSERT INTO custom_pricing (model_key, label, input, output, cache_read, cache_write)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(model_key) DO UPDATE SET
      label = COALESCE(NULLIF(excluded.label, ''), label),
      input = excluded.input,
      output = excluded.output,
      cache_read = excluded.cache_read,
      cache_write = excluded.cache_write
  `).run(modelKey, label, Number(input) || 0, Number(output) || 0, Number(cacheRead) || 0, Number(cacheWrite) || 0);
}

export function deleteCustomPricingEntry(db, modelKey) {
  if (!modelKey) {
    db.prepare('DELETE FROM custom_pricing').run();
  } else {
    db.prepare('DELETE FROM custom_pricing WHERE model_key = ?').run(modelKey);
  }
}
