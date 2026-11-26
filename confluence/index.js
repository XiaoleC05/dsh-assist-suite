// Confluence / 高级记忆 — Host plugin entry (v0.3: workspace bus + user profile).
//
// Wires the modules onto the live Cordis context. v0.3 scope decision
// (ADR-0008): TWO coexisting scopes —
//   * workspace: frozen from the session's original cwd; shared context, notes
//     and addressed messages (the session bus). Not merged across workspaces.
//   * global: the durable user profile, plus the metadata-only session ledger
//     and presence heartbeats that stay profile-wide.
//
//   config -> origin resolver (ledger provenance) -> journal store
//          -> board / context / bus (workspace services)
//          -> profile (global) -> ledger / presence -> watermark
//          -> facade -> six model tools
//          -> two prompt contributions (confluence:profile, confluence:pulse)
//          -> read-only panel routes (optional `webServer`)
//
// Constraints: plain ESM + Node builtins only; no static `@deepseek-ai/*`
// imports; no network calls; no additional listening port; no child processes;
// no model calls. Shared content is untrusted data: bounded, escaped, redacted.
//
// Activation is asynchronous (store/projection attachment is I/O): `apply()`
// starts the bootstrap and returns. A bootstrap failure is logged and degrades
// to "plugin inactive", never a thrown plugin.

import fsSync from 'node:fs'
import fsPromises from 'node:fs/promises'

import { ConfluenceError, createLogger, isoNow, makeWriterId } from './lib/util.js'
import { DEFAULTS, publicConfig, resolveConfig } from './lib/config.js'
import { canonicalizeDir, createOriginResolver } from './lib/workspace.js'
import { GLOBAL_SCOPE_KEY, JournalStore } from './lib/store.js'
import { createRedactor } from './lib/redact.js'
import { BoardService } from './lib/board.js'
import { ContextService } from './lib/context.js'
import { MessageBus } from './lib/bus.js'
import { ProfileService } from './lib/profile.js'
import { MemoryService } from './lib/memory.js'
import { StyleService } from './lib/style.js'
import { SessionLedger } from './lib/ledger.js'
import { Presence } from './lib/presence.js'
import { WatermarkTracker } from './lib/watermark.js'
import {
  MEMORY_CONTEXT_NAME,
  MEMORY_CONTEXT_ORDER,
  PROFILE_CONTEXT_NAME,
  PROFILE_CONTEXT_ORDER,
  PulseService,
  STYLE_CONTEXT_NAME,
  STYLE_CONTEXT_ORDER,
} from './lib/pulse.js'
import { RecallService } from './lib/recall.js'
import { createTools, registerTools } from './lib/tools.js'
import { registerHostUi } from './lib/hostui.js'
import { ConfluenceFacade, PROFILE_SCOPE } from './lib/facade.js'

/** One bounded onboarding block for the profile contribution while the profile is empty. */
const PROFILE_EMPTY_NUDGE = [
  '<confluence-profile status="empty" facts="0">',
  'No user persona facts recorded yet. When the user reveals a durable individual trait (identity, personality, communication style, habit, boundary, taste), record it with confluence_profile (never store secrets).',
  '</confluence-profile>',
].join('\n')

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'confluence'

/** Required services: the tool registry is the plugin's primary surface. */
export const inject = ['tools']

/** Complete v3 default configuration (single source of truth: lib/config.js). */
export { DEFAULTS }

/** Plugin version reported by the panel ping route. */
export const VERSION = '0.4.0'

/**
 * Host plugin entry.
 * @param {object} ctx Cordis plugin context
 * @param {object} [rawConfig] Loader row config (defensive object; see lib/config.js)
 * @returns {undefined}
 */
export function apply(ctx, rawConfig) {
  if (ctx === null || typeof ctx !== 'object') return undefined
  /** @type {{disposed: boolean, booted: boolean, services: object | null}} */
  const state = { disposed: false, booted: false, services: null }

  const boot = bootstrap(ctx, rawConfig).then(
    (services) => {
      if (state.disposed) {
        services.dispose()
        return
      }
      state.services = services
      state.booted = true
      if (typeof ctx.effect === 'function') {
        ctx.effect(
          () => () => {
            state.disposed = true
            try {
              services.dispose()
            } catch {
              // Teardown must never throw.
            }
          },
          'confluence:lifecycle',
        )
      }
    },
    (error) => {
      state.disposed = true
      logActivationFailure(ctx, error)
    },
  )

  return boot.then(() => undefined)
}

