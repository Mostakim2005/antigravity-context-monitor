import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  normalizeModelKey,
  resolveModelPricing,
  calculateScopeCosts,
  getCatalogPricingList,
} from '../pricing.mjs';
import { computeContextBreakdown } from '../breakdown.mjs';
import { extractAICredits } from '../quotas.mjs';
import { parseTranscriptText, enrichSummaryWithSpeed } from '../lib.mjs';
import { extractActiveAccountSnapshot, readLegacyMonitorSeed, extractPerModelQuotas } from '../accounts.mjs';
import {
  deduplicateApiErrorText,
  parseAntigravityUserConfig,
  readLocalOrchestratorConfig,
  analyzeActiveDiagnostics,
} from '../diagnostics.mjs';
import {
  openContextDb,
  scanTranscriptIncremental,
  queryScopeRows,
  buildProjectAndChatBreakdowns,
  listMonthsInDb,
  exportMonthArchive,
  importMonthArchive,
  recordQuotaSamplesAndComputeRunway,
  saveCustomPricingEntry,
  getCustomPricingMap,
  deleteCustomPricingEntry,
  seedAccountsFromLegacyOnce,
  backfillLegacyAccountModelsOnce,
  upsertActiveAccountSnapshot,
  listAccountSnapshots,
  removeAccountSnapshot,
  getCostPrefs,
  saveCostPrefs,
  resolveUiPrefsPath,
  getUiPrefs,
  saveUiPrefs,
  queryHeatmapSql,
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

  // Zero-token promptSections must fall through cleanly to steps / usage_fallback
  const zeroSectionsWithSteps = computeContextBreakdown({
    generatorMetadata: [
      { chatModel: { promptSections: [{ title: 'System', tokenType: 'SYSTEM_PROMPT', numTokens: 0 }] } },
    ],
    steps: [
      { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { items: [{ text: 'Explain layout bug' }] } },
      { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: 'Root cause found' } },
    ],
    usedTokens: 285000,
    limitTokens: 512000,
  });
  assert.equal(zeroSectionsWithSteps.source, 'steps_estimated');
  assert.ok(zeroSectionsWithSteps.segments.length >= 2);

  const usageFallbackOnly = computeContextBreakdown({
    generatorMetadata: [],
    steps: [],
    usedTokens: 50000,
    limitTokens: 512000,
  });
  assert.equal(usageFallbackOnly.source, 'usage_fallback');
  assert.equal(usageFallbackOnly.segments[0].tokens, 50000);
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

