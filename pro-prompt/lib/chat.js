// pro-prompt — SiliconFlow chat client for voice polish and prompt optimization.
//
// ASR is a separate SiliconFlow client (lib/asr.js); this client handles the
// selected chat model with the same SiliconFlow key.
//
//   deepseek-ai/DeepSeek-V4.1-Flash  transcript -> polished speech
//                                    prompt draft -> agent-ready prompt
//
// The key is resolved on demand from the profile config or environment. It is
// never logged, never returned to the browser, and never included in an error.

import { ProPromptError, redactSecrets } from './errors.js';
import {
  buildCritiqueBody,
  buildOptimizeBody,
  buildSpeechPolishBody,
  cleanModelText,
  isUsefulOptimizedText,
  isUsefulVoiceText,
  hasPlaceholderOutput,
  MODE_STRUCTURE,
  needsStructureReview,
  normalizeMode,
} from './prompts.js';

export class ChatError extends ProPromptError {
  constructor(message, code = 'CHAT_FAILED', status = 502) {
    super(message, code, status);
    this.name = 'ChatError';
  }
}

/** Join the text parts of an OpenAI-style content field. */
export function contentText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const item of content) {
    if (typeof item === 'string') parts.push(item);
    else if (item !== null && typeof item === 'object') {
      if (typeof item.text === 'string') parts.push(item.text);
      else if (typeof item.transcript === 'string') parts.push(item.transcript);
    }
  }
  return parts.join('').trim();
}

/** Pull the assistant text out of compatible-mode or native response shapes. */
export function extractMessageText(payload) {
  if (payload === null || typeof payload !== 'object') return '';
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  if (choices.length > 0) {
    const message = choices[0] !== null && typeof choices[0] === 'object' ? choices[0].message : null;
    if (message !== null && typeof message === 'object') {
      const text = contentText(message.content);
      if (text !== '') return text;
    }
    if (typeof choices[0].text === 'string') return choices[0].text.trim();
  }
  const output = payload.output;
  if (output !== null && typeof output === 'object') {
    const outputChoices = Array.isArray(output.choices) ? output.choices : [];
    if (outputChoices.length > 0) {
      const message = outputChoices[0] !== null && typeof outputChoices[0] === 'object' ? outputChoices[0].message : null;
      if (message !== null && typeof message === 'object') {
        const text = contentText(message.content);
        if (text !== '') return text;
      }
    }
    if (typeof output.text === 'string') return output.text.trim();
  }
  return '';
}

export class SiliconFlowChatClient {
  /**
   * @param {object} options
   * @param {object} options.config - resolved plugin config
   * @param {object} options.keyResolver - KeyResolver
   * @param {Function} [options.fetchImpl] - fetch seam
   * @param {Function} [options.log] - logger
   */
  constructor(options) {
    this.config = options.config;
    this.keyResolver = options.keyResolver;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.log = typeof options.log === 'function' ? options.log : () => {};
    if (typeof this.fetchImpl !== 'function') throw new Error('pro-prompt needs a fetch implementation');
  }

  /** Key status without the key itself. */
  async status() {
    const keyStatus = await this.keyResolver.status();
    return {
      ...keyStatus,
      enabled: this.config.enabled !== false,
      polishModel: this.config.polishModel,
      language: this.config.language,
      maxSeconds: this.config.maxSeconds,
      polish: this.config.polish !== false,
    };
  }

  /** One same-origin SiliconFlow POST with bounded timeout and redacted failures. */
  async request(body, options = {}) {
    const resolved = await this.keyResolver.resolve();
    if (resolved.key === '') {
      throw new ChatError(
        '未找到 SiliconFlow 密钥（apiKey）。请在 profile 级配置中设置，或设置 SILICONFLOW_API_KEY。',
        'KEY_MISSING',
        503,
      );
    }
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : this.config.speechTimeoutMs;
    const external = options.signal;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const forward = () => controller.abort();
    if (external !== undefined && external !== null) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', forward, { once: true });
    }
    try {
      const response = await this.fetchImpl(this.config.apiBase, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + resolved.key,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      let raw = '';
      try {
        raw = await response.text();
      } catch {
        raw = '';
      }
      let payload = null;
      try {
        payload = raw === '' ? null : JSON.parse(raw);
      } catch {
        payload = null;
      }
      if (!response.ok) throw this.httpError(response.status, payload, raw);
      if (payload === null || typeof payload !== 'object') {
        throw new ChatError('SiliconFlow 返回了无法解析的结果', 'BAD_RESPONSE', 502);
      }
      return payload;
    } catch (error) {
      if (error instanceof ProPromptError) throw error;
      if (timedOut) throw new ChatError('SiliconFlow 服务超时，请稍后重试', 'TIMEOUT', 504);
      if (external !== undefined && external !== null && external.aborted) {
        throw new ChatError('请求已取消', 'ABORTED', 499);
      }
      throw new ChatError('无法连接 SiliconFlow 服务：' + redactSecrets(error instanceof Error ? error.message : error), 'NETWORK', 502);
    } finally {
      clearTimeout(timer);
      if (external !== undefined && external !== null) external.removeEventListener('abort', forward);
    }
  }

