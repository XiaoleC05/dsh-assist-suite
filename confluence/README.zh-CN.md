# Confluence / 高级记忆

> **同工作区的会话一起工作，你的长期记忆、画像与风格跟着你走。**
> **Sessions in one workspace work as a team; your long-term memory, persona and style follow you everywhere.**

**状态：v0.4.0 目标版——三层（工作区总线、长期记忆、用户画像）+ 双域风格卡。** v0.4.0 是由
[ADR 0009](docs/adr/0009-long-term-memory-persona-style.md) 定义的破坏性轮次，它扩展
[ADR 0008](docs/adr/0008-bus-and-profile.md)（两个作用域、队列式消息），并继续取代
[ADR 0007](docs/adr/0007-universal-memory-scope.md) 的作用域规则。约束性接口规范见
[docs/plan/v0.4-interfaces.md](docs/plan/v0.4-interfaces.md)。v0.4.0 的离线证据**已在本代码树执行（2026-11-27）**：
离线套件 **398/398 通过**、打包契约 **20/20 项检查通过**、契约测试 **25/25 通过**、离线临时 profile E2E
**22/22 项 harness 检查 + 19/19 条断言检查，退出码 0**（运行目录 `.tmp/e2e/run-20261127-025250`）、
`npm pack --dry-run` 30 个文件；本机真实 desktop profile 已在运行 v0.4.0（心跳与 persona/memory 注入块可见，
旧画像 `tech` 事实已迁移为长期记忆 pattern）。下表已执行证据只对各自版本成立：
v0.3.0（2026-11-19，离线套件 **353/353 通过**、打包检查 **18/18 项通过**、离线临时 profile E2E
**17/17 项 harness 检查 + 15/15 条断言检查，退出码 0**，运行目录 `.tmp/e2e/run-20261119-032058`）；
v0.2.1（2026-11-16，**291/291**、**17/17**、E2E **15/15 + 12/12**，运行目录
`.tmp/e2e/run-20261116-203730`；证据见
[docs/discussion/v0.2-e2e-evidence.md](docs/discussion/v0.2-e2e-evidence.md)）；v0.1.0（2026-11-13，
**256/256**、**12/12**、E2E **8/8**）。任何版本都仍未执行：面板渲染、真实 desktop profile 的
安装/重启、发布——**未发布任何东西**。

Confluence（中文名 **高级记忆**）是一个**完全离线**的 DeepSeek Harness（DSH）插件，服务于单个 DSH
profile。它提供三层记忆，外加一个输出侧：**工作区会话总线**让同一目录下的会话共享任务态、便签和定向消息；
**长期记忆**保存可泛化的 pattern，跨任务、跨工作区复用；**用户画像**只保存个性子集并注入每个会话；
**风格卡**约束回答与工程产物怎么写。运行时不联网、不启动服务器、不新增监听端口、不启动子进程、
不调用模型、不使用向量库。

- 目标宿主：DSH Desktop **0.2.2-rc.1**（声明的最低要求 `>=0.2.2-rc.1`），profile `desktop`。
- 包：`dsh-confluence` **v0.4.0** 目标版（manifest/版本切换属于 v0.4.0 打包工作流），`private: true`，
  MIT，无运行时依赖。
