# 提示词工程：开源项目参考与结构模式取舍

结构优化（`structure`，当前默认）不是简单套模板。它先分析草稿，再构建一份可直接交给 DSH agent 的完整提示词，并做一次审查/压缩。下面记录所参考的高星开源项目、采纳的节点，以及没有照搬的部分。

> 星数为 2026-11-19 查询时的大致值；项目均为开源免费，许可证以各仓库为准。这里只借鉴提示词结构与流程思想，没有复制项目代码。

## 参考项目

| 项目 | 星数（约） | 采纳的节点 |
| --- | ---: | --- |
| [dair-ai/Prompt-Engineering-Guide](https://github.com/dair-ai/Prompt-Engineering-Guide) | 80k | 清晰指令、角色/上下文/输出格式分离、示例与约束 |
| [openai/openai-cookbook](https://github.com/openai/openai-cookbook) | 77k | 任务目标、输入、步骤、输出契约；用明确格式减少歧义 |
| [anthropics/claude-cookbooks](https://github.com/anthropics/claude-cookbooks) | 54k | 用分隔符/小节组织长提示词、示例驱动、先给成功标准 |
| [stanfordnlp/dspy](https://github.com/stanfordnlp/dspy) | 39k | “签名”思想：输入/输出/约束显式化；生成后评估与迭代 |
| [promptfoo/promptfoo](https://github.com/promptfoo/promptfoo) | 27k | 把验收标准写成可检查的测试/断言，而不是空泛要求 |
| [agentsmd/agents.md](https://github.com/agentsmd/agents.md) | 25k | 面向编码 agent 的项目上下文、先读后改、最小 diff、验证命令 |
| [microsoft/guidance](https://github.com/microsoft/guidance) | 21k | 结构化生成/模板约束，减少“自由发挥” |
| [SylphAI-Inc/AdalFlow](https://github.com/SylphAI-Inc/AdalFlow) | 4.2k | 自动提示词优化循环：候选 → 评估 → 改进 |
| [zou-group/textgrad](https://github.com/zou-group/textgrad) | 3.8k | 用“文本梯度/评审”改进提示词，而不是只做一次生成 |
| [google-deepmind/opro](https://github.com/google-deepmind/opro) | 0.8k | “LLM as optimizer”：让模型基于候选与反馈迭代改提示词 |
| [microsoft/LMOps](https://github.com/microsoft/LMOps) | 4.5k | Promptist 等提示词优化/重写思路 |

## 采纳到 `lib/prompts.js` 的节点

1. **先分析后构建**：任务类型、目标、已知事实、缺失事实、能力、输入/处理/输出/验收、风险。
2. **完整提示词骨架**：角色与目标 / 背景与已知事实 / 输入 / 执行步骤 / 可用能力 / 约束 / 输出格式 / 验收标准。
3. **能力选择**：只从 `capabilityCatalog` 或当前会话真实工具列表选 1–3 个 DSH skill / MCP / 插件，写明用途；目录外不编造。
4. **不捏造 + 无占位符**：关键事实缺失时用“执行前确认”协议，不写 `【待补充】`/`TODO`；执行约定与用户事实分开。
5. **验收可执行**：输出检查项/测试，而不是“确保正确”这类空话（参考 promptfoo 的断言式评估）。
6. **生成后审查**：结构模式在候选缺节、含占位符或能力名可疑时触发第二遍审查/压缩（参考 DSPy/TextGrad/OPRO/AdalFlow 的迭代优化）。
7. **编码任务约定**：先读代码、最小 diff、说明验证结果与剩余风险（参考 AGENTS.md / awesome-cursorrules）。

## 没有照搬的部分

- 没有引入 DSPy/TextGrad/AdalFlow 的 Python 运行时或自动优化器；本插件是单次/双次模型调用，保持零额外依赖。
- 没有做线上 A/B 或 benchmark；只做了本机真实接口的延迟/完整性抽查。
- 没有复制任何项目的提示词原文；只吸收结构与检查项。
- 没有引入模板库、提示词历史或新的存储；结构模式仍只输出当前输入框的最终提示词。
