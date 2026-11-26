/**
 * 对话助手套件的融合插件（包根 Loader 行）。
 *
 * 一个插件主体同时承载：
 *   - Confluence：工作区总线 / 长期记忆 / 用户画像 / 风格卡（8 个工具 + 面板路由）
 *   - pro-prompt：输入框语音与提示词优化（面板路由 + 设置持久化）
 *   - Crisp 质量门禁（默认关闭，config.crisp.enabled 打开后才加载）
 *   - 合并后的浏览器模块（Confluence 面板 + 输入框按钮）
 *
 * 成员模块仍是各自目录里的 apply(ctx, config)；这里把它们挂到同一个插件主体上，
 * 插件列表里只出现一行。
 */
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
}
