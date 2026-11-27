import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { calculateScopeCosts, normalizeModelKey, resolveModelPricing } from './pricing.mjs';
import { isCustomOrByokModel } from './quotas.mjs';

export const LEGACY_ORCHESTRATOR_PLANNER_IDS = new Set([
  'MODEL_PLACEHOLDER_M537',
  'MODEL_PLACEHOLDER_M667',
  'MODEL_PLACEHOLDER_M681',
]);

export const LEGACY_ORCHESTRATOR_EXECUTOR_IDS = new Set([
  'MODEL_PLACEHOLDER_M669',
]);

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function toNum(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Strip API-doubled error messages such as "UNAVAILABLE: UNAVAILABLE".
 */
export function deduplicateApiErrorText(msg) {
  const s = String(msg || '').trim();
  if (!s) return '';
  let sf = 0;
  while (sf < s.length) {
    const si = s.indexOf(': ', sf);
    if (si < 0 || si >= s.length - 2) break;
    if (s.slice(0, si) === s.slice(si + 2)) return s.slice(0, si);
    sf = si + 2;
  }
  return s;
}

export function extractErrorCode(msg) {
  const s = String(msg || '');
  const httpMatch = s.match(/\b(429|500|502|503|504|400|401|403|404)\b/);
  if (httpMatch) return httpMatch[1];
  const grpcMatch = s.match(/\b(UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED|INTERNAL|ABORTED|CANCELLED|CANCELED|INVALID_ARGUMENT|PERMISSION_DENIED)\b/i);
  if (grpcMatch) return grpcMatch[1].toUpperCase();
  if (/timeout|timed out/i.test(s)) return 'TIMEOUT';
  if (/rate.?limit|quota/i.test(s)) return 'RATE_LIMIT';
  return 'ERROR';
}

export function resolveAntigravityConfigPath({ configPath = '', env = process.env } = {}) {
  if (configPath && String(configPath).trim()) return String(configPath).trim();
  const base = env.USERPROFILE || env.HOME || homedir();
  return join(base, '.gemini', 'config', 'config.json');
}

export function parseAntigravityUserConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const us =
    (raw.userSettings && typeof raw.userSettings === 'object' && !Array.isArray(raw.userSettings) && raw.userSettings) ||
    (raw.userConfig?.userSettings && typeof raw.userConfig.userSettings === 'object' && !Array.isArray(raw.userConfig.userSettings) && raw.userConfig.userSettings) ||
    null;
  if (!us) return null;

  const orchestratorModel = typeof us.orchestratorModel === 'string' ? us.orchestratorModel.trim() : '';
  const orchestratorExecutorModel = typeof us.orchestratorExecutorModel === 'string' ? us.orchestratorExecutorModel.trim() : '';
  const hasUseAiCredits = typeof us.useAiCredits === 'boolean';
  if (!orchestratorModel && !orchestratorExecutorModel && !hasUseAiCredits) return null;

  return {
    orchestratorModel,
    orchestratorExecutorModel,
    ...(hasUseAiCredits ? { useAiCredits: us.useAiCredits } : {}),
  };
}

export function readLocalOrchestratorConfig({ configPath = '', env = process.env } = {}) {
  const targetPath = resolveAntigravityConfigPath({ configPath, env });
  if (!targetPath || !existsSync(targetPath)) return null;
  try {
    const raw = readFileSync(targetPath, 'utf8').replace(/^\uFEFF/, '');
    if (!raw.trim()) return null;
    const parsed = parseAntigravityUserConfig(JSON.parse(raw));
    return parsed ? { ...parsed, configPath: targetPath } : null;
  } catch {
    return null;
  }
}

function emptyRoleMetrics() {
  return {
    calls: 0,
    models: [],
    labels: [],
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cacheHitRate: null,
    costUsd: 0,
  };
}

