// pro-prompt — voice input.
//
// Chain: browser records 16 kHz mono PCM16 WAV -> host validates the WAV ->
// SiliconFlow Qwen/Qwen3-ASR-1.7B transcribes -> SiliconFlow DeepSeek-V4.1-Flash polishes
// with the built-in speech polish prompts. Audio is decoded in memory and never
// persisted. No history is kept.

import { ProPromptError, safeMessage } from './errors.js';
import { isFillerOnly, isUsefulVoiceText, normalizeMode } from './prompts.js';

export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
export const MIN_AUDIO_MS = 500;
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

export class VoiceError extends ProPromptError {
  constructor(message, code = 'VOICE_FAILED', status = 502) {
    super(message, code, status);
    this.name = 'VoiceError';
  }
}

/** Decode a data URI or bare base64 payload into a bounded Buffer. */
export function decodeAudioBase64(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new VoiceError('缺少录音数据', 'VOICE_AUDIO_REQUIRED', 400);
  }
  let base64 = value.trim();
  if (base64.startsWith('data:')) {
    const comma = base64.indexOf(',');
    if (comma === -1 || !/^data:audio\/[a-z0-9.+-]+;base64$/i.test(base64.slice(0, comma))) {
      throw new VoiceError('音频 Data URI 无效', 'VOICE_INVALID_AUDIO', 400);
    }
    base64 = base64.slice(comma + 1);
  }
  base64 = base64.replace(/\s+/g, '');
  if (base64.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4) {
    throw new VoiceError('录音文件过大', 'VOICE_AUDIO_TOO_LARGE', 413);
  }
  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    throw new VoiceError('录音数据不是有效的 Base64', 'VOICE_INVALID_AUDIO', 400);
  }
  if (buffer.length === 0) throw new VoiceError('缺少录音数据', 'VOICE_AUDIO_REQUIRED', 400);
  if (buffer.length > MAX_AUDIO_BYTES) throw new VoiceError('录音文件过大', 'VOICE_AUDIO_TOO_LARGE', 413);
  return buffer;
}

/** Validate a canonical 16 kHz mono PCM16 WAV and return its shape. */
export function parseWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
    throw new VoiceError('音频格式无效', 'VOICE_INVALID_AUDIO', 400);
  }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new VoiceError('音频格式无效：需要 WAV', 'VOICE_INVALID_AUDIO', 400);
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;
    if (payloadOffset + size > buffer.length) {
      throw new VoiceError('音频数据不完整', 'VOICE_INVALID_AUDIO', 400);
    }
    if (id === 'fmt ') {
      if (size < 16) throw new VoiceError('音频格式头无效', 'VOICE_INVALID_AUDIO', 400);
      fmt = {
        audioFormat: buffer.readUInt16LE(payloadOffset),
        channels: buffer.readUInt16LE(payloadOffset + 2),
        sampleRate: buffer.readUInt32LE(payloadOffset + 4),
        byteRate: buffer.readUInt32LE(payloadOffset + 8),
        blockAlign: buffer.readUInt16LE(payloadOffset + 12),
        bitsPerSample: buffer.readUInt16LE(payloadOffset + 14),
      };
    } else if (id === 'data') {
      data = { offset: payloadOffset, size };
    }
    offset = payloadOffset + size + (size % 2);
  }
  if (fmt === null || data === null) throw new VoiceError('音频缺少格式或数据块', 'VOICE_INVALID_AUDIO', 400);
  if (fmt.audioFormat !== 1 || fmt.channels !== CHANNELS || fmt.bitsPerSample !== BITS_PER_SAMPLE || fmt.sampleRate !== SAMPLE_RATE) {
    throw new VoiceError('音频需要 16 kHz 单声道 16 位 PCM', 'VOICE_INVALID_AUDIO', 400);
  }
  if (fmt.blockAlign !== CHANNELS * (BITS_PER_SAMPLE / 8)) {
    throw new VoiceError('音频块对齐无效', 'VOICE_INVALID_AUDIO', 400);
  }
  const durationMs = Math.round((data.size / (SAMPLE_RATE * CHANNELS * 2)) * 1000);
  return { sampleRate: SAMPLE_RATE, channels: CHANNELS, bitsPerSample: BITS_PER_SAMPLE, dataSize: data.size, durationMs };
}

