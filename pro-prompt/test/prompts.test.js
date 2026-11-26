import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AGENT_CONSTRAINTS,
  DEFAULT_CAPABILITY_CATALOG,
  DEFAULT_MODE,
  MODE_LABELS,
  OPTIMIZE_PROMPTS,
  SPEECH_PROMPTS,
  buildCritiqueBody,
  buildOptimizeBody,
  buildOptimizeSystemPrompt,
  buildSpeechPolishBody,
  cleanModelText,
  hasPlaceholderOutput,
  isFillerOnly,
  isUsefulOptimizedText,
  isUsefulVoiceText,
  looksLikeMetaReply,
  looksLikeOptimizeRefusal,
  needsStructureReview,
  normalizeMode,
  voiceUserMessage,
} from '../lib/prompts.js';

test('the two built-in speech prompts and labels are preserved', () => {
  assert.equal(DEFAULT_MODE, 'structure');
  assert.deepEqual(MODE_LABELS, { faithful: '保真润色', structure: '结构优化' });
  assert.match(SPEECH_PROMPTS.faithful, /100% 保留原意/);
  assert.match(SPEECH_PROMPTS.faithful, /修的是说法，不是对错/);
  assert.match(SPEECH_PROMPTS.faithful, /不要纠正用户说错的事实、数字、人名、产品名、技术名词/);
  assert.match(SPEECH_PROMPTS.structure, /先理清结构，再准确说出原意/);
  assert.match(SPEECH_PROMPTS.structure, /1-4 个句子为宜/);
  assert.match(SPEECH_PROMPTS.faithful, /403/);
  assert.match(SPEECH_PROMPTS.structure, /重启后依然如此/);
});