test('multi-account extractor, legacy seed once, post-cutoff live token attribution, and remove behavior', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-acct-test-'));
  const db = openContextDb(join(dir, 'accts.db'));
  t.after(() => {
    try { db.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  });

  // Extract live account snapshot from GetUserStatus shape
  const rawStatus = {
    userStatus: {
      name: 'Parvin Akter',
      email: 'parvin@example.com',
      planStatus: { planInfo: { planName: 'Pro' } },
      userTier: {
        name: 'Google AI Pro',
        availableCredits: [{ creditType: 'CREDIT_TYPE_PROMPT_CREDITS', creditAmount: '900' }],
      },
      cascadeModelConfigData: {
        clientModelConfigs: [
          { label: 'Gemini 4 Hydrogen (High)', quotaInfo: { remainingFraction: 0.72, resetTime: '2026-11-28T00:00:00Z' } },
          { label: 'Claude Opus 4.6', quotaInfo: { remainingFraction: 1.0, resetTime: '1970-01-01T00:00:00Z' } },
        ],
      },
    },
  };
  const snap = extractActiveAccountSnapshot(rawStatus, Date.parse('2026-11-27T12:00:00Z'));
  assert.equal(snap.email, 'parvin@example.com');
  assert.equal(snap.resetPools.length, 2);
  assert.equal(snap.credits[0].amount, 900);

  // Seed legacy state-v1.json once (active + settled ledger + cached account)
  const legacyPath = join(dir, 'state-v1.json');
  writeFileSync(legacyPath, JSON.stringify({
    global: {
      accountSnapshots: [
        { email: 'parvin@example.com', name: 'Parvin Akter', tierName: 'Google AI Pro', isActive: true },
        { email: 'mostakim@example.com', name: 'Mostakim Kazi', tierName: 'Google AI Pro', isActive: false },
      ],
      dailyLedgerState: {
        accounts: {
          'parvin@example.com': { totalCalls: 10, totalInputTokens: 1000, totalCacheRead: 9000, totalOutputTokens: 500, totalEstimatedCost: 0.25 },
        },
        settled: [
          { accountEmail: 'mostakim@example.com', totalCalls: 50, totalInputTokens: 5000, totalCacheRead: 40000, totalOutputTokens: 2000, totalEstimatedCost: 1.2 },
        ],
      },
    },
  }));

  const legacy = readLegacyMonitorSeed(legacyPath);
  const tCutoff = Date.parse('2026-11-27T12:00:00Z');
  assert.equal(seedAccountsFromLegacyOnce(db, legacy, tCutoff), true);
  assert.equal(seedAccountsFromLegacyOnce(db, legacy, tCutoff + 5000), false); // never imports twice

  upsertActiveAccountSnapshot(db, snap, tCutoff);

  // Pre-cutoff call MUST NOT double-count against legacy seed; post-cutoff call MUST increment live tokens
  const tp = join(dir, 'chat.jsonl');
  writeFileSync(tp, [
    JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 1, created_at: '2026-11-27T11:55:00Z', model: 'gemini-4-hydrogen', input_tokens: 500, cache_read_tokens: 1000, output_tokens: 50 }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 2, created_at: '2026-11-27T12:05:00Z', model: 'gemini-4-hydrogen', input_tokens: 200, cache_read_tokens: 800, output_tokens: 100 }),
  ].join('\n') + '\n');

  scanTranscriptIncremental(db, {
    convId: '44444444-4444-4444-8444-444444444444',
    transcriptPath: tp,
    activeAccountEmail: 'parvin@example.com',
  });

  const list = listAccountSnapshots(db);
  assert.equal(list.accounts.length, 2);
  const parvin = list.accounts.find((a) => a.email === 'parvin@example.com');
  const mostakim = list.accounts.find((a) => a.email === 'mostakim@example.com');
  assert.equal(parvin.isActive, true);
  // 10,500 seed + 1,100 post-cutoff live (pre-cutoff 1,550 skipped) = 11,600
  assert.equal(parvin.usage.totalTokens, 11_600);
  assert.equal(parvin.usage.calls, 11);
  assert.equal(mostakim.usage.totalTokens, 47_000);
  assert.equal(list.summary.totalTokens, 58_600);

  // Cannot remove active account, CAN remove cached account
  assert.equal(removeAccountSnapshot(db, 'parvin@example.com'), false);
  assert.equal(removeAccountSnapshot(db, 'mostakim@example.com'), true);
  assert.equal(listAccountSnapshots(db).accounts.length, 1);
});