  /** Turn an upstream failure into an actionable, redacted error. */
  httpError(status, payload, rawText) {
    const upstream = payload !== null && typeof payload === 'object' && payload.error !== null && typeof payload.error === 'object'
      ? payload.error
      : null;
    const message = upstream !== null && typeof upstream.message === 'string' ? upstream.message : rawText;
    const detail = redactSecrets(message, 240);
    if (status === 401 || status === 403) {
      return new ChatError(
        'SiliconFlow 密钥无效或权限受限；请检查 apiKey 并确认所选 chat 模型可用。',
        'AUTH',
        502,
      );
    }
    if (status === 429) {
      return new ChatError('SiliconFlow 调用过于频繁或额度不足，请稍后重试。', 'RATE_LIMIT', 502);
    }
    if (status === 400 || status === 404) {
      return new ChatError('SiliconFlow 请求参数或模型无效：' + detail, 'BAD_REQUEST', 502);
    }
    if (status >= 500) return new ChatError('SiliconFlow 服务暂时不可用：' + detail, 'UPSTREAM', 502);
    return new ChatError('SiliconFlow 返回错误：' + detail, 'HTTP_ERROR', 502);
  }

  /** Optimize one prompt for agent input with the selected chat model. */
  async optimize(text, mode, signal) {
    const normalized = normalizeMode(mode, this.config.defaultMode);
    const catalog = this.config.capabilityCatalog;
    const body = buildOptimizeBody(text, normalized, this.config.polishModel, this.config.maxOutputTokens, catalog);
    const payload = await this.request(body, { timeoutMs: this.config.optimizeTimeoutMs, signal });
    const candidate = cleanModelText(extractMessageText(payload));
    // In structure mode the candidate may still contain placeholders; the
    // critique pass is allowed to repair them. Only reject an empty/refusal
    // candidate before that pass.
    const candidateCheckMode = normalized === MODE_STRUCTURE ? 'faithful' : normalized;
    if (!isUsefulOptimizedText(candidate, candidateCheckMode)) {
      throw new ChatError('模型没有返回可用的提示词，请重试或换一种说法。', 'EMPTY_OUTPUT', 502);
    }

    // Structure mode gets a second, adversarial review pass: completeness,
    // fabricated facts, placeholder tokens, and capability names. This is the
    // "analyze → build → critique → finalize" loop used by prompt-optimization
    // projects such as TextGrad/OPRO/AdalFlow.
    if (normalized === MODE_STRUCTURE && needsStructureReview(candidate)) {
      try {
        const reviewBody = buildCritiqueBody(text, candidate, this.config.polishModel, this.config.maxOutputTokens, catalog);
        const reviewPayload = await this.request(reviewBody, { timeoutMs: this.config.optimizeTimeoutMs, signal });
        const reviewed = cleanModelText(extractMessageText(reviewPayload));
        if (isUsefulOptimizedText(reviewed, normalized)) {
          return { text: reviewed, mode: normalized, model: body.model, reviewed: true };
        }
        if (hasPlaceholderOutput(reviewed) || hasPlaceholderOutput(candidate)) {
          throw new ChatError('生成结果仍含占位符，未达到“完整提示词”要求，请重试。', 'PLACEHOLDER_OUTPUT', 502);
        }
      } catch (error) {
        if (error instanceof ChatError && error.code === 'PLACEHOLDER_OUTPUT') throw error;
        if (error instanceof ChatError && error.code === 'ABORTED') throw error;
        this.log('warn', 'pro-prompt.structure-review-failed', {
          message: redactSecrets(error instanceof Error ? error.message : error),
        });
        if (hasPlaceholderOutput(candidate)) {
          throw new ChatError('生成结果含占位符，未达到“完整提示词”要求，请重试。', 'PLACEHOLDER_OUTPUT', 502);
        }
      }
    }

    return { text: candidate, mode: normalized, model: body.model, reviewed: false };
  }

  /** Polish one transcript with the built-in speech prompt for the chosen mode. */
  async polish(transcript, mode, signal) {
    const body = buildSpeechPolishBody(transcript, mode, this.config.polishModel);
    const payload = await this.request(body, { timeoutMs: this.config.speechTimeoutMs, signal });
    const cleaned = cleanModelText(extractMessageText(payload));
    return isUsefulVoiceText(cleaned) ? cleaned : '';
  }
}