function finalizeRole(bucket, modelSet, labelSet) {
  bucket.models = [...modelSet];
  bucket.labels = [...labelSet];
  const promptTotal = bucket.inputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens;
  bucket.cacheHitRate = promptTotal > 0 ? Number(((bucket.cacheReadTokens / promptTotal) * 100).toFixed(1)) : null;
  return bucket;
}

function isSubagentMeta(gm, promptSectionTitles, isSubagentConversation) {
  if (isSubagentConversation) return true;
  const execId = String(gm?.executionId || '').trim();
  if (execId && /^(?:subagent|swarm[-_]?worker)(?:[-_:]|$)/i.test(execId)) return true;
  return promptSectionTitles.some((t) => /^(?:subagent|swarm\s+worker)\b/i.test(String(t || '').trim()));
}

function parseCompletionConfig(cc) {
  if (!cc || typeof cc !== 'object') return null;
  return {
    maxTokens: toInt(cc.maxTokens),
    temperature: toNum(cc.temperature),
    firstTemperature: toNum(cc.firstTemperature),
    topK: toInt(cc.topK),
    topP: toNum(cc.topP),
    numCompletions: toInt(cc.numCompletions),
    stopPatternCount: Array.isArray(cc.stopPatterns) ? cc.stopPatterns.length : 0,
  };
}

/**
 * Compute active-chat Group 2 diagnostics (Orchestrator vs Executor cache switches,
 * Retry & Error token/USD waste, and Model DNA parameters) directly from
 * LanguageServer `GetCascadeTrajectoryGeneratorMetadata` entries without storing
 * heavy cross-chat history.
 */
