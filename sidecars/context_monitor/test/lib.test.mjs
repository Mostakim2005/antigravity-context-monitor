import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FIXED_LIMIT_TOKENS,
  buildHeatmapData,
  buildSpeedIndex,
  enrichSummaryWithSpeed,
  extractPromptText,
  parseDurationSec,
  parseTranscriptDaily,
  parseTranscriptText,
} from '../lib.mjs';

test('extractPromptText strips USER_REQUEST and metadata wrappers', () => {
  const raw = [
    '<USER_REQUEST>',
    '你好，帮我看下上下文',
    '</USER_REQUEST>',
    '<ADDITIONAL_METADATA>',
    'The current local time is: 2026-11-13.',
    '</ADDITIONAL_METADATA>',
  ].join('\n');

  const res = extractPromptText(raw);
  assert.equal(res.full, '你好，帮我看下上下文');
  assert.equal(res.preview, '你好，帮我看下上下文');
});

test('parseTranscriptText groups by user prompt and classifies cold/partial/warm starts', () => {
  const sample = [
    JSON.stringify({
      step_index: 0,
      type: 'USER_INPUT',
      created_at: '2026-11-13T07:34:15Z',
      content: '<USER_REQUEST>\n第一条问题\n</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-13T07:34:15Z',
      input_tokens: 10000,
      cache_read_tokens: 0,
      output_tokens: 500,
    }),
    JSON.stringify({
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-13T07:34:18Z',
      input_tokens: 2000,
      cache_read_tokens: 10500,
      output_tokens: 200,
    }),
    JSON.stringify({
      step_index: 3,
      type: 'USER_INPUT',
      created_at: '2026-11-13T07:35:00Z',
      content: '<USER_REQUEST>\n第二条追问\n</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 4,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-13T07:35:01Z',
      input_tokens: 1500,
      cache_read_tokens: 12700,
      output_tokens: 300,
    }),
    JSON.stringify({
      step_index: 5,
      type: 'USER_INPUT',
      created_at: '2026-11-13T07:45:00Z',
      content: '<USER_REQUEST>\n间隔很久后的第三条\n</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 6,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-13T07:45:01Z',
      input_tokens: 8000,
      cache_read_tokens: 7000,
      output_tokens: 100,
    }),
    JSON.stringify({
      step_index: 7,
      type: 'USER_INPUT',
      created_at: '2026-11-13T07:46:00Z',
      content: '<USER_REQUEST>\n刚发出的第四条\n</USER_REQUEST>',
    }),
    '{"partial_incomplete_line": ',
  ].join('\n');

  const out = parseTranscriptText(sample);
  assert.equal(out.totalSteps, 8);
  assert.equal(out.modelCalls, 4);
  assert.equal(out.turnCount, 4);

  // Latest model call metrics
  assert.equal(out.latest.stepIndex, 6);
  assert.equal(out.latest.contextUsed, 15000);
  assert.equal(out.latest.projectedNextMin, 15100);

  // Recent turns are newest-first
  const [t4, t3, t2, t1] = out.recentTurns;

  assert.equal(t4.turnIndex, 4);
  assert.equal(t4.promptPreview, '刚发出的第四条');
  assert.equal(t4.startup.kind, 'pending');
  assert.equal(t4.modelCalls, 0);

  assert.equal(t3.turnIndex, 3);
  assert.equal(t3.startup.kind, 'partial');
  assert.equal(t3.startup.label, '部分缓存');
  assert.equal(t3.turnDelta, 800); // 15000 - 14200

  assert.equal(t2.turnIndex, 2);
  assert.equal(t2.startup.kind, 'warm');
  assert.equal(t2.startup.label, '热启动');
  assert.equal(t2.modelCalls, 1);
  assert.equal(t2.turnDelta, 1700); // 14200 - 12500

  assert.equal(t1.turnIndex, 1);
  assert.equal(t1.startup.kind, 'cold');
  assert.equal(t1.startup.label, '冷启动 · 首轮');
  assert.equal(t1.modelCalls, 2);
  assert.equal(t1.endContextUsed, 12500);
  assert.equal(t1.turnDelta, 12500);
});

