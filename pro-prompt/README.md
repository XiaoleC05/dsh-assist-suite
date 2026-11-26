# 输入增强（pro-prompt）

[![test](https://github.com/XiaoleC05/pro-prompt/actions/workflows/test.yml/badge.svg)](https://github.com/XiaoleC05/pro-prompt/actions/workflows/test.yml)

DSH 输入框的独立增强插件：**语音输入** + **提示词优化**。全部模型通过 **SiliconFlow 中转站**调用：ASR 使用 `Qwen/Qwen3-ASR-1.7B`，语音润色/提示词优化使用 `deepseek-ai/DeepSeek-V4.1-Flash`；共用同一把 SiliconFlow 密钥。语音润色与结构优化提示词均为插件内置，不依赖外部程序或文件。

- 中文名：**输入增强**
- 英文/包名：**pro-prompt**
- 界面语言：中文
- 不保存提示词、音频或历史记录，不创建额外存储空间

## 功能

| 功能 | 位置 | 行为 |
| --- | --- | --- |
| 提示词优化 | 输入框左侧 ✦ 按钮 | 点击后**直接**调用 `deepseek-ai/DeepSeek-V4.1-Flash` 优化当前输入并替换；无确认弹窗、无中间页 |
| 语音输入 | 输入框左侧麦克风按钮 | 点一次开始录音，再点一次停止；自动识别 + 润色并插入输入框 |
| 模式设置 | 左侧栏「输入增强」页 / 右侧栏「增强」页 | 保真润色 / 结构优化；可切换、可设为默认 |
| 服务状态 | 左侧栏「输入增强」页 / 右侧栏「增强」页 | 显示 SiliconFlow 密钥来源、`Qwen/Qwen3-ASR-1.7B` / `DeepSeek-V4.1-Flash`、最长录音；不显示密钥 |

配置项全部在侧边栏：左侧栏「输入增强」面板，或右侧栏「增强」页。

## 两种模式

两种模式同时作用于**提示词优化**与**语音润色**：

### 结构优化（structure，默认）

- 先分析草稿：任务类型、目标、已知事实、缺失信息、输入/处理/输出/验收、风险边界。
- 再构建**完整提示词**：角色与目标 / 背景与已知事实 / 输入 / 执行步骤 / 可用能力 / 约束 / 输出格式 / 验收标准。
- 从可配置的 **DSH 能力目录**中选择真正相关的 skill / MCP / 插件，并写明用哪个能力做什么；目录外不编造名称。
- 事实不足时使用**执行前确认协议**（最小澄清问题或条件分支），不写 `【待补充】`、`TODO` 等占位符，也不编造事实。
- 区分“用户事实”与“执行约定”；执行约定只使用工程通用做法（先读代码、最小改动、报告验证等）。
- 结构模式生成后会做一次**审查/压缩**：缺节、含占位符、能力名可疑时自动重写，确保最终可发送。
- 适合“只有一个想法，希望 agent 直接按完整提示词执行”的输入。

### 保真润色（faithful）

- 100% 保留原意、事实、数字、专名、时间、约束、代码与示例。
- 只修语序、残句、指代、标点、重复和口头禅。
- 不加结构、不扩写、不替用户补事实。
- 适合“想法已经清楚，只希望 agent 准确理解”的输入。

两种模式的完整提示词在 [`lib/prompts.js`](lib/prompts.js)；结构优化的能力目录可通过 `capabilityCatalog` 配置。GitHub 开源项目的取舍见 [`docs/prompt-engineering-research.md`](docs/prompt-engineering-research.md)。

## 语音识别与 Key

链路：浏览器录音 → 16 kHz 单声道 PCM16 WAV → `/pro-prompt/voice/process` → SiliconFlow `Qwen/Qwen3-ASR-1.7B` → SiliconFlow `deepseek-ai/DeepSeek-V4.1-Flash` → 插入输入框。

- **密钥**：一把 SiliconFlow 密钥，写在 profile 级 `apiKey`；不进入插件仓库。也可用环境变量 `SILICONFLOW_API_KEY`。ASR 与 chat 共用。
- **模型**：`Qwen/Qwen3-ASR-1.7B`（识别）、`deepseek-ai/DeepSeek-V4.1-Flash`（润色/优化）。
- **识别参数**：`language=zh`；SiliconFlow 的音频转写接口负责标点/文本整理。
- **音频**：只在识别时临时经内存发送，不落盘、不保存历史。
- **失败降级**：润色失败时保留 ASR 原文并提示；纯语气词/无实质内容返回空，不插入。

> 语音提示词与提示词优化提示词都在 [`lib/prompts.js`](lib/prompts.js)；插件不读取外部 exe、`.env`、模板或历史文件。

## 面向 agent 输入的约束

优化提示词在内置的保真/结构语义上增加了 9 条约束：

1. 目标明确
2. 结构与上下文分离
3. 事实保真
4. 约束可执行
5. 输出明确
6. 验收明确
7. 歧义不臆测
8. 精简无冗余
9. 代码任务先读后改

来源、star 数与逐条映射见 [`docs/agent-input-constraints.md`](docs/agent-input-constraints.md)。star 数为 2026-11-18 通过 GitHub API 读取。

## 安装与启用

### 从本地目录安装（推荐）

```powershell
cd D:\05_Code\pro-prompt
# 在 DSH 的 Plugins 页面用 “Add plugin” 选择本目录；或使用 plugin_manager：
#   install_bundle  target = D:\05_Code\pro-prompt
```

安装后确认 **Plugins** 中出现：

- 中文名：输入增强
- 包名：`pro-prompt`

插件行 id 为 `pro-prompt`。

### 手工链接（desktop profile）

桌面版 profile 由 Electron 独占管理时，可手工链接：

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
$plugin  = "D:\05_Code\pro-prompt"

New-Item -ItemType Junction -Path "$profile\node_modules\pro-prompt" -Target $plugin
# profile/package.json:
#   dependencies:    "pro-prompt": "link:D:/05_Code/pro-prompt"
#   dsh.profile.bundles: 追加 "pro-prompt"
```

然后重启 DSH。若从旧的 `dsh-prompt-studio` 迁移，先移除旧 bundle，避免两个插件同时注册输入框按钮。

### 安装后

1. 刷新页面（客户端模块会重新加载）。
2. 打开任意会话，确认输入框左侧出现 ✦ / 麦克风两个功能按钮。
3. 左侧栏出现「输入增强」面板图标；右侧栏「增强」页签也可打开同一配置页。

## 配置

`cordis.patch.yml` 默认行：

```yaml
- insert:
    - id: pro-prompt
      name: pro-prompt
      config:
        enabled: true
        apiBase: https://api.siliconflow.cn/v1/chat/completions
        apiKey: ''
        apiKeyEnvFile: ''
        apiKeyEnvName: SILICONFLOW_API_KEY
        asrProvider: siliconflow
        asrApiBase: https://api.siliconflow.cn/v1
        asrModel: Qwen/Qwen3-ASR-1.7B
        polishModel: deepseek-ai/DeepSeek-V4.1-Flash
        language: zh
        defaultMode: structure
        maxSeconds: 60
        speechTimeoutMs: 90000
        optimizeTimeoutMs: 180000
        maxPromptChars: 20000
        maxOutputTokens: 2048
        polish: true
```

| 字段 | 说明 |
| --- | --- |
| `apiKey` | SiliconFlow 密钥；默认空，推荐写在 profile 级配置，**不要提交真实密钥** |
| `apiKeyEnvName` | 默认 `SILICONFLOW_API_KEY` |
| `asrApiBase` / `asrModel` | `https://api.siliconflow.cn/v1` / `Qwen/Qwen3-ASR-1.7B` |
| `polishModel` | `deepseek-ai/DeepSeek-V4.1-Flash`（SiliconFlow 润色/优化） |
| `language` | `zh`（默认）/ `auto` / `en` |
| `defaultMode` | `structure`（默认）/ `faithful`；侧边栏“设为默认”会通过配置编辑器写回 |
| `capabilityCatalog` | 结构优化使用的 DSH skill / MCP / 插件目录；默认内置当前 profile 的真实能力，避免编造名称 |
| `maxSeconds` | 插件保护上限，5–120 |
| `maxPromptChars` | 单次优化输入上限 |
| `polish` | 关闭后语音只返回 ASR 原文 |

## 存储与隐私

- **没有**模板库、提示词预置、最近使用、语音历史。
- **没有** `$DSH_HOME/storages/pro-prompt/`；插件不创建存储目录。
- 唯一可能持久化的偏好是“默认模式”，写入**已有**的 profile 配置（`configEditor`），不是新文件；配置编辑器不可用时只在本次运行生效，并在 UI 说明。
- SiliconFlow 密钥写在 profile 级 `cordis.patch.yml` 的 `apiKey`，不进入插件仓库，也不创建新的密钥文件。
- 浏览器不保存提示词/音频；客户端启动时清理旧 Prompt Studio 的两个 localStorage 键。
- 密钥只在 Host 进程内读取，浏览器只拿到“是否配置/来源”。

## 从旧 Prompt Studio 迁移

删除/替换：

- 模板库与模糊搜索（`lib/templates.js`、模板路由、模板 UI、starter templates）
- 提示词预置与模板编辑/保存/删除
- 语音历史（localStorage）与 Key 配置 UI
- 旧优化器的 DSH LLM 路由、风格/输出语言选择、本地回退、provider/model 配置

保留/升级：

- 输入框双功能按钮（✦ / 麦克风）与左侧栏入口
- 浏览器录音 → 16 kHz WAV → SiliconFlow ASR → SiliconFlow chat 润色 → 插入输入框
- 内置的 faithful/structure 语音润色提示词
- 优化按钮改为直接替换（无二次确认）

旧数据：`$DSH_HOME/storages/prompt-studio/templates.v1.json`、`voice.json` 和旧 localStorage 键已在迁移中清理；详见 [`docs/manual-acceptance.md`](docs/manual-acceptance.md)。

## 测试

```powershell
npm run check
npm test
```

覆盖：配置归一化、SiliconFlow 密钥解析、语音提示词保真、SiliconFlow ASR 转写请求/错误、SiliconFlow chat 润色/优化、WAV 校验、语音降级、优化器校验、路由同源/方法/大小限制、Host 装配、浏览器 WAV/插入/状态机。真实通话不在 CI 内，按 [`docs/manual-acceptance.md`](docs/manual-acceptance.md) 手工验收。

开发过程中已用临时脚本对真实接口做过抽查（不随包交付）：SiliconFlow `Qwen/Qwen3-ASR-1.7B` 转写、SiliconFlow `DeepSeek-V4.1-Flash` 润色/优化均返回中文结果。

## 目录

```text
index.js                 Host 入口：配置、Key 解析、服务与路由装配
client.js                浏览器半：输入框按钮、录音、侧边栏
lib/config.js            配置归一化与边界
lib/key.js               profile 配置 / 环境变量只读 Key 解析
lib/asr.js               SiliconFlow Qwen3-ASR-1.7B 转写适配
lib/prompts.js           内置语音提示词 + 完整提示词构建/审查
lib/chat.js              SiliconFlow DeepSeek-V4.1-Flash 润色/优化客户端
lib/voice.js             WAV 校验、ASR+润色编排
lib/optimize.js          提示词优化器
lib/routes.js            四个同源 JSON 路由
locale/                  插件卡片中英文名称
docs/                    约束来源、提示词工程参考、备选方案、手工验收
test/                    Node 单元测试
```

## 备选方案

见 [`docs/alternatives.md`](docs/alternatives.md)。当前只启用 **SiliconFlow `Qwen/Qwen3-ASR-1.7B` + `DeepSeek-V4.1-Flash`**；本地 FunASR/Paraformer 仍是隐私优先的备选，但需要额外存储/运行时。

## 已知限制 / 待确认

- 麦克风需要 HTTPS 或 localhost；识别是批处理，不是流式字幕。
- 默认 60 秒上限是插件保护值。
- 结构优化在关键事实缺失时不会编造，也不会写占位符；它把缺口写成“执行前确认”的最小问题或条件分支。若希望结果完全不出现澄清问题，需要在草稿里提供足够事实。
- 结构优化比保真模式更慢：可能触发第二遍审查/压缩；这是完整性与速度的取舍。
- SiliconFlow 密钥的配额、归属、到期时间需确认；本机 2026-11-19 实测 ASR 与 chat 两段链路均可调用。
- 真实麦克风、真实识别质量和真实 React 渲染需按手工清单验收。
- 插件界面固定中文；英文 locale 只用于插件卡片名称/描述。

## License

MIT
