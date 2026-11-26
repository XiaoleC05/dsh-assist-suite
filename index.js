/**
 * 对话助手套件的融合插件（包根 Loader 行）。
 *
 * 一个插件主体同时承载：
 *   - Confluence：工作区总线 / 长期记忆 / 用户画像 / 风格卡（8 个工具 + 面板路由）
 *   - pro-prompt：输入框语音与提示词优化（面板路由 + 设置持久化）
 *   - Crisp 质量门禁（默认关闭，config.crisp.enabled 打开后才加载）
 *   - 合并后的浏览器模块（入口页 + 记忆面板 + 输入框按钮）
 *   - 「重启应用」路由：Windows 桌面端没有可用的重启入口，这里提供一个设置页按钮
 *     的后端（延迟拉起新的桌面实例，再退出旧的主进程）。
 *
 * 成员模块仍是各自目录里的 apply(ctx, config)；这里把它们挂到同一个插件主体上，
 * 插件列表里只出现一行。
 */
import { spawn } from 'node:child_process'
import z from '@deepseek-ai/schemastery'
import * as confluence from './confluence/index.js'
import * as proPrompt from './pro-prompt/index.js'
import * as crisp from './crisp/index.js'

export const name = 'assist-suite'

/** 成员可能用到的服务并集。 */
export const inject = ['tools', 'webServer', 'systemPrompt', 'subprocess', 'workingDirectory', 'llm']

/** 融合配置：每个成员拿自己的 section；Crisp 有独立的 enabled 开关。 */
export const Config = z.object({
  confluence: z.any(),
  proPrompt: z.any(),
  crisp: z.any(),
})

const RESTART_STATUS_PATH = '/assist-suite/restart/status'
const RESTART_PATH = '/assist-suite/restart'

/** 输出质量技能正文：对最终回答做优化与统一规范。 */
const OUTPUT_QUALITY_SKILL = `# 输出优化与统一规范

用于给出最终回答前的润色与自检。目标是让回答清晰、一致、可执行，而不是改变事实或结论。

## 1 结构

- 结论先行：第一段直接回答“做了什么 / 是什么 / 结论是什么”；需要细节时再用小标题或要点展开。
- 同一段内只讲一件事；并列内容用列表，对比内容用表格，步骤用编号列表。
- 超过三层嵌套的列表改为小标题；空话、套话、重复结论一律删掉。
- 长回答先给三行以内的摘要，再给细节；能一句说清就不写三句。

## 2 一致性与术语

- 同一概念全文只用一个名称；首次出现给出中文与英文/缩写，例如“验收关卡（S5）”。
- 人称与时态统一；中文用全角标点，中英文之间留一个空格，代码、路径、命令用等宽格式。
- 数字、单位、日期格式全文一致；路径写成可点击的完整相对路径或 \`文件:行\`。
- 标题层级连续，不跳级；列表标记统一（- 或 1.），不混用。

## 3 格式

- 代码块标注语言；命令块可直接复制执行，不夹带说明文字。
- 表格列对齐，表头简洁；表格只用于真正的多维对比。
- 引用外部内容时给出链接；不编造链接、文件名、命令输出。
- 不建议用表情符号、全大写强调或大量加粗代替结构。

## 4 事实与验证

- 只写本会话真实做过、真实运行过的内容；未验证的结论必须标注“未验证：原因”。
- 引用工具输出时保留关键数字与退出码；不把推测写成事实。
- 不删除用户已有的验收标准；不为了好看而改写结论。

## 5 交付前自检

1. 第一段是否直接给出结论？
2. 每条结论是否都有依据（运行输出、文件位置、来源链接）？
3. 术语、人称、标点、日期格式是否全文一致？
4. 是否存在重复段落、空话、未解释的缩写？
5. 需要用户决策的事项是否已单独列出，并给出推荐项？
6. 未验证内容是否已标注？

按需只应用与当前回答相关的规则，不要为了“规范”而堆砌模板或把短回答写长。`

const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
})

/** Same trust decision the host applies to its own `/api` routes. */
function guard(ctx, requestLike) {
  let connection
  try {
    connection = ctx.get('connection')
  } catch {
    return { status: 503, code: 'guard-unavailable' }
  }
  if (!connection || typeof connection.requestRejection !== 'function') {
    return { status: 503, code: 'guard-unavailable' }
  }
  try {
    const status = connection.requestRejection({ headers: requestLike?.headers ?? {} })
    if (status === undefined) return undefined
    if (status === 401) return { status: 401, code: 'unauthorized' }
    if (status === 403) return { status: 403, code: 'forbidden' }
    return { status: 503, code: 'guard-unavailable' }
  } catch {
    return { status: 503, code: 'guard-unavailable' }
  }
}