test('parseTranscriptText handles empty transcript', () => {
  const out = parseTranscriptText('');
  assert.equal(out.totalSteps, 0);
  assert.equal(out.modelCalls, 0);
  assert.equal(out.turnCount, 0);
  assert.equal(out.latest, null);
  assert.deepEqual(out.recentTurns, []);
});

test('FIXED_LIMIT_TOKENS matches 512K default context window', () => {
  assert.equal(FIXED_LIMIT_TOKENS, 512_000);
});

test('parseDurationSec and enrichSummaryWithSpeed compute TTFT and weighted TPS', () => {
  assert.equal(parseDurationSec('3.115985166s'), 3.115985166);
  assert.equal(parseDurationSec(null), null);

  const sample = [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nhi\n</USER_REQUEST>' }),
    JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', input_tokens: 1000, cache_read_tokens: 0, output_tokens: 500 }),
    JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', input_tokens: 200, cache_read_tokens: 1300, output_tokens: 300 }),
  ].join('\n');

  const summary = parseTranscriptText(sample);
  const speedIndex = buildSpeedIndex([
    {
      stepIndices: [1],
      chatModel: {
        responseModel: 'gemini-test-model',
        timeToFirstToken: '2.00s',
        streamingDuration: '1.00s',
        usage: { outputTokens: '500' },
        chatStartMetadata: {
          contextWindowMetadata: { maxContextTokens: 256000 },
        },
      },
    },
    {
      stepIndices: [2],
      chatModel: {
        timeToFirstToken: '1.00s',
        streamingDuration: '1.00s',
        usage: { outputTokens: '300' },
        chatStartMetadata: {
          contextWindowMetadata: { maxContextTokens: 512000 },
        },
      },
    },
  ]);

  const enriched = enrichSummaryWithSpeed(summary, speedIndex);
  assert.equal(enriched.latest.speed.ttftSec, 1);
  assert.equal(enriched.latest.speed.streamingTps, 300);
  assert.equal(enriched.latest.speed.tps, 150);
  assert.equal(enriched.contextLimitTokens, 512000);
  assert.equal(enriched.recentTurns[0].speed.ttftSec, 2);
  assert.equal(enriched.recentTurns[0].speed.streamingTps, 400); // (500+300)/(1+1)
  assert.equal(enriched.recentTurns[0].speed.model, 'gemini-test-model');
  assert.equal(enriched.speedStats.avgTtftSec, 1.5);
  assert.equal(enriched.speedStats.avgStreamingTps, 400);
  assert.deepEqual(enriched.speedStats.models, ['gemini-test-model']);
});

test('parseTranscriptDaily and buildHeatmapData aggregate 16-week total tokens', () => {
  const now = new Date('2026-11-13T12:00:00Z');
  const t1 = [
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-13T08:00:00Z',
      input_tokens: 1000,
      cache_read_tokens: 9000,
      output_tokens: 500,
    }),
    JSON.stringify({
      step_index: 2,
      type: 'USER_INPUT',
      created_at: '2026-11-13T08:01:00Z',
      content: 'ignored',
    }),
  ].join('\n');

  const t2 = JSON.stringify({
    step_index: 1,
    type: 'PLANNER_RESPONSE',
    created_at: '2026-11-12T08:00:00Z',
    input_tokens: 500,
    cache_read_tokens: 0,
    output_tokens: 200,
  });

  const hm = buildHeatmapData(
    [
      { convId: 'conv-a', dailyMap: parseTranscriptDaily(t1) },
      { convId: 'conv-b', dailyMap: parseTranscriptDaily(t2) },
    ],
    { weeks: 16, now },
  );

  assert.equal(hm.weeks, 16);
  assert.equal(hm.days.length, 16 * 7);
  assert.equal(hm.totals.totalTokens, 11200);
  assert.equal(hm.totals.activeDays, 2);
  assert.equal(hm.totals.sessions, 2);
  assert.equal(hm.maxDayTokens, 10500);
});
