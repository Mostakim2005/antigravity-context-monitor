import assert from 'node:assert/strict';
import test from 'node:test';
import { formatResetCountdown, parseQuotaSummary, parseUserStatusQuotaFallback, isCustomOrByokModel } from '../quotas.mjs';

test('formatResetCountdown formats minutes, hours, and days cleanly', () => {
  const now = Date.parse('2026-11-27T10:00:00Z');
  assert.equal(formatResetCountdown(now + 45 * 60_000, now), '45m');
  assert.equal(formatResetCountdown(now + (3 * 3600 + 15 * 60) * 1000, now), '3h 15m');
  assert.equal(formatResetCountdown(now + (2 * 86400 + 5 * 3600) * 1000, now), '2d 5h');
  assert.equal(formatResetCountdown(null, now), null);
});

test('parseQuotaSummary extracts 5h and weekly windows for Gemini and Claude/GPT', () => {
  const now = Date.parse('2026-11-27T10:00:00Z');
  const raw = {
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          {
            bucketId: 'gemini-5h',
            window: '5h',
            remainingFraction: 0.72,
            resetTime: '2026-11-27T12:30:00Z',
          },
          {
            bucketId: 'gemini-weekly',
            window: 'weekly',
            remainingFraction: 0.91,
            resetTime: '2026-12-01T00:00:00Z',
          },
        ],
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          {
            bucketId: '3p-5h',
            // omitted remainingFraction + future resetTime => Proto3 default 0.0 (exhausted)
            resetTime: '2026-11-27T11:00:00Z',
          },
          {
            bucketId: '3p-weekly',
            // omitted remainingFraction + epoch-0 resetTime => untouched 100%
            resetTime: '1970-01-01T00:00:00Z',
          },
        ],
      },
    ],
  };

  const parsed = parseQuotaSummary(raw, now);
  assert.equal(parsed.source, 'summary');
  assert.equal(parsed.pools.length, 2);
  assert.equal(parsed.pools[0].label, 'Gemini');
  assert.equal(parsed.pools[0].fiveHour.remainingPct, 72);
  assert.equal(parsed.pools[0].fiveHour.resetCountdown, '2h 30m');
  assert.equal(parsed.pools[0].weekly.remainingPct, 91);
  assert.equal(parsed.pools[0].weekly.resetCountdown, '3d 14h');

  assert.equal(parsed.pools[1].label, 'Claude / GPT');
  assert.equal(parsed.pools[1].fiveHour.remainingPct, 0);
  assert.equal(parsed.pools[1].weekly.remainingPct, 100);
  assert.equal(parsed.pools[1].weekly.resetCountdown, null);
});

test('parseUserStatusQuotaFallback aggregates minimum remaining quota per pool', () => {
  const now = Date.parse('2026-11-27T10:00:00Z');
  const raw = {
    userStatus: {
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: 'Gemini 4 Hydrogen (High)',
            modelOrAlias: { model: 'MODEL_PLACEHOLDER_M530' },
            quotaInfo: { remainingFraction: 0.85, resetTime: '2026-11-27T13:00:00Z' },
          },
          {
            label: 'Gemini 4 Neon (High)',
            modelOrAlias: { model: 'MODEL_PLACEHOLDER_M532' },
            quotaInfo: { remainingFraction: 0.65, resetTime: '2026-11-27T13:00:00Z' },
          },
          {
            label: 'Claude Opus 5.5',
            modelOrAlias: { model: 'MODEL_PLACEHOLDER_CLAUDE' },
            quotaInfo: { remainingFraction: 0.4, resetTime: '2026-11-27T12:00:00Z' },
          },
        ],
      },
    },
  };

  const parsed = parseUserStatusQuotaFallback(raw, now);
  assert.equal(parsed.source, 'user_status');
  assert.equal(parsed.pools.length, 2);
  assert.equal(parsed.pools[0].fiveHour.remainingPct, 65);
  assert.equal(parsed.pools[1].fiveHour.remainingPct, 40);
});

test('isCustomOrByokModel isolates BYOK and local models without false positives on Orchestrator Custom', () => {
  assert.equal(isCustomOrByokModel('custom-my-model', 'My Model'), true);
  assert.equal(isCustomOrByokModel('openrouter/deepseek/deepseek-r1', 'DeepSeek R1'), true);
  assert.equal(isCustomOrByokModel('ollama/qwen3:32b', 'Qwen 3 (Local)'), true);
  assert.equal(isCustomOrByokModel('', 'Custom: My Endpoint'), true);

  // Antigravity built-in Orchestrator (Custom) still runs on Google quota pools
  assert.equal(isCustomOrByokModel('MODEL_PLACEHOLDER_M537', 'Orchestrator (Custom)'), false);
  assert.equal(isCustomOrByokModel('MODEL_PLACEHOLDER_M530', 'Gemini 4 Hydrogen (High)'), false);
  // Explicit BYOK label overrides built-in ID check
  assert.equal(isCustomOrByokModel('MODEL_PLACEHOLDER_M530', 'Gemini 4 Hydrogen (BYOK)'), true);
});
