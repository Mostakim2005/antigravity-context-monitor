import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const i18nSrc = readFileSync(join(__dirname, '..', 'public', 'i18n.js'), 'utf-8');
const indexHtml = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf-8');

function loadTranslator() {
  const ctx = { globalThis: {} };
  vm.runInNewContext(i18nSrc, ctx);
  return ctx.globalThis.CM_I18N;
}

test('translates all static Chinese strings and attributes in index.html cleanly', () => {
  const { translateText } = loadTranslator();

  const textMatches = [...indexHtml.matchAll(/>([^<]*[\u4e00-\u9fff][^<]*)</g)].map((m) => m[1]);
  assert.ok(textMatches.length >= 25, 'expected static Chinese text nodes in index.html');
  for (const raw of textMatches) {
    const isWeekday = raw.trim().length === 1 && '一三五日'.includes(raw.trim());
    const translated = translateText(raw, 'en', { isWeekday });
    assert.equal(/[\u4e00-\u9fff]/.test(translated), false, `Untranslated HTML text: ${raw} -> ${translated}`);
  }

  const attrMatches = [...indexHtml.matchAll(/(?:title|aria-label)="([^"]*[\u4e00-\u9fff][^"]*)"/g)].map((m) => m[1]);
  assert.ok(attrMatches.length >= 4, 'expected Chinese attributes in index.html');
  for (const raw of attrMatches) {
    const translated = translateText(raw, 'en');
    assert.equal(/[\u4e00-\u9fff]/.test(translated), false, `Untranslated attr: ${raw} -> ${translated}`);
  }
});

test('translates all dynamic runtime templates from app.js and lib.mjs', () => {
  const { translateText } = loadTranslator();

  const samples = [
    '暂无趋势数据',
    '最近 26 次调用 · 峰值 115.8K / 512.0K',
    '共 4 轮 · 倒序',
    '上下文压缩/截断：本轮净减少 398.7K',
    '本轮上下文大幅增长 +51.5K（≥ 20K）',
    '本轮上下文净变化 +1.25K（< 20K）',
    '暂无 Prompt 记录',
    '等待响应',
    '等待首步模型响应…',
    '首步 Cache 106.7K / 109.6K',
    '结束 115.8K',
    '2 次调用',
    '冷启动 · 首轮 · 0.0%',
    '冷启动 · 缓存未命中 · 12.0%',
    '部分缓存 · 45.0%',
    '热启动 · 97.3%',
    '（空 Prompt）',
    '（会话初始指令）',
    '无会话',
    '未检测到 conversationId',
    '当前会话还没有完成的模型调用（PLANNER_RESPONSE），发送消息或执行一步后会自动更新。',
    '未从宿主接收到 conversationId，请在 Antigravity 对话右侧辅助面板中打开。',
    '当前模型上下文上限（来自 LanguageServerService maxContextTokens: 512,000）',
    '当前默认上下文上限：512,000 tokens',
    '超出 12.0K',
    '按 512,000 上限计算',
    '步后统计（含输出后下轮底数 ≥ 116.4K）',
    '步后统计（含输出后下轮底数 ≥ 490.0K） · 接近窗口上限，建议适时 /compact',
    '命中率 94.5%',
    '会话均值 4.78s',
    '含首字 97.6 tok/s',
    '均值 320.0 tok/s',
    '流式 1.56s',
    '26 次模型调用 · 93 步',
    '14 天',
    '8 个会话',
    '峰值 2.50M',
    '1月',
    '11月',
    '2026-11-27: 1,234,567 tokens (12 次调用)',
    '暂无历史数据',
    '2026-11-27 · 无模型调用',
    ' · 共 1.23M (12 次调用 · 3 会话)',
    'Cache 1.00M · 新增 200K · 输出 30K',
    '模型：查询中…',
    '模型：gemini-4-hydrogen (12次 · 1.23M) · gemini-4-neon (3次 · 100K)',
    '模型：暂无模型 ID 记录',
    '历史热力图加载失败',
    '重试中',
  ];

  for (const s of samples) {
    const out = translateText(s, 'en');
    assert.equal(/[\u4e00-\u9fff]/.test(out), false, `Untranslated sample: ${s} -> ${out}`);
    assert.equal(translateText(s, 'zh'), s, 'zh mode must preserve original text');
  }
});