test('phase 3 pricing aliases, compactions, per-model quotas, project/chat breakdown, and heatmap analytics', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-phase3-'));
  const db = openContextDb(join(dir, 'context.db'));
  t.after(() => {
    try { db.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  // 1. M318 & orchestrator alias pricing resolution
  assert.equal(normalizeModelKey('MODEL_PLACEHOLDER_M318'), 'gemini-3.8-flash');
  assert.equal(normalizeModelKey('gemini-pro-orchestrator-neon'), 'gemini-4-neon');
  assert.equal(resolveModelPricing('MODEL_PLACEHOLDER_M318').input, 0.75);
  assert.equal(resolveModelPricing('gemini-pro-orchestrator-neon').output, 15.0);

  // 2. Transcript compaction drop detection (>= 25K) + native 1M limit
  const sampleLog = [
    JSON.stringify({ type: 'USER_INPUT', step_index: 1, content: 'start' }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 2, input_tokens: 10_000, cache_read_tokens: 190_000, output_tokens: 500 }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 3, input_tokens: 12_000, cache_read_tokens: 60_000, output_tokens: 400 }),
  ].join('\n');
  const parsed = parseTranscriptText(sampleLog);
  assert.equal(parsed.compactions.length, 1);
  assert.equal(parsed.compactions[0].beforeTokens, 200_000);
  assert.equal(parsed.compactions[0].afterTokens, 72_000);
  assert.equal(parsed.compactions[0].savedTokens, 128_000);

  const enriched = enrichSummaryWithSpeed(
    parsed,
    new Map([[3, { model: 'gemini-4-hydrogen', maxContextTokens: 512_000 }]]),
  );
  assert.equal(enriched.nativeLimitTokens, 1_048_576);

  // 3. Dedicated per-model quotas (5h from clientModelConfigs + 7d from summary)
  const perModel = extractPerModelQuotas(
    {
      userStatus: {
        cascadeModelConfigData: {
          clientModelConfigs: [
            { label: 'Gemini 4 Hydrogen (High)', modelOrAlias: { model: 'gemini-4-hydrogen' }, quotaInfo: { remainingFraction: 0.68, resetTime: '2026-11-27T16:00:00Z' } },
            { label: 'Claude Opus 4.6', modelId: 'claude-opus-4-6', quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-27T17:00:00Z' } },
          ],
        },
      },
    },
    {
      pools: [
        { pool: 'gemini', weekly: { remainingPct: 82, resetTime: '2026-12-03T00:00:00Z', resetCountdown: '5d 12h' } },
        { pool: 'premium', weekly: { remainingPct: 95, resetTime: '2026-12-03T00:00:00Z', resetCountdown: '5d 12h' } },
      ],
    },
    Date.parse('2026-11-27T12:00:00Z'),
  );
  assert.equal(perModel.length, 2);
  assert.equal(perModel[0].fiveHour.remainingPct, 68);
  assert.equal(perModel[0].weekly.remainingPct, 82);
  assert.equal(perModel[1].family, 'premium');
  assert.equal(perModel[1].weekly.remainingPct, 95);

  // 4. SQLite Cost Prefs (Currency FX & Monthly Plan Fee)
  assert.deepEqual(getCostPrefs(db), { currency: 'USD', fxRate: 1, monthlyFee: 0 });
  const savedPrefs = saveCostPrefs(db, { currency: 'bdt', fxRate: 120, monthlyFee: 20 });
  assert.deepEqual(savedPrefs, { currency: 'BDT', fxRate: 120, monthlyFee: 20 });
  assert.deepEqual(getCostPrefs(db), { currency: 'BDT', fxRate: 120, monthlyFee: 20 });

  // 5. Project & Chat Breakdowns + Heatmap SQL Analytics (App vs CLI + Streaks)
  const nowMs = Date.parse('2026-11-27T12:00:00Z');
  const day1 = new Date(nowMs - 86_400_000).toISOString();
  const day2 = new Date(nowMs).toISOString();
  const tpApp = join(dir, 'app.jsonl');
  const tpCli = join(dir, 'cli.jsonl');
  writeFileSync(
    tpApp,
    JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 1, created_at: day1, model: 'gemini-4-hydrogen', input_tokens: 1_000_000, cache_read_tokens: 0, output_tokens: 100_000 }) + '\n',
  );
  writeFileSync(
    tpCli,
    JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 1, created_at: day2, model: 'claude-opus-4-6', input_tokens: 500_000, cache_read_tokens: 0, output_tokens: 50_000 }) + '\n',
  );
  scanTranscriptIncremental(db, {
    convId: 'conv-app-1',
    transcriptPath: tpApp,
    title: 'App Chat',
    workspaceUri: 'file:///C:/Projects/Alpha',
    appSource: 'antigravity',
  });
  scanTranscriptIncremental(db, {
    convId: 'conv-cli-1',
    transcriptPath: tpCli,
    title: 'CLI Chat',
    workspaceUri: 'file:///C:/Projects/Beta',
    appSource: 'agy',
  });

  const allScope = queryScopeRows(db, { scope: 'all', nowMs });
  const { byProject, byChat } = buildProjectAndChatBreakdowns(allScope.rows, {});
  assert.equal(byProject.length, 2);
  assert.equal(byChat.length, 2);
  assert.equal(byProject[0].chats.length, 1);

  const hmAll = queryHeatmapSql(db, { weeks: 16, sourceFilter: 'all', nowMs });
  const hmCli = queryHeatmapSql(db, { weeks: 16, sourceFilter: 'cli', nowMs });
  const hmApp = queryHeatmapSql(db, { weeks: 16, sourceFilter: 'app', nowMs });
  assert.equal(hmAll.streaks.current, 2);
  assert.equal(hmAll.streaks.longest, 2);
  assert.equal(hmAll.periods.all.calls, 2);
  assert.equal(hmCli.periods.all.calls, 1);
  assert.equal(hmApp.periods.all.calls, 1);
  assert.ok(hmAll.periods.year.cost > 0);

  // 6. Legacy per-account model seed backfill without double-counting totals
  const acctTp = join(dir, 'acct-legacy.json');
  writeFileSync(
    acctTp,
    JSON.stringify({
      global: {
        accountSnapshots: [
          { email: 'user@example.com', name: 'User One', tierName: 'Google AI Pro', isActive: true },
        ],
        dailyLedgerState: {
          accounts: {
            'user@example.com': {
              totalCalls: 10,
              totalInputTokens: 1000,
              totalCacheRead: 2000,
              totalOutputTokens: 300,
              totalEstimatedCost: 0.5,
              modelStats: {
                'gemini-4-hydrogen': { calls: 6, inputTokens: 600, cacheReadTokens: 1200, outputTokens: 200 },
                'claude-opus-4-6': { calls: 4, inputTokens: 400, cacheReadTokens: 800, outputTokens: 100 },
              },
            },
          },
        },
      },
    }),
  );
  const legacySeed = readLegacyMonitorSeed(acctTp);
  assert.equal(legacySeed.accounts[0].seed.models.length, 2);
  assert.equal(seedAccountsFromLegacyOnce(db, legacySeed, nowMs), true);
  // Fresh seed already records legacy_account_models_seeded_v1 so backfill is a no-op
  assert.equal(backfillLegacyAccountModelsOnce(db, legacySeed), false);

  // Simulate Phase 2 DB upgrade (only seed_* columns populated, no account_daily 'seed' rows yet)
  db.exec(`
    DELETE FROM kv WHERE k = 'legacy_account_models_seeded_v1';
    DELETE FROM account_daily WHERE email = 'user@example.com' AND date_key = 'seed';
    UPDATE accounts SET seed_calls = 10, seed_input_tokens = 1000, seed_cache_read_tokens = 2000, seed_output_tokens = 300, seed_cost_usd = 0.5 WHERE email = 'user@example.com';
  `);
  assert.equal(backfillLegacyAccountModelsOnce(db, legacySeed), true);
  assert.equal(backfillLegacyAccountModelsOnce(db, legacySeed), false);

  const acctList = listAccountSnapshots(db);
  assert.equal(acctList.accounts[0].usage.totalTokens, 3300);
  assert.equal(acctList.accounts[0].byModel.length, 2);
  assert.equal(acctList.summary.totalTokens, 3300);
});