export function analyzeActiveDiagnostics({
  generatorMetadata = [],
  localConfig = null,
  customPricing = {},
  isSubagentConversation = false,
} = {}) {
  const gmList = Array.isArray(generatorMetadata) ? generatorMetadata : [];

  const configuredPlanRaw = String(localConfig?.orchestratorModel || '').trim();
  const configuredExecRaw = String(localConfig?.orchestratorExecutorModel || '').trim();
  const configuredPlanKey = configuredPlanRaw ? normalizeModelKey(configuredPlanRaw) : '';
  const configuredExecKey = configuredExecRaw ? normalizeModelKey(configuredExecRaw) : '';
  const fallbackRoute = configuredPlanKey && configuredExecKey
    ? { planKey: configuredPlanKey, execKey: configuredExecKey, isSameModel: configuredPlanKey === configuredExecKey }
    : null;

  // Pass 1: discover explicit plannerConfig.planExecuteConfig.executionModel anchors
  const callAnchors = [];
  for (let i = 0; i < gmList.length; i++) {
    const gm = gmList[i] || {};
    const cm = gm.chatModel || {};
    const rawModel = String(cm.responseModel || cm.model || cm.modelDisplayName || '').trim();
    const rawKey = rawModel ? normalizeModelKey(rawModel) : '';
    const execModelRaw = String(gm.plannerConfig?.planExecuteConfig?.executionModel || '').trim();
    const execKey = execModelRaw ? normalizeModelKey(execModelRaw) : '';
    const origModelId = String(cm.model || '').trim().toUpperCase();
    if (rawKey && execKey) {
      callAnchors.push({ idx: i, planKey: rawKey, execKey, isSameModel: rawKey === execKey });
    } else if (LEGACY_ORCHESTRATOR_PLANNER_IDS.has(origModelId)) {
      callAnchors.push({ idx: i, planKey: rawKey, execKey: 'gemini-4-hydrogen', isSameModel: false });
    }
  }

  const roles = {
    orchestrator: emptyRoleMetrics(),
    executor: emptyRoleMetrics(),
    subagent: emptyRoleMetrics(),
    direct: emptyRoleMetrics(),
  };
  const roleModelSets = {
    orchestrator: new Set(),
    executor: new Set(),
    subagent: new Set(),
    direct: new Set(),
  };
  const roleLabelSets = {
    orchestrator: new Set(),
    executor: new Set(),
    subagent: new Set(),
    direct: new Set(),
  };

  let currentRoute = null;
  let prevRole = null;
  let prevWasSameModelOrch = false;
  let roleSwitchCount = 0;
  let coldCacheSwitchCount = 0;
  let coldSwitchFreshInputTokens = 0;
  const switches = [];

  // Retry & Error accumulator
  let totalFailedRetries = 0;
  let callsWithRetries = 0;
  let failedCallsCount = 0;
  let wastedInputTokens = 0;
  let wastedOutputTokens = 0;
  let wastedCredits = 0;
  let wastedCostUsd = 0;
  const errorCodeCounts = new Map();
  const recentErrors = [];

  // Model DNA accumulator
  const dnaMap = new Map();

  for (let i = 0; i < gmList.length; i++) {
    const gm = gmList[i] || {};
    const cm = gm.chatModel || {};
    const usage = cm.usage || {};
    const csm = cm.chatStartMetadata || {};

    const rawModel = String(cm.responseModel || cm.model || '').trim();
    const rawPlaceholder = String(cm.model || '').trim().toUpperCase();
    const rawDisplay = String(cm.modelDisplayName || '').trim();
    const canonicalKey = normalizeModelKey(rawModel || rawDisplay || rawPlaceholder);
    const rate = resolveModelPricing(canonicalKey, customPricing);
    const label = rawDisplay || rate?.label || canonicalKey;

    const inputTokens = toInt(usage.inputTokens);
    const cacheReadTokens = toInt(usage.cacheReadTokens);
    const cacheWriteTokens = toInt(usage.cacheCreationTokens);
    const outputTokens = toInt(usage.outputTokens);
    const thinkingTokens = toInt(usage.thinkingOutputTokens);
    const stepIndices = Array.isArray(gm.stepIndices) ? gm.stepIndices : [];
    const stepIndex = stepIndices.length > 0 ? toInt(stepIndices[0]) : toInt(csm.startStepIndex);

    const promptSections = Array.isArray(cm.promptSections) ? cm.promptSections : [];
    const promptSectionTitles = [...new Set(promptSections.map((p) => String(p?.title || '').trim()).filter(Boolean))];
    const execModelRaw = String(gm.plannerConfig?.planExecuteConfig?.executionModel || '').trim();
    const execKey = execModelRaw ? normalizeModelKey(execModelRaw) : '';

    // 1. Role classification & cold-cache switch detection
    let role = 'direct';
    if (isSubagentMeta(gm, promptSectionTitles, isSubagentConversation)) {
      role = 'subagent';
    } else if (LEGACY_ORCHESTRATOR_PLANNER_IDS.has(rawPlaceholder)) {
      role = 'orchestrator';
      currentRoute = { planKey: canonicalKey, execKey: execKey || 'gemini-4-hydrogen', isSameModel: false };
    } else if (LEGACY_ORCHESTRATOR_EXECUTOR_IDS.has(rawPlaceholder)) {
      role = 'executor';
    } else if (canonicalKey && execKey) {
      role = 'orchestrator';
      currentRoute = { planKey: canonicalKey, execKey, isSameModel: canonicalKey === execKey };
      prevWasSameModelOrch = canonicalKey === execKey;
    } else {
      let activeRoute = currentRoute;
      if (!activeRoute && callAnchors.length > 0) {
        const upcoming = callAnchors.find((a) => a.idx >= i);
        if (upcoming && (canonicalKey === upcoming.planKey || canonicalKey === upcoming.execKey)) {
          activeRoute = upcoming;
        }
      }
      if (!activeRoute) activeRoute = fallbackRoute;

      if (activeRoute) {
        if (activeRoute.isSameModel && canonicalKey === activeRoute.planKey) {
          const hasExplicitAnchor = callAnchors.some((a) => a.isSameModel && a.planKey === canonicalKey);
          if (hasExplicitAnchor && prevWasSameModelOrch) {
            role = 'executor';
          } else if (!hasExplicitAnchor && prevRole === 'orchestrator' && cacheReadTokens === 0 && (inputTokens + cacheWriteTokens) > 0) {
            role = 'executor';
          } else {
            role = 'orchestrator';
          }
        } else if (canonicalKey === activeRoute.planKey) {
          role = 'orchestrator';
        } else if (canonicalKey === activeRoute.execKey) {
          role = 'executor';
        }
      }
    }

    const totalPrompt = inputTokens + cacheReadTokens + cacheWriteTokens;
    const isInternalEmpty = totalPrompt === 0 && outputTokens === 0;

    if (!isInternalEmpty && prevRole !== null && prevRole !== role) {
      if ((prevRole === 'orchestrator' && role === 'executor') || (prevRole === 'executor' && role === 'orchestrator')) {
        roleSwitchCount += 1;
        const isCold = cacheReadTokens === 0 && totalPrompt > 0;
        if (isCold) {
          coldCacheSwitchCount += 1;
          coldSwitchFreshInputTokens += inputTokens;
        }
        switches.push({
          stepIndex,
          direction: prevRole === 'orchestrator' ? 'orchestrator_to_executor' : 'executor_to_orchestrator',
          fromRole: prevRole,
          toRole: role,
          model: label,
          isCold,
          freshInputTokens: inputTokens,
        });
      }
    }
    if (!isInternalEmpty) {
      prevRole = role;
      if (role !== 'orchestrator') prevWasSameModelOrch = false;
    }

    const callCost = calculateScopeCosts([{
      model: canonicalKey,
      calls: 1,
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
    }], customPricing).totals.totalCost;

    const bucket = roles[role];
    bucket.calls += 1;
    bucket.inputTokens += inputTokens;
    bucket.cacheReadTokens += cacheReadTokens;
    bucket.cacheWriteTokens += cacheWriteTokens;
    bucket.outputTokens += outputTokens;
    bucket.thinkingTokens += thinkingTokens;
    bucket.costUsd += callCost;
    if (canonicalKey) roleModelSets[role].add(canonicalKey);
    if (label) roleLabelSets[role].add(label);

    // 2. Retry & Error waste aggregation
    const callErrorRaw = deduplicateApiErrorText(gm.error || '');
    const retryInfos = Array.isArray(cm.retryInfos) ? cm.retryInfos : [];
    const failedInfos = [];
    for (const ri of retryInfos) {
      if (!ri || typeof ri !== 'object') continue;
      const errMsg = deduplicateApiErrorText(ri.error || '');
      if (!errMsg) continue;
      failedInfos.push({ ri, errMsg });
    }
    const cmRetriesTotal = toInt(cm.retries);
    const callFailedRetries = failedInfos.length > 0
      ? failedInfos.length
      : (cmRetriesTotal > 1 ? cmRetriesTotal - 1 : 0);

    if (callFailedRetries > 0 || callErrorRaw) {
      callsWithRetries += 1;
      totalFailedRetries += callFailedRetries;
      if (callErrorRaw) {
        failedCallsCount += 1;
        const code = extractErrorCode(callErrorRaw);
        errorCodeCounts.set(code, (errorCodeCounts.get(code) || 0) + 1);
        recentErrors.push({ stepIndex, model: label, code, message: callErrorRaw.slice(0, 140) });
      }
      for (const { ri, errMsg } of failedInfos) {
        const ru = ri.usage || {};
        const rIn = toInt(ru.inputTokens);
        const rOut = toInt(ru.outputTokens);
        wastedInputTokens += rIn;
        wastedOutputTokens += rOut;
        if (rIn > 0 || rOut > 0) {
          wastedCostUsd += calculateScopeCosts([{
            model: canonicalKey,
            calls: 1,
            inputTokens: rIn,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: rOut,
          }], customPricing).totals.totalCost;
        }
        if (Array.isArray(ri.consumedCredits)) {
          for (const rc of ri.consumedCredits) {
            wastedCredits += toInt(rc?.creditAmount);
          }
        }
        const code = extractErrorCode(errMsg);
        errorCodeCounts.set(code, (errorCodeCounts.get(code) || 0) + 1);
        recentErrors.push({ stepIndex, model: label, code, message: errMsg.slice(0, 140) });
      }
    }

    // 3. Model DNA extraction
    if (canonicalKey && canonicalKey !== 'unknown') {
      const tools = Array.isArray(cm.tools) ? cm.tools : [];
      const toolSample = [...new Set(tools.map((t) => String(t?.name || '').trim()).filter(Boolean))].slice(0, 6);
      const compCfg = parseCompletionConfig(cm.completionConfig);
      const apiProvider = String(usage.apiProvider || cm.apiProvider || '').trim();
      const prevDna = dnaMap.get(canonicalKey);
      const dnaEntry = {
        modelKey: canonicalKey,
        label,
        responseModel: String(cm.responseModel || prevDna?.responseModel || '').trim(),
        modelId: String(cm.model || prevDna?.modelId || '').trim(),
        apiProvider: apiProvider || prevDna?.apiProvider || '',
        isCustomModel: isCustomOrByokModel(rawModel || rawPlaceholder, rawDisplay || label),
        completionConfig: compCfg || prevDna?.completionConfig || null,
        hasSystemPrompt: Boolean(cm.systemPrompt) || Boolean(prevDna?.hasSystemPrompt),
        toolCount: Math.max(tools.length, prevDna?.toolCount || 0),
        toolSample: toolSample.length > 0 ? toolSample : (prevDna?.toolSample || []),
        promptSectionTitles: promptSectionTitles.length > 0 ? promptSectionTitles : (prevDna?.promptSectionTitles || []),
        calls: (prevDna?.calls || 0) + 1,
        latestStepIndex: Math.max(stepIndex, prevDna?.latestStepIndex || 0),
      };
      dnaMap.set(canonicalKey, dnaEntry);
    }
  }

  for (const rKey of ['orchestrator', 'executor', 'subagent', 'direct']) {
    finalizeRole(roles[rKey], roleModelSets[rKey], roleLabelSets[rKey]);
  }

  const orchestratorActive = roles.orchestrator.calls > 0 || roles.executor.calls > 0 || roleSwitchCount > 0;
  const errorCodes = [...errorCodeCounts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count);
  const modelDna = [...dnaMap.values()].sort((a, b) => b.latestStepIndex - a.latestStepIndex);

  return {
    available: gmList.length > 0,
    totalCalls: gmList.length,
    orchestrator: {
      active: orchestratorActive,
      isSameModelOrchestrated: Boolean(fallbackRoute?.isSameModel || callAnchors.some((a) => a.isSameModel)),
      configuredPair: fallbackRoute
        ? {
            planModel: configuredPlanRaw,
            planLabel: resolveModelPricing(configuredPlanKey, customPricing)?.label || configuredPlanRaw,
            executionModel: configuredExecRaw,
            executionLabel: resolveModelPricing(configuredExecKey, customPricing)?.label || configuredExecRaw,
            useAiCredits: typeof localConfig?.useAiCredits === 'boolean' ? localConfig.useAiCredits : null,
          }
        : null,
      roleSwitchCount,
      coldCacheSwitchCount,
      coldSwitchFreshInputTokens,
      switches: switches.slice(-10).reverse(),
      roles: {
        orchestrator: roles.orchestrator,
        executor: roles.executor,
        subagent: roles.subagent,
        direct: roles.direct,
      },
    },
    retries: {
      totalFailedRetries,
      callsWithRetries,
      failedCallsCount,
      wastedInputTokens,
      wastedOutputTokens,
      wastedTotalTokens: wastedInputTokens + wastedOutputTokens,
      wastedCredits,
      wastedCostUsd,
      errorCodes,
      recentErrors: recentErrors.slice(-8).reverse(),
    },
    modelDna,
  };
}
