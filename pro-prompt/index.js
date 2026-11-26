// pro-prompt (输入增强) — host half.
//
// The browser half is a separate plain-ESM module loaded by the DSH web client.
// This host half owns:
//   - the SiliconFlow ASR client for Qwen/Qwen3-ASR-1.7B;
//   - the SiliconFlow chat client for DeepSeek-V4.1-Flash polish/optimization;
//   - four narrow same-origin routes on the existing webServer;
//   - the optional persistence of the UI's default mode through configEditor.
//
// There is no template store, no prompt history, no audio storage, and no key
// store. "No extra storage" is a product requirement, not only a preference.

import os from 'node:os';
import path from 'node:path';

import { DEFAULTS, resolveConfig } from './lib/config.js';
import { SiliconFlowAsrClient } from './lib/asr.js';
import { SiliconFlowChatClient } from './lib/chat.js';
import { KeyResolver } from './lib/key.js';
import { Optimizer } from './lib/optimize.js';
import { normalizeMode } from './lib/prompts.js';
import { registerRoutes } from './lib/routes.js';
import { VoiceService } from './lib/voice.js';
import { safeMessage } from './lib/errors.js';

/** Required services: the route surface needs the web server at activation. */
export const inject = ['webServer'];

/** Cordis plugin name used by loader diagnostics. */
export const name = 'pro-prompt';

/** Version reported by the package and diagnostics. */
export const VERSION = '1.4.0';

/** Complete default configuration, exported for profile examples. */
export { DEFAULTS };

/** Resolve the profile home the same way the rest of DSH does. */
export function resolveDshHome(env = process.env, homedir = () => os.homedir()) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (configured !== '') return configured;
  try {
    return path.join(homedir(), '.dsh');
  } catch {
    return path.join(process.cwd(), '.dsh');
  }
}

/** Defensive service lookup: activation must not depend on a missing optional service. */
function safeGet(ctx, service) {
  try {
    if (ctx !== null && typeof ctx === 'object' && typeof ctx.get === 'function') {
      const value = ctx.get(service);
      if (value !== undefined) return value;
    }
  } catch {
    // Optional services may be absent or not yet provided.
  }
  try {
    return ctx?.[service];
  } catch {
    return undefined;
  }
}

/** Minimal logger that never throws and keeps one stable prefix. */
function createLogger(ctx) {
  const write = (level, event, detail) => {
    let line = '[pro-prompt] ' + event;
    if (detail !== undefined) {
      try {
        line += ' ' + JSON.stringify(detail);
      } catch {
        line += ' [unserializable detail]';
      }
    }
    try {
      const logger = ctx !== null && typeof ctx === 'object' ? ctx.logger : undefined;
      if (logger !== null && logger !== undefined && typeof logger[level] === 'function') {
        logger[level](line);
        return;
      }
    } catch {
      // Fall through to the console.
    }
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.info(line);
  };
  return (level, event, detail) => write(level, event, detail);
}

/**
 * Persist the default mode in the profile's existing configuration, not in a
 * new file. The config editor owns the write and validates it; when it is not
 * available the value still applies to the current run and the UI says so.
 */
async function persistDefaultMode(ctx, mode, log) {
  let editor;
  let entry;
  try {
    editor = safeGet(ctx, 'configEditor');
    entry = ctx !== null && typeof ctx === 'object' && ctx.fiber !== undefined ? ctx.fiber.entry : undefined;
  } catch {
    editor = undefined;
    entry = undefined;
  }
  if (editor === null || editor === undefined || typeof editor.edit !== 'function' || entry === undefined || entry === null) {
    return { persisted: false, warning: '当前 profile 不支持写入配置；默认模式已在本次运行生效。' };
  }
  try {
    await editor.edit(entry, current => ({
      ...(current || {}),
      proPrompt: {
        ...(current !== null && typeof current === 'object'
          && current.proPrompt !== null && typeof current.proPrompt === 'object' ? current.proPrompt : {}),
        defaultMode: mode,
      },
    }));
    return { persisted: true };
  } catch (error) {
    const detail = safeMessage(error instanceof Error ? error.message : error);
    log('warn', 'pro-prompt.default-mode-save-failed', { message: detail });
    return { persisted: false, warning: '写入配置失败：' + detail + '；默认模式已在本次运行生效。' };
  }
}

/**
 * Host plugin entry.
 * @param {object} ctx - Cordis host context
 * @param {object} [rawConfig] - loader row config
 * @returns {Promise<void>|undefined}
 */
export function apply(ctx, rawConfig) {
  if (ctx === null || typeof ctx !== 'object') return undefined;
  const { config, warnings } = resolveConfig(rawConfig);
  const log = createLogger(ctx);
  for (const warning of warnings) log('warn', 'pro-prompt.config-warning', { warning });
  if (!config.enabled) {
    log('info', 'pro-prompt.disabled');
    return undefined;
  }

  // Runtime config is mutable only for the one UI preference that must change
  // without recreating the services.
  const runtimeConfig = { ...config };
  let defaultPersisted = true;
  const home = resolveDshHome();
  // One SiliconFlow key covers both ASR and chat; it is supplied through the
  // profile-level config or SILICONFLOW_API_KEY.
  const keyResolver = new KeyResolver({ config: runtimeConfig, home });
  const asr = new SiliconFlowAsrClient({ config: runtimeConfig, keyResolver, log });
  const chat = new SiliconFlowChatClient({ config: runtimeConfig, keyResolver, log });
  const voice = new VoiceService({ config: runtimeConfig, asr, chat });
  const optimizer = new Optimizer({ config: runtimeConfig, client: chat });

  const setDefaultMode = async (mode) => {
    const normalized = normalizeMode(mode, runtimeConfig.defaultMode);
    runtimeConfig.defaultMode = normalized;
    const result = await persistDefaultMode(ctx, normalized, log);
    defaultPersisted = result.persisted === true;
    return { mode: normalized, ...result };
  };

  registerRoutes(ctx, {
    config: runtimeConfig,
    voice,
    optimizer,
    getDefaultMode: () => runtimeConfig.defaultMode,
    getDefaultPersisted: () => defaultPersisted,
    setDefaultMode,
    version: VERSION,
    log,
  });

  // Status is read lazily from the reference .env; a missing key is a normal,
  // displayable state, not an activation failure.
  Promise.all([asr.status(), chat.status()]).then(([asrStatus, chatStatus]) => {
    log('info', 'pro-prompt.ready', {
      asrConfigured: asrStatus.configured,
      asrSource: asrStatus.source,
      asrModel: runtimeConfig.asrModel,
      chatConfigured: chatStatus.configured,
      chatSource: chatStatus.source,
      polishModel: runtimeConfig.polishModel,
      defaultMode: runtimeConfig.defaultMode,
    });
  }).catch((error) => {
    log('warn', 'pro-prompt.status-failed', {
      message: safeMessage(error instanceof Error ? error.message : error),
    });
  });

  return undefined;
}
