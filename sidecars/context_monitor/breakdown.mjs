// 9-category active context breakdown + Top 5 largest items.
// Strictly computed for the single active conversation only.

export const CATEGORY_META = [
  { key: 'system', en: 'System Prompt', zh: '系统提示词', color: '#64748b' },
  { key: 'rules_skills', en: 'Rules & Skills', zh: '规则与技能', color: '#f97316' },
  { key: 'plugins_mcp', en: 'Plugins & MCP', zh: '插件与 MCP', color: '#06b6d4' },
  { key: 'subagents', en: 'Subagents', zh: '子智能体', color: '#ec4899' },
  { key: 'user', en: 'User Messages', zh: '用户消息', color: '#3b82f6' },
  { key: 'assistant_thinking', en: 'Assistant & Thinking', zh: '助手与思考', color: '#8b5cf6' },
  { key: 'tools', en: 'Tools & Results', zh: '工具与结果', color: '#eab308' },
  { key: 'media_files', en: 'Files & Media', zh: '文件与媒体', color: '#10b981' },
  { key: 'other', en: 'Other Context', zh: '其他上下文', color: '#94a3b8' },
];

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

export function classifySection(tokenType, title) {
  const normType = String(tokenType || '').trim().toUpperCase();
  const normTitle = String(title || '').trim();

  if (normType) {
    if (/RULE|SKILL|WORKFLOW|INSTRUCTION|MEMORY/.test(normType)) return 'rules_skills';
    if (/PLUGIN|MCP/.test(normType)) return 'plugins_mcp';
    if (/SUBAGENT|SWARM|DELEGATED/.test(normType)) return 'subagents';
    if (/SYSTEM|IDENTITY|PREAMBLE|USER_INFO|ENVIRONMENT|CHECKPOINT|ARTIFACT|KNOWLEDGE|EPHEMERAL/.test(normType)) return 'system';
    if (/USER_MESSAGE|USER_INPUT|TOKEN_TYPE_USER/.test(normType)) return 'user';
    if (/ASSISTANT|THINKING|THOUGHT|REASONING|PLANNER|MODEL_RESPONSE/.test(normType)) return 'assistant_thinking';
    if (/TOOL|FUNCTION|COMMAND_OUTPUT/.test(normType)) return 'tools';
    if (/MEDIA|IMAGE|FILE|ATTACHMENT|EDITOR|CODE_CONTEXT|DIFF/.test(normType)) return 'media_files';
  }

  if (normTitle) {
    if (/(?<![a-zA-Z])(?:skills?|rules?|user_rules|workflows?)(?![a-zA-Z])|agents\.md|claude\.md|gemini\.md/i.test(normTitle)) return 'rules_skills';
    if (/(?<![a-zA-Z])(?:plugins?|mcp|mcp_servers?)(?![a-zA-Z])/i.test(normTitle)) return 'plugins_mcp';
    if (/(?<![a-zA-Z])(?:subagents?|sub-agents?|swarm)(?![a-zA-Z])/i.test(normTitle)) return 'subagents';
    if (/(?<![a-zA-Z])(?:system|identity|preamble|user_information|checkpoints?|artifacts?|knowledge|environment)(?![a-zA-Z])/i.test(normTitle)) return 'system';
    if (/(?<![a-zA-Z])user[\s_]+(?:messages?|inputs?|requests?|prompts?)(?![a-zA-Z])/i.test(normTitle)) return 'user';
    if (/(?<![a-zA-Z])(?:assistant|thinking|thoughts?|reasoning|planner)(?![a-zA-Z])/i.test(normTitle)) return 'assistant_thinking';
    if (/(?<![a-zA-Z])(?:tools?|function[\s_]*calls?|command[\s_]*outputs?|read_file|write_file|edit_file|view_file|run_command|grep_search|find_by_name|terminal|shell|grep|search)(?![a-zA-Z])/i.test(normTitle)) return 'tools';
    if (/(?<![a-zA-Z])(?:files?|media|images?|attachments?|screenshots?|pdfs?|diffs?)(?![a-zA-Z])/i.test(normTitle)) return 'media_files';
  }
  return 'other';
}

function classifyStep(step) {
  const type = String(step?.type || '').toUpperCase();
  if (type.includes('USER_INPUT')) return { category: 'user', label: 'User prompt' };
  if (type.includes('CHECKPOINT')) return { category: 'system', label: 'Compaction checkpoint' };
  if (type.includes('PLANNER_RESPONSE') || type.includes('MODEL_RESPONSE')) {
    return { category: 'assistant_thinking', label: 'Assistant response' };
  }
  if (type.includes('SUBAGENT') || step?.subagentSpec || step?.subagent) {
    return { category: 'subagents', label: 'Subagent call' };
  }
  if (type.includes('MCP') || step?.mcpToolCall) {
    return { category: 'plugins_mcp', label: 'MCP tool' };
  }
  if (type.includes('TOOL') || type.includes('RUN_COMMAND') || type.includes('CODE_ACTION') || step?.toolCall) {
    const toolName = step?.toolCall?.name || step?.metadata?.toolName || type.replace(/^CORTEX_STEP_TYPE_/, '');
    return { category: 'tools', label: toolName || 'Tool call' };
  }
  if (type.includes('FILE') || type.includes('VIEW') || type.includes('MEDIA')) {
    return { category: 'media_files', label: 'File / media' };
  }
  return { category: 'other', label: type.replace(/^CORTEX_STEP_TYPE_/, '') || 'Step' };
}