/**
 * Test/embedding seam: same activation with injected service seams.
 * @param {object} ctx Cordis-like context (`get`, `on`, `effect`)
 * @param {object} [rawConfig]
 * @param {object} [deps]
 * @returns {Promise<object>} services handle (has `dispose()`/`disposeAsync()`)
 */
export async function applyWithDeps(ctx, rawConfig, deps = {}) {
  return await bootstrap(ctx, rawConfig, deps)
}

/**
 * @param {object} ctx
 * @param {object} [rawConfig]
 * @param {object} [injected]
 * @returns {Promise<object>}
 */
async function bootstrap(ctx, rawConfig, injected = {}) {
  const { config, warnings } = resolveConfig(rawConfig)
  const logger = createLogger(true, createLogSink(config, injected))
  for (const warning of warnings) logger.warn({ event: 'confluence.config.warning', warning })

  const deps = {
    fs: injected.fs ?? fsPromises,
    fsSync: injected.fsSync ?? fsSync,
    now: typeof injected.now === 'function' ? injected.now : () => Date.now(),
    random: typeof injected.random === 'function' ? injected.random : Math.random,
    pid: injected.pid ?? process.pid,
    ...injected.deps,
  }

  const safeGet = (serviceName) => {
    try {
      if (ctx && typeof ctx.get === 'function') return ctx.get(serviceName)
    } catch {
      return undefined
    }
    return undefined
  }

  const originResolver =
    injected.originResolver ??
    createOriginResolver({
      workingDirectory: safeGet('workingDirectory') ?? null,
      fs: deps.fs,
      platform: process.platform,
    })

  const store = injected.store ?? new JournalStore({ config, logger, deps })
  const redactor = injected.redactor ?? createRedactor(config, { logger })

  const board =
    injected.board ??
    new BoardService({ store, config, redactor, logger, deps: { now: deps.now } })
  const context =
    injected.context ??
    new ContextService({ store, config, redactor, logger, deps: { now: deps.now } })
  const bus =
    injected.bus ?? new MessageBus({ store, config, redactor, logger, deps: { now: deps.now } })
  const profile =
    injected.profile ??
    new ProfileService({ store, config, redactor, logger, deps: { now: deps.now } })
  const memory =
    injected.memory ??
    new MemoryService({ store, config, redactor, logger, deps: { now: deps.now } })
  const style =
    injected.style ?? new StyleService({ store, config, redactor, logger, deps: { now: deps.now } })

  const ledgerDeps = {
    now: deps.now,
    originResolver,
    workspaceResolver: originResolver, // legacy alias; provenance only
    canonicalizeDir: (raw) => canonicalizeDir(raw, { fs: deps.fs, platform: process.platform }),
    redactor,
    getService: safeGet,
  }
  const ledger = injected.ledger ?? new SessionLedger({ store, config, logger, deps: ledgerDeps })
  const presence =
    injected.presence ??
    new Presence({
      store,
      config,
      logger,
      deps: { now: deps.now, plugin: { name: 'dsh-confluence', version: VERSION } },
    })
  const watermark = injected.watermark ?? new WatermarkTracker({ config, logger, deps: { now: deps.now } })

  const sessionQuery = safeGet('sessionQuery') ?? null
  const sessionTitle = safeGet('sessionTitle') ?? null
  const recall =
    injected.recall ??
    new RecallService({
      config,
      logger,
      deps: {
        sessionQuery,
        getSessionQuery: () => safeGet('sessionQuery') ?? null,
        redactor,
        now: deps.now,
        canonicalizeDir: (raw) => canonicalizeDir(raw, { fs: deps.fs, platform: process.platform }),
      },
    })

  /** @type {Array<() => void>} */
  const disposers = []
  const disposeOnce = (() => {
    let done = false
    return () => {
      if (done) return
      done = true
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose()
        } catch {
          // Teardown is best-effort.
        }
      }
    }
  })()

  /** @type {ConfluenceFacade} */
  const facade =
    injected.facade ??
    new ConfluenceFacade({
      config,
      logger,
      store,
      board,
      context,
      bus,
      profile,
      memory,
      style,
      presence,
      watermark,
      redactor,
      recall,
      sessionQuery,
      sessionTitle,
      getService: safeGet,
      fs: deps.fs,
      onChanged: () => {
        // Read paths are pull-based (pulse/tools/panel); nothing to push here.
      },
    })

  const pulse =
    injected.pulse ??
    new PulseService({
      config,
      logger,
      deps: {
        getAgentScope: (agent) => facade.scopeForAgent(agent),
        getBusView: (scopeKey) => facade.busView(scopeKey),
        getCursor: (sessionId) => {
          const session = facade.sessionFor(sessionId)
          return session === null ? null : watermark.get(session)
        },
        now: deps.now,
      },
    })

  // ── host events: session tracking + workspace warm-up ──────────────────
  const onAgentCreated = (payload) => {
    try {
      const agent = payload && payload.agent
      const session = agent && agent.session
      if (session) facade.trackSession(session)
      if (agent) {
        void facade
          .ensureReady(agent)
          .catch(() => {
            // A session without a workspace still gets the profile.
          })
      }
    } catch {
      // Event handlers must never throw into the host.
    }
  }
  const onSessionEvent = (session) => {
    try {
      if (session) facade.trackSession(session)
    } catch {
      // Event handlers must never throw into the host.
    }
  }
  const onSessionDisposed = (payload) => {
    try {
      const sessionId = payload && (payload.sessionId ?? (payload.session && payload.session.id))
      if (typeof sessionId === 'string') {
        facade.sessions.delete(sessionId)
        facade.scopes.delete(sessionId)
      }
    } catch {
      // Event handlers must never throw into the host.
    }
  }

  const offAgentCreated = ctx.on('agent/created', onAgentCreated)
  if (typeof offAgentCreated === 'function') disposers.push(offAgentCreated)
  const offSessionEvent = ctx.on('session/event', onSessionEvent)
  if (typeof offSessionEvent === 'function') disposers.push(offSessionEvent)
  try {
    const offDisposed = ctx.on('session/disposed', onSessionDisposed)
    if (typeof offDisposed === 'function') disposers.push(offDisposed)
  } catch {
    // Optional event.
  }

  // ── component attachment (synchronous registrations only) ──────────────
  try {
    const offLedger = ledger.attach(ctx)
    if (typeof offLedger === 'function') disposers.push(offLedger)
  } catch (error) {
    logger.warn({ event: 'confluence.ledger.attach-failed', message: String(error) })
  }

  const listLiveSessions = () => {
    const agents = safeGet('agents')
    const rows = []
    if (!agents || typeof agents.list !== 'function') return rows
    const titleService = safeGet('sessionTitle')
    try {
      for (const agent of agents.list() || []) {
        const session = agent && agent.session
        const sessionId = session && session.id
        if (typeof sessionId !== 'string' || sessionId === '') continue
        const origin = facade.originFor(sessionId)
        let title = ''
        try {
          if (titleService && typeof titleService.get === 'function') {
            const snapshot = titleService.get(session)
            const raw = snapshot && typeof snapshot === 'object' ? snapshot.title : snapshot
            if (typeof raw === 'string') title = raw
          }
        } catch {
          title = ''
        }
        if (title === '' && session && session.header && typeof session.header.title === 'string') {
          title = session.header.title
        }
        rows.push({
          id: sessionId,
          sessionId,
          title,
          workspaceLabel: origin === null ? '' : String(origin.workspaceLabel ?? ''),
          workspaceKey: origin === null ? '' : String(origin.workspaceKey ?? ''),
          status: typeof agent.status === 'string' ? agent.status : 'idle',
        })
      }
    } catch {
      // Presence degrades to "no peers".
    }
    return rows
  }
  try {
    const offPresence = presence.attach(ctx, listLiveSessions)
    if (typeof offPresence === 'function') disposers.push(offPresence)
  } catch (error) {
    logger.warn({ event: 'confluence.presence.attach-failed', message: String(error) })
  }
  try {
    pulse.attach(ctx)
  } catch (error) {
    logger.warn({ event: 'confluence.pulse.attach-failed', message: String(error) })
  }

  // ── prompt contributions: persona, long-term memory, style cards ───────
  // All three are global, synchronous, bounded and exception-safe. The persona
  // block falls back to a short onboarding nudge while the persona is empty.
  try {
    const systemPrompt = safeGet('systemPrompt')
    if (systemPrompt && typeof systemPrompt.context === 'function') {
      const contributions = [
        {
          name: PROFILE_CONTEXT_NAME,
          order: PROFILE_CONTEXT_ORDER,
          text: (assembleContext) => {
            const agent = assembleContext && typeof assembleContext === 'object' ? assembleContext.agent : undefined
            if (agent !== undefined && facade.isPrivateSession(agent)) return ''
            if (!config.profile || config.profile.enabled === false) return ''
            if (config.profile.inject === false) return ''
            const rendered = facade.profileRender()
            return rendered === '' ? PROFILE_EMPTY_NUDGE : rendered
          },
        },
        {
          name: MEMORY_CONTEXT_NAME,
          order: MEMORY_CONTEXT_ORDER,
          text: (assembleContext) =>
            facade.memoryRender(
              assembleContext && typeof assembleContext === 'object' ? assembleContext.agent : undefined,
            ),
        },
        {
          name: STYLE_CONTEXT_NAME,
          order: STYLE_CONTEXT_ORDER,
          text: (assembleContext) =>
            facade.styleRender(
              assembleContext && typeof assembleContext === 'object' ? assembleContext.agent : undefined,
            ),
        },
      ]
      for (const contribution of contributions) {
        try {
          const off = systemPrompt.context({
            name: contribution.name,
            order: contribution.order,
            required: false,
            interpolate: false,
            text: contribution.text,
          })
          if (typeof off === 'function') disposers.push(off)
        } catch (error) {
          logger.warn({ event: 'confluence.prompt.register-failed', name: contribution.name, message: String(error) })
        }
      }
    }
  } catch (error) {
    logger.warn({ event: 'confluence.prompt.register-failed', message: String(error) })
  }

  // ── model-facing tools ──────────────────────────────────────────────────
  let unregisterTools = null
  try {
    const definitions = createTools(facade, config)
    unregisterTools = registerTools(ctx, definitions)
    if (typeof unregisterTools === 'function') disposers.push(unregisterTools)
    logger.info({ event: 'confluence.tools.registered', count: definitions.length })
  } catch (error) {
    logger.warn({ event: 'confluence.tools.register-failed', message: String(error) })
  }

  // ── read-only panel routes (optional web server) ────────────────────────
  let unregisterUi = null
  try {
    unregisterUi = registerHostUi(ctx, { facade, config, logger })
    if (typeof unregisterUi === 'function') disposers.push(unregisterUi)
  } catch (error) {
    logger.warn({ event: 'confluence.ui.register-failed', message: String(error) })
  }

  // ── async activation: store, profile, watermarks, live workspaces ───────
  // Tools/pulse/profile-prompt/routes are registered synchronously above so the
  // first model request after activation already sees the plugin (M0 cold-start
  // race). The I/O below only fills the stores behind those registrations.
  try {
    if (typeof store.init === 'function') await store.init()
  } catch (error) {
    logger.warn({ event: 'confluence.store.init-failed', message: String(error) })
  }
  try {
    await profile.attach()
  } catch (error) {
    logger.warn({ event: 'confluence.profile.attach-failed', message: String(error) })
  }
  try {
    await memory.attach()
  } catch (error) {
    logger.warn({ event: 'confluence.memory.attach-failed', message: String(error) })
  }
  try {
    await style.attach()
  } catch (error) {
    logger.warn({ event: 'confluence.style.attach-failed', message: String(error) })
  }
  try {
    await watermark.attach(ctx)
  } catch (error) {
    logger.warn({ event: 'confluence.watermark.attach-failed', message: String(error) })
  }
  // ── warm live agents (workspace attachment + provenance labels) ─────────
  for (const agent of listAgents(ctx)) onAgentCreated({ agent })
  try {
    await presence.refreshPresence()
  } catch {
    // Presence polling is best-effort.
  }

  const pollMs = Math.max(4000, Math.min(10000, Math.trunc(Number(config.store && config.store.pollMs) || 4000)))
  const timer = setInterval(() => {
    void (async () => {
      try {
        if (presence && typeof presence.refreshPresence === 'function') await presence.refreshPresence()
      } catch {
        // Presence polling is best-effort.
      }
    })()
  }, pollMs)
  if (timer && typeof timer.unref === 'function') timer.unref()
  disposers.push(() => clearInterval(timer))

  // ── ordered teardown ────────────────────────────────────────────────────
  disposers.push(() => {
    try {
      pulse.dispose()
    } catch {
      /* best-effort */
    }
  })
  disposers.push(() => {
    try {
      presence.dispose()
    } catch {
      /* best-effort */
    }
  })
  disposers.push(() => {
    try {
      ledger.dispose()
    } catch {
      /* best-effort */
    }
  })
  disposers.push(() => {
    void (async () => {
      try {
        await watermark.dispose()
      } catch {
        /* best-effort */
      }
      try {
        if (typeof store.close === 'function') await store.close()
      } catch {
        /* best-effort */
      }
    })()
  })

  return {
    version: VERSION,
    config,
    publicConfig: publicConfig(config),
    warnings,
    logger,
    scope: PROFILE_SCOPE,
    globalScopeKey: GLOBAL_SCOPE_KEY,
    services: { store, board, context, bus, profile, memory, style, ledger, presence, watermark, pulse, recall, facade },
    dispose: disposeOnce,
    /** Awaitable teardown for tests/embedders; idempotent, never throws. */
    async disposeAsync() {
      disposeOnce()
      try {
        await watermark.dispose()
      } catch {
        /* best-effort */
      }
      try {
        if (typeof store.close === 'function') await store.close()
      } catch {
        /* best-effort */
      }
    },
  }
}

