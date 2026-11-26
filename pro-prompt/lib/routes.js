// pro-prompt — same-origin JSON routes on the existing DSH web server.
//
// The browser half has no generic host RPC in this build, so it uses the same
// narrow route pattern as other DSH plugins. There are exactly four routes:
//
//   GET  /pro-prompt/status         key status + models + current mode
//   POST /pro-prompt/optimize       one prompt rewrite (SiliconFlow chat)
//   POST /pro-prompt/voice/process  transcribe + polish one WAV
//   POST /pro-prompt/default-mode   persist the UI's default mode
//
// There is deliberately no template route, no history route, and no key-save
// route. Guards: method allow-list, same-origin check, optional connection
// fence, bounded body, no-store responses, and errors that never carry a
// credential or a filesystem path.

import { MODES, MODE_LABELS, normalizeMode } from './prompts.js';
import { ProPromptError } from './errors.js';

export const ROUTE_PREFIX = '/pro-prompt';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_VOICE_BODY_BYTES = 12 * 1024 * 1024;
const MAX_MODE_BODY_BYTES = 64 * 1024;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function headerValue(req, name) {
  if (req === null || typeof req !== 'object' || req.headers === null || typeof req.headers !== 'object') return '';
  const value = req.headers[name];
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  return typeof value === 'string' ? value : '';
}

/** Reject an explicitly cross-site request; missing headers are fine for local tools. */
function originProblem(req, webServer) {
  const site = headerValue(req, 'sec-fetch-site');
  if (site !== '' && site !== 'same-origin' && site !== 'none') return { status: 403, code: 'FOREIGN_ORIGIN' };
  const origin = headerValue(req, 'origin').trim();
  if (origin === '') return null;
  let originHost = '';
  try {
    originHost = new URL(origin).host;
  } catch {
    return { status: 403, code: 'FOREIGN_ORIGIN' };
  }
  const host = headerValue(req, 'host');
  if (host !== '') return originHost === host ? null : { status: 403, code: 'FOREIGN_ORIGIN' };
  try {
    const expected = typeof webServer?.getOrigin === 'function' ? new URL(webServer.getOrigin()) : undefined;
    if (expected !== undefined && originHost === expected.host) return null;
  } catch {
    // getOrigin may throw before the listener binds; reject below.
  }
  return { status: 403, code: 'FOREIGN_ORIGIN' };
}

/** Run the optional connection fence, if this host exposes one. */
function rejectedByConnection(ctx, req, res) {
  let connection;
  try {
    connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined;
  } catch {
    connection = undefined;
  }
  if (connection === null || typeof connection !== 'object' || typeof connection.requestRejection !== 'function') return false;
  let rejection;
  try {
    rejection = connection.requestRejection(req);
  } catch {
    return false;
  }
  if (rejection === undefined || rejection === null || rejection === false) return false;
  const status = typeof rejection === 'number' ? rejection : typeof rejection.status === 'number' ? rejection.status : 403;
  res.statusCode = status;
  res.setHeader('cache-control', 'no-store');
  res.end();
  return true;
}

function sendJson(req, res, status, payload) {
  const text = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('content-length', String(Buffer.byteLength(text, 'utf8')));
  if (req.method === 'HEAD') res.end();
  else res.end(text);
}

function sendError(req, res, status, code, message) {
  sendJson(req, res, status, { ok: false, error: { code, message } });
}

/** Read a bounded JSON body from a Node request stream. */
async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object') return req.body;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > maxBytes) throw new HttpError(413, 'BODY_TOO_LARGE', 'request body is too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'INVALID_BODY', 'request body must be a JSON object');
    }
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'INVALID_JSON', 'request body is not valid JSON');
  }
}

