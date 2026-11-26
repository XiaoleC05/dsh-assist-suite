// pro-prompt — SiliconFlow ASR adapter.
//
// The selected model is Qwen/Qwen3-ASR-1.7B, served by SiliconFlow's
// OpenAI-compatible audio transcription endpoint:
//
//   POST https://api.siliconflow.cn/v1/audio/transcriptions
//   multipart/form-data: file=<wav>, model=Qwen/Qwen3-ASR-1.7B, language=zh
//
// This is deliberately separate from the chat client so each model can keep
// its own request shape. Both use the same SiliconFlow key; the key is never
// written into the package or returned to the browser.

import { ProPromptError, redactSecrets, safeMessage } from './errors.js';

export class AsrError extends ProPromptError {
  constructor(message, code = 'ASR_FAILED', status = 502) {
    super(message, code, status);
    this.name = 'AsrError';
  }
}

/** Extract the transcript from a SiliconFlow/OpenAI transcription payload. */
export function extractTranscript(payload) {
  if (payload === null || typeof payload !== 'object') return '';
  if (typeof payload.text === 'string') return payload.text.replace(/\s+/g, ' ').trim();
  const candidates = [
    payload.output,
    payload.result,
    payload.data,
  ];
  for (const candidate of candidates) {
    if (candidate !== null && typeof candidate === 'object' && typeof candidate.text === 'string') {
      return candidate.text.replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}

/** Join a configured base URL and an endpoint path without duplicate slashes. */
function endpoint(base, path) {
  return String(base).replace(/\/+$/, '') + path;
}

export class SiliconFlowAsrClient {
  /**
   * @param {object} options
   * @param {object} options.config - resolved plugin config
   * @param {object} options.keyResolver - KeyResolver bound to the ASR fields
   * @param {Function} [options.fetchImpl] - fetch seam
   * @param {Function} [options.log] - logger
   */
  constructor(options) {
    this.config = options.config;
    this.keyResolver = options.keyResolver;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.log = typeof options.log === 'function' ? options.log : () => {};
    if (typeof this.fetchImpl !== 'function') throw new Error('pro-prompt ASR needs a fetch implementation');
  }

  /** Status for the UI; only the safe source label, never the key. */
  async status() {
    const keyStatus = await this.keyResolver.status();
    return {
      ...keyStatus,
      provider: 'SiliconFlow',
      asrModel: this.config.asrModel,
    };
  }

  /** One multipart transcription request. */
  async transcribe(audioBase64, language, signal) {
    const resolved = await this.keyResolver.resolve();
    if (resolved.key === '') {
      throw new AsrError('未配置 SiliconFlow 语音识别密钥（asrApiKey）', 'ASR_KEY_MISSING', 503);
    }
    let buffer;
    try {
      buffer = Buffer.from(String(audioBase64 ?? '').replace(/^data:audio\/[^;]+;base64,/, ''), 'base64');
    } catch {
      throw new AsrError('录音数据不是有效的 Base64', 'VOICE_INVALID_AUDIO', 400);
    }
    if (buffer.length === 0) throw new AsrError('缺少录音数据', 'VOICE_AUDIO_REQUIRED', 400);

    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', this.config.asrModel);
    if (language === 'zh' || language === 'en') form.append('language', language);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.config.speechTimeoutMs);
    const forward = () => controller.abort();
    if (signal !== undefined && signal !== null) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', forward, { once: true });
    }
    try {
      const response = await this.fetchImpl(endpoint(this.config.asrApiBase, '/audio/transcriptions'), {
        method: 'POST',
        headers: { authorization: 'Bearer ' + resolved.key },
        body: form,
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
        throw new AsrError('SiliconFlow 返回了无法解析的结果', 'ASR_BAD_RESPONSE', 502);
      }
      const text = extractTranscript(payload);
      if (text === '') {
        throw new AsrError('没有识别到内容，请再说一次', 'VOICE_NO_SPEECH', 422);
      }
      return {
        text,
        model: this.config.asrModel,
        provider: 'SiliconFlow',
        language: typeof payload.language === 'string' ? payload.language : language,
      };
    } catch (error) {
      if (error instanceof ProPromptError) throw error;
      if (timedOut) throw new AsrError('语音识别服务超时，请稍后重试', 'ASR_TIMEOUT', 504);
      if (signal !== undefined && signal !== null && signal.aborted) {
        throw new AsrError('语音识别请求已取消', 'ABORTED', 499);
      }
      throw new AsrError('无法连接 SiliconFlow 语音识别服务：' + redactSecrets(error instanceof Error ? error.message : error), 'ASR_NETWORK', 502);
    } finally {
      clearTimeout(timer);
      if (signal !== undefined && signal !== null) signal.removeEventListener('abort', forward);
    }
  }

  /** Turn a SiliconFlow failure into an actionable, redacted error. */
  httpError(status, payload, rawText) {
    const upstream = payload !== null && typeof payload === 'object' && payload.error !== null && typeof payload.error === 'object'
      ? payload.error
      : null;
    const message = upstream !== null && typeof upstream.message === 'string' ? upstream.message : rawText;
    const detail = redactSecrets(message, 240);
    if (status === 401 || status === 403) {
      return new AsrError('SiliconFlow 密钥无效或权限受限；请检查 asrApiKey 并确认 Qwen/Qwen3-ASR-1.7B 可用。', 'ASR_AUTH', 502);
    }
    if (status === 429) return new AsrError('SiliconFlow 调用过于频繁或额度不足，请稍后重试。', 'ASR_RATE_LIMIT', 502);
    if (status === 400 || status === 404) {
      return new AsrError('SiliconFlow 请求参数或模型无效：' + detail, 'ASR_BAD_REQUEST', 502);
    }
    if (status >= 500) return new AsrError('SiliconFlow 服务暂时不可用：' + detail, 'ASR_UPSTREAM', 502);
    return new AsrError('SiliconFlow 返回错误：' + detail, 'ASR_HTTP', 502);
  }
}

export const internals = { extractTranscript, endpoint, safeMessage };