// ── small host helpers ────────────────────────────────────────────────────

/** @param {object} ctx @returns {object[]} */
function listAgents(ctx) {
  const safeGet = (name) => {
    try {
      if (ctx && typeof ctx.get === 'function') return ctx.get(name)
    } catch {
      return undefined
    }
    return undefined
  }
  const agents = safeGet('agents')
  if (!agents || typeof agents.list !== 'function') return []
  try {
    return [...(agents.list() || [])]
  } catch {
    return []
  }
}

/** @param {object} config @param {object} injected @returns {object} logger sink */
function createLogSink(config, injected) {
  const debug = config && config.debug && typeof config.debug === 'object' ? config.debug : {}
  const logFile = typeof debug.logFile === 'string' && debug.logFile !== '' ? debug.logFile : ''
  const write = (level) => (record) => {
    const line = JSON.stringify({ time: isoNow(Date.now()), level, plugin: 'confluence', ...record })
    if (logFile !== '') {
      try {
        fsPromises.appendFile(logFile, `${line}\n`, 'utf8').catch(() => {})
        return
      } catch {
        // Fall through to stderr.
      }
    }
    if (level === 'warn' || level === 'error') {
      try {
        process.stderr.write(`[confluence] ${line}\n`)
      } catch {
        // Never throw from logging.
      }
    }
  }
  if (injected && injected.logSink) return injected.logSink
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') }
}

/** @param {object} ctx @param {unknown} error */
function logActivationFailure(ctx, error) {
  try {
    const message = error instanceof Error ? error.message : String(error)
    const record = { event: 'confluence.activation-failed', message, code: error && error.code ? error.code : undefined }
    if (ctx && typeof ctx.logger === 'object' && ctx.logger && typeof ctx.logger.error === 'function') {
      ctx.logger.error(record)
      return
    }
    process.stderr.write(`[confluence] ${JSON.stringify(record)}\n`)
  } catch {
    // Never throw from the failure path.
  }
}

// Re-export the error class for embedding/tests (no side effects).
export { ConfluenceError, makeWriterId }