/** Whether this Host runs as the Electron Desktop Host (its execPath is the app). */
function isDesktopHost() {
  return process.env.ELECTRON_RUN_AS_NODE === '1'
}

/** Launch a fresh desktop instance after the current one exits. */
function relaunchDesktop() {
  const exe = typeof process.execPath === 'string' ? process.execPath : ''
  if (exe.length === 0) return { ok: false, code: 'no-executable' }
  if (!isDesktopHost()) return { ok: false, code: 'not-desktop' }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const launcher = process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/s', '/c', `ping -n 4 127.0.0.1 >nul & start "" "${exe}"`], {
        detached: true, stdio: 'ignore', windowsHide: true, env,
      })
      : spawn(exe, [], { detached: true, stdio: 'ignore', env })
    launcher.unref()
  } catch (error) {
    return { ok: false, code: 'spawn-failed', message: error instanceof Error ? error.message : String(error) }
  }
  // Let the HTTP response flush, then stop the desktop main process; the delayed
  // launcher above starts a fresh instance after the old one is gone.
  setTimeout(() => {
    try { process.kill(process.ppid, 'SIGTERM') } catch { /* already gone */ }
    setTimeout(() => {
      try { process.exit(0) } catch { /* already exiting */ }
    }, 300)
  }, 400)
  return { ok: true }
}

/**
 * 组装融合插件。
 * @param ctx - Cordis 宿主上下文
 * @param config - 融合配置
 */
export function apply(ctx, config) {
  const confluenceConfig = config?.confluence
  confluence.apply(ctx, confluenceConfig !== null && typeof confluenceConfig === 'object' ? confluenceConfig : {})

  const promptConfig = config?.proPrompt
  proPrompt.apply(ctx, promptConfig !== null && typeof promptConfig === 'object' ? promptConfig : {})

  const crispConfig = config?.crisp
  if (crispConfig !== null && typeof crispConfig === 'object' && crispConfig.enabled === true) {
    crisp.apply(ctx, crispConfig)
  }

  // Quality gate as a runtime skill: no external executable, no extra credentials.
  // Agents load it through the skill tool when they need output polish or a final check.
  let skills
  try {
    skills = ctx.get('skills')
  } catch {
    skills = undefined
  }
  if (skills !== null && skills !== undefined && typeof skills.register === 'function') {
    ctx.effect(() => skills.register({
      name: 'output-quality',
      description: '输出优化与统一规范：结论先行、结构一致、术语统一、格式与标点规范、未验证断言明确标注。',
      whenToUse: '给出最终回答前，或需要润色、统一格式与术语、做交付自检时使用。',
      source: 'runtime',
      invocation: { modelInvocable: true, userInvocable: true },
      content: OUTPUT_QUALITY_SKILL,
    }), 'assist-suite: output quality skill')
  }

  const webServer = ctx.webServer
  if (webServer === null || webServer === undefined || typeof webServer.register !== 'function') return

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: RESTART_STATUS_PATH,
    resource: async (request) => {
      const rejection = guard(ctx, request)
      if (rejection) return new Response(JSON.stringify({ error: { code: rejection.code } }), { status: rejection.status, headers: JSON_HEADERS })
      return new Response(JSON.stringify({
        ok: true,
        desktop: isDesktopHost(),
        executable: typeof process.execPath === 'string' ? process.execPath : null,
        platform: process.platform,
      }), { status: 200, headers: JSON_HEADERS })
    },
  }), 'assist-suite: restart status route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: RESTART_PATH,
    handler: async (req, res) => {
      const send = (status, value) => {
        if (res.headersSent) return
        res.statusCode = status
        for (const [name, headerValue] of Object.entries(JSON_HEADERS)) res.setHeader(name, headerValue)
        res.end(JSON.stringify(value))
      }
      const drain = () => {
        try { req.resume?.() } catch { /* already ended */ }
      }
      const rejection = guard(ctx, req)
      if (rejection) {
        drain()
        return send(rejection.status, { error: { code: rejection.code } })
      }
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        drain()
        return send(405, { error: { code: 'method-not-allowed' } })
      }
      drain()
      const result = relaunchDesktop()
      if (!result.ok) return send(409, { error: { code: result.code, message: result.message } })
      send(202, { ok: true })
    },
  }), 'assist-suite: restart route')
}
