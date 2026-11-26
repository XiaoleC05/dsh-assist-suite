# 输入增强（pro-prompt）交付报告

交付日期：2026-11-18。工作区：`D:\05_Code\pro-prompt`。

## 1. 交付物清单

### 源码目录

```text
D:\05_Code\pro-prompt
├─ index.js                 Host 入口：配置、Key 解析、服务与路由装配
├─ client.js                浏览器半：输入框双按钮、录音、左侧栏/右侧栏配置页
├─ cordis.patch.yml         插件默认配置与 bundle 行
├─ package.json             pro-prompt 1.4.0，dsh.bundle / dsh.client 元数据
├─ icon.svg                 原创图标（输入增强）
├─ locale/
│  ├─ zh.json               卡片名：输入增强
│  └─ en.json               卡片名：pro-prompt
├─ lib/
│  ├─ config.js             配置归一化与边界
│  ├─ key.js                配置 / 环境变量只读 Key 解析
│  ├─ prompts.js            内置语音提示词 + 完整提示词构建/审查
│  ├─ asr.js                SiliconFlow Qwen3-ASR-1.7B 转写适配
│  ├─ chat.js               SiliconFlow DeepSeek-V4.1-Flash 润色/优化客户端
│  ├─ voice.js              WAV 校验、ASR+润色编排
│  ├─ optimize.js           提示词优化器
│  ├─ routes.js             四个同源路由
│  └─ errors.js             统一错误、脱敏、安全消息
├─ docs/
│  ├─ agent-input-constraints.md  开源规范、star、约束映射
│  ├─ alternatives.md             备选方案（当前只启用首选）
│  ├─ prompt-engineering-research.md  开源提示词工程参考与采纳节点
│  └─ manual-acceptance.md        手工验收步骤
├─ test/                    63 个 Node 测试
└─ README.md
```

### 配置项（`cordis.patch.yml`）

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `apiBase` | SiliconFlow chat 接口 | 润色/优化 chat |
| `apiKey` | `''`（profile 级配置中提供） | SiliconFlow 密钥（ASR + chat） |
| `apiKeyEnvFile` | `''` | 可选 env 文件 |
| `apiKeyEnvName` | `SILICONFLOW_API_KEY` | 环境变量名 |
| `asrProvider` | `siliconflow` | ASR 提供商 |
| `asrApiBase` | `https://api.siliconflow.cn/v1` | SiliconFlow ASR 地址 |
| `asrModel` | `Qwen/Qwen3-ASR-1.7B` | 用户选定的识别模型 |
| `polishModel` | `deepseek-ai/DeepSeek-V4.1-Flash` | SiliconFlow 润色/优化模型 |
| `language` | `zh`（默认）/ `auto` / `en` |
| `defaultMode` | `structure` | 结构优化（默认） |
| `capabilityCatalog` | 内置真实 DSH 能力目录 | 结构优化选择 skill/MCP/插件，避免编造名称 |
| `maxSeconds` | `60` | 插件保护上限 |
| `speechTimeoutMs` | `90000` | 单次 ASR / 润色的超时 |
| `optimizeTimeoutMs` | `180000` | 单次优化超时（结构模式可能两次调用） |
| `maxPromptChars` | `20000` | 优化输入上限 |
| `maxOutputTokens` | `2048` | 优化输出上限 |
| `polish` | `true` | 关闭后语音只返回 ASR 原文 |

### 安装与启用

已在本机 `desktop` profile 安装并启用：

- 包名/插件行：`pro-prompt`
- 版本：1.4.0
- 依赖：`pro-prompt: link:D:/05_Code/pro-prompt`
- bundle 列表末尾：`pro-prompt`
- `plugin_manager` 结果：`application: applied`；Host 行 `include:pro-prompt`，`fiberPhase: active`
- 旧 bundle `dsh-prompt-studio` 已移除；旧 junction 与旧 storage 已清理

重装/迁移：

```powershell
# 在 DSH Plugins 页面用 Add plugin 选择 D:\05_Code\pro-prompt，
# 或让 agent 调用 plugin_manager install_bundle（target 为目录）。
# 安装后刷新页面一次，打开任意会话查看输入框左侧两按钮与左侧栏面板。
```

## 2. 内置提示词与模型

### 语音提示词

