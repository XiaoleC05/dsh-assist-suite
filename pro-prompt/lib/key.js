// Resolve a configured API key (profile config, optional env file, or process
// environment). It is deliberately not a key store: there is no UI and no
// write path. The key never leaves the host process and is never logged.

import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_KEY_CHARS = 512;

/** Parse one KEY=value line from a dotenv file, including quotes and `export`. */
export function parseEnvValue(text, name) {
  if (typeof text !== 'string' || typeof name !== 'string' || name.trim() === '') return '';
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp('^\\s*(?:export\\s+)?' + escaped + '\\s*=\\s*(.*)$');
  const source = text.replace(/^\uFEFF/, '');
  for (const line of source.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (match === null) continue;
    let value = match[1].trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const closing = value.indexOf(quote, 1);
      value = closing > 0 ? value.slice(1, closing) : value.slice(1);
    } else {
      const comment = value.search(/\s#/);
      if (comment >= 0) value = value.slice(0, comment).trim();
    }
    return value.trim().slice(0, MAX_KEY_CHARS);
  }
  return '';
}

/** A JSON form is accepted too, for a profile that already has one. */
function parseJsonValue(text, name) {
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') return '';
    const key = parsed[name] ?? parsed.siliconflowApiKey ?? parsed.apiKey;
    return typeof key === 'string' ? key.trim().slice(0, MAX_KEY_CHARS) : '';
  } catch {
    return '';
  }
}

/** One read-only resolver over an optional env file and the process env. */
export class KeyResolver {
  /**
   * @param {object} options
   * @param {object} options.config - resolved plugin config
   * @param {string} [options.home] - $DSH_HOME, used for relative paths
   * @param {object} [options.env] - environment seam
   * @param {object} [options.fs] - fs/promises seam
   */
  constructor(options) {
    this.config = options.config;
    this.home = options.home || path.join(os.homedir(), '.dsh');
    this.env = options.env || process.env;
    this.fs = options.fs || fsPromises;
  }

  /** Absolute path of the configured .env file, without exposing it in status. */
  envFile() {
    const configured = typeof this.config.apiKeyEnvFile === 'string' ? this.config.apiKeyEnvFile.trim() : '';
    if (configured === '') return '';
    const expanded = configured === '~' || configured.startsWith('~/') || configured.startsWith('~\\')
      ? path.join(os.homedir(), configured.slice(1))
      : configured;
    return path.isAbsolute(expanded) ? expanded : path.resolve(this.home, expanded);
  }

  /**
   * Resolve the key and a safe source label.
   * Order: explicit config override, optional env file, process environment.
   * @returns {Promise<{key: string, source: 'config'|'env-file'|'env'|'none'}>}
   */
  async resolve() {
    const configured = typeof this.config.apiKey === 'string' ? this.config.apiKey.trim() : '';
    if (configured !== '') return { key: configured.slice(0, MAX_KEY_CHARS), source: 'config' };

    const file = this.envFile();
    if (file !== '') {
      try {
        const text = await this.fs.readFile(file, 'utf8');
        const fromDotenv = parseEnvValue(text, this.config.apiKeyEnvName);
        const fromFile = fromDotenv !== ''
          ? fromDotenv
          : (text.trim().startsWith('{') ? parseJsonValue(text, this.config.apiKeyEnvName) : '');
        if (fromFile !== '') return { key: fromFile, source: 'env-file' };
      } catch {
        // A missing or unreadable reference file falls through to the env.
      }
    }

    const fromEnv = this.env !== null && typeof this.env === 'object' ? this.env[this.config.apiKeyEnvName] : undefined;
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
      return { key: fromEnv.trim().slice(0, MAX_KEY_CHARS), source: 'env' };
    }
    return { key: '', source: 'none' };
  }

  /** Status for the UI; never includes the key or the full path. */
  async status() {
    const resolved = await this.resolve();
    return {
      configured: resolved.key !== '',
      source: resolved.source,
      sourceLabel: resolved.source === 'env-file'
        ? '配置文件'
        : resolved.source === 'env'
          ? '环境变量'
          : resolved.source === 'config'
            ? '插件配置'
            : '未配置',
    };
  }
}
