# 面向 agent 输入的约束来源

整理日期：2026-11-18。star 数通过 GitHub REST API（`https://api.github.com/repos/<owner>/<repo>`）当日读取；star 会随时间变化。

## 采用的项目 / 规范

| 项目或规范 | 链接 | star（2026-11-18） | 许可证 | 被采纳的约束 |
| --- | --- | --- | --- | --- |
| dair-ai/Prompt-Engineering-Guide | <https://github.com/dair-ai/Prompt-Engineering-Guide> | 80,151 | MIT | 指令清晰、结构化提示、示例、评估；C1/C2/C4/C5/C6 |
| openai/openai-cookbook | <https://github.com/openai/openai-cookbook> | 77,214 | MIT | 指令与上下文分隔、具体描述、输出格式、减少空泛；C1/C2/C4/C5/C8 |
| anthropics/claude-cookbooks | <https://github.com/anthropics/claude-cookbooks> | 54,798 | MIT | 用 XML/标题分隔结构、示例、角色、歧义时先澄清；C1/C2/C5/C7 |
| PatrickJS/awesome-cursorrules | <https://github.com/PatrickJS/awesome-cursorrules> | 41,166 | CC0-1.0 | 编码 agent 的上下文、约束、测试/验证、避免无关改动；C4/C6/C9 |
| stanfordnlp/dspy | <https://github.com/stanfordnlp/dspy> | 39,109 | MIT | 把提示拆成可组合的指令/输入/输出契约，评估驱动；C2/C5/C6 |
| agentsmd/agents.md | <https://github.com/agentsmd/agents.md> | 25,529 | MIT | 给 coding agent 的构建/测试/代码风格/项目上下文；C2/C4/C6/C9 |
| guidance-ai/guidance | <https://github.com/guidance-ai/guidance> | 21,825 | MIT | 结构化模板、受约束输出、指令与数据分离；C2/C5 |
| brexhq/prompt-engineering | <https://github.com/brexhq/prompt-engineering> | 9,592 | MIT | 精简、少空话、先给指令再给上下文；C1/C8 |

同时参考了官方公开规范（不作为 star 统计对象）：

- Anthropic, *Claude prompting best practices*：<https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices>（XML 标签、示例、角色、歧义澄清）
- OpenAI, *Best practices for prompt engineering with the OpenAI API*：<https://help.openai.com/en/articles/6654000-best-practices-for-prompt-engineering-with-the-openai-api>（指令在前、用 `###`/`"""` 分隔、具体描述、输出格式、减少 fluffy）
- AGENTS.md 规范：<https://agents.md/>（项目上下文、构建/测试命令、代码风格、测试说明）

## 提炼出的 9 条约束（实现于 `lib/prompts.js`）

| id | 约束 | 来源 | 在提示词中的落实 |
| --- | --- | --- | --- |
| C1 | 目标明确：第一句写清要 agent 做什么，保留原文角色/背景，不补造 | Prompt-Engineering-Guide、OpenAI cookbook、Anthropic | 两种模式第 1 条；faithful 不补角色，structure 用完整提示词契约 |
| C2 | 结构与上下文分离：任务/背景/输入/约束/输出/验收分开 | OpenAI cookbook、Anthropic XML、guidance、AGENTS.md | structure 的 Markdown 分节；faithful 仅在原文已有资料时用「背景：/输入：」分隔 |
| C3 | 事实保真：事实、数字、专名、时间、约束、示例、代码不增不减 | OpenAI cookbook、Prompt-Engineering-Guide、内置语音提示词 | 两种模式的禁止清单；structure 用执行前确认协议标缺口，不填事实 |
| C4 | 约束可执行：逐条保留硬性限制，模糊动词改可检查说法，不新增限制 | OpenAI cookbook、Prompt-Engineering-Guide、awesome-cursorrules、AGENTS.md | 两种模式第 4 条；structure 的「约束」节 |
| C5 | 输出明确：交付物、格式、语言明确；未要求不发明 | OpenAI cookbook、Anthropic、dspy、guidance | 两种模式第 5 条；structure 缺失时用执行约定或确认协议 |
| C6 | 验收明确：保留已有验收；缺失时给可执行约定 | AGENTS.md、awesome-cursorrules、dspy | 两种模式第 6 条；structure 写检查项/测试或确认协议 |
| C7 | 歧义不臆测：不替用户假设答案，不自问自答 | Anthropic、Prompt-Engineering-Guide | 两种模式第 7 条；structure 用最小澄清问题或条件分支 |
| C8 | 精简无冗余：删重复/空泛/客套/口头禅，不加元评论 | OpenAI cookbook、brexhq、内置语音提示词 | 两种模式第 8 条；输出清洗与 refusal 判断 |
| C9 | 代码任务先读后改：先阅读相关文件、最小改动、说明验证结果 | awesome-cursorrules、AGENTS.md | faithful 只保留原文已有要求；structure 可加入这句执行方式 |

## 实现位置

- 提示词：`lib/prompts.js` 的 `OPTIMIZE_PROMPTS`（faithful / structure）
- 约束清单：`lib/prompts.js` 的 `AGENT_CONSTRAINTS`
- 输出清洗：`cleanModelText`、`isUsefulOptimizedText`
- 测试：`test/prompts.test.js` 断言 faithful 保留 9 条约束、structure 覆盖完整提示词契约、能力目录注入、占位符检测/审查

## 取舍说明

- **faithful 不补结构**：为了做到「100% 保留原意」，faithful 不添加原文没有的标题、占位符或执行步骤；它仍通过语序、指代、标点、去冗余来满足 C1/C3/C4/C5/C8，但 C6 的「验收」只在原文已有的时候保留。
- **structure 才构建完整提示词**：结构模式会补目标/背景/输入/步骤/能力/约束/输出/验收；缺失事实用执行前确认协议，不写 `【待补充】`。C9 在代码任务里补的是一句通用执行方式，不是领域事实。
- **不采用 `f/prompts.chat`（177,740 stars）作为规范来源**：它是提示词集合/社区站点，许可证为 NOASSERTION，且不是工程化约束文档；star 高但不适合作为规则依据。