test('faithful keeps the nine constraints; structure keeps the complete-prompt contract', () => {
  assert.match(OPTIMIZE_PROMPTS.faithful, /面向 agent 输入的硬性约束/);
  assert.match(OPTIMIZE_PROMPTS.faithful, /只输出整理后的提示词正文/);
  assert.match(OPTIMIZE_PROMPTS.faithful, /不编造|不推测|不要新增/);

  assert.match(OPTIMIZE_PROMPTS.structure, /资深提示词工程师/);
  assert.match(OPTIMIZE_PROMPTS.structure, /完整提示词/);
  assert.match(OPTIMIZE_PROMPTS.structure, /\{\{CAPABILITIES\}\}/);
  assert.match(OPTIMIZE_PROMPTS.structure, /执行前确认/);
  assert.match(OPTIMIZE_PROMPTS.structure, /不捏造事实/);
  assert.match(OPTIMIZE_PROMPTS.structure, /# 输入/);
  assert.match(OPTIMIZE_PROMPTS.structure, /# 执行步骤（如何处理）/);
  assert.match(OPTIMIZE_PROMPTS.structure, /# 输出格式/);
  assert.match(OPTIMIZE_PROMPTS.structure, /# 验收标准/);
  assert.doesNotMatch(OPTIMIZE_PROMPTS.structure, /【待补充[:：]/);
  assert.equal(AGENT_CONSTRAINTS.length, 9);
  assert.equal(AGENT_CONSTRAINTS[0].title, '目标明确');
  assert.equal(AGENT_CONSTRAINTS[8].title, '代码任务先读后改');
});

test('mode normalization accepts ids, Chinese labels, and UI aliases', () => {
  assert.equal(normalizeMode('structure'), 'structure');
  assert.equal(normalizeMode('结构优化'), 'structure');
  assert.equal(normalizeMode('logic'), 'structure');
  assert.equal(normalizeMode('保真润色'), 'faithful');
  assert.equal(normalizeMode('keep'), 'faithful');
  assert.equal(normalizeMode('nonsense'), 'structure');
  assert.equal(normalizeMode('nonsense', 'faithful'), 'faithful');
});

test('placeholder detection rejects half-finished prompts', () => {
  assert.equal(hasPlaceholderOutput('## 任务\n修复登录页'), false);
  assert.equal(hasPlaceholderOutput('## 任务\n【待补充：验收标准】'), true);
  assert.equal(hasPlaceholderOutput('## 任务\nTODO: 补充输出格式'), true);
  assert.equal(isUsefulOptimizedText('## 任务\n修复登录页', 'structure'), true);
  assert.equal(isUsefulOptimizedText('## 任务\n【待补充：验收标准】', 'structure'), false);
  assert.equal(needsStructureReview('## 任务\n修复登录'), true);
  assert.equal(needsStructureReview('# 角色与目标\nx\n# 输入\ny\n# 执行步骤\nz\n# 输出格式\nw\n# 验收标准\n1. ok'), false);
});

test('cleanModelText unwraps a whole-answer fence, label, and quotes', () => {
  assert.equal(cleanModelText('```markdown\n## 任务\n做这件事\n```'), '## 任务\n做这件事');
  assert.equal(cleanModelText('优化后的提示词：\n内容'), '内容');
  assert.equal(cleanModelText('“内容”'), '内容');
  assert.equal(cleanModelText('  keep  '), 'keep');
  assert.equal(cleanModelText('line\n\n\n\nline'), 'line\n\nline');
});

test('filler and meta detection separates the voice path from the optimizer path', () => {
  assert.equal(isFillerOnly('嗯嗯 那个 然后 就是'), true);
  assert.equal(isFillerOnly('修复登录页的 500 错误'), false);
  assert.equal(looksLikeMetaReply('（无实质内容）'), true);
  assert.equal(looksLikeMetaReply('请补充更多信息'), true);
  assert.equal(looksLikeMetaReply('请补充测试数据后运行这个脚本'), true);
  assert.equal(looksLikeOptimizeRefusal('请补充测试数据后运行这个脚本'), false);
  assert.equal(looksLikeOptimizeRefusal('无法优化'), true);
  assert.equal(isUsefulVoiceText('你好。'), true);
  assert.equal(isUsefulVoiceText('嗯嗯'), false);
  assert.equal(isUsefulOptimizedText('## 任务\n修复 500 错误'), true);
  assert.equal(isUsefulOptimizedText('无实质内容'), false);
});

test('request bodies use the extracted models, temperatures, and user messages', () => {
  const voice = buildSpeechPolishBody('原始口语', 'faithful', 'deepseek-ai/DeepSeek-V4.1-Flash');
  assert.equal(voice.model, 'deepseek-ai/DeepSeek-V4.1-Flash');
  assert.equal(voice.temperature, 0.2);
  assert.equal(voice.max_tokens, 512);
  assert.equal(voice.messages[0].content, SPEECH_PROMPTS.faithful);
  assert.equal(voice.messages[1].content, voiceUserMessage('原始口语'));

  const structure = buildOptimizeBody('帮我修一下', 'structure', 'deepseek-ai/DeepSeek-V4.1-Flash', 2048, DEFAULT_CAPABILITY_CATALOG);
  assert.equal(structure.model, 'deepseek-ai/DeepSeek-V4.1-Flash');
  assert.equal(structure.temperature, 0.4);
  assert.equal(structure.max_tokens, 2048);
  assert.match(structure.messages[0].content, /dsh-doc/);
  assert.match(structure.messages[0].content, /DeepSeek Harness/);
  assert.doesNotMatch(structure.messages[0].content, /\{\{CAPABILITIES\}\}/);
  assert.equal(structure.messages[0].content, buildOptimizeSystemPrompt('structure', DEFAULT_CAPABILITY_CATALOG));
  assert.match(structure.messages[1].content, /帮我修一下/);

  const critique = buildCritiqueBody('原始草稿', '候选提示词', 'deepseek-ai/DeepSeek-V4.1-Flash', 2048, DEFAULT_CAPABILITY_CATALOG);
  assert.match(critique.messages[0].content, /质量审查员/);
  assert.match(critique.messages[0].content, /dsh-doc/);
  assert.match(critique.messages[1].content, /原始草稿/);
  assert.match(critique.messages[1].content, /候选提示词/);
});