/** Map a thrown error to a safe envelope; never leak a stack or a path. */
function mapError(error) {
  if (error instanceof HttpError) return { status: error.status, code: error.code, message: error.message };
  if (error instanceof ProPromptError) {
    if (error.code === 'ABORTED') return { status: 499, code: 'ABORTED', message: '请求已取消' };
    return { status: error.status, code: error.code, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 500, code: 'INTERNAL', message: message.length > 300 ? message.slice(0, 300) : message };
}

/** Remove a path-looking prefix from an error message before it reaches the browser. */
function safeMessage(value) {
  return String(value ?? '').replace(/[A-Za-z]:[\\/][^\s'"]+/g, '[path]').slice(0, 300);
}

function buildStatus(voiceStatus, context) {
  return {
    ...voiceStatus,
    defaultMode: context.getDefaultMode(),
    defaultPersisted: context.getDefaultPersisted ? context.getDefaultPersisted() : true,
    modes: MODES.map(id => ({ id, label: MODE_LABELS[id] })),
    version: context.version,
  };
}

/** Build one route handler. */
function createHandler(route, context) {
  return function handler(req, res) {
    const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET';
    const expected = route.method;
    const allowed = expected === 'GET' ? ['GET', 'HEAD'] : [expected];
    if (!allowed.includes(method)) {
      res.statusCode = 405;
      res.setHeader('allow', allowed.join(', '));
      res.setHeader('cache-control', 'no-store');
      res.end();
      return undefined;
    }
    if (rejectedByConnection(context.ctx, req, res)) return undefined;
    const origin = originProblem(req, context.webServer);
    if (origin !== null) {
      sendError(req, res, origin.status, origin.code, '跨站请求被拒绝');
      return undefined;
    }
    const run = async () => {
      try {
        const payload = await route.run({ ...context, req, method });
        sendJson(req, res, 200, { ok: true, data: payload });
      } catch (error) {
        const mapped = mapError(error);
        sendError(req, res, mapped.status, mapped.code, mapped.status >= 500 ? safeMessage(mapped.message) : mapped.message);
      }
    };
    return run().catch((error) => {
      try {
        sendError(req, res, 500, 'INTERNAL', safeMessage(error instanceof Error ? error.message : error));
      } catch {
        // The socket is already gone.
      }
    });
  };
}

/**
 * Register every route on the optional web server.
 * @param {object} ctx - host plugin context
 * @param {object} options - { voice, optimizer, config, getDefaultMode, setDefaultMode, version, log }
 * @returns {() => void} disposer
 */
export function registerRoutes(ctx, options) {
  const { voice, optimizer } = options;
  const log = typeof options.log === 'function' ? options.log : () => {};
  let webServer;
  try {
    webServer = typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined;
  } catch {
    webServer = undefined;
  }
  if (webServer === undefined) {
    try {
      webServer = ctx?.webServer;
    } catch {
      webServer = undefined;
    }
  }
  if (webServer === null || webServer === undefined || typeof webServer.register !== 'function') {
    log('warn', 'pro-prompt.no-web-server');
    return () => {};
  }
  const context = {
    ctx,
    webServer,
    voice,
    optimizer,
    config: options.config,
    getDefaultMode: options.getDefaultMode,
    getDefaultPersisted: options.getDefaultPersisted,
    setDefaultMode: options.setDefaultMode,
    version: options.version,
  };

  const routes = [
    {
      name: 'status', method: 'GET', path: ROUTE_PREFIX + '/status',
      async run() {
        const voiceStatus = await voice.status();
        return buildStatus(voiceStatus, context);
      },
    },
    {
      name: 'optimize', method: 'POST', path: ROUTE_PREFIX + '/optimize',
      async run({ req }) {
        const body = await readJsonBody(req);
        const text = typeof body.text === 'string' ? body.text.replace(CONTROL_CHARS, ' ').trim() : '';
        if (text === '') throw new HttpError(400, 'TEXT_REQUIRED', '请先输入要优化的内容');
        if (text.length > context.config.maxPromptChars) {
          throw new HttpError(413, 'TEXT_TOO_LARGE', '输入内容过长，最多 ' + context.config.maxPromptChars + ' 个字符');
        }
        return await optimizer.optimize({ text, mode: body.mode });
      },
    },
    {
      name: 'voice-process', method: 'POST', path: ROUTE_PREFIX + '/voice/process',
      async run({ req }) {
        const body = await readJsonBody(req, MAX_VOICE_BODY_BYTES);
        if (typeof body.audio !== 'string' || body.audio.trim() === '') {
          throw new HttpError(400, 'VOICE_AUDIO_REQUIRED', '缺少录音数据');
        }
        return await voice.process({
          audioBase64: body.audio,
          mode: body.mode,
          language: body.language,
        });
      },
    },
    {
      name: 'default-mode', method: 'POST', path: ROUTE_PREFIX + '/default-mode',
      async run({ req }) {
        const body = await readJsonBody(req, MAX_MODE_BODY_BYTES);
        const requested = typeof body.mode === 'string' ? body.mode.trim() : '';
        const known = requested === 'faithful' || requested === 'structure'
          || requested === '保真润色' || requested === '结构优化';
        if (!known) throw new HttpError(400, 'MODE_INVALID', '模式只能是保真润色或结构优化');
        return await context.setDefaultMode(normalizeMode(requested));
      },
    },
  ];

  const disposers = [];
  for (const route of routes) {
    const handler = createHandler(route, context);
    const register = () => webServer.register({ kind: 'exact', path: route.path, handler });
    try {
      const dispose = typeof ctx?.effect === 'function'
        ? ctx.effect(register, 'pro-prompt:route:' + route.name)
        : register();
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (error) {
      log('error', 'pro-prompt.route-register-failed', {
        path: route.path,
        message: safeMessage(error instanceof Error ? error.message : error),
      });
    }
  }
  if (disposers.length > 0) log('info', 'pro-prompt.routes-ready', { count: disposers.length });
  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // Teardown must never throw.
      }
    }
  };
}

export const internals = { originProblem, readJsonBody, mapError, safeMessage, MAX_BODY_BYTES, MAX_VOICE_BODY_BYTES };