- 仓库：[https://github.com/XiaoleC05/Confluence](https://github.com/XiaoleC05/Confluence)
- 从 v0.3.x 升级？先读 [docs/upgrade-v0.4.md](docs/upgrade-v0.4.md)——记录类型、工具、导出文档与配置都变了，
  旧画像事实会一次性迁移进 pattern，且本地链接的 bundle 需要重启 DSH。

---

## 问题

DSH 的每个会话都是相互隔离的语言上下文，由此产生三个问题：

1. **任务态被困在单个会话里。** 同一项目上的两个窗口、两个 Agent 看不到彼此的决策、发现和下一步，
   于是同样的排查被重复，交接只能靠复制粘贴文件。
2. **在一个任务里学到的东西活不到下一个任务。** Windows 上改文件名要重试的坑、API 错误信封的项目约定、
   某个服务的领域知识——每个新会话都要重新学一遍。
3. **风格不是你的。** 回答、commit message、代码注释、README 文案、错误信息、日志、UI 微文案都默认按
   模型的通用风格走，无论用户偏好什么。

v0.1.0 按工作区隔离记忆，太窄；v0.2.0 又矫枉过正，用一层通用记忆
（[ADR 0007](docs/adr/0007-universal-memory-scope.md)，现已退役）取代工作区边界；v0.3.0 把产品拆成
工作区总线 + 全局用户画像（[ADR 0008](docs/adr/0008-bus-and-profile.md)），但「画像」里混进了技术栈与项目事实。
v0.4.0 修正这个模型（[ADR 0009](docs/adr/0009-long-term-memory-persona-style.md)）：

> 三层记忆：**工作区任务态（总线）** → **长期记忆（可泛化 pattern，候选确认制）** → **用户画像**（个性子集）。
> 独立一条输出侧：**双域风格卡**（对话文风 + 工程产物文案）。

画像是「关于用户本人」的子集；来自任务的知识绝不进入画像，而是成为长期记忆 pattern。风格是长期的输出约定：
像记忆一样存储、像记忆一样注入、随记忆一起导出。

---

## 三层（外加风格侧）

| 层 | 内容 | 记录类型 | 作用域 | 生命周期 |
|---|---|---|---|---|
| **1. 工作区任务态**（v0.3，未变） | 任务状态、便签、定向消息 | `context`、`entry`、`message` | 单个工作区 | 任务范围 |
| **2. 长期记忆**（新） | 从任务中提炼的可泛化 pattern | `pattern` | 全局，带标签（`global`/`workspace`） | 持久、可移植 |
| **3. 用户画像**（v0.3 画像的重构） | 个性子集：identity、personality、communication、habits、boundaries、taste | `profile` | 全局 | 持久、可移植 |
| **风格侧**（新） | 对话文风/结构 + 工程产物文案规则 | `style`（两个通道） | 全局 | 持久、可移植 |

三类全局记录都保存在保留的全局作用域 `ws_0000000000000000`，并通过**有界提示词块**注入。工作区总线在
v0.4.0 中不受影响。

---

## 第 1 层 — 工作区会话总线（v0.3，未变）

工作目录解析到同一工作区的会话共享一条活的总线，多窗口、多 Agent 协作不再需要手工传文件。

- **工作区身份。** 键为 `ws_<sha256(canonical header.cwd realpath, win32 lower-case)[:16]>`，在会话首次被
  观察到时由 `session.header.cwd` 冻结（之后的 `cd` 不会搬家）。键相同的会话共享总线，不同的永不相通。
  没有 `cwd` ⇒ 总线调用返回 `NO_WORKSPACE`（空视图；全局层仍可用）。标签只是 basename/registry 标题，
  仅用于显示：**绝对路径绝不进入记录、提示词或面板载荷**。
- **共享状态池**（`confluence_context`）。每个工作区一组键值（键匹配 `^[a-z0-9][a-z0-9._-]{0,63}$`，
  `valueType` 为 `text` 或 `json`）；按 `seq` 最后写入者胜出，`delete` 写墓碑。上限：
  `bus.context.maxKeys` 200 个活键，`bus.context.maxValueBytes` 8192。
- **便签板**（`confluence_board`）。仅追加的类型化便签——`finding`、`decision`、`gotcha`、`question`、
  `handoff`、`warning`——支持线程、`resolves`/`supersedes`、标签与文件。动作：`list`、`read`、`post`、
  `reply`、`search`；结果渲染 `through=<seq>` 游标。每个工作区上限 `bus.notes.maxEntries` 2000。
- **会话间消息**（`confluence_send`、`confluence_inbox`）。可发给整个工作区（`to:"*"`）或某个精确的
  session id；类型为 `notice`、`instruction`、`query`、`reply`；消息不可变。上限：`maxStored` 500 条活消息，
  `maxBodyBytes` 4096 每条正文。
- **被动脉冲。** 每步最多渲染一段有界的
  `<confluence-memory scope="workspace" name="<label>" unread="<n>" peers="<m>" seq="<maxSeq>">` 摘要：
  少量共享状态键、未读消息标题、当前在线的同伴，以及总线工具指引。上限 `bus.pulse.maxChars` 1400、
  `maxMessages` 3、`maxStateKeys` 3、`maxPeers` 2，按固定顺序降级；字节稳定，无事可说时整块不出现。

总线数据**只**存在于该工作区的日志：绝不跨工作区合并、绝不导出到另一个工作区、也绝不注入另一个工作区的会话。

---

## 第 2 层 — 长期记忆（pattern，候选确认制）

`pattern` 记录保存**从任务中提炼的可泛化 pattern**，以便跨任务、跨工作区复用。插件本身不会学习：Agent 在
正常对话中提出 pattern，用户确认后才生效。

- **形状。** `key`（`^[a-z0-9][a-z0-9._-]{0,63}$`，更新时保持稳定）、`category`
  （`workflow`、`project`、`domain`、`pitfall`、`heuristic`、`quality`）、`title`（≤120 字符）、
  `body`（≤2048 字节）、`tags`（≤8）、`scope`（默认 `global`，或 `workspace` 并带
  `workspaceKey`/`workspaceLabel`）、`status`（`candidate|active|rejected|superseded`）、`confidence`
  （0..1，默认 0.5）、`source`（`agent|user|import|migration`）、最多 3 条仅元数据的 `evidence` 与
  `author`。记录仅追加：更新是同 `key` 的新记录，`seq` 最大者胜出。
- **候选优先写入。** `confluence_memory add` **总是**写 `status:"candidate"`。候选绝不会作为规则被注入。
  用户确认 → Agent 调 `promote`（→ `active`）；用户否决 → `reject`/`forget`（→ `rejected`）；修订时保持
  状态并追加新版本。只有 `active` 的 pattern 会被注入，另外附带一段有界的候选提示（数量 + 最多两个
  key/标题），让用户/Agent 知道有待确认项。
- **注入时选择。** 取 `scope: global` 的 active pattern，加上 `scope: workspace` 且匹配当前会话工作区的
  pattern；按 `confidence` 降序、再按 `seq` 降序；上限 `memory.maxInjectPatterns` 5、
  `memory.maxInjectChars` 1200；每行渲染为 `[category] title: body`。
- **上限与安全。** `memory.maxPatterns` 300 条活 pattern（候选 + 生效），body/title/tags/evidence 均有
  上限，所有文本写入时脱敏，所有 pattern 文本在提示词中按不可信数据处理。
- **半自动。** 没有后台抽取、没有提示词抓取、没有 LLM 抽取、没有嵌入或向量检索。抽象发生在 Agent 的
  正常对话里；把整份语料蒸馏成风格卡是另一项显式的内容任务（Agent/CLI 协助），绝不是运行时隐藏的一遍。

---

## 第 3 层 — 用户画像（只存个性子集）

每个 DSH profile 一份持久、可移植的画像，无论工作区都会注入每个会话。

- **存什么。** **六个个性分节**的事实——`identity`、`personality`、`communication`、`habits`、
  `boundaries`、`taste`——每条是一个 `(section, key)` 对，带值、`confidence`（0..1，默认 0.6）和
  `source`（`agent`、`user`、`import`）；同一键最后写入者胜出，`forget` 写墓碑。上限：
  `profile.maxFacts` 200 条活事实，`profile.maxValueBytes` 1024。
- **旧数据别名与迁移。** v0.3 的 `preferences` 事实在读取时折叠为 `communication`，`rules` 折叠为
  `boundaries`。v0.3 的 `tech`/`context` 事实**不是画像**：它们由一次性的 `memory-migration` 标记
  迁移为 `pattern` 记录（category `project`/`domain`，source `migration`），不再出现在画像块里。
- **全局注入。** `<confluence-profile rev="<seq>" facts="<n>">` 按固定顺序
  `identity, personality, communication, habits, boundaries, taste` 渲染六个分节，只取
  `confidence >= profile.minConfidence` 的事实，每节最多 3 条、值 ≤ 80 字符、总量 ≤
  `profile.maxInjectChars` 1200。画像为空时，注册的贡献改为一段有界的 onboarding 提示
  （`<confluence-profile status="empty" facts="0">`），提醒 Agent 记录持久特质；首条事实写入后即消失。
- **半自动。** 当用户透露持久特质时，Agent 通过 `confluence_profile set` 记录；用户也可以明确要求记录；
  导入是确定性的。没有隐藏的模型调用。
- **画像工具。** `confluence_profile` 现在**只管画像**：`get`、`list`、`set`、`forget`。导出/导入已移到
  `confluence_memory`（`confluence.memory/v1` 也覆盖 pattern 与风格）。

---

## 风格卡（两个通道）

`style` 记录是同一持久层的输出侧：确定、可移植的输出约定，不是微调。

- **通道与领域。** `channel: chat` 覆盖 `general`、`tone`、`structure`（回答文风）；`channel: engineering`
  覆盖 `commit`、`comment`、`docs`、`naming`、`error`、`log`、`ui`——即 commit message、注释/docstring、
  README/文档、PR/issue 文案、错误信息、日志、命名与 UI 微文案。
- **形状。** `key`（稳定，`^[a-z0-9][a-z0-9._-]{0,63}$`）、`title`（≤120）、`rule`（≤1024 字节）、
  最多 3 条 `{bad, good}` 示例（各 ≤512 字节）、tags（≤8）、`priority` 0..100（默认 50，高者优先）、
  `enabled`、`confidence`、`source`（`user|agent|import`）；按 `(channel, key)` 最后写入者胜出。
- **写入即生效。** `confluence_style set` 直接写一条生效规则——用户在明确陈述风格，因此这里没有候选队列。
  `confluence_style remove` 写 `enabled:false`。
- **有界注入。** `<confluence-style chat="<n>" engineering="<m>">` 先渲染 `chat` 规则再渲染 `engineering`；
  `priority` 降序、再按 key；每条规则一行且有界；`enabled:false` 跳过；chat 总量 ≤
  `style.maxInjectCharsChat` 600，engineering ≤ `style.maxInjectCharsEngineering` 900。`style.maxRules`
  100 条活规则（两个通道合计）。
- **半自动。** 风格规则来自用户明说，或来自 Agent/CLI 依据用户提供的材料所做的显式离线蒸馏任务——
  插件自身从不调用模型。

---

## 三个注入块与预算

下表四行都是 `ctx.systemPrompt.context()` 贡献，从内存折叠同步渲染：无 IO、字节稳定、异常安全、有界。
`index.js` 负责注册 v0.4 的三个块；工作区脉动是 v0.3 的贡献，未变。

| 名称 | 顺序 | 块 | 预算 |
|---|---|---|---|
| `confluence:profile` | 1400 | `<confluence-profile rev="…" facts="…">` 画像（六个个性分节） | 每节 ≤3 条、值 ≤80 字符，总量 `profile.maxInjectChars` 1200 |
| `confluence:memory` | 1410 | `<confluence-memory-patterns count="N" candidates="M">` 生效 pattern + 候选提示 | `memory.maxInjectPatterns` 5、`memory.maxInjectChars` 1200 |
| `confluence:style` | 1420 | `<confluence-style chat="N" engineering="M">` 先 chat 后 engineering | `style.maxInjectCharsChat` 600 + `maxInjectCharsEngineering` 900 |
| `confluence:pulse` | 1500 | `<confluence-memory scope="workspace" …>` 工作区摘要（v0.3，未变） | `bus.pulse.maxChars` 1400 |

某一层为空时渲染 `''`、不产生贡献（画像为空时贡献那段有界 onboarding 提示）。每个块都是提示词中的
**被动文本**——不是消息，也不是命令——pattern/style/画像内容都按不可信背景数据处理。

---

## 候选确认流程（显式、对话式）

离线插件刻意不做自动学习，owner 选择了候选队列：

1. 任务结束后，Agent 用 `confluence_memory add` 提出可泛化的 pattern（总是 `candidate`，附 `evidence`
   元数据与 `confidence`）。
2. 提示词里只显示有界的候选提示——在确认之前，候选**绝不是规则**。
3. 用户在对话中确认（或要求丢弃）。Agent 确认后调 `confluence_memory promote`，否决时调
   `reject`/`forget`，修订时调 `update`（同 key、新版本、状态保留）。
4. 面板保持**只读**：它列出 pattern/候选，并提示用户向 Agent 确认——UI 没有写入路径。
5. 风格不走候选队列，因为 `set` 就是用户在明确陈述规则；`remove` 用于停用。

`memory.autoCapture: off` 告诉 Agent 不要自动提出 pattern（工具与队列仍然可用）。插件自身从不决定记住什么。

---

## 半自动与离线边界

- **没有隐藏的模型调用。** Confluence 不发网络请求、不调用模型、不抓取提示词、不做后台抽取、不用嵌入/
  向量库。抽象与蒸馏发生在 Agent 的正常对话中，或由用户显式运行 CLI 完成。
- **确定性的可移植性。** 导出/导入是确定性且经过校验的；同一份文档产生同一批记录。
- **只写显式路径。** pattern 来自 `confluence_memory add`（Agent）或导入；风格来自 `confluence_style set`
  或导入；画像事实来自 `confluence_profile set` 或导入。没有静默捕获路径。
- **用户掌控。** 候选队列、只读面板与 `privacy.privateSessions` 是控制面；私密会话对所有层都不可见。

---

## 可移植性 — `confluence.memory/v1` 与记忆 CLI

一份规范文档承载全部持久记忆：

```json
{
  "format": "confluence.memory/v1", "version": 1, "kind": "memory", "scope": "global",
  "generatedAt": "ISO", "revision": "ULID|null",
  "persona": { "sections": [{ "id": "communication", "facts": [{"key","value","confidence","source","ts"}] }] },
  "patterns": [{"key","category","title","body","tags","scope","workspaceKey?","workspaceLabel","status","confidence","source","ts"}],
  "styles":   [{"channel","area","key","title","rule","examples","tags","priority","enabled","confidence","source","ts"}],
  "counts": {"persona": 3, "patterns": 12, "styles": 6},
  "limits": {"maxPatterns": 300, "maxFacts": 200, "maxRules": 100},
  "redaction": {"applied": true, "policy": "confluence.redact/v1"}
}
```

- **导出：** `confluence_memory export`（结构化输出；`exported.text` 留在工具结果里，不进提示词）、面板的
  `/confluence/panel/profile/export?format=json|md` 下载，或 CLI。导出已脱敏、不含路径，并受
  `profile.maxExportBytes` 65536 约束。
- **导入：** `confluence_memory import` / CLI，`merge`（默认；按 key/分节键最后写入者胜出）或 `replace`
  （文档中不存在的 pattern/style 变为 `rejected`；画像先写 `profile-reset` 代际标记）。严格校验、有尺寸上限、
  绝不抛原始错误。旧 `confluence.profile/v1` 文档按**仅画像**接受。
- **CLI（v0.4.0 改名）：** `scripts/memory-export.mjs` 与 `scripts/memory-import.mjs` 取代
  `scripts/profile-export.mjs`/`profile-import.mjs`，保持 v0.3 的离线 CLI 形态：
  `node scripts/memory-export.mjs --dsh-home <dir> [--format json|md] [--out <file>] [--dry-run]` 与
  `node scripts/memory-import.mjs --dsh-home <dir> --from <file> [--mode merge|replace] [--dry-run]`。
  `--dsh-home` 为必填；绝不回退到真实主目录。

持久日志位于全局作用域 `ws_0000000000000000`（作用域标签「全部会话」/ All sessions），与未变的仅元数据账本、
presence 心跳同存。它是**画像**作用域，不是看板——仍然没有全局便签视图。

---

## 消息是队列式的——不打断、不唤醒

这是从 v0.3.0 继承的硬性产品规则（[ADR 0008](docs/adr/0008-bus-and-profile.md) §3），v0.4.0 未变：
DSH 0.2.2-rc.5 没有静默的跨会话通知通道，而所有主动通道都会伪造 user 角色消息、可能唤醒空闲会话、
并消耗一次 LLM 调用。

- `confluence_send` 写入一条持久 `message` 记录；它不会触碰接收方的会话。
- 运行中的接收方在**下一步**看到它（下一步的工作区脉动 + `confluence_inbox`，是秒级而不是瞬时）；
  空闲接收方在**下一次发言**时看到它。
- 读取游标（`inboxReadSeq`）只从已提交的 `confluence_inbox` 结果前进——绝不因 UI 操作或脉动渲染前进。
- v0.4.0 绝不打断、操纵、唤醒或提示会话，也绝不为投递消耗模型调用。可选的唤醒/注入投递明确**不在范围内**，
  将来需要新的 ADR。

脉动与三个记忆/画像/风格块遵循同样的诚实原则：它们是提示词中的**被动文本**，不是消息，也不是命令。

---

## 工作方式（架构）

```text
┌──────────────────── DSH Desktop（每个应用实例一个 Host）────────────────────┐
│  会话 A — 工作区 X        会话 B — 工作区 X        会话 C — 工作区 Y          │
│  prompt: profile (1400)   prompt: profile (1400)   prompt: profile (1400)      │
│        + memory (1410)          + memory (1410)          + memory (1410)       │
│        + style (1420)           + style (1420)           + style (1420)        │
│        + 工作区脉动 (1500)      + 工作区脉动 (1500)      （无工作区总线）        │
│  tools: confluence_* × 8   tools: confluence_* × 8  tools: confluence_* × 8   │
│            │                     │                        │                   │
│            ▼                     ▼                        ▼                   │
│  ┌──────── Confluence 宿主插件（纯 ESM，仅 Node 内置模块）────────────────┐     │
│  │ facade.js：工作区解析 + 私密会话门禁 + 懒加载                          │     │
│  │ store.js（逐作用域日志 + 合并缓存）· board · context · bus             │     │
│  │ profile（画像）· memory（pattern）· style（风格卡）· pulse · watermark  │     │
│  │ presence · ledger · recall · tools · hostui · export · config           │     │
│  │ workspace · redact · util                                               │     │
│  └────────────────────────────────┬───────────────────────────────────────┘     │
│                                   │                                            │
│  $DSH_HOME/storages/confluence/v1/                                             │
│    workspaces/ws_<16hex>/            L1 总线：状态 + 便签 + 消息（逐工作区）     │
│    workspaces/ws_0000000000000000/   L2 pattern + L3 画像 + 风格                │
│                                      + 仅元数据账本 + presence                  │
│    （v0.2.1 的全局看板文件留在此处，不修改、不归属到任何工作区）                 │
│                                                                                │
│  Web 面板：三个只读同源视图；不新增端口、不写入                                  │
└────────────────────────────────────────────────────────────────────────────────┘
```

关键边界：

- **两个作用域。** 工作区日志保存总线数据且彼此隔离；全局日志保存 pattern、画像事实、风格规则、
  仅元数据账本与会话心跳。跨工作区知识只通过全局持久层流动。
- **会话日志仍是唯一事实来源。** 水位（`digestSeq`、`boardReadSeq`、`inboxReadSeq`）从已提交会话事件推导；
  插件状态只是派生缓存。
- **共享与习得的内容都是不可信数据。** 便签、状态值、同伴消息、pattern 与风格规则都带固定警告、
  转义框架字符（`<`、`&`、U+2028/2029），绝不作为指令执行，也绝不自行触发工具调用。画像是用户背景，
  按偏好应用；风格规则是用户明说的输出约定。
- **离线且有界。** Host 半身没有 `fetch`、网络模块、socket、子进程或模型调用；面板唯一的请求是相对同源 GET。
  按写入者分片的仅追加 JSONL，所有新写入路径都脱敏，所有尺寸都有上限（值脱敏为空时报 `REDACTED`）。
- **旧数据保留。** v0.3 画像事实留在磁盘上（只做增量迁移）；v0.2.1 全局看板条目原样保留，不合并进任何
  工作区视图；v0.1.0 工作区目录就是该工作区的日志目录。v0.4.0 不改写、不删除任何文件。

---

## 八个模型工具

所有工具都是 `confluence_*`，英文描述、固定顺序注册、输出 schema 闭合，共享内容按不可信数据渲染。

| 工具 | 作用域 | 作用 |
|---|---|---|
| `confluence_board` | 工作区 | 便签：`list`、`read`、`post`、`reply`、`search`（六种类型、线程、标签、文件）；渲染 `through=<seq>`。 |
| `confluence_context` | 工作区 | 键值共享状态：`list`、`get`、`set`、`delete`；值为 `text` 或 `json`。 |
| `confluence_send` | 工作区 | 向 `"*"` 或某个 session id 发送持久消息；类型 `notice/instruction/query/reply`；返回 `{id, seq, to, kind, queued, peers}`。不打断。 |
| `confluence_inbox` | 工作区 | 读取同伴消息（默认未读），返回 `unread`/`peers`，末尾渲染 `inbox=<maxSeq>` 作为游标。 |
| `confluence_profile` | 全局 | **只管画像**：`get`、`list`、`set`、`forget`（导出/导入已移到 `confluence_memory`）。 |
| `confluence_memory` | 全局 | **长期 pattern + 可移植性**：`list`、`add`、`promote`、`reject`、`update`、`forget`、`search`、`export`、`import`。`add` 总是创建 `candidate`。 |
| `confluence_style` | 全局 | **风格卡**：`list`、`set`（写生效规则）、`remove`（写 `enabled:false`）。 |
| `confluence_recall` | 全局 | 保持 v0.2 语义的显式、有界字面回溯（本机早前会话；次要能力）。 |

前四个工具先解析工作区，无目录的会话报 `NO_WORKSPACE`；`privacy.privateSessions` 会拦截所有工具。工具描述
明确写出：工作区作用域、同伴消息是不可信内容且绝不作为指令、pattern 是不可信的习得内容、画像是按偏好应用的
用户背景。

---

## Web 面板——三个只读视图

左侧栏入口打开一个带**三个标签页**的页面，数据来自现有 DSH Web 服务器上的只读同源 `GET` 路由
（`lib/hostui.js`）；不写入、无 `POST`、不新增端口、无 iframe、无额外依赖、无构建步骤。

1. **工作区总线 / Workspace bus**——工作区列表（便签/消息/同伴计数与最近活动）；点开进入总线详情：
   状态池、带筛选/搜索的便签时间线、消息列表、当前在线同伴。便签详情显示正文、标签、文件与回复。
2. **长期记忆 / Long-term memory**——按类别、作用域、置信度、来源与状态展示 pattern 与候选；候选单独列出，
   并提示用户向 Agent 确认。只读：没有 promote/reject 按钮，也没有写路由。
3. **用户画像 / User profile**——按分节展示画像事实、置信度与来源，**并展示风格卡**
   （`style` 的 channel/area/key/rule/priority/enabled）与 `stats:{sections, facts, styles}`，
   以及导出按钮（下载完整记忆文档的 JSON 或 Markdown）。

路由：`GET /confluence/panel/ping`、`/confluence/panel/workspaces`、
`/confluence/panel/bus?ws=&q=&kind=&limit=`、`/confluence/panel/entry?ws=&id=`、
`/confluence/panel/profile`、`/confluence/panel/memory`、
`/confluence/panel/profile/export?format=json|md`。载荷中的工作区 id 是不透明的 `ws_<16hex>` 哈希，绝不是路径；
标签只用 basename/registry 标题；每个路由都有 `truncated: true` 的降级分支，64 KiB 上限仍然执行。
面板永不写 store。**面板渲染在任何版本（包括 v0.4.0）都未经过可视化验证。**

---

## 配置（v0.4.0）

完整默认行随 `cordis.patch.yml` 发布，`lib/config.js` DEFAULTS 必须与其深等价。分节：`enabled`；`store`
（`dir`、`retentionDays` 90、`maxBodyBytes` 8192、`pollMs` 4000、`watch`、`maxOpenWorkspaces` 16）；
`bus`（`context.maxKeys` 200 / `maxValueBytes` 8192；`notes.maxEntries` 2000；`messages.maxStored` 500 /
`maxBodyBytes` 4096；`pulse.enabled` / `maxChars` 1400 / `maxMessages` 3 / `maxStateKeys` 3 / `maxPeers` 2）；
`profile`（`enabled`、`inject`、`maxFacts` 200、`maxInjectChars` 1200、`minConfidence` 0.3、
`maxValueBytes` 1024、`maxExportBytes` 65536——画像预算）；`memory`（`enabled`、`inject`、`maxPatterns` 300、
`maxInjectPatterns` 5、`maxInjectChars` 1200、`candidateConfidence` 0.5、`autoCapture` `candidate|off`）；
`style`（`enabled`、`inject`、`maxRules` 100、`maxInjectCharsChat` 600、`maxInjectCharsEngineering` 900）；
`ledger`、`recall`、`privacy`（`redact`、`redactTitles`、`denyPathPatterns`、`privateSessions`、
`redactPatterns`）、`ui`（`enabled`、`pollMs`）、`debug`（`logFile`）。v0.4 新增 `memory`/`style`，
**没有弃用项**（v0.3 键名与含义不变）；从 v0.3 升级需要重新复制整行覆盖配置并重启 DSH——配置变化、
自动数据迁移、重启要求、验证清单与回滚见 **[docs/upgrade-v0.4.md](docs/upgrade-v0.4.md)**。

---

## v0.4.0 明确不做的事

- 不做自动学习：没有后台抽取、提示词抓取、LLM 抽取、嵌入或向量检索——pattern 由 Agent 提出、用户确认，
  风格蒸馏是用户显式运行的内容任务；
- 不从面板写入（包括候选队列：确认是对话式的）；
- 不做微调或模型训练——风格卡是确定性的提示词规则；
- 不做唤醒/打断/操纵/「即时推送」投递——消息是队列式的，在接收方下一步/下次发言出现（将来若要做需新 ADR）；
- 不跨工作区合并总线数据（只有全局持久层能跨工作区），也没有全局「全部会话」看板视图；
- 不做服务器、网络调用、额外监听端口、外部数据库、子进程或模型调用；
- 不做跨机器的记忆/画像/风格同步，只有显式的 JSON/Markdown 导入导出；
- 不做便签编辑/删除界面、composer、自定义工具卡片、每会话未读徽标（已推迟）；不做远程/LAN 协作、
  Liveshare、git 自动化；
- 不替代 `@` 提及快照或原始会话搜索——它与它们并存。

---

## 实现现状（本仓库今天有什么）

| 声明 | 现状 |
|---|---|
| 三层决策（ADR 0009）+ 约束性 v0.4 接口规范 | **已有**——本轮冻结 |
| 宿主插件 v0.4.0（20 个 `lib/*.js`：v0.3.0 的 18 个 + `memory`/`style`） | **本轮实现中**——目标清单；尚未由 v0.4 门禁验证 |
| 八个 v0.4 工具、三个全局提示词块 + 工作区脉动、七条面板路由 / 三个标签页 | **本轮实现中**——设计已冻结，实现由各工作流进行；未执行 v0.4 门禁 |
| Web 面板（`client.js`，Dynamic ModuleLoader id `dsh-confluence`） | **实现中**（三个标签页 / 七条只读路由）；**任何版本都未做可视化验证** |
| 离线单元 + 集成测试 | v0.1.0：256/256；v0.2.1 树：**291/291 通过**（2026-11-16）；v0.3.0 树：**353/353 通过**（2026-11-19）；**v0.4.0：未执行** |
| 打包契约（清单/patch/locale/图标/入口） | v0.1.0：12/12；v0.2.1 树：**17/17**；v0.3.0 树：**18/18**（2026-11-19）；**v0.4.0：未执行** |
| 离线临时 profile E2E | v0.1.0：8/8；v0.2.1：**15/15 + 12/12**（运行 `20261116-203730`）；v0.3.0：**17/17 + 15/15，退出码 0**（运行 `20261119-032058`）；**v0.4.0：未执行** |
| 安装进临时 profile | **已在 v0.3.0 离线 E2E 中执行**（一次性 `DSH_HOME`、`dsh plugin add` + `--dump-config`） |
| 安装进真实 desktop profile | v0.1.0 **已执行**（`install_bundle` → applied）；v0.2.x、v0.3.0 与 v0.4.0 的重装/重启**未执行** |
| 在真实 GUI 中渲染面板 / npm pack / 发布 | 面板渲染**未执行**（无浏览器控制）；v0.3.0 pack dry-run 已执行（28 个文件，未生成 tarball）；**尚无 v0.4.0 打包声明**；无 release、未发布 |

仓库**不**声称 v0.4.0 已安装进真实 desktop profile、门禁已绿，也不声称面板经过可视化验证。历史 E2E 证据来自
一次性临时 profile，从未写入用户的真实 profile，且 E2E 使用本地 mock 模型。

---

## 仓库结构

```text
D:\05_Code\Confluence\
  index.js                   宿主入口：把 lib 模块装配到 Cordis 上下文
  client.js                  Web 面板：纯 Dynamic ModuleLoader 模块（id 'dsh-confluence'）
  lib/                       宿主模块（纯 ESM，仅 Node 内置模块）：
    util.js config.js workspace.js redact.js store.js board.js watermark.js pulse.js
    ledger.js presence.js recall.js tools.js hostui.js facade.js export.js
    context.js bus.js profile.js          （v0.3.0：状态池、同伴消息、用户画像）
    memory.js style.js                   （v0.4.0：长期 pattern、风格卡——实现中）
  package.json               bundle 清单：dsh-confluence，private，MIT，无依赖
  cordis.patch.yml           插入唯一的 `confluence` 行及完整默认配置
  locale/en.json, zh.json    显示元数据 + 面板文案（中英对齐）
  icon.svg                   原创图标：三条水流汇入一条通道
  examples/profile-patch.yml 用户覆盖示例（v0.4 更新由打包工作流负责）
  scripts/check.mjs          独立打包检查（零依赖）
    e2e-dsh.ps1              离线临时 profile E2E harness
    export-memories.mjs      显式启用的旧记忆导出工具（工具脚本）
    memory-export.mjs / memory-import.mjs   v0.4 记忆 CLI（由 v0.3 画像 CLI 改名）
  test/                      每模块单元测试、集成测试、e2e 脚手架、fixtures
  docs/                      设计、研究、决策、计划、状态、安装/发布指南
```

没有构建步骤：宿主半身是纯 ESM，面板是纯浏览器模块。

---

## 文档

完整文档地图与阅读顺序见[文档索引](docs/README.md)。

- **v0.4.0 约束性文档：** [ADR 0009](docs/adr/0009-long-term-memory-persona-style.md)（三层、候选优先写入、
  三个提示词块、可移植性、迁移）与 [v0.4 接口规范](docs/plan/v0.4-interfaces.md)（记录、服务、工具、
  提示词块、路由、配置、迁移、工作流）。
- **v0.3.0 基础：** [ADR 0008](docs/adr/0008-bus-and-profile.md)（两个作用域、队列式消息、半自动画像、
  面板传输、旧数据策略）——[ADR 0007](docs/adr/0007-universal-memory-scope.md) 的作用域规则继续被取代，
  其余保证有效。
- **历史：** [ADR 0007](docs/adr/0007-universal-memory-scope.md) ·
  [ADR 0001](docs/adr/0001-confluence-architecture.md) ·
  [ADR 0002](docs/adr/0002-store-format-and-concurrency.md) ·
  [ADR 0003](docs/adr/0003-pulse-and-watermarks.md) ·
  [ADR 0004](docs/adr/0004-privacy-and-consent.md) ·
  [ADR 0005](docs/adr/0005-ui-transport.md) ·
  [ADR 0006](docs/adr/0006-solo-bench-integration.md)（提议中）·
  [第 1 轮](docs/discussion/round-1.md) · [第 2 轮](docs/discussion/round-2.md) ·
  [立场 A](docs/discussion/position-a.md) · [立场 B](docs/discussion/position-b.md)
- **状态与计划：** [实现状态（实时）](docs/plan/implementation-status.md)（v0.4.0 轮次记录；最终验证数字由
  Lead 填写）、历史 [v0.3 接口规范](docs/plan/v0.3-interfaces.md)、
  [作用域增量](docs/plan/scope-refactor-delta.md) 与
  [实现接口](docs/plan/implementation-interfaces.md)、
  [执行计划](docs/plan/execution-plan.md)、[M0 探针](docs/plan/m0-spikes.md)。
- **设计文档（含 v0.4 修订）：** [架构](docs/design/architecture.md) ·
  [数据模型](docs/design/data-model.md) · [存储格式](docs/design/store-format.md) ·
  [工具 API](docs/design/tool-api.md) · [脉动](docs/design/pulse.md) ·
  [账本与回溯](docs/design/ledger-recall.md) · [面板](docs/design/ui.md) ·
  [配置](docs/design/config.md) · [安全与隐私](docs/design/security-privacy.md) ·
  [测试](docs/design/testing.md) · [solo-bench 集成](docs/design/solo-bench-integration.md)。
- **运维：** [升级到 v0.4.0](docs/upgrade-v0.4.md)（记录/迁移/配置变化、重启、验证、回滚）·
  [升级到 v0.3.0（历史）](docs/upgrade-v0.3.md) ·
  [升级到 v0.2.0（历史）](docs/upgrade-v0.2.md) ·
  [安装与验证指南](docs/install.md)（v0.4 清单更新由打包工作流负责）·
  [发布与版本流程](docs/publishing.md)（「未发布任何东西」的诚实说明仍然成立）。
- 测试：`test/*.test.js`（模块 + 打包）与 `test/integration.test.js`。

---

## 离线与隐私保证

- Host 半身没有 `fetch`、出站 socket、网络模块、子进程或模型调用；不额外监听端口、不启动服务器（面板只做
  相对同源 GET）；不使用外部数据库——只有 `$DSH_HOME/storages/confluence/v1/` 下的本地文件；无遥测、
  无崩溃上报、无更新检查；不抓取提示词。

v0.4.0 的隐私模型——三级可见性，外加不可信数据与脱敏规则：

- **工作区键决定谁能看到总线数据。** 冻结的 `header.cwd` 键相同的会话共享状态池、便签和消息；其他工作区
  永远看不到。这是可见性边界，不是按目录的同意开关：`privacy.disabledWorkspaces` 保持移除并忽略。
- **全局持久层按设计是 profile 范围。** pattern、画像事实与风格规则（以及仅元数据账本与 presence 心跳）
  是 profile 全局的，注入每个会话——这就是产品本身。`workspace` 作用域的 pattern 存在全局日志中，但只注入
  匹配工作区的会话。除显式导入导出文件外，不跨 profile、跨操作系统用户或跨机器。
- **`privacy.privateSessions` 仍是会话退出开关：** 私密会话对 Confluence 的所有表面不可见——无总线、
  无画像/记忆/风格工具、无提示词块、无账本、无 presence、无回溯。
- **候选在确认前是不可信数据。** Agent 提出的 pattern 是不可信内容、不是规则；只有 `active` 的 pattern 会作为
  指引注入，提升由用户确认。
- **元数据优先的账本。** 标题、会话 id、时间戳、轮次数、状态与最多 8 个相对路径；不含提示词、助手文本、
  工具输出或命令行。早前会话日志只在显式 `confluence_recall` 时读取，且只返回有界摘录。
- **所有写入都尽力脱敏**，可配置拒绝路径/规则。便签、状态值、消息、pattern 与风格规则是不可信数据
  （固定警告、转义框架、绝不作为指令）；记忆导出显式、已脱敏、无绝对路径且有界，导入经过校验且有界。

这些保证由静态契约检查与隐私单元测试执行；它们不代表已对真实宿主做过审计，也无法防御同一 profile 内其他工具
的行为。

---

## 从 v0.3.x 升级

v0.4.0 是破坏性小版本。完整指南：**[docs/upgrade-v0.4.md](docs/upgrade-v0.4.md)**。

- **产品面：** v0.3 的用户画像收窄为**个性子集**（六个个性分节）；新增长期记忆（`pattern`，候选确认制）与
  双域风格卡（`style`）；工具从六个变八个；面板从两个标签页/六路由变三个标签页/七路由。
- **数据：** 自动一次性迁移——旧 `tech`/`context` 事实变成 `pattern` 记录（source `migration`）；
  `preferences`/`rules` 折叠为 `communication`/`boundaries`。不改写、不删除任何记录；其余 pattern/style
  从空开始；回滚前建议先备份 store。
- **导出：** 新的规范文档 `confluence.memory/v1`；旧 `confluence.profile/v1` 文档仍可导入（仅画像）；
  CLI 改名为 `memory-export`/`memory-import`。
- **配置：** 新增 `memory.*` 与 `style.*`，没有弃用项；`bus.*`/`profile.*` 键名与含义不变。整行覆盖配置需要
  重新复制。
- **需要重启：** 已安装 bundle 是本地链接，必须重启 DSH（或切换该 bundle 行）才能加载新的 Host 模块代际。
  仅改配置只会重载插件行，不会重载模块代码。

---

## 安装状态

> **v0.4.0 尚未安装或重装。** v0.1.0 曾安装进真实 desktop profile（`install_bundle` → applied）；
> v0.2.x、v0.3.0 与 v0.4.0 的重装/重启都**未执行**。v0.3.0 的离线临时 profile E2E（2026-11-19）只作为
> 该版本的历史证据。

流程见 [docs/install.md](docs/install.md)（其 v0.4 清单更新由打包工作流负责）：通过 Plugin Manager
`install_bundle`（或 `dsh plugin --profile <scratch> add <path>`）安装，确认组合后的行含 `memory`/`style`
且 `bus`/`profile` 未被替换，重启 DSH，然后验证八个工具、三个全局块（+ 工作区脉动）、候选确认流程、
同工作区共享 vs 跨工作区隔离、队列式投递不打断、面板三个标签页，以及没有网络/端口/子进程。
回滚：移除该 bundle 并重启 DSH；数据感知路径见 [docs/upgrade-v0.4.md](docs/upgrade-v0.4.md) §5。

---

## 开发

要求：**Node.js ≥ 22.19.0**；后续真实激活需要 DSH Desktop **0.2.2-rc.1**。无依赖、无构建步骤。

```powershell
# 在仓库根目录
node --test --test-force-exit "test/*.test.js"   # 全部离线测试（单元 + 集成 + 打包）
node scripts/check.mjs                            # 独立打包检查（零依赖）
npm pack --dry-run --json                         # 检查随包文件清单（离线）
```

`npm pack --dry-run` 在 v0.1.0 代码树上报告 24 个随包文件、v0.3.0 树 28 个；v0.4.0 树新增
`lib/memory.js`、`lib/style.js` 并改名 CLI 脚本，清单、大小与校验和需在发布检查点重新记录——目前不做 v0.4.0
的打包声明。

| 脚本 | 用途 |
|---|---|
| `node scripts/check.mjs` | 零依赖打包/契约检查。 |
| `node scripts/m0-smoke.mjs` | M0 证据套件：ULID、脱敏语料、脉动上限、日志追加/断尾/双写者、原生 lease、离线扫描。 |
| `pwsh -File scripts/e2e-dsh.ps1` | 离线临时 profile E2E：全新 `DSH_HOME` + headless profile + 本地 Messages-API mock。**v0.3.0 运行**：17/17 项检查 + 15/15 条断言（`20261119-032058`）；**v0.4.0 重跑未执行**。 |
| `node scripts/export-memories.mjs --dsh-home <dir> [--json] [--dry-run]` | 显式启用的旧记忆导出工具（与 v0.4 记忆导出无关）。 |
| `node scripts/memory-export.mjs --dsh-home <dir> [--format json\|md] [--out <file>] [--dry-run]` | v0.4 记忆导出 CLI（规范 `confluence.memory/v1` JSON 或 Markdown）。 |
| `node scripts/memory-import.mjs --dsh-home <dir> --from <file> [--mode merge\|replace] [--dry-run]` | v0.4 记忆导入 CLI（校验、仅追加、支持 dry-run）。 |

---

## 验证状态

**v0.4.0——本轮：实现中，验证尚未执行。**

| 检查项 | 状态 |
|---|---|
| ADR 0009 + v0.4 接口规范 | **已有**——冻结的约束性文档（非运行时检查） |
| 宿主插件 v0.4.0（20 个 `lib/*.js`、八个工具、三个全局块、七条路由） | **实现中**——设计已冻结，实现由各工作流进行 |
| 离线套件（`node --test --test-force-exit "test/*.test.js"`） | **v0.4.0 未执行**——最终数字由 Lead 填写 |
| 打包检查（`node scripts/check.mjs`） | **v0.4.0 未执行**——最终数字由 Lead 填写 |
| 打包契约测试（`test/contract.test.js`） | **v0.4.0 未执行**——最终数字由 Lead 填写 |
| 离线临时 profile E2E（`pwsh -NoProfile -File scripts/e2e-dsh.ps1`） | **v0.4.0 未执行** |
| 面板渲染（三个标签页）/ 真实 profile 安装 + 重启 | **未执行**——渲染从未可视化验证；v0.4.0 安装/重启未执行 |
| npm pack / 发布 | **v0.4.0 未执行**；任何版本都无 release、未发布 |

Lead 会在 [docs/plan/implementation-status.md](docs/plan/implementation-status.md) 中更新这些行——且只在有已执行的
命令与输出时才更新。

**v0.3.0（历史，已在本代码树执行，2026-11-19）：** 离线套件 **353/353 通过**；打包检查 **18/18 项通过**；
打包契约测试 **24/24 通过**；离线临时 profile E2E **17/17 项 harness 检查 + 15/15 条断言检查，退出码 0**
（运行 `.tmp/e2e/run-20261119-032058`）；`npm pack --dry-run` 已执行（28 个文件、packed 199,159 B——未生成
tarball）；面板渲染未执行；真实 profile 安装/重启未执行。

**v0.2.0 / v0.2.1（历史，2026-11-16 执行，2026-11-17 中文名补丁未改变）：** 离线套件 **291/291 通过**；
打包契约 **17/17 项检查通过**；M0 冒烟 **14 通过 / 0 失败 / 1 阻塞**（可选的 atomic-write 探针；实际采用原生
lease）；离线临时 profile 跨目录 E2E **15/15 项 PowerShell 检查、退出码 0；12/12 条断言检查**（运行
`.tmp/e2e/run-20261116-203730`；证据见
[docs/discussion/v0.2-e2e-evidence.md](docs/discussion/v0.2-e2e-evidence.md)）。v0.2.x 的真实 profile
重装/重启：**未执行**。

**v0.1.0（历史，2026-11-13 执行）**：离线套件 **256/256 通过**、打包检查 **12/12 项**、临时 profile E2E
**8/8 项**、真实 desktop profile `install_bundle` 已应用、导出生产端 + `solo-bench` Go 消费端通过。

**任何版本都未执行：** 面板渲染/可视化验证、PTC 预设（`run_code`）工具可达性、多窗口实时新鲜度实测、
浸泡/压缩与长期保留、tarball/SHA-256 与发布/release。

---

## 许可证

[MIT](LICENSE) © 2026 XiaoleC05 与 Confluence / 高级记忆 贡献者。

## 链接

- GitHub: [https://github.com/XiaoleC05/Confluence](https://github.com/XiaoleC05/Confluence)
- Crisp——本打包遵循的本地插件先例：`D:\05_Code\Crisp\integrations\dsh-plugin-crisp`