- 两种模式：`结构优化`（structure，默认）/ `保真润色`（faithful）。
- 保真：100% 保留原意；只改口误重复、语序、残句、指代、标点；不纠正事实/数字/专名，不补原因/方案/评价。
- 结构：重组语序、合并碎句、理顺逻辑，输出 1–4 句书面中文；不编造信息。
- 共同规则：去语气词/口头禅；只输出正文；纯语气词输出空字符串；无意义重复压缩掉，不发明新请求。
- 参数：faithful `temperature=0.2`，structure `temperature=0.4`，`max_tokens=512`；用户消息为「请按当前模式润色下面这段口语识别原文：\n…」。
- 输出清洗：去整段代码围栏、`优化：`/`润色：`前缀、包裹引号；空/纯语气词/元评论丢弃。

### 提示词优化

- faithful：只修表达，不新增章节/标题/占位符/步骤。
- structure：构建完整提示词（目标/事实/输入/步骤/能力/约束/输出/验收）；缺事实用执行前确认协议，不写占位符，不新增事实、文件、技术栈、时限、执行规则或证据要求。
- 参数：faithful `0.2`，structure `0.4`；`max_tokens=2048`。
- 结构模式会按 `capabilityCatalog` 选择 skill/MCP/插件；候选缺节/含占位符时触发审查。

### 模型与接口

- ASR：SiliconFlow `Qwen/Qwen3-ASR-1.7B`（`/v1/audio/transcriptions`），识别语言 `zh`，16 kHz WAV。
- chat：SiliconFlow `deepseek-ai/DeepSeek-V4.1-Flash`（`/v1/chat/completions`）。
- 密钥：profile 级 `apiKey`（或 `SILICONFLOW_API_KEY`），ASR 与 chat 共用；不进入插件仓库。

### 无外部依赖

- 不读取外部 exe、`.env`、模板、提示词历史或音频历史。
- 不创建新存储目录；默认模式只写现有 profile 配置。

## 3. 开源提示词工程化规范与采纳约束

star 数通过 GitHub REST API 于 2026-11-18 读取；会随时间变化。

| 项目/规范 | 来源 | star | 许可证 | 采纳 |
| --- | --- | --- | --- | --- |
| dair-ai/Prompt-Engineering-Guide | <https://github.com/dair-ai/Prompt-Engineering-Guide> | 80,151 | MIT | 指令清晰、结构、示例、评估：C1/C2/C4/C5/C6 |
| openai/openai-cookbook | <https://github.com/openai/openai-cookbook> | 77,214 | MIT | 指令/上下文分隔、具体描述、输出格式、减少空泛：C1/C2/C4/C5/C8 |
| anthropics/claude-cookbooks | <https://github.com/anthropics/claude-cookbooks> | 54,798 | MIT | XML/标题分隔、示例、角色、歧义澄清：C1/C2/C5/C7 |
| PatrickJS/awesome-cursorrules | <https://github.com/PatrickJS/awesome-cursorrules> | 41,166 | CC0-1.0 | 编码 agent 上下文、约束、测试/验证、避免无关改动：C4/C6/C9 |
| stanfordnlp/dspy | <https://github.com/stanfordnlp/dspy> | 39,109 | MIT | 指令/输入/输出契约、评估驱动：C2/C5/C6 |
| agentsmd/agents.md | <https://github.com/agentsmd/agents.md> | 25,529 | MIT | 构建/测试/代码风格/项目上下文：C2/C4/C6/C9 |
| guidance-ai/guidance | <https://github.com/guidance-ai/guidance> | 21,825 | MIT | 结构化模板、受约束输出、指令/数据分离：C2/C5 |
| brexhq/prompt-engineering | <https://github.com/brexhq/prompt-engineering> | 9,592 | MIT | 精简、少空话、指令在前：C1/C8 |

同时参考官方公开规范：

- Anthropic *Claude prompting best practices*：<https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices>
- OpenAI *Best practices for prompt engineering*：<https://help.openai.com/en/articles/6654000-best-practices-for-prompt-engineering-with-the-openai-api>
- AGENTS.md：<https://agents.md/>

### 9 条约束（实现于 `lib/prompts.js`）