test('phase 4 active-chat orchestrator split, retry/error waste, model dna, config reader, and byok isolation', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-phase4-'));
  const db = openContextDb(join(dir, 'context.db'));
  t.after(() => {
    try { db.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  // 1. Doubled error cleanup & config.json orchestrator reader
  assert.equal(deduplicateApiErrorText('UNAVAILABLE: UNAVAILABLE'), 'UNAVAILABLE');
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({
    userSettings: {
      orchestratorModel: 'MODEL_PLACEHOLDER_M537',
      orchestratorExecutorModel: 'MODEL_PLACEHOLDER_M669',
      useAiCredits: true,
    },
  }));
  const localCfg = readLocalOrchestratorConfig({ configPath: cfgPath });
  assert.equal(localCfg.orchestratorModel, 'MODEL_PLACEHOLDER_M537');
  assert.equal(localCfg.orchestratorExecutorModel, 'MODEL_PLACEHOLDER_M669');
  assert.equal(localCfg.useAiCredits, true);
  assert.equal(parseAntigravityUserConfig({}), null);

  // 2. Multi-model Orchestrator <-> Executor cold-cache switch + Retry waste + Model DNA
  const genMeta = [
    {
      stepIndices: [1],
      plannerConfig: { planExecuteConfig: { executionModel: 'MODEL_PLACEHOLDER_M530' } },
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M537',
        responseModel: 'gemini-4-neon',
        modelDisplayName: 'Gemini 4 Neon',
        systemPrompt: 'You are an expert coordinator.',
        tools: [{ name: 'read_file' }, { name: 'edit_file' }],
        promptSections: [{ title: 'System Prompt' }, { title: 'MCP Tools' }],
        completionConfig: { maxTokens: '8192', temperature: 0.4, topP: 0.95, topK: 40, stopPatterns: ['END'] },
        retries: 2,
        retryInfos: [
          { error: 'UNAVAILABLE: UNAVAILABLE', usage: { inputTokens: '100000', outputTokens: '500' }, consumedCredits: [{ creditAmount: '5' }] },
          { usage: { inputTokens: '50000' } }, // successful attempt entry (no error) must not be counted as wasted retry
        ],
        usage: { inputTokens: '50000', cacheReadTokens: '10000', outputTokens: '1000', apiProvider: 'GOOGLE_VERTEX' },
      },
    },
    {
      stepIndices: [2],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M669',
        responseModel: 'gemini-4-hydrogen',
        modelDisplayName: 'Gemini 4 Hydrogen',
        completionConfig: { maxTokens: 4096, temperature: 0.2 },
        promptSections: [{ title: 'System Prompt' }],
        usage: { inputTokens: '40000', cacheReadTokens: '0', outputTokens: '2000', apiProvider: 'GOOGLE_VERTEX' },
      },
    },
    {
      stepIndices: [3],
      error: 'RESOURCE_EXHAUSTED: RESOURCE_EXHAUSTED',
      chatModel: {
        model: 'custom/local-coder',
        modelDisplayName: 'Local Coder (BYOK)',
        usage: { inputTokens: '2000', cacheReadTokens: '0', outputTokens: '100' },
      },
    },
  ];

  const diag = analyzeActiveDiagnostics({ generatorMetadata: genMeta, localConfig: localCfg });
  assert.equal(diag.available, true);
  assert.equal(diag.orchestrator.active, true);
  assert.equal(diag.orchestrator.roles.orchestrator.calls, 1);
  assert.equal(diag.orchestrator.roles.executor.calls, 1);
  assert.equal(diag.orchestrator.roles.direct.calls, 1);
  assert.equal(diag.orchestrator.roleSwitchCount, 1);
  assert.equal(diag.orchestrator.coldCacheSwitchCount, 1);
  assert.equal(diag.orchestrator.coldSwitchFreshInputTokens, 40_000);
  assert.ok(diag.orchestrator.configuredPair);

  assert.equal(diag.retries.totalFailedRetries, 1);
  assert.equal(diag.retries.callsWithRetries, 2);
  assert.equal(diag.retries.failedCallsCount, 1);
  assert.equal(diag.retries.wastedTotalTokens, 100_500);
  assert.equal(diag.retries.wastedCredits, 5);
  assert.ok(diag.retries.wastedCostUsd > 0);
  assert.equal(diag.retries.errorCodes.some((c) => c.code === 'UNAVAILABLE' && c.count === 1), true);
  assert.equal(diag.retries.errorCodes.some((c) => c.code === 'RESOURCE_EXHAUSTED' && c.count === 1), true);

  assert.equal(diag.modelDna.length, 3);
  const byokDna = diag.modelDna.find((m) => m.modelKey === 'custom/local-coder');
  assert.equal(byokDna.isCustomModel, true);
  const neonDna = diag.modelDna.find((m) => m.modelKey === 'gemini-4-neon');
  assert.equal(neonDna.apiProvider, 'GOOGLE_VERTEX');
  assert.equal(neonDna.completionConfig.temperature, 0.4);
  assert.equal(neonDna.toolCount, 2);

  // 3. Same-model orchestrator delegation detection
  const sameModelMeta = [
    {
      stepIndices: [1],
      plannerConfig: { planExecuteConfig: { executionModel: 'gemini-4-neon' } },
      chatModel: { model: 'gemini-4-neon', usage: { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 200 } },
    },
    {
      stepIndices: [2],
      chatModel: { model: 'gemini-4-neon', usage: { inputTokens: 2000, cacheReadTokens: 0, outputTokens: 300 } },
    },
  ];
  const sameDiag = analyzeActiveDiagnostics({ generatorMetadata: sameModelMeta });
  assert.equal(sameDiag.orchestrator.active, true);
  assert.equal(sameDiag.orchestrator.isSameModelOrchestrated, true);
  assert.equal(sameDiag.orchestrator.roles.orchestrator.calls, 1);
  assert.equal(sameDiag.orchestrator.roles.executor.calls, 1);
  assert.equal(sameDiag.orchestrator.coldCacheSwitchCount, 1);

  // 4. BYOK runway isolation inside SQLite quota tracker
  const isolated = recordQuotaSamplesAndComputeRunway(
    db,
    [{ pool: 'gemini', fiveHour: { remainingPct: 75, resetTime: '2026-11-27T18:00:00Z' } }],
    Date.parse('2026-11-27T14:00:00Z'),
    { isCustomModel: true },
  );
  assert.equal(isolated[0].runway.status, 'custom_model_isolated');
});

