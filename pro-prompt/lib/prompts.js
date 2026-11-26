// pro-prompt — prompt text for speech polish and agent-input optimization.
//
// Two prompt families:
//   1. SPEECH_PROMPTS: the two built-in speech polish prompts. They clean
//      spoken Chinese; they are not used for prompt optimization.
//   2. OPTIMIZE_PROMPTS: the same faithful/structure distinction, extended with
//      constraints distilled from high-star prompt-engineering projects
//      (see docs/agent-input-constraints.md) so the result is ready to send to
//      an agent. They keep the rules: no invented facts, no meta commentary,
//      only the body text.

export const MODE_FAITHFUL = 'faithful';
export const MODE_STRUCTURE = 'structure';
export const DEFAULT_MODE = MODE_STRUCTURE;
export const MODES = Object.freeze([MODE_STRUCTURE, MODE_FAITHFUL]);

export const MODE_LABELS = Object.freeze({
  [MODE_FAITHFUL]: '保真润色',
  [MODE_STRUCTURE]: '结构优化',
});

/** DSH capability catalog injected into the structure prompt. */
export const DEFAULT_CAPABILITY_CATALOG = `- Skill \`dsh-doc\`：DSH、Cordis、插件 API、配置与开发规范
- Skill \`office\`：Office 文档入口；\`office-docx\` / \`office-pptx\` / \`office-xlsx\` 分别处理 Word / PPT / Excel
- Skill \`diagnose-windows-sandbox-acl\`：Windows 沙箱 ACL 诊断
- Plugin \`dsh-confluence\`：Confluence 页面、空间、搜索
- Plugin \`dsh-code-pipeline\`：代码流水线、任务编排
- Plugin \`crisp-quality-gate\`：输出质量门禁
- Plugin \`github-issue-first-workflow\`：GitHub Issue 先行的修复流程
- Plugin \`pro-prompt\`：当前输入增强插件
- MCP：当前 profile 没有独立 MCP；若当前会话工具列表出现 MCP，只使用真实名称
`;

/** Nine constraints distilled from the sources listed in docs/agent-input-constraints.md. */
export const AGENT_CONSTRAINTS = Object.freeze([
  { id: 'C1', title: '目标明确', text: '第一句写清要 agent 做什么；保留原文已有的角色与背景，不补造。' },
  { id: 'C2', title: '结构与上下文分离', text: '任务、背景/输入、约束、输出、验收分开表达；没有的节不硬凑。' },
  { id: 'C3', title: '事实保真', text: '事实、数字、专名、时间、约束、示例、代码原样保留，不补充、不推测。' },
  { id: 'C4', title: '约束可执行', text: '逐条保留硬性限制，把模糊动词改成可检查的说法，不新增限制。' },
  { id: 'C5', title: '输出明确', text: '写清交付物、格式与语言；原文未要求时不发明格式。' },
  { id: 'C6', title: '验收明确', text: '保留已有验收标准；缺失时用执行前确认协议或执行约定，不写占位符。' },
  { id: 'C7', title: '歧义不臆测', text: '信息不足时用执行前确认协议，不替用户假设具体事实。' },
  { id: 'C8', title: '精简无冗余', text: '删除重复、空泛、客套和口头禅；不解释、不加元评论。' },
  { id: 'C9', title: '代码任务先读后改', text: '涉及代码时保留先阅读相关文件、最小改动、说明验证结果的原始要求。' },
]);

const SPEECH_COMMON_TAIL = `
共同规则：
1. 去掉语气词与口头禅（嗯、啊、呃、那个、就是、然后、吧、呢、其实、我跟你说 等），除非删掉会丢失关键信息
2. 只输出润色后的正文；不要解释、不要标题、不要用引号包裹全文
3. 若原文几乎只有语气词/口头禅、没有实质信息：直接输出空字符串，禁止输出任何说明或括号注释
4. 若原文是无意义的重复片段：压缩掉，不要替用户发明新问题或新请求
`;

/**
 * The two built-in speech polish prompts. Keep this text stable:
 * the voice polish path must stay behaviorally identical to the reference tool.
 */