function estimateCharsTokens(step) {
  try {
    return Math.max(20, Math.round(JSON.stringify(step).length / 4));
  } catch {
    return 100;
  }
}

export function computeContextBreakdown({
  generatorMetadata = [],
  steps = [],
  usedTokens = 0,
  limitTokens = 512_000,
} = {}) {
  const buckets = new Map(CATEGORY_META.map((m) => [m.key, { ...m, tokens: 0, itemCount: 0 }]));
  const items = [];

  // Prefer promptSections from latest generatorMetadata entry if present
  let latestSections = [];
  let latestGroups = [];
  let gmUsed = 0;

  if (Array.isArray(generatorMetadata) && generatorMetadata.length > 0) {
    for (let i = generatorMetadata.length - 1; i >= 0; i--) {
      const cm = generatorMetadata[i]?.chatModel;
      if (!cm) continue;
      if (!gmUsed && cm.usage) {
        gmUsed = toNum(cm.usage.inputTokens) + toNum(cm.usage.cacheReadTokens) + toNum(cm.usage.cacheCreationTokens);
      }
      if (Array.isArray(cm.promptSections) && cm.promptSections.length > 0) {
        latestSections = cm.promptSections;
        break;
      }
      if (Array.isArray(cm.tokenBreakdownGroups) && cm.tokenBreakdownGroups.length > 0) {
        latestGroups = cm.tokenBreakdownGroups;
        break;
      }
    }
  }

  let source = 'none';
  const targetUsed = usedTokens > 0 ? usedTokens : gmUsed;

  if (latestSections.length > 0) {
    source = 'prompt_sections';
    for (const sec of latestSections) {
      const tok = toNum(sec.numTokens ?? sec.tokens) || Math.round(toNum(sec.contentLen) / 4);
      if (tok <= 0) continue;
      const cat = classifySection(sec.tokenType, sec.title);
      const b = buckets.get(cat);
      b.tokens += tok;
      b.itemCount += 1;
      items.push({ title: String(sec.title || cat), category: cat, tokens: tok });
    }
  } else if (latestGroups.length > 0) {
    source = 'token_breakdown';
    for (const grp of latestGroups) {
      const tok = toNum(grp.numTokens ?? grp.tokens);
      if (tok <= 0) continue;
      const cat = classifySection(grp.type, grp.name);
      const b = buckets.get(cat);
      b.tokens += tok;
      b.itemCount += 1;
      items.push({ title: String(grp.name || cat), category: cat, tokens: tok });
    }
  } else if (Array.isArray(steps) && steps.length > 0) {
    source = 'steps_estimated';
    const rawItems = [];
    let rawSum = 0;
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      const { category, label } = classifyStep(st);
      const est = estimateCharsTokens(st);
      rawSum += est;
      rawItems.push({ title: `#${i} ${label}`, category, est });
    }
    const scale = targetUsed > 0 && rawSum > 0 ? targetUsed / rawSum : 1;
    for (const ri of rawItems) {
      const tok = Math.max(1, Math.round(ri.est * scale));
      const b = buckets.get(ri.category);
      b.tokens += tok;
      b.itemCount += 1;
      items.push({ title: ri.title, category: ri.category, tokens: tok });
    }
  }

  const segTotal = [...buckets.values()].reduce((s, b) => s + b.tokens, 0);
  if (targetUsed > segTotal && segTotal > 0) {
    buckets.get('other').tokens += targetUsed - segTotal;
    buckets.get('other').itemCount += 1;
  }

  const totalUsed = Math.max(targetUsed, segTotal);
  const effectiveDenom = Math.max(limitTokens || 1, totalUsed, 1);

  const segments = [...buckets.values()]
    .filter((b) => b.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .map((b) => ({
      key: b.key,
      en: b.en,
      zh: b.zh,
      color: b.color,
      tokens: b.tokens,
      itemCount: b.itemCount,
      pctOfLimit: Number(((b.tokens / effectiveDenom) * 100).toFixed(1)),
      pctOfUsed: totalUsed > 0 ? Number(((b.tokens / totalUsed) * 100).toFixed(1)) : 0,
    }));

  const largestItems = items
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5)
    .map((it) => ({
      ...it,
      pctOfUsed: totalUsed > 0 ? Number(((it.tokens / totalUsed) * 100).toFixed(1)) : 0,
    }));

  return {
    source,
    usedTokens: totalUsed,
    limitTokens,
    segments,
    largestItems,
  };
}
