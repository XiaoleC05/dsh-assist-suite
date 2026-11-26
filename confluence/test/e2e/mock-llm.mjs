#!/usr/bin/env node
// Confluence / 高级记忆 — deterministic local model stub for the offline E2E harness.
//
// This is the ONLY "server" the Confluence E2E run uses. It binds 127.0.0.1 on a
// random port, speaks the Messages-compatible wire format of the installed
// `deepseek-official` adapter (`dsh-llm-deepseek`: POST <baseURL>/v1/messages,
// SSE `message_start` / `content_block_*` / `message_delta` / `message_stop`,
// `x-api-key` auth), and records every request body to a JSONL log so the
// harness can assert what the model was actually shown.
//
// It is a stub, not a model: answers come from a small scenario file, are chosen
// deterministically, and are never invented by the plugin. No dependency, no
// network egress, no child process.
//
// CLI:
//   node test/e2e/mock-llm.mjs --scenario <file> --log <file> [--port 0]
//                              [--host 127.0.0.1] [--print-port-file <file>]
//
// Scenario format (JSON):
//   {
//     "default": { "text": "..." },              // fallback for unmatched calls
//     "responses": [                             // first matching entry wins
//       { "when": { "hasToolResult": true }, "text": "..." },
//       { "when": { "systemIncludes": "title" }, "text": "Mock Title" },
//       { "text": "..." }                        // no `when` = matches anything
//     ]
//   }
// A response is exactly one of:
//   { "text": "answer" }                                  → text block, stop end_turn
//   { "toolUse": { "name": "confluence_board", "input": {} } } → tool_use block, stop tool_use
//   { "error": { "status": 500, "code": "server_error" } }      → HTTP error (rarely needed)
//
// Request log line (JSONL, one per request):
//   { seq, ts, method, path, model, stream, apiKeyPresent, messageCount,
//     systemChars, messages: [...], bodyBytes, matched: {index, reason},
//     answer: "text"|"tool_use:<name>"|"error:<status>" }
//
// Exit: SIGINT/SIGTERM closes cleanly. `--print-port-file` writes the bound port
// so a harness that cannot parse stdout still learns it.