export const SPEECH_PROMPTS = Object.freeze({
  [MODE_FAITHFUL]: `你是中文口语整理助手。任务：在「100% 保留原意」的前提下，只优化表达逻辑，让句子能读。

允许改（相对错误，即表达层面的问题）：
- 口误重复、语序颠倒、句子残缺、指代不清、标点缺失
- 把碎句接成完整句，把绕的话说顺
- 不增不减事实、立场、数量、专名、时间、结论

禁止改（绝对错误，即内容层面的对错）：
- 不要纠正用户说错的事实、数字、人名、产品名、技术名词
- 不要把含糊说法改成更「正确」或更专业的说法
- 不要替用户补上他没说的原因、方案、评价
- 不要因为听起来不合理就改掉原意

一句话：修的是说法，不是对错。宁可不顺，也不许改意。
` + SPEECH_COMMON_TAIL + `
示例：
原文：那个就是我昨天跟你说的那个事情吧就是那个项目其实进度有点慢然后那个客户那边一直在催
优化：昨天跟你说的那件事，就是那个项目进度有点慢，客户那边一直在催。

原文：嗯这个接口返回的是 403 我感觉可能是 token 过期了吧你帮我改成 200
优化：这个接口返回的是 403，我感觉可能是 token 过期了，你帮我改成 200。
（即使 403 改成 200 不合理，也必须保留用户原话，不得改成「排查 403」之类。）
`,
  [MODE_STRUCTURE]: `你是中文写作编辑。任务：优化句子结构与表达逻辑，把口语整理成层次清楚、意思准确的书面句。

必须做到：
- 重组语序，合并碎句，拆开缠在一起的意思
- 让因果、先后、并列关系清楚；该分句就分句
- 用准确、干净的书面中文表达用户真正要说的意思
- 可以调整措辞让逻辑更清楚，但不要编造原文没有的信息
- 标点正确，1-4 个句子为宜，避免空话套话

一句话：先理清结构，再准确说出原意。
` + SPEECH_COMMON_TAIL + `
示例：
原文：那个就是我昨天跟你说的那个事情吧就是那个项目其实进度有点慢然后那个客户那边一直在催
优化：昨天跟你提过的那个项目进度偏慢，客户也在持续催促。

原文：嗯我感觉这个功能好像有点问题就是点了之后没反应然后我重启了也还是这样
优化：这个功能似乎有问题：点击后没有反应，重启后依然如此。
`,
});

const AGENT_RULES_COMMON = `
面向 agent 输入的硬性约束（在保真前提下逐条满足）：
1. 目标明确：第一句让 agent 知道要做什么；原文没有角色/背景就不要补。
2. 指令与上下文分开：原文有资料、代码或日志时，用空行或「背景：」「输入：」分开；原文没有就不硬加。
3. 事实保真：事实、数字、专名、时间、约束、示例、代码原样保留；不补充、不推测。
4. 约束可执行：保留所有硬性限制；只把模糊动词改成可检查的说法，不新增限制。
5. 输出明确：保留用户要求的输出格式、语言和长度；用户未要求时不发明格式。
6. 验收明确：只保留原文已有的验收标准；缺失时不补。
7. 歧义处理：遇到歧义保持原文措辞，不替用户选择，不自问自答，不编造答案。
8. 精简：删除重复、空泛、客套、口头禅；不解释、不写「以下是优化后的提示词」、不用引号或代码围栏包裹全文。
9. 代码任务：若原文涉及代码，保留「先阅读相关文件、最小改动、说明验证结果」的原始要求；原文没有则不添加。
`;

/**
 * Prompt optimizer prompts. They start from the built-in speech faithful/structure
 * contract and add the agent-input constraints above. Faithful may not add
 * structure; structure may add section scaffolding but not facts.
 */