| id | 约束 | 来源 | 落实 |
| --- | --- | --- | --- |
| C1 | 目标明确 | Prompt-Engineering-Guide、OpenAI cookbook、Anthropic | 两种模式第 1 条 |
| C2 | 结构与上下文分离 | OpenAI cookbook、Anthropic XML、guidance、AGENTS.md | structure 的 Markdown 分节；faithful 仅在原文有资料时分隔 |
| C3 | 事实保真 | OpenAI cookbook、Prompt-Engineering-Guide、内置语音提示词 | 禁止清单；structure 用执行前确认协议 |
| C4 | 约束可执行 | OpenAI cookbook、Prompt-Engineering-Guide、awesome-cursorrules、AGENTS.md | 两种模式第 4 条 |
| C5 | 输出明确 | OpenAI cookbook、Anthropic、dspy、guidance | 两种模式第 5 条 |
| C6 | 验收明确 | AGENTS.md、awesome-cursorrules、dspy | 两种模式第 6 条；structure 用可执行检查或确认协议 |
| C7 | 歧义不臆测 | Anthropic、Prompt-Engineering-Guide | 两种模式第 7 条 |
| C8 | 精简无冗余 | OpenAI cookbook、brexhq、内置语音提示词 | 两种模式第 8 条 |
| C9 | 代码任务先读后改 | awesome-cursorrules、AGENTS.md | faithful 只保留原文要求；structure 可补执行方式 |

完整来源映射与取舍见 [`docs/agent-input-constraints.md`](agent-input-constraints.md)。

## 4. 变更说明

### 新增

- `pro-prompt` 独立插件包，中文名「输入增强」；Host + Client 两半。
- 左侧栏「输入增强」入口 + 主页面，右侧栏「增强」页：两个模式卡片、默认模式设置、密钥来源/模型状态、9 条约束。
- 输入框双按钮：✦ 直接优化并替换；麦克风点击开始/再次点击停止并插入。配置只在侧边栏。
- 直接优化路径（无确认页）、语音录音计时、识别中取消、默认模式仅本次运行时的重试状态。
- 结构优化升级：先分析任务/事实/缺口，再构建完整提示词，包含输入、执行步骤、DSH skill/MCP/插件选择、输出格式、验收；事实不足用“执行前确认”协议，不写占位符。
- 结构优化二次审查：缺节、占位符或能力名可疑时自动审查/压缩；能力目录可配置，防止编造名称。
- `lib/key.js` 只读解析 profile 配置 / 环境变量；无 Key UI、无 Key 写入。
- `lib/asr.js` SiliconFlow ASR；`lib/chat.js` SiliconFlow chat；错误脱敏。
- 63 个测试、5 份文档、原创图标。

### 修改

- 包名/插件行：`dsh-prompt-studio` → `pro-prompt`。
- 优化引擎：旧 DSH LLM 路由/风格/语言/本地回退 → SiliconFlow `DeepSeek-V4.1-Flash`；结构优化扩展为完整提示词工程，保真模式保留原约束。
- 默认模式：`faithful` → `structure`；侧边栏卡片与配置默认值同步。
- 语音配置：全部切换为 SiliconFlow：ASR `Qwen/Qwen3-ASR-1.7B`、润色/优化 `DeepSeek-V4.1-Flash`；同一把 profile 级 `apiKey`。
- 优化交互：旧浮层预览 + 应用确认 → 直接替换，无二次确认。
- 语音交互：旧打开浮层录音 → 点击开始/再次点击停止，直接插入。
- 语音润色空结果：旧丢弃 → 保留 ASR 原文并提示。
- 界面：全中文；默认模式保存走现有 profile 配置。
- 文档/测试/CI/图标/README 全部重写。

### 删除

- 模板库：`lib/templates.js`、`/pro-prompt/templates`（原 `/prompt-studio/templates`）、模板 UI/编辑器/搜索/最近使用。
- 提示词预置、种子模板、模板上限/字符数配置。
- 语音历史（localStorage）与历史 UI。
- Key 配置路由/表单/`voice.json` 写入。
- 旧优化器：`provider`/`model`/`maxTokens` 路由、`style`/`language` 选择、本地规则回退。
- 旧文档图片、旧测试（fuzzy/templates/voice-e2e）、旧 storage 数据与 profile junction。
- 浏览器旧键 `dsh.prompt-studio.voice.prefs.v1` 与 `...history.v1` 在客户端启动时删除。

## 5. 备选方案建议（当前只启用首选）

详见 [`docs/alternatives.md`](alternatives.md)。结论：

