import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  normalizeModelKey,
  resolveModelPricing,
  calculateScopeCosts,
  getCatalogPricingList,
} from '../pricing.mjs';
import { computeContextBreakdown } from '../breakdown.mjs';
import { extractAICredits } from '../quotas.mjs';
import {
  openContextDb,
  scanTranscriptIncremental,
  queryScopeRows,
  listMonthsInDb,
  exportMonthArchive,
  importMonthArchive,
  recordQuotaSamplesAndComputeRunway,
  saveCustomPricingEntry,
  getCustomPricingMap,
  deleteCustomPricingEntry,
} from '../db.mjs';

test('pricing normalizes placeholders, calculates scope totals, and honors overrides', () => {
  assert.equal(normalizeModelKey('MODEL_PLACEHOLDER_M530'), 'gemini-4-hydrogen');
  assert.equal(normalizeModelKey('deepseek-ai/deepseek-v4.1-flash'), 'deepseek-v4.1-flash');
  assert.equal(normalizeModelKey('claude-opus-5-5-high'), 'claude-opus-5-5');

  const beforeDec = resolveModelPricing('gemini-4-carbon', {}, '2026-11-27');
  const afterDec = resolveModelPricing('gemini-4-carbon', {}, '2026-12-05');
  assert.equal(beforeDec.input, 2.0);
  assert.equal(afterDec.input, 4.0);

  const custom = { 'gemini-4-hydrogen': { label: 'Hydrogen Custom', input: 1.0, output: 5.0, cacheRead: 0.05 } };
  const cost = calculateScopeCosts([
    {
      model: 'gemini-4-hydrogen',
      dateKey: '2026-11-27',
      calls: 2,
      inputTokens: 1_000_000,
      cacheReadTokens: 2_000_000,
      cacheWriteTokens: 0,
      outputTokens: 500_000,
    },
    {
      model: 'unknown-custom-model',
      dateKey: '2026-11-27',
      calls: 1,
      inputTokens: 10_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000,
    },
  ], custom);

  assert.equal(cost.totals.calls, 3);
  assert.ok(Math.abs(cost.totals.inputCost - 1.0) < 1e-6);
  assert.ok(Math.abs(cost.totals.cacheCost - 0.1) < 1e-6);
  assert.ok(Math.abs(cost.totals.outputCost - 2.5) < 1e-6);
  assert.ok(Math.abs(cost.totals.cacheSavedUsd - 1.9) < 1e-6);
  assert.equal(cost.totals.unpricedTokens, 11_000);
  assert.equal(getCatalogPricingList(custom).some((c) => c.isCustom && c.modelKey === 'gemini-4-hydrogen'), true);
});

test('breakdown maps promptSections into 9 categories and falls back to steps estimation', () => {
  const exact = computeContextBreakdown({
    generatorMetadata: [
      {
        chatModel: {
          promptSections: [
            { title: 'System Instructions', tokenType: 'SYSTEM_PROMPT', numTokens: 4000 },
            { title: 'Rules & SKILL.md', numTokens: 12000 },
            { title: 'MCP Server: infigraph', numTokens: 3000 },
            { title: 'Subagent worker brief', numTokens: 2000 },
            { title: 'Assistant response & thinking', numTokens: 6000 },
            { title: 'read_file src/app.ts', numTokens: 25000 },
          ],
        },
      },
    ],
    usedTokens: 60000,
    limitTokens: 512000,
  });

  assert.equal(exact.source, 'prompt_sections');
  assert.equal(exact.largestItems.length, 5);
  assert.equal(exact.largestItems[0].title, 'read_file src/app.ts');
  assert.equal(exact.segments.some((s) => s.key === 'other' && s.tokens === 8000), true);

  const estimated = computeContextBreakdown({
    steps: [
      { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { items: [{ text: 'Fix SQLite incremental scanner' }] } },
      { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: 'Scanning files now', thinking: 'Checking byte offsets' } },
      { type: 'CORTEX_STEP_TYPE_RUN_COMMAND', runCommand: { command: 'node --test', combinedOutput: { full: 'all tests passed' } } },
    ],
    usedTokens: 10000,
    limitTokens: 512000,
  });
  assert.equal(estimated.source, 'steps_estimated');
  assert.ok(estimated.segments.length >= 2);
});

test('extractAICredits parses numeric and string credits safely', () => {
  const credits = extractAICredits({
    userStatus: {
      userTier: {
        availableCredits: [
          { creditType: 'CREDIT_TYPE_PROMPT_CREDITS', creditAmount: '1250' },
          { creditType: 'CREDIT_TYPE_FLOW_CREDITS', creditAmount: 42 },
          { creditType: 'INVALID', creditAmount: 'NaN' },
        ],
      },
    },
  });
  assert.deepEqual(credits, [
    { creditType: 'PROMPT_CREDITS', amount: 1250 },
    { creditType: 'FLOW_CREDITS', amount: 42 },
  ]);
});