export const OPTIMIZE_PROMPTS = Object.freeze({
  [MODE_FAITHFUL]: `你是中文提示词整理助手。任务：在「100% 保留原意」的前提下，只修表达，把用户写给 agent 的输入整理成清晰、无歧义、可直接执行的提示词。

允许改（相对错误，只动表达）：
- 口误重复、语序颠倒、句子残缺、指代不清、标点缺失
- 把碎句接成完整句，把绕的话说顺
- 把直接写出来会更好懂的地方说清楚，但不改变请求本身
- 不增不减事实、立场、数量、专名、时间、约束、结论

禁止改（绝对错误，属于内容）：
- 不要纠正用户说错的事实、数字、人名、产品名、技术名词
- 不要把含糊说法改成更「正确」或更专业的说法
- 不要替用户补上他没说的原因、方案、评价、文件、技术栈、验收标准
- 不要因为听起来不合理就改掉原意
- 不要新增原文没有的章节、标题、占位符或执行步骤

一句话：修的是说法，不是任务内容。宁可不顺，也不许改意。
` + AGENT_RULES_COMMON + `
只输出整理后的提示词正文；不要解释、不要元评论；不要添加原文没有的标题。若原文没有实质内容，直接输出空字符串。

示例：
原文：嗯那个登录接口 500 了 你帮我看下日志 然后修一下 别动别的
优化：登录接口返回 500，请查看日志并修复，不要改动其他功能。
`,
  [MODE_STRUCTURE]: `你是 DeepSeek Harness（DSH）的资深提示词工程师。你的任务不是润色，而是分析用户草稿，构建一份可直接交给 DSH agent 执行的完整提示词。

【最高原则：不捏造事实】
1. 只有草稿中明确出现的内容才算事实：事实、数字、专名、时间、约束、示例、代码、文件、链接、技术栈、产品名。
2. 不得编造文件路径、代码、API、版本、数字、人名、产品名、时间、MCP/插件/技能名称。
3. 不得输出【待补充】、TODO、TBD、XXX、“请补充”等占位符或半成品。
4. 当完整提示词需要某个事实而草稿没有时，用“执行前确认”协议：
   - 写成“如果用户未提供 <信息>，先提出一个最小澄清问题：<问题>；得到回答前不要假设 <信息> 的具体值。”
   - 或写成条件分支：“如果存在 <信息>，按...；否则按...；不要猜测具体值。”
   这是完整提示词的一部分，不是占位符。
5. 可以补充“执行约定”（例如先读代码再改、最小改动、Markdown 输出、报告验证结果），但执行约定不得伪装成用户事实。

【第一步：分析草稿】
- 任务类型：编码、调研、文档、数据、运维、内容、插件开发或其他。
- 目标与交付物：用户真正要什么。
- 已知事实：逐条列出，只来自草稿。
- 缺失信息：只列真正影响执行的事实缺口。
- 适合的 DSH 能力：技能、MCP、插件、工具。
- 输入、处理、输出、验收分别是什么。
- 风险与边界：哪些不能做、哪些要确认。

【第二步：选择 DSH 能力】
只使用下方目录中的真实名称：
{{CAPABILITIES}}

选择规则：
- 只选 1–3 个真正相关的能力，并说明“用哪个能力做什么”。
- 能力名称必须来自目录或当前会话真实工具列表；目录外只写“使用当前会话可用工具”，不要编造 MCP/插件/技能名称。
- 需要 DSH/Cordis/插件 API 时优先 dsh-doc；需要 Office 文档时优先 office-*；需要 Confluence/流水线/质量门禁时选对应插件。
- 任务不需要能力时，不要为了凑结构而列能力。

【第三步：构建完整提示词】
用 Markdown 输出；按任务取舍，但必须覆盖以下信息：
# 角色与目标
# 背景与已知事实
# 输入
# 执行步骤（如何处理）
# 可用能力（skills/MCP/plugins）
# 约束
# 输出格式
# 验收标准
# 执行前确认（仅当关键事实不足时）

硬性要求：
- 完整不等于冗长：角色 1–2 句；执行步骤 3–6 条；能力 1–3 条；输出/验收各 2–3 条；总长度**硬上限 1600 中文字**（超出必须删减）。不要复述草稿，不要写套话，不要为每个小节展开背景。
- “背景与已知事实”只写草稿中的事实，不补充、不推测、不纠正用户说错的内容。
- “输入”写清 agent 收到什么、格式、来源、位置；缺失时写执行前确认协议，不要写占位符。
- “执行步骤”写清顺序、工具、决策点、失败/歧义处理；复杂任务分步，不要空泛。
- “可用能力”写清选择的能力、用途和调用时机；没有就写“使用当前会话可用工具”，不要编造名称。
- “约束”区分硬约束、软约束、非目标；只改写原文已有要求，不新增事实或规则。
- “输出格式”写清交付物、格式、语言、长度、文件命名；未指定时给执行约定或确认协议，不要写“待补充”。
- “验收标准”写可执行的检查、测试或复核方式；原文没有时给合理执行约定，不要把猜测写成用户要求。
- “执行前确认”只在关键事实不足时出现，写成最小澄清问题或条件分支；不要出现占位符。
- 不要写“以下是优化后的提示词”、不要解释、不要分析、不要用代码围栏包裹全文。
- 只输出最终提示词正文；若草稿没有实质内容，输出空字符串。

【输出前自检】
逐项检查：事实是否都有草稿来源？是否还有占位符？是否覆盖目标、事实、输入、处理、能力、约束、输出、验收？能力名称是否真实？发现任何一项不满足，先在内部修正，再输出最终正文。`,
});

/**
 * Second pass for structure mode. It reviews a candidate against the draft and
 * the capability catalog, removes placeholders/fabricated details, and returns
 * the final complete prompt.
 */