- **当前已切换**：ASR 为 `SiliconFlow Qwen/Qwen3-ASR-1.7B`；润色/优化为 `SiliconFlow DeepSeek-V4.1-Flash`，共用一把 SiliconFlow 密钥。本地 FunASR/Paraformer 仍是隐私优先备选，但需要额外存储/运行时。
- 若放宽“零额外存储”：本地 FunASR/Paraformer（21,059 stars，MIT）最值得做；需 Python/模型/常驻进程。
- 若只要多语种/离线：faster-whisper（26,828 stars）/ Whisper（113,055 stars）；需模型下载与本地运行时。
- SenseVoiceSmall（9,774 stars）：本地中文备选，同样需额外存储。
- `paraformer-v2`：文件识别需公网 URL，不适合当前 Base64 WAV 链路。
- Azure/Google/讯飞：需新 Key/账号，违反复用约束。
- 润色模型 `qwen-max`/`qwen3-max`：质量可能更高但成本/延迟更高，未做 A/B。
- 优化改用 DSH 内置模型：可减少对 SiliconFlow 的依赖，但偏离当前单一 Provider；未实现。
- 流式 ASR：需重写链路，不在本次范围。

**已按用户选择只启用首选 ASR；其他 ASR 备选未启用。**

## 6. 验证记录

### 自动化

- `npm run check`：11 个 JS 文件语法通过。
- `npm test`：63/63 通过。
- 覆盖：配置、SiliconFlow 密钥解析、语音提示词保真、SiliconFlow ASR/chat 请求与错误、结构提示词能力目录、占位符检测、生成后审查、WAV 校验、语音降级、优化器、路由守卫、Host 装配、浏览器 WAV/插入/apply 注册。
- 新增：SiliconFlow ASR 适配与真实转写、结构模式完整提示词契约、能力目录注入、占位符审查/修复、默认模式改为 structure、默认模式持久化失败状态、客户端/主进程约束标题一致性、插入忙碌失败、客户端 apply 不抛错。

### 真实接口（2026-11-19，开发机）

- status：`configured=true`、`asrConfigured=true`，`source=config`，`asrSource=config`，`asrModel=Qwen/Qwen3-ASR-1.7B`，`polishModel=deepseek-ai/DeepSeek-V4.1-Flash`，`defaultMode=structure`。
- ASR（SiliconFlow）：`这是一个语音识别测试，请把这句话转成文字。`
- faithful 输出：`登录页面返回 500 错误，请查看日志并修复，不要改动其他功能。`
- structure 输出（3 个真实草稿）：都包含「角色与目标 / 背景与已知事实 / 输入 / 执行步骤 / 可用能力 / 约束 / 输出格式 / 验收标准」；能力名来自目录（如 `dsh-doc`）；无 `【待补充】`/`TODO`；关键事实缺失时生成「执行前确认」最小问题。
- structure 延迟：约 12–22s（复杂插件任务约 21s；简单查询约 12s）；若候选缺节/含占位符会触发第二遍审查，延迟增加。
- voice：transcript + text，`engine=siliconflow`；ASR 约 0.5s，润色约 1.5s；输出无 Key。

### 安装与运行

- `plugin_manager install_bundle`：`application: applied`，bundle `pro-prompt` 1.4.0。
- Host 行 `include:pro-prompt`：`enabled=true`，`fiberPhase=active`。
- 客户端代码已注册左侧栏入口 `sidebar.panellist`、主页面 `main`、右侧栏页 `sidebar.right.pane.tab`、输入框 `conversation.input.left`；此前 Slot 检查确认右侧栏/输入框占用，左侧栏/主页面需刷新页面后确认。
- 后续检查时页面处于无会话/侧栏未打开状态，会话级槽位为空；这是会话作用域的正常表现，不是插件卸载。
- 旧 `dsh-prompt-studio` bundle/junction/storage 已清理；`~/.dsh/storages/pro-prompt` 不存在。

### UX 评审与修复

已用独立 reviewer 评审；P1 全部修复：

- 默认模式写入失败不再“假成功/死路”：标记「默认（仅本次）」，按钮可重试。
- 润色降级提示不再被成功提示覆盖：只显示一条降级提示。
- 状态/告警文字改用主文本色，状态色只用于点/底色；对比度问题修正。
- 悬停改用 `--dsw-alias-interactive-bg-hover*`，修复浅色白底白 hover。
- 网络错误中文化；优化期间输入改动时插入而非覆盖；语音插入忙碌失败不再假成功。
- 面板 toast 改为面板内绝对定位；录音计时移出 28px 按钮；识别中显示状态与取消。
- 模式 radiogroup 支持方向键/Home/End；移除条件 hook；清理死文案/参数/超时不一致。
- 文档术语与 UI 同步（密钥/智能体/按钮文案）。