test('db incremental scanning, scope queries, monthly freeze/archive import, quota runway, and custom pricing', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-db-test-'));
  const dbPath = join(dir, 'context.db');
  const db = openContextDb(dbPath);
  t.after(() => {
    try { db.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  });

  const convA = '11111111-1111-4111-8111-111111111111';
  const convB = '22222222-2222-4222-8222-222222222222';
  const tpA = join(dir, 'a.jsonl');
  const tpB = join(dir, 'b.jsonl');

  const now = new Date();
  const todayIso = now.toISOString();
  const thisMonth = todayIso.slice(0, 7);
  const oldDateIso = '2026-09-15T10:00:00Z';

  writeFileSync(
    tpA,
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      step_index: 1,
      created_at: todayIso,
      model: 'gemini-4-hydrogen',
      input_tokens: 1000,
      cache_read_tokens: 4000,
      output_tokens: 200,
    }) + '\n',
    'utf8',
  );
  writeFileSync(
    tpB,
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      step_index: 1,
      created_at: oldDateIso,
      model: 'claude-opus-5-5',
      input_tokens: 500,
      cache_read_tokens: 1000,
      output_tokens: 100,
    }) + '\n',
    'utf8',
  );

  // Initial incremental scan + metadata update on cached file
  const r1 = scanTranscriptIncremental(db, {
    convId: convA,
    transcriptPath: tpA,
    workspaceUri: 'file:///C:/Repo/App',
    title: 'Initial Title',
  });
  assert.equal(r1.scanned, true);
  assert.equal(r1.addedCalls, 1);

  const r1Cached = scanTranscriptIncremental(db, {
    convId: convA,
    transcriptPath: tpA,
    workspaceUri: 'file:///C:/Repo/App2',
    title: 'Updated Title',
  });
  assert.equal(r1Cached.scanned, false);
  assert.equal(r1Cached.cached, true);

  // Append a second response -> scans ONLY the appended slice
  appendFileSync(
    tpA,
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      step_index: 2,
      created_at: todayIso,
      model: 'gemini-4-hydrogen',
      input_tokens: 500,
      cache_read_tokens: 2000,
      output_tokens: 150,
    }) + '\n',
    'utf8',
  );
  const r2 = scanTranscriptIncremental(db, { convId: convA, transcriptPath: tpA });
  assert.equal(r2.scanned, true);
  assert.equal(r2.addedCalls, 1);

  scanTranscriptIncremental(db, {
    convId: convB,
    transcriptPath: tpB,
    workspaceUri: 'file:///D:/Other',
    title: 'Old Sept Session',
  });

  // Scope queries
  const convScope = queryScopeRows(db, { scope: 'conversation', convId: convA });
  assert.equal(convScope.rows[0].calls, 2);
  assert.equal(convScope.rows[0].inputTokens, 1500);

  const projScope = queryScopeRows(db, {
    scope: 'project',
    convId: convA,
    workspaceUris: ['c:\\repo\\app2'],
  });
  assert.equal(projScope.conversationsCount, 1);

  const d7Scope = queryScopeRows(db, { scope: '7d', nowMs: now.getTime() });
  assert.equal(d7Scope.conversationsCount, 1);

  const allScope = queryScopeRows(db, { scope: 'all', nowMs: now.getTime() });
  assert.equal(allScope.conversationsCount, 2);

  // Freeze September 2026 -> convB marked archived -> subsequent scans skip convB
  const months = listMonthsInDb(db);
  assert.equal(months.some((m) => m.monthKey === '2026-09'), true);
  assert.equal(months.some((m) => m.monthKey === thisMonth), true);

  const bundle = exportMonthArchive(db, '2026-09', { freeze: true });
  assert.equal(bundle.rows.length, 1);

  appendFileSync(
    tpB,
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      step_index: 2,
      created_at: oldDateIso,
      model: 'claude-opus-5-5',
      input_tokens: 999,
      cache_read_tokens: 0,
      output_tokens: 99,
    }) + '\n',
    'utf8',
  );
  const frozenScan = scanTranscriptIncremental(db, { convId: convB, transcriptPath: tpB });
  assert.equal(frozenScan.skippedArchived, true);

  // Import standalone archive month from earlier year
  const imported = importMonthArchive(db, {
    version: 1,
    monthKey: '2026-06',
    exportedAt: '2026-07-01T00:00:00Z',
    rows: [
      {
        conv_id: '33333333-3333-4333-8333-333333333333',
        date_key: '2026-06-10',
        month_key: '2026-06',
        model: 'gemini-3-flash',
        calls: 5,
        input_tokens: 10000,
        cache_read_tokens: 40000,
        cache_write_tokens: 0,
        output_tokens: 2000,
      },
    ],
  });
  assert.equal(imported.monthKey, '2026-06');
  const allWithImported = queryScopeRows(db, { scope: 'all' });
  assert.equal(allWithImported.rows.some((r) => r.monthKey === '2026-06'), true);

  // Quota runway tracking: safe_until_reset vs at_risk
  const t0 = Date.parse('2026-11-27T10:00:00Z');
  const resetIso = '2026-11-27T11:00:00Z';
  recordQuotaSamplesAndComputeRunway(db, [
    { pool: 'gemini', label: 'Gemini', fiveHour: { remainingPct: 80, resetTime: resetIso } },
  ], t0);
  const pSafe = recordQuotaSamplesAndComputeRunway(db, [
    { pool: 'gemini', label: 'Gemini', fiveHour: { remainingPct: 60, resetTime: resetIso } },
  ], t0 + 20 * 60_000);
  assert.equal(pSafe[0].runway.status, 'safe_until_reset');
  assert.equal(pSafe[0].runway.burnRatePctPerHour, 60);

  const pRisk = recordQuotaSamplesAndComputeRunway(db, [
    { pool: 'gemini', label: 'Gemini', fiveHour: { remainingPct: 15, resetTime: resetIso } },
  ], t0 + 30 * 60_000);
  assert.equal(pRisk[0].runway.status, 'at_risk');
  assert.ok(pRisk[0].runway.estExhaustMin > 0);

  // Custom pricing CRUD
  saveCustomPricingEntry(db, { modelKey: 'my-local-model', label: 'Local', input: 0.25, output: 1.0, cacheRead: 0.02 });
  assert.equal(getCustomPricingMap(db)['my-local-model'].input, 0.25);
  deleteCustomPricingEntry(db, 'my-local-model');
  assert.equal(getCustomPricingMap(db)['my-local-model'], undefined);
});