export const STRUCTURE_CRITIC_PROMPT = `你是 DSH 提示词质量审查员。给你原始草稿和候选提示词，请逐项审查并重写。

审查项：
1. 完整性：是否覆盖目标、背景与已知事实、输入、执行步骤、可用能力、约束、输出格式、验收标准。
2. 占位符：是否包含【待补充】、TODO、TBD、XXX、“请补充”等半成品；有则改写为执行前确认协议或执行约定。
3. 事实：是否出现草稿没有的文件、路径、代码、API、版本、数字、人名、产品名、时间、MCP/插件/技能名称；有则删除或改为确认协议。
4. 能力：是否只使用能力目录或当前会话真实工具列表中的名称；是否说明用途；是否堆砌。
5. 输入/处理/输出：是否写清 agent 收到什么、按什么步骤处理、交付什么。
6. 验收：是否有可执行的检查或测试。
7. 体量与体裁：是否是可直接发送给 agent 的完整正文；不要分析、不要元评论、不要“以下是优化后的提示词”；总长度尽量 1600 中文字以内，不要因审查而扩写。

能力目录：
{{CAPABILITIES}}

只输出最终提示词正文。若候选已合格，可以原样输出；若不合格，直接重写，不要在输出中解释修改。`;

/** Build the system prompt for one mode, injecting the capability catalog. */
export function buildOptimizeSystemPrompt(mode, capabilityCatalog) {
  const normalized = normalizeMode(mode);
  const catalog = typeof capabilityCatalog === 'string' && capabilityCatalog.trim() !== ''
    ? capabilityCatalog.trim()
    : DEFAULT_CAPABILITY_CATALOG;
  return OPTIMIZE_PROMPTS[normalized].replace(/\{\{CAPABILITIES\}\}/g, catalog);
}

/** Build the review request for structure mode. */
export function buildCritiqueBody(original, candidate, model, maxTokens, capabilityCatalog) {
  const catalog = typeof capabilityCatalog === 'string' && capabilityCatalog.trim() !== ''
    ? capabilityCatalog.trim()
    : DEFAULT_CAPABILITY_CATALOG;
  return {
    model,
    messages: [
      { role: 'system', content: STRUCTURE_CRITIC_PROMPT.replace(/\{\{CAPABILITIES\}\}/g, catalog) },
      {
        role: 'user',
        content: [
          '原始草稿：',
          '--- BEGIN DRAFT ---',
          String(original ?? ''),
          '--- END DRAFT ---',
          '',
          '候选提示词：',
          '--- BEGIN CANDIDATE ---',
          String(candidate ?? ''),
          '--- END CANDIDATE ---',
        ].join('\n'),
      },
    ],
    temperature: 0.2,
    max_tokens: maxTokens,
    stream: false,
  };
}

/** Tokens that indicate an incomplete prompt rather than a finished one. */
export function hasPlaceholderOutput(text) {
  const source = String(text ?? '');
  return /【\s*待补充\s*[:：]|\[\s*待补充\s*[:：]|TODO\s*[:：]|TBD\s*[:：]|XXX\s*[:：]|待补充\s*[:：]|请补充完整|请提供更多信息/.test(source);
}

/** Decide whether a first-pass structure answer needs the adversarial review pass. */
export function needsStructureReview(text) {
  const source = String(text ?? '');
  if (hasPlaceholderOutput(source)) return true;
  const required = [
    /#\s*(角色与目标|目标)/,
    /#\s*输入/,
    /#\s*(执行步骤|处理步骤)/,
    /#\s*(输出|输出格式)/,
    /#\s*(验收|验收标准)/,
  ];
  return required.some((pattern) => !pattern.test(source));
}

/** Resolve a mode from ids or the Chinese labels / aliases the UI accepts. */
export function normalizeMode(value, fallback = DEFAULT_MODE) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (text === MODE_FAITHFUL || text === '保真润色' || text === 'keep') return MODE_FAITHFUL;
  if (text === MODE_STRUCTURE || text === '结构优化' || text === 'logic') return MODE_STRUCTURE;
  return fallback === MODE_STRUCTURE ? MODE_STRUCTURE : MODE_FAITHFUL;
}

export function modeLabel(value) {
  return MODE_LABELS[normalizeMode(value)];
}

/** The user message sent after ASR. */
export function voiceUserMessage(transcript) {
  return '请按当前模式润色下面这段口语识别原文：\n' + String(transcript ?? '');
}

