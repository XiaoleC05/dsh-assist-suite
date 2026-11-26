// pro-prompt — host configuration normalization.
//
// The loader row in cordis.patch.yml is the complete default object. A profile
// override replaces that object wholesale, so every field is read defensively
// and every numeric field is clamped. Nothing here may throw activation.

import { DEFAULT_CAPABILITY_CATALOG, DEFAULT_MODE, normalizeMode } from './prompts.js';

export const DEFAULTS = Object.freeze({
  enabled: true,
  // SiliconFlow relay: one key covers ASR and chat. The API key is supplied
  // through the profile-level config (or SILICONFLOW_API_KEY), never here.
  apiBase: 'https://api.siliconflow.cn/v1/chat/completions',
  apiKey: '',
  apiKeyEnvFile: '',
  apiKeyEnvName: 'SILICONFLOW_API_KEY',
  asrProvider: 'siliconflow',
  asrApiBase: 'https://api.siliconflow.cn/v1',
  asrModel: 'Qwen/Qwen3-ASR-1.7B',
  // Chat model for transcript polish and prompt optimization. Chosen from the
  // SiliconFlow catalog after latency/fidelity comparison.
  polishModel: 'deepseek-ai/DeepSeek-V4.1-Flash',
  // Real DSH skills/plugins/MCP names injected into structure mode. Keep only
  // names that actually exist in this profile; MCP is resolved at run time.
  capabilityCatalog: DEFAULT_CAPABILITY_CATALOG,
  // Recognition defaults to zh; SiliconFlow handles ITN / punctuation.
  language: 'zh',
  defaultMode: DEFAULT_MODE,
  maxSeconds: 60,
  speechTimeoutMs: 90000,
  optimizeTimeoutMs: 180000,
  maxPromptChars: 20000,
  maxOutputTokens: 2048,
  polish: true,
});

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Coerce to a finite integer inside [min, max]. */
export function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/** Collapse control characters and runs of whitespace into single spaces. */
export function cleanText(value) {
  return typeof value === 'string' ? value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim() : '';
}

function asBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true' || text === '1' || text === 'yes' || text === 'on') return true;
    if (text === 'false' || text === '0' || text === 'no' || text === 'off') return false;
  }
  return fallback;
}

function resolveHttpsBase(value, fallback, label, warnings) {
  const candidate = cleanText(value).slice(0, 300) || fallback;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') throw new Error('invalid');
    return candidate;
  } catch {
    warnings.push(label + ' 必须是纯 HTTPS 地址，已回退到默认值');
    return fallback;
  }
}

function resolveModels(input) {
  return {
    asrModel: cleanText(input.asrModel).slice(0, 120) || DEFAULTS.asrModel,
    polishModel: cleanText(input.polishModel).slice(0, 80) || DEFAULTS.polishModel,
  };
}

function resolveLanguage(value) {
  return value === 'auto' || value === 'en' || value === 'zh' ? value : DEFAULTS.language;
}

/**
 * Resolve one raw loader config into a complete, bounded configuration.
 * @param {unknown} raw - the loader row's config object.
 * @returns {{config: Readonly<typeof DEFAULTS>, warnings: string[]}}
 */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const warnings = [];
  const models = resolveModels(input);
  const requestedMode = cleanText(input.defaultMode);
  const defaultMode = normalizeMode(requestedMode, DEFAULTS.defaultMode);
  const knownMode = requestedMode === '' || ['faithful', 'structure', '保真润色', '结构优化', 'keep', 'logic'].includes(requestedMode.toLowerCase());
  if (!knownMode) {
    warnings.push('defaultMode 只能是 faithful 或 structure，已回退到结构优化');
  }
  const apiKeyEnvFile = typeof input.apiKeyEnvFile === 'string'
    ? input.apiKeyEnvFile.trim().slice(0, 500) || DEFAULTS.apiKeyEnvFile
    : DEFAULTS.apiKeyEnvFile;

  const config = Object.freeze({
    enabled: asBoolean(input.enabled, DEFAULTS.enabled),
    apiBase: resolveHttpsBase(input.apiBase, DEFAULTS.apiBase, 'apiBase', warnings),
    apiKey: typeof input.apiKey === 'string' ? input.apiKey.trim().slice(0, 512) : DEFAULTS.apiKey,
    apiKeyEnvFile,
    apiKeyEnvName: cleanText(input.apiKeyEnvName).slice(0, 80) || DEFAULTS.apiKeyEnvName,
    asrProvider: 'siliconflow',
    asrApiBase: resolveHttpsBase(input.asrApiBase, DEFAULTS.asrApiBase, 'asrApiBase', warnings),
    asrModel: models.asrModel,
    polishModel: models.polishModel,
    capabilityCatalog: typeof input.capabilityCatalog === 'string' && input.capabilityCatalog.trim() !== ''
      ? input.capabilityCatalog.trim().slice(0, 6000)
      : DEFAULTS.capabilityCatalog,
    language: resolveLanguage(input.language),
    defaultMode,
    maxSeconds: clampInt(input.maxSeconds, 5, 120, DEFAULTS.maxSeconds),
    speechTimeoutMs: clampInt(input.speechTimeoutMs, 15000, 180000, DEFAULTS.speechTimeoutMs),
    optimizeTimeoutMs: clampInt(input.optimizeTimeoutMs, 10000, 180000, DEFAULTS.optimizeTimeoutMs),
    maxPromptChars: clampInt(input.maxPromptChars, 200, 200000, DEFAULTS.maxPromptChars),
    maxOutputTokens: clampInt(input.maxOutputTokens, 128, 8192, DEFAULTS.maxOutputTokens),
    polish: asBoolean(input.polish, DEFAULTS.polish),
  });
  return { config, warnings };
}