test('ui prefs persist in SQLite and durable JSON mirror across disable/enable and fresh DB reinstall', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-ui-prefs-'));
  const dbPath1 = join(dir, 'run1', 'context.db');
  const dbPath2 = join(dir, 'run2', 'context.db');
  const prefsPath = join(dir, 'user-config', 'ui-prefs.json');
  const db1 = openContextDb(dbPath1);
  let db1Reopened = null;
  let db2 = null;
  t.after(() => {
    try { db1.close(); } catch {}
    try { db1Reopened?.close(); } catch {}
    try { db2?.close(); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  // Path resolution covers override + Windows/macOS/Linux
  assert.equal(resolveUiPrefsPath({ ANTIGRAVITY_CONTEXT_MONITOR_PREFS_PATH: prefsPath }), prefsPath);
  assert.equal(
    resolveUiPrefsPath({ APPDATA: 'C:\\Users\\demo\\AppData\\Roaming' }, 'win32'),
    join('C:\\Users\\demo\\AppData\\Roaming', 'context-monitor', 'ui-prefs.json'),
  );
  assert.ok(resolveUiPrefsPath({ XDG_CONFIG_HOME: '/tmp/cfg' }, 'linux').endsWith(join('context-monitor', 'ui-prefs.json')));

  // Initial empty state
  const empty = getUiPrefs(db1, { prefsPath });
  assert.deepEqual(empty.sections, {});
  assert.equal(empty.lang, null);
  assert.equal(empty.activeTab, null);

  // Save section toggles + guard unsafe keys / non-boolean values
  const saved1 = saveUiPrefs(
    db1,
    {
      sections: { quotas: false, retries: false, heatmap: false, bad: 'nope' },
      ['__proto__']: { polluted: true },
    },
    { prefsPath },
  );
  assert.deepEqual(saved1.sections, { quotas: false, retries: false, heatmap: false });
  assert.equal(existsSync(prefsPath), true);

  // Partial update of lang/activeTab/scope/switcher must preserve sections
  const saved2 = saveUiPrefs(
    db1,
    {
      lang: 'zh',
      activeTab: 'cost',
      scope: { scope: 'project', showPricing: true },
      switcher: { lockMain: true },
    },
    { prefsPath },
  );
  assert.deepEqual(saved2.sections, { quotas: false, retries: false, heatmap: false });
  assert.equal(saved2.lang, 'zh');
  assert.equal(saved2.activeTab, 'cost');
  assert.equal(saved2.scope.scope, 'project');
  assert.equal(saved2.scope.showPricing, true);
  assert.equal(saved2.switcher.lockMain, true);

  // Simulate plugin disable -> enable on same DB (new connection)
  db1.close();
  db1Reopened = openContextDb(dbPath1);
  const afterToggle = getUiPrefs(db1Reopened, { prefsPath });
  assert.deepEqual(afterToggle.sections, { quotas: false, retries: false, heatmap: false });
  assert.equal(afterToggle.lang, 'zh');
  assert.equal(afterToggle.switcher.lockMain, true);

  // Simulate uninstall + reinstall (brand-new DB file, only durable user ui-prefs.json survives)
  db2 = openContextDb(dbPath2);
  const restored = getUiPrefs(db2, { prefsPath });
  assert.deepEqual(restored.sections, { quotas: false, retries: false, heatmap: false });
  assert.equal(restored.lang, 'zh');
  assert.equal(restored.activeTab, 'cost');
  assert.equal(restored.scope.scope, 'project');
  assert.equal(restored.switcher.lockMain, true);
  // Seeded back into db2 kv table
  const rowInDb2 = db2.prepare("SELECT v FROM kv WHERE k = 'ui_prefs_v1'").get();
  assert.ok(rowInDb2?.v);

  // Simulate deleted external JSON mirror -> recovered from SQLite db2
  rmSync(prefsPath, { force: true });
  const recovered = getUiPrefs(db2, { prefsPath });
  assert.deepEqual(recovered.sections, { quotas: false, retries: false, heatmap: false });
  assert.equal(existsSync(prefsPath), true);
});

test('prefs.js + sections.js restore server sections across port changes, migrate localStorage, and coalesce saves', async () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const prefsSrc = readFileSync(join(testDir, '..', 'public', 'prefs.js'), 'utf-8');
  const sectionsSrc = readFileSync(join(testDir, '..', 'public', 'sections.js'), 'utf-8');

  function makeHarness({ serverBoot = undefined, initialLocal = {}, fetchImpl = null } = {}) {
    const store = new Map(Object.entries(initialLocal));
    const listeners = new Map();
    const classSet = (initial = []) => {
      const s = new Set(initial);
      return {
        add: (c) => s.add(c),
        remove: (c) => s.delete(c),
        toggle: (c, force) => (force === undefined ? (s.has(c) ? (s.delete(c), false) : (s.add(c), true)) : (force ? s.add(c) : s.delete(c), Boolean(force))),
        contains: (c) => s.has(c),
      };
    };
    const makeEl = (id) => ({
      id,
      className: '',
      classList: classSet(),
      dataset: {},
      children: [],
      attributes: {},
      innerHTML: '',
      textContent: '',
      title: '',
      parentElement: null,
      setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute(k) { return this.attributes[k] ?? null; },
      append(...nodes) { for (const n of nodes) { n.parentElement = this; this.children.push(n); } },
      appendChild(n) { n.parentElement = this; this.children.push(n); return n; },
      insertBefore(n) { n.parentElement = this; this.children.unshift(n); return n; },
      addEventListener(ev, fn) {
        if (!listeners.has(`${id}:${ev}`)) listeners.set(`${id}:${ev}`, []);
        listeners.get(`${id}:${ev}`).push(fn);
      },
      querySelectorAll: () => [],
      querySelector: () => null,
      click() {},
    });

    const limitBar = makeEl('.limit-bar');
    const header = makeEl('.header');
    const limitBadge = makeEl('limit-badge');
    limitBadge.parentElement = limitBar;
    const byId = new Map([
      ['limit-badge', limitBadge],
      ['quotas-card', makeEl('quotas-card')],
      ['switcher-bar', makeEl('switcher-bar')],
      ['tab-heatmap', makeEl('tab-heatmap')],
    ]);

    const document = {
      readyState: 'complete',
      getElementById: (id) => byId.get(id) || null,
      querySelector: (sel) => (sel === '.limit-bar' ? limitBar : sel === '.header' ? header : null),
      createElement: (tag) => {
        const el = makeEl(tag);
        const origSetId = Object.getOwnPropertyDescriptor(el, 'id');
        Object.defineProperty(el, 'id', {
          get() { return this._id || ''; },
          set(v) { this._id = v; if (v) byId.set(v, this); },
        });
        if (origSetId?.value) el.id = origSetId.value;
        return el;
      },
      addEventListener: () => {},
    };

    const ctx = {
      globalThis: {},
      document,
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
      },
      sidecar: fetchImpl ? { fetch: fetchImpl } : undefined,
      setTimeout,
      clearTimeout,
    };
    ctx.globalThis = ctx;
    if (serverBoot !== undefined) {
      ctx.__CM_UI_PREFS__ = serverBoot;
    }

    vm.runInNewContext(prefsSrc, ctx);
    vm.runInNewContext(sectionsSrc, ctx);

    return { ctx, store, byId, listeners };
  }

  // Case A: Empty localStorage (new ephemeral port after disable/enable), server bootstrap restores turned-off sections
  const callsA = [];
  const hA = makeHarness({
    serverBoot: {
      sections: { quotas: false, heatmap: false, modelDna: false },
      lang: 'en',
      updatedAtMs: 1000,
    },
    initialLocal: {},
    fetchImpl: async (url, opts) => {
      callsA.push({ url, opts });
      return { ok: true, json: async () => ({ ok: true, prefs: { sections: JSON.parse(opts.body).sections } }) };
    },
  });
  assert.equal(hA.ctx.CM_SECTIONS.isEnabled('quotas'), false);
  assert.equal(hA.ctx.CM_SECTIONS.isEnabled('heatmap'), false);
  assert.equal(hA.ctx.CM_SECTIONS.isEnabled('modelDna'), false);
  assert.equal(hA.ctx.CM_SECTIONS.isEnabled('gauge'), true);
  assert.equal(hA.byId.get('quotas-card').classList.contains('cm-sec-hidden'), true);
  assert.equal(JSON.parse(hA.store.get('cm_sections_v1')).quotas, false);
  assert.equal(callsA.length, 0);

  // Case B: First upgrade migration from existing localStorage when server sections is empty
  const callsB = [];
  const hB = makeHarness({
    serverBoot: { sections: {}, updatedAtMs: 0 },
    initialLocal: { cm_sections_v1: JSON.stringify({ chart: false, turns: false }) },
    fetchImpl: async (url, opts) => {
      callsB.push({ url, opts });
      return { ok: true, json: async () => ({ ok: true, prefs: { sections: JSON.parse(opts.body).sections, updatedAtMs: 2000 } }) };
    },
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(hB.ctx.CM_SECTIONS.isEnabled('chart'), false);
  assert.equal(hB.ctx.CM_SECTIONS.isEnabled('turns'), false);
  assert.equal(callsB.length, 1);
  assert.equal(callsB[0].url, '/api/ui-prefs');
  assert.equal(JSON.parse(callsB[0].opts.body).sections.chart, false);

  // Case C: Rapid patch coalescing (first POST in flight, two updates merge into single follow-up POST)
  const callsC = [];
  let releaseFirst;
  const firstGate = new Promise((r) => { releaseFirst = r; });
  const hC = makeHarness({
    serverBoot: { sections: { quotas: true }, updatedAtMs: 10 },
    fetchImpl: async (url, opts) => {
      const body = JSON.parse(opts.body);
      callsC.push(body);
      if (callsC.length === 1) await firstGate;
      return { ok: true, json: async () => ({ ok: true, prefs: { sections: body.sections, updatedAtMs: 20 + callsC.length } }) };
    },
  });
  const p1 = hC.ctx.CM_PREFS.saveServerPatch({ sections: { quotas: false } });
  const p2 = hC.ctx.CM_PREFS.saveServerPatch({ sections: { heatmap: false } });
  const p3 = hC.ctx.CM_PREFS.saveServerPatch({ sections: { quotas: true } });
  releaseFirst();
  await Promise.all([p1, p2, p3]);
  assert.equal(callsC.length, 2);
  assert.deepEqual(callsC[1].sections, { heatmap: false, quotas: true });

  // Case D: Async GET /api/ui-prefs fallback when __CM_UI_PREFS__ bootstrap is absent
  const hD = makeHarness({
    serverBoot: undefined,
    initialLocal: {},
    fetchImpl: async (url) => {
      assert.equal(url, '/api/ui-prefs');
      return { ok: true, json: async () => ({ prefs: { sections: { switcher: false, quotas: false }, updatedAtMs: 5000 } }) };
    },
  });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(hD.ctx.CM_SECTIONS.isEnabled('switcher'), false);
  assert.equal(hD.ctx.CM_SECTIONS.isEnabled('quotas'), false);
  assert.equal(hD.byId.get('switcher-bar').classList.contains('cm-sec-hidden'), true);
});

test('quotas.js independently hides Claude / GPT pool when claudeQuotas section is disabled', async () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const quotasSrc = readFileSync(join(testDir, '..', 'public', 'quotas.js'), 'utf-8');

  let claudeEnabled = false;
  const listeners = [];
  const quotasCard = { id: 'quotas-card', className: '', innerHTML: '', addEventListener() {} };
  const viewSession = {
    appendChild() {},
    insertBefore() {},
  };
  const ctx = {
    globalThis: {},
    URLSearchParams,
    CM_I18N: { getLang: () => 'en', onChange: () => {} },
    CM_SECTIONS: {
      isEnabled: (k) => (k === 'claudeQuotas' ? claudeEnabled : true),
      applyVisibility: () => {},
      onChange: (fn) => listeners.push(fn),
    },
    sidecar: {
      fetch: async () => ({
        ok: true,
        json: async () => ({
          available: true,
          pools: [
            { pool: 'gemini', label: 'Gemini', fiveHour: { remainingPct: 71 }, weekly: { remainingPct: 67 } },
            { pool: 'premium', label: 'Claude / GPT', fiveHour: { remainingPct: 100 }, weekly: { remainingPct: 96 } },
          ],
          aiCredits: [],
        }),
      }),
    },
    document: {
      readyState: 'complete',
      getElementById: (id) => {
        if (id === 'view-session') return viewSession;
        if (id === 'quotas-card') return quotasCard._mounted ? quotasCard : null;
        return null;
      },
      createElement: () => {
        quotasCard._mounted = true;
        return quotasCard;
      },
      addEventListener() {},
    },
    setInterval: () => 1,
    clearInterval: () => {},
  };
  ctx.globalThis = ctx;

  vm.runInNewContext(quotasSrc, ctx);
  await new Promise((r) => setTimeout(r, 15));

  // Gemini stays visible, Claude / GPT is hidden
  assert.ok(quotasCard.innerHTML.includes('Gemini'));
  assert.equal(quotasCard.innerHTML.includes('Claude / GPT'), false);

  // Re-enabling claudeQuotas triggers immediate re-render showing Claude / GPT
  claudeEnabled = true;
  for (const fn of listeners) fn({ quotas: true, claudeQuotas: true });
  assert.ok(quotasCard.innerHTML.includes('Gemini'));
  assert.ok(quotasCard.innerHTML.includes('Claude / GPT'));
});

test('breakdown enriches CODE_ACTION items with bilingual hover explanations and hints', () => {
  const res = computeContextBreakdown({
    steps: [
      {
        type: 'CORTEX_STEP_TYPE_CODE_ACTION',
        codeAction: { description: 'Update public/extras.js clipboard fallback', targetFile: 'sidecars/context_monitor/public/extras.js' },
      },
      {
        type: 'CORTEX_STEP_TYPE_CODE_ACTION',
        codeAction: {},
      },
    ],
    usedTokens: 20_000,
    limitTokens: 512_000,
  });

  assert.equal(res.largestItems.length, 2);
  const first = res.largestItems[0];
  assert.ok(first.title.includes('CODE_ACTION'));
  assert.ok(first.detailEn.includes('CODE_ACTION'));
  assert.ok(first.detailEn.includes('Update public/extras.js clipboard fallback'));
  assert.ok(first.detailZh.includes('CODE_ACTION'));
  assert.ok(first.detailZh.includes('代码/文件操作步骤'));

  const generic = res.largestItems[1];
  assert.ok(generic.detailEn.includes('file edit, write, diff'));
  assert.ok(generic.detailZh.includes('文件编辑、写入或 Diff'));
});