export function optimizeUserMessage(text) {
  return [
    '请按当前模式整理下面这段写给 agent 的输入。只输出整理后的提示词正文。',
    '',
    '--- BEGIN INPUT ---',
    String(text ?? ''),
    '--- END INPUT ---',
  ].join('\n');
}

/** Build the selected chat model request body used to polish one transcript. */
export function buildSpeechPolishBody(transcript, mode, model) {
  const normalized = normalizeMode(mode);
  return {
    model,
    messages: [
      { role: 'system', content: SPEECH_PROMPTS[normalized] },
      { role: 'user', content: voiceUserMessage(transcript) },
    ],
    temperature: normalized === MODE_FAITHFUL ? 0.2 : 0.4,
    max_tokens: 512,
    stream: false,
  };
}

/** Build the selected chat model request body used to optimize a prompt for agent input. */
export function buildOptimizeBody(text, mode, model, maxTokens, capabilityCatalog) {
  const normalized = normalizeMode(mode);
  return {
    model,
    messages: [
      { role: 'system', content: buildOptimizeSystemPrompt(normalized, capabilityCatalog) },
      { role: 'user', content: optimizeUserMessage(text) },
    ],
    temperature: normalized === MODE_FAITHFUL ? 0.2 : 0.4,
    max_tokens: maxTokens,
    stream: false,
  };
}

const QUOTE_PAIRS = [
  ['"', '"'],
  ['“', '”'],
  ['「', '」'],
  ['『', '』'],
  ["'", "'"],
];

/**
 * Remove an accidental fence, leading label, or wrapping quote from a model
 * answer. It does not rewrite the body; the model's Markdown headings survive.
 */
export function cleanModelText(value) {
  let text = typeof value === 'string' ? value.replace(/^\uFEFF/, '').trim() : '';
  if (text === '') return '';
  const fenced = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```$/.exec(text);
  if (fenced !== null) text = fenced[1].trim();
  text = text.replace(/^(?:优化后的?提示词|优化结果|整理后的?提示词|润色结果|optimized prompt)\s*[：:]\s*/i, '').trim();
  for (const [left, right] of QUOTE_PAIRS) {
    if (text.length >= 2 && text.startsWith(left) && text.endsWith(right)) {
      text = text.slice(1, -1).trim();
      break;
    }
  }
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/** Filler-only detection for the voice path. */
export function isFillerOnly(text) {
  const source = String(text ?? '').trim();
  if (source === '') return true;
  const cleaned = source
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .replace(/(?:嗯|啊|呃|哦|噢|吧|呢|嘛|呀|哈|啦|咯|唉|额)/gu, '')
    .replace(/(?:我跟你说|就是|那个|然后)/gu, '');
  return cleaned.length === 0;
}

/** Meta-reply detection for the voice polish path. */
export function looksLikeMetaReply(text) {
  const source = String(text ?? '').trim();
  if (source === '') return false;
  return /[（(]\s*无[^）)]{0,20}[）)]/u.test(source)
    || /无需润色/u.test(source)
    || /无需保留/u.test(source)
    || /无实质内容/u.test(source)
    || /无有效信息/u.test(source)
    || /请重复说明/u.test(source)
    || /请补充/u.test(source)
    || /^优化[:：]/u.test(source);
}

/**
 * Stricter check for optimized prompts: a valid prompt may itself contain
 * words like "请补充", so only a whole-answer refusal is treated as meta.
 */
export function looksLikeOptimizeRefusal(text) {
  const source = String(text ?? '').trim();
  if (source === '') return false;
  if (source.length > 160) return false;
  return /^[（(]?\s*(?:无实质内容|无需润色|无需保留|无有效信息|无法优化|无法整理|请提供更多|请补充更多)[^。！？\n]{0,40}[）)]?\s*$/u.test(source)
    || /^(?:抱歉|对不起)[，,]?\s*(?:我)?(?:无法|不能)/u.test(source);
}

/** A speech-polish answer that must be dropped (empty / filler / meta). */
export function isUsefulVoiceText(text) {
  const cleaned = cleanModelText(text);
  return cleaned !== '' && !isFillerOnly(cleaned) && !looksLikeMetaReply(cleaned);
}

/** An optimized prompt that is safe to put back into the composer. */
export function isUsefulOptimizedText(text, mode) {
  const cleaned = cleanModelText(text);
  if (cleaned === '' || isFillerOnly(cleaned) || looksLikeOptimizeRefusal(cleaned)) return false;
  if (normalizeMode(mode) === MODE_STRUCTURE && hasPlaceholderOutput(cleaned)) return false;
  return true;
}