export class VoiceService {
  /**
   * @param {object} options
   * @param {object} options.config - resolved plugin config
   * @param {object} options.asr - SiliconFlowAsrClient
   * @param {object} options.chat - SiliconFlowChatClient
   * @param {Function} [options.now] - clock seam
   */
  constructor(options) {
    this.config = options.config;
    this.asr = options.asr;
    this.chat = options.chat;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
  }

  /** UI status: separate ASR and chat key states, never the keys themselves. */
  async status() {
    const [asrStatus, chatStatus] = await Promise.all([this.asr.status(), this.chat.status()]);
    return {
      enabled: this.config.enabled !== false,
      configured: chatStatus.configured === true,
      source: chatStatus.source,
      sourceLabel: chatStatus.sourceLabel,
      asrConfigured: asrStatus.configured === true,
      asrSource: asrStatus.source,
      asrSourceLabel: asrStatus.sourceLabel,
      asrProvider: 'SiliconFlow',
      asrModel: this.config.asrModel,
      polishModel: this.config.polishModel,
      language: this.config.language,
      maxSeconds: this.config.maxSeconds,
      polish: this.config.polish !== false,
      defaultMode: this.config.defaultMode,
    };
  }

  /**
   * Transcribe and (optionally) polish one canonical WAV.
   * @param {{audioBase64: string, mode?: string, language?: string, signal?: AbortSignal}} input
   */
  async process(input) {
    if (this.config.enabled === false) throw new VoiceError('语音输入已禁用', 'VOICE_DISABLED', 503);
    const buffer = decodeAudioBase64(input.audioBase64);
    const wav = parseWav(buffer);
    if (wav.durationMs < MIN_AUDIO_MS) throw new VoiceError('录音太短，请再说一次', 'VOICE_TOO_SHORT', 422);
    if (wav.durationMs > this.config.maxSeconds * 1000 + 800) {
      throw new VoiceError('录音超过 ' + this.config.maxSeconds + ' 秒上限', 'VOICE_TOO_LONG', 413);
    }
    const audioBase64 = buffer.toString('base64');
    const language = input.language === 'auto' || input.language === 'en' || input.language === 'zh'
      ? input.language
      : this.config.language;
    const mode = normalizeMode(input.mode || this.config.defaultMode, this.config.defaultMode);
    const started = this.now();
    const asr = await this.asr.transcribe(audioBase64, language, input.signal);
    const transcript = asr.text;
    const asrMs = this.now() - started;

    if (isFillerOnly(transcript)) {
      return {
        transcript,
        text: '',
        mode,
        engine: 'asr',
        empty: true,
        durationMs: wav.durationMs,
        timings: { asrMs, polishMs: 0 },
        asrModel: this.config.asrModel,
        asrProvider: 'SiliconFlow',
        polishModel: this.config.polishModel,
        language,
      };
    }

    let text = transcript;
    let engine = 'asr';
    let warning;
    let polishMs = 0;
    if (this.config.polish !== false) {
      const polishStarted = this.now();
      try {
        const polished = await this.chat.polish(transcript, mode, input.signal);
        polishMs = this.now() - polishStarted;
        if (polished === '') {
          // The transcript is meaningful enough to transcribe but the polish
          // model declined to return text. Keep the recognized text rather than
          // throwing away what the user said.
          warning = '润色未返回有效内容，已保留识别原文';
        } else {
          text = polished;
          engine = 'siliconflow';
        }
      } catch (error) {
        if (error instanceof ProPromptError && error.code === 'ABORTED') throw error;
        warning = safeMessage(error instanceof Error ? error.message : error);
        text = transcript;
        engine = 'asr';
      }
    }

    // A polish answer that is only filler is treated as no meaningful content.
    if (text !== '' && isFillerOnly(text)) text = '';

    return {
      transcript,
      text,
      mode,
      engine,
      empty: text === '',
      ...(warning === undefined ? {} : { warning }),
      durationMs: wav.durationMs,
      timings: { asrMs, polishMs },
      asrModel: this.config.asrModel,
      asrProvider: 'SiliconFlow',
      polishModel: this.config.polishModel,
      language,
    };
  }
}

/** Kept for tests and future adapters. */
export function isUsablePolishedText(value) {
  return isUsefulVoiceText(value);
}
