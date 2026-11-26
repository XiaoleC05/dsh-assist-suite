// pro-prompt — prompt optimization.
//
// One SiliconFlow chat call (DeepSeek-V4.1-Flash) through the same client family.
// The optimizer does not create a session, a turn, or a history record: the
// result goes straight back to the composer (or to the sidebar's status view).

import { ProPromptError } from './errors.js';
import { normalizeMode } from './prompts.js';

export class OptimizeError extends ProPromptError {
  constructor(message, code = 'OPTIMIZE_FAILED', status = 502) {
    super(message, code, status);
    this.name = 'OptimizeError';
  }
}

export class Optimizer {
  /**
   * @param {object} options
   * @param {object} options.config - resolved plugin config
   * @param {object} options.client - SiliconFlowChatClient
   */
  constructor(options) {
    this.config = options.config;
    this.client = options.client;
  }

  /**
   * Optimize one prompt. No confirmation step is implied by this API.
   * @param {{text: string, mode?: string, signal?: AbortSignal}} input
   */
  async optimize(input) {
    const source = typeof input.text === 'string' ? input.text.replace(/\r\n/g, '\n').trim() : '';
    if (source === '') throw new OptimizeError('请先输入要优化的内容', 'TEXT_REQUIRED', 400);
    if (source.length > this.config.maxPromptChars) {
      throw new OptimizeError('输入内容过长，最多 ' + this.config.maxPromptChars + ' 个字符', 'TEXT_TOO_LARGE', 413);
    }
    const mode = normalizeMode(input.mode || this.config.defaultMode, this.config.defaultMode);
    const started = Date.now();
    const result = await this.client.optimize(source, mode, input.signal);
    return { ...result, mode, elapsedMs: Date.now() - started };
  }
}