### 仍需人工/浏览器验证

- 真实浏览器渲染：两按钮外观/宽度、左侧栏入口/主页面、侧边栏窄宽、浅/深色实际对比。
- 真实麦克风权限、MediaRecorder/解码/重采样、60 秒自动停止、计时/取消。
- 默认模式写入真实 profile 配置（`configEditor.edit` 会触发插件重启）后的页面行为与重启后持久性。
- 真实 UI 下的优化替换、光标插入、输入框忙碌失败。
- 页面刷新以加载最新客户端代码（本会话最后一次修改发生在安装之后）。

## 7. 占位符与待确认

| 原占位符 | 本次取值 | 依据 |
| --- | --- | --- |
| dsh 技术栈/插件机制/扩展规范 | DSH Cordis Host 插件 + Client Slot/`sidebarRightTabs` + `webServer.register` | `dsh-doc` 技能文档 + live `cordis_inspect_query` |
| 现有输入框代码路径 | `D:\05_Code\pro-prompt`（原 `dsh-prompt-studio`） | 工作区与 profile 依赖 |
| 插件文档路径/链接 | dsh-doc 的 `references/plugin-development.md`、`ui-plugin.md`、`configuration.md`、`verification.md` | 已加载并遵守 |
| 两个模式名称与定义 | 结构优化（默认）/ 保真润色 | 内置模式定义 + 结构模式升级 |

待确认：Key 归属/配额/到期；默认模式真实配置写入的重启行为；真实麦克风与视觉效果；60 秒上限是插件保护值而非 exe 值；结构优化在关键事实缺失时会保留“执行前确认”问题，这是不捏造事实的取舍。

## 8. 验收标准对照

| 验收项 | 状态 | 证据/备注 |
| --- | --- | --- |
| 插件注册，中文名/英文名正确 | 已实现 | `pro-prompt` 1.4.0；`locale/zh.json`=输入增强，`en.json`=pro-prompt；Host 行 active；视觉效果待刷新确认 |
| 界面全部中文 | 已实现 | 客户端文案/错误/toast 中文化；技术名（模型名、`pro-prompt`）除外；视觉待确认 |
| 模板/预置已删除并清理 | 已实现 | 代码/路由/UI/配置删除；旧 storage/junction 清理；旧 localStorage 键客户端删除 |
| 语音使用选定的 ASR 模型/密钥 | 已实现并实测 | SiliconFlow `Qwen/Qwen3-ASR-1.7B` + profile `apiKey`；真实 ASR 通过；润色/优化为 `DeepSeek-V4.1-Flash` |
| 优化直接产出，无二次确认 | 已实现 | ✦ → `/optimize` → `setDraft` 替换；无确认 UI；单测覆盖 |
| 优化满足 agent 约束 | 已实现 | faithful 保留 9 条约束；structure 使用完整提示词契约 + 能力目录 + 执行前确认 |
| 默认模式为结构优化 | 已实现 | `DEFAULT_MODE=structure`；patch/profile/configEditor/client 同步；测试覆盖 |
| 结构优化是完整提示词 | 已实现并实测 | 覆盖目标/事实/输入/步骤/能力/约束/输出/验收；3 个真实草稿无占位符；缺事实时用执行前确认 |
| 结构优化选择 DSH 能力 | 已实现 | `capabilityCatalog` 注入真实 skill/plugin；MCP 无则明确不编造；单测 + 实测 `dsh-doc` |
| 结构优化不捏造事实 | 已实现 | 事实只来自草稿；执行约定与事实分离；二次审查检查占位符/虚构 |
| 侧边栏可切换两模式并设默认 | 已实现 | 模式卡/默认徽标/设置接口；默认模式写入走 configEditor；真实持久化待点验 |
| 语音点击开始/再次停止输出 | 已实现 | 录音状态机、计时、识别中取消、插入；真实麦克风待验收 |
| 无历史提示词/额外存储 | 已实现 | 无模板/历史/Key 存储；`storages/pro-prompt` 不存在；默认模式写现有配置 |
| 备选方案单独提交 | 已实现 | `docs/alternatives.md` + 本报告第 5 节；当前只启用首选，其他备选未启用 |