import { appendFileSync, closeSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { createServer } from 'node:http'

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { scenario: '', log: '', host: '127.0.0.1', port: 0, printPortFile: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${arg}`)
      i += 1
      return argv[i]
    }
    if (arg === '--scenario') out.scenario = next()
    else if (arg === '--log') out.log = next()
    else if (arg === '--host') out.host = next()
    else if (arg === '--port') out.port = Number(next())
    else if (arg === '--print-port-file') out.printPortFile = next()
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: node test/e2e/mock-llm.mjs --scenario <file> --log <file> [--port 0] [--host 127.0.0.1] [--print-port-file <file>]\n')
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  if (!out.scenario) throw new Error('--scenario is required')
  if (!out.log) throw new Error('--log is required')
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) throw new Error('--port must be 0-65535')
  return out
}

// ---------------------------------------------------------------------------
// scenario
// ---------------------------------------------------------------------------

function loadScenario(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed === null || typeof parsed !== 'object') throw new Error('scenario must be a JSON object')
  const responses = Array.isArray(parsed.responses) ? parsed.responses : []
  for (const [index, response] of responses.entries()) {
    if (response === null || typeof response !== 'object') throw new Error(`scenario.responses[${index}] must be an object`)
    if (response.when !== undefined) {
      if (typeof response.when !== 'object' || response.when === null) throw new Error(`scenario.responses[${index}].when must be an object`)
      for (const key of Object.keys(response.when)) {
        if (!['hasToolResult', 'systemIncludes', 'messagesIncludes', 'minMessages', 'maxMessages', 'modelIncludes'].includes(key)) {
          throw new Error(`scenario.responses[${index}].when has unknown matcher "${key}"`)
        }
      }
    }
    const shapes = ['text', 'toolUse', 'error'].filter((key) => response[key] !== undefined)
    if (shapes.length !== 1) throw new Error(`scenario.responses[${index}] must set exactly one of text|toolUse|error`)
  }
  return {
    responses,
    fallback: parsed.default === undefined ? { text: 'Mock answer.' } : parsed.default,
  }
}

/** @param {unknown} system */
function systemToText(system) {
  if (typeof system === 'string') return system
  if (Array.isArray(system)) return system.map((block) => (block && typeof block === 'object' && typeof block.text === 'string' ? block.text : '')).join('\n')
  return ''
}

/** @param {unknown} messages */
function messagesToText(messages) {
  if (!Array.isArray(messages)) return ''
  const parts = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    const content = message.content
    if (typeof content === 'string') parts.push(content)
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue
        if (typeof block.text === 'string') parts.push(block.text)
        else if (typeof block.content === 'string') parts.push(block.content)
        else if (Array.isArray(block.content)) parts.push(block.content.map((inner) => (inner && typeof inner.text === 'string' ? inner.text : '')).join('\n'))
        else if (block.type === 'tool_result') parts.push(JSON.stringify(block))
      }
    }
  }
  return parts.join('\n')
}

/** @param {unknown} messages */
function hasToolResult(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some(
    (message) =>
      message !== null &&
      typeof message === 'object' &&
      Array.isArray(message.content) &&
      message.content.some((block) => block !== null && typeof block === 'object' && block.type === 'tool_result'),
  )
}

/** Choose the first scenario response whose `when` matches; `default` otherwise. */
function selectResponse(scenario, request) {
  const systemText = systemToText(request.system)
  const messageText = messagesToText(request.messages)
  const messageCount = Array.isArray(request.messages) ? request.messages.length : 0
  const model = typeof request.model === 'string' ? request.model : ''
  const toolResult = hasToolResult(request.messages)
  for (const [index, response] of scenario.responses.entries()) {
    const when = response.when
    if (when === undefined) return { response, index, reason: 'ordered' }
    if (when.hasToolResult !== undefined && when.hasToolResult !== toolResult) continue
    if (when.systemIncludes !== undefined && !systemText.toLowerCase().includes(String(when.systemIncludes).toLowerCase())) continue
    if (when.messagesIncludes !== undefined && !messageText.toLowerCase().includes(String(when.messagesIncludes).toLowerCase())) continue
    if (when.minMessages !== undefined && messageCount < Number(when.minMessages)) continue
    if (when.maxMessages !== undefined && messageCount > Number(when.maxMessages)) continue
    if (when.modelIncludes !== undefined && !model.toLowerCase().includes(String(when.modelIncludes).toLowerCase())) continue
    return { response, index, reason: 'when' }
  }
  return { response: scenario.fallback, index: -1, reason: 'default' }
}

// ---------------------------------------------------------------------------
// request log
// ---------------------------------------------------------------------------

let logSeq = 0
let logFd = null

function openLog(path) {
  logFd = openSync(path, 'a')
}

function appendLog(entry) {
  if (logFd === null) return
  const line = Buffer.from(JSON.stringify(entry) + '\n', 'utf8')
  writeSync(logFd, line)
}

function closeLog() {
  if (logFd !== null) {
    try {
      closeSync(logFd)
    } catch {
      /* best effort */
    }
    logFd = null
  }
}

// ---------------------------------------------------------------------------
// Messages response shapes
// ---------------------------------------------------------------------------

function nextMessageId() {
  logSeq += 1
  return `msg_mock_${String(logSeq).padStart(4, '0')}`
}

function sseEvent(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
}

function usageFor(text) {
  const inputTokens = 100
  const outputTokens = Math.max(1, Math.ceil(String(text).length / 4))
  return { input_tokens: inputTokens, output_tokens: outputTokens }
}

/** Non-streaming Messages response object. */
function messageObject(model, content, stopReason, textForUsage) {
  return {
    id: nextMessageId(),
    type: 'message',
    role: 'assistant',
    model: model || 'deepseek-mock',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: usageFor(textForUsage),
  }
}

/** SSE stream of one assistant message in the sequence the DeepSeek adapter consumes. */
function writeSseMessage(res, model, content, stopReason, textForUsage) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  sseEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: nextMessageId(),
      type: 'message',
      role: 'assistant',
      model: model || 'deepseek-mock',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 0 },
    },
  })
  content.forEach((block, index) => {
    if (block.type === 'text') {
      sseEvent(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      // Split into a few deltas so the adapter's delta assembly is exercised.
      const chunkSize = Math.max(1, Math.ceil(block.text.length / 3))
      for (let offset = 0; offset < block.text.length; offset += chunkSize) {
        sseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: block.text.slice(offset, offset + chunkSize) },
        })
      }
      sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index })
      return
    }
    // tool_use block: start with empty input, then stream the JSON as partial_json.
    sseEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
    })
    sseEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) },
    })
    sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index })
  })
  sseEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { ...usageFor(textForUsage), input_tokens: 100 },
  })
  sseEvent(res, 'message_stop', { type: 'message_stop' })
  res.end()
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 8 * 1024 * 1024

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function createMockServer({ scenario, logPath }) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const method = req.method ?? 'GET'
    if (method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
      sendJson(res, 200, { ok: true, service: 'confluence-e2e-mock-llm' })
      return
    }
    // Model listing: the api-key route does not request it on a custom baseURL,
    // but answer it so a misconfigured run fails with data rather than a hang.
    if (method === 'GET' && url.pathname.endsWith('/v1/models')) {
      sendJson(res, 200, {
        data: [{ id: 'deepseek-mock', type: 'model', display_name: 'Mock DeepSeek' }],
        has_more: false,
        first_id: 'deepseek-mock',
        last_id: 'deepseek-mock',
      })
      return
    }
    if (method === 'POST' && url.pathname.endsWith('/v1/messages')) {
      let body
      try {
        body = JSON.parse((await readBody(req)).toString('utf8'))
      } catch (error) {
        sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: String(error) } })
        return
      }
      const { response, index, reason } = selectResponse(scenario, body)
      const model = typeof body.model === 'string' ? body.model : ''
      const requestMeta = {
        seq: logSeq + 1,
        ts: new Date().toISOString(),
        method,
        path: url.pathname,
        apiKeyPresent: Boolean(req.headers['x-api-key'] || req.headers['authorization']),
        messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
        systemChars: systemToText(body.system).length,
        messages: Array.isArray(body.messages) ? body.messages : [],
        system: typeof body.system === 'string' ? body.system : body.system ?? null,
        tools: Array.isArray(body.tools)
          ? body.tools.map((tool) => (tool && typeof tool.name === 'string' ? tool.name : null)).filter((name) => name !== null)
          : null,
        model,
        stream: Boolean(body.stream),
        maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : null,
        matched: { index, reason },
      }
      try {
        if (response.error !== undefined) {
          const status = Number(response.error.status ?? 500)
          appendLog({ ...requestMeta, bodyBytes: Buffer.byteLength(JSON.stringify(body)), answer: `error:${status}` })
          sendJson(res, status, { type: 'error', error: { type: response.error.code ?? 'server_error', message: 'mock error' } })
          return
        }
        if (response.toolUse !== undefined) {
          const tool = response.toolUse
          if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string') throw new Error('scenario toolUse needs {name,input}')
          const id = `toolu_mock_${String(logSeq + 1).padStart(4, '0')}`
          const content = [{ type: 'tool_use', id, name: tool.name, input: tool.input ?? {} }]
          appendLog({ ...requestMeta, bodyBytes: Buffer.byteLength(JSON.stringify(body)), answer: `tool_use:${tool.name}` })
          if (body.stream) writeSseMessage(res, model, content, 'tool_use', tool.name)
          else sendJson(res, 200, messageObject(model, content, 'tool_use', tool.name))
          return
        }
        const text = typeof response.text === 'string' ? response.text : 'Mock answer.'
        const content = [{ type: 'text', text }]
        appendLog({ ...requestMeta, bodyBytes: Buffer.byteLength(JSON.stringify(body)), answer: 'text' })
        if (body.stream) writeSseMessage(res, model, content, 'end_turn', text)
        else sendJson(res, 200, messageObject(model, content, 'end_turn', text))
        return
      } catch (error) {
        appendLog({ ...requestMeta, bodyBytes: Buffer.byteLength(JSON.stringify(body)), answer: `ERROR:${String(error)}` })
        sendJson(res, 500, { type: 'error', error: { type: 'server_error', message: String(error) } })
        return
      }
    }
    // Files API is irrelevant for text-only scenarios: fail loudly, never hang.
    sendJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: `${method} ${url.pathname} not implemented by mock` } })
  })
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const scenario = loadScenario(args.scenario)
  openLog(args.log)
  const server = createMockServer({ scenario, logPath: args.log })
  const sockets = new Set()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(args.port, args.host, () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : args.port
  const baseUrl = `http://${args.host}:${port}`
  if (args.printPortFile) writeFileSync(args.printPortFile, `${port}\n`, 'utf8')
  process.stdout.write(`mock-llm listening on ${baseUrl}\n`)
  process.stdout.write(`mock-llm base url (DEEPSEEK_BASE_URL): ${baseUrl}\n`)

  const shutdown = () => {
    server.close(() => {
      closeLog()
      process.exit(0)
    })
    for (const socket of sockets) socket.destroy()
    setTimeout(() => {
      closeLog()
      process.exit(0)
    }, 1000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  process.stderr.write(`mock-llm: ${error && error.stack ? error.stack : String(error)}\n`)
  closeLog()
  process.exit(2)
})
