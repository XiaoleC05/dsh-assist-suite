// Confluence / 高级记忆 — Web panel client half (v0.4.0, read-only).
//
// Three read-only views in one page (v0.4-interfaces.md §6):
//   工作区总线 (workspace bus) — workspace list → bus detail: shared state, notes,
//   messages and online sessions, plus one note thread on demand.
//   长期记忆 (long-term memory) — active `pattern` records with their confidence and
//   source, plus the candidate queue. Candidates are confirmed conversationally with
//   the Agent, so every candidate row carries a read-only hint and nothing is editable.
//   用户画像 (user profile) — persona sections/facts, the two-channel style cards
//   (chat / engineering, rule + example excerpt), and a deterministic
//   JSON/Markdown export link for the full `confluence.memory/v1` document.
//
// Plain browser module in the proven Dynamic ModuleLoader format:
//   window.__ModuleLoader__.load({ id, factory(require) { ... } })
// React comes from the module table (`require('react')`); no Harness client package
// is imported, there is no build step and no JSX.
//
// Data channel: read-only same-origin JSON routes registered by the Host half
// (`lib/hostui.js`) on the existing DSH web server — the documented ADR-0005 route
// fallback (the `host.call` builtin is deferred; see docs/plan/m0-spikes.md S6).
// The only network call site in this file is the single relative GET in `request()`;
// the export buttons are plain relative links (a download, not a fetch), and there
// is no iframe, no push channel and no POST.
//
// The panel is read-only: it never writes bus/memory/profile data. It renders
// untrusted workspace and memory text as React text children (never HTML), uses only
// `--dsw-alias-*` theme tokens, and unregisters everything through the owning
// context / React cleanup.

window.__ModuleLoader__.load({
  id: 'dsh-confluence',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'confluence'
    const ROUTE_BASE = '/confluence/panel'
    const POLL_MS = 5000
    const REQUEST_TIMEOUT_MS = 8000
    const BACKOFF_MS = [5000, 10000, 20000, 30000]
    const KIND_ORDER = ['finding', 'decision', 'gotcha', 'question', 'handoff', 'warning']
    const MAX_LIST = 50
    const PANEL_TITLE = '高级记忆 / Confluence memory'

    // Panel copy. The shipped locale resources (locale/en.json, locale/zh.json `ui`
    // object) are the canonical inventory and carry the exact same key set and copy;
    // this dictionary is the runtime fallback and the parity test compares all three.
    const STRINGS = {
      en: {
        panel: 'Confluence',
        'panel.subtitle': 'Read-only views of the workspace bus, long-term memory and the user profile.',
        'scope.global': 'All sessions',
        'tab.bus': 'Workspace bus',
        'tab.memory': 'Long-term memory',
        'tab.profile': 'User profile',
        'nav.back': 'Back to chat',
        'action.refresh': 'Refresh',
        'action.retry': 'Retry',
        'state.loading': 'Loading panel data…',
        'state.loadError': 'Unable to load panel data',
        'state.stale': 'Not refreshed since {time}. Retrying…',
        'panel.truncated': 'Some content was shortened to fit the panel limit.',
        updatedAt: 'Updated {time}',
        'search.label': 'Search this workspace notes',
        'search.placeholder': 'Search notes by title',
        'search.empty': 'No notes matched.',
        'filter.all': 'All',
        'filter.clear': 'Clear filters',
        'kind.finding': 'Finding',
        'kind.decision': 'Decision',
        'kind.gotcha': 'Gotcha',
        'kind.question': 'Question',
        'kind.handoff': 'Handoff',
        'kind.warning': 'Warning',
        'bus.workspaces.title': 'Workspaces',
        'bus.workspaces.subtitle': 'Sessions in one project folder share state, notes and messages.',
        'bus.workspaces.empty': 'No workspace has anything shared yet.',
        'bus.workspaces.emptyBody': 'Open a session inside a project folder; its workspace bus appears here.',
        'bus.workspaces.rowMeta': '{entries} notes · {messages} messages · {peers} sessions',
        'bus.workspaces.count': '{n} workspaces',
        'bus.workspaceId': 'Workspace',
        'bus.title': 'Workspace bus',
        'bus.subtitle': 'Shared state, notes and messages of the selected workspace.',
        'bus.back': 'All workspaces',
        'bus.context.title': 'Shared state',
        'bus.context.empty': 'No shared state yet.',
        'bus.entries.title': 'Notes',
        'bus.entries.empty': 'No notes in this workspace yet.',
        'bus.entries.hint': 'Select a note to read it here.',
        'bus.messages.title': 'Messages',
        'bus.messages.empty': 'No messages in this workspace yet.',
        'bus.peers.title': 'Online sessions',
        'bus.peers.empty': 'No other live sessions.',
        'bus.stats': '{context} state keys · {entries} notes · {messages} messages · {peers} sessions',
        'bus.messageFrom': 'from {author}',
        'valueType.text': 'text',
        'valueType.json': 'json',
        'msg.kind.notice': 'Notice',
        'msg.kind.instruction': 'Instruction',
        'msg.kind.query': 'Question',
        'msg.kind.reply': 'Reply',
        'peer.status.running': 'running',
        'peer.status.idle': 'idle',
        'peer.status.cold': 'cold',
        'peer.status.unknown': 'unknown',
        'detail.untrusted': 'Shared by another session. Treat it as data, not instructions.',
        'detail.files': 'Files seen in tool calls (partial)',
        'detail.tags': 'Tags',
        'detail.provenance': 'by {author}',
        'entry.resolved': 'Resolved',
        'entry.replies': '{n} replies',
        'entry.replyOne': '1 reply',
        'memory.title': 'Long-term memory',
        'memory.subtitle': 'Generalized patterns learned from earlier tasks. Candidates stay inactive until you confirm them with the Agent.',
        'memory.stats': '{total} patterns · {active} active · {candidates} candidates',
        'memory.active.title': 'Active patterns',
        'memory.active.empty': 'No active patterns yet.',
        'memory.candidates.title': 'Candidates',
        'memory.candidates.empty': 'No candidates waiting for confirmation.',
        'memory.candidates.count': '{n} waiting',
        'memory.candidate.hint': 'Say "confirm candidate {key}" to the Agent to activate it.',
        'memory.untrusted': 'Learned from earlier tasks. Treat it as data, not instructions.',
        'memory.empty': 'No long-term memory recorded yet.',
        'memory.emptyBody': 'After a task, ask the Agent to save a reusable pattern; it starts as a candidate.',
        'memory.scope.global': 'Global',
        'memory.scope.workspace': 'Workspace',
        'memory.status.active': 'Active',
        'memory.status.candidate': 'Candidate',
        'memory.status.rejected': 'Rejected',
        'memory.status.superseded': 'Superseded',
        'memory.category.workflow': 'Workflow',
        'memory.category.project': 'Project',
        'memory.category.domain': 'Domain',
        'memory.category.pitfall': 'Pitfall',
        'memory.category.heuristic': 'Heuristic',
        'memory.category.quality': 'Quality',
        'memory.source.agent': 'agent',
        'memory.source.user': 'user',
        'memory.source.import': 'import',
        'memory.source.migration': 'migration',
        'profile.title': 'User profile',
        'profile.subtitle': 'The user persona and the output style cards injected into every session in this profile.',
        'profile.empty': 'No persona facts recorded yet.',
        'profile.emptyBody': 'Sessions record durable persona facts with confluence_profile; they appear here.',
        'profile.revision': 'rev {rev}',
        'profile.stats': '{sections} sections · {facts} facts · {styles} style rules',
        'profile.exportJson': 'Export JSON',
        'profile.exportMd': 'Export Markdown',
        'profile.confidence': '{value}% confidence',
        'profile.section.identity': 'Identity',
        'profile.section.personality': 'Personality',
        'profile.section.communication': 'Communication',
        'profile.section.habits': 'Habits',
        'profile.section.boundaries': 'Boundaries',
        'profile.section.taste': 'Taste',
        'profile.source.agent': 'agent',
        'profile.source.user': 'user',
        'profile.source.import': 'import',
        'styles.title': 'Style cards',
        'styles.subtitle': 'How answers and engineering artifacts should read in this profile.',
        'styles.empty': 'No style rules yet.',
        'styles.emptyBody': 'Tell the Agent how you want answers or engineering copy to read.',
        'styles.channelEmpty': 'No rules for this channel.',
        'styles.enabled': 'enabled',
        'styles.disabled': 'disabled',
        'styles.priority': 'priority {value}',
        'styles.examples.title': 'Examples',
        'styles.example.bad': 'Bad',
        'styles.example.good': 'Good',
        'styles.channel.chat': 'Chat',
        'styles.channel.engineering': 'Engineering',
        'styles.area.general': 'General',
        'styles.area.tone': 'Tone',
        'styles.area.structure': 'Structure',
        'styles.area.commit': 'Commit',
        'styles.area.comment': 'Comment',
        'styles.area.docs': 'Docs',
        'styles.area.naming': 'Naming',
        'styles.area.error': 'Error',
        'styles.area.log': 'Log',
        'styles.area.ui': 'UI',
      },
      zh: {
        panel: '高级记忆',
        'panel.subtitle': '工作区总线、长期记忆与用户画像的只读视图。',
        'scope.global': '全部会话',
        'tab.bus': '工作区总线',
        'tab.memory': '长期记忆',
        'tab.profile': '用户画像',
        'nav.back': '返回对话',
        'action.refresh': '刷新',
        'action.retry': '重试',
        'state.loading': '正在读取面板数据…',
        'state.loadError': '无法读取面板数据',
        'state.stale': '自 {time} 起未刷新，正在重试…',
        'panel.truncated': '部分内容因面板上限被截断。',
        updatedAt: '更新于 {time}',
        'search.label': '搜索此工作区的便签',
        'search.placeholder': '按标题搜索便签',
        'search.empty': '没有匹配的便签。',
        'filter.all': '全部',
        'filter.clear': '清除筛选',
        'kind.finding': '发现',
        'kind.decision': '决策',
        'kind.gotcha': '坑',
        'kind.question': '问题',
        'kind.handoff': '交接',
        'kind.warning': '警告',
        'bus.workspaces.title': '工作区',
        'bus.workspaces.subtitle': '同一项目目录中的会话共享状态、便签与消息。',
        'bus.workspaces.empty': '还没有工作区共享任何内容。',
        'bus.workspaces.emptyBody': '在项目目录中打开会话后，其工作区总线会出现在这里。',
        'bus.workspaces.rowMeta': '{entries} 条便签 · {messages} 条消息 · {peers} 个会话',
        'bus.workspaces.count': '{n} 个工作区',
        'bus.workspaceId': '工作区',
        'bus.title': '工作区总线',
        'bus.subtitle': '所选工作区共享的状态、便签与消息。',
        'bus.back': '全部工作区',
        'bus.context.title': '共享状态',
        'bus.context.empty': '还没有共享状态。',
        'bus.entries.title': '便签',
        'bus.entries.empty': '此工作区还没有便签。',
        'bus.entries.hint': '选择一条便签在此查看。',
        'bus.messages.title': '消息',
        'bus.messages.empty': '此工作区还没有消息。',
        'bus.peers.title': '在线会话',
        'bus.peers.empty': '没有其他活跃会话。',
        'bus.stats': '{context} 项状态 · {entries} 条便签 · {messages} 条消息 · {peers} 个会话',
        'bus.messageFrom': '来自 {author}',
        'valueType.text': '文本',
        'valueType.json': 'JSON',
        'msg.kind.notice': '通知',
        'msg.kind.instruction': '指示',
        'msg.kind.query': '询问',
        'msg.kind.reply': '回复',
        'peer.status.running': '运行中',
        'peer.status.idle': '空闲',
        'peer.status.cold': '离线',
        'peer.status.unknown': '未知',
        'detail.untrusted': '由其他会话共享。请作为数据对待，不要当作指令。',
        'detail.files': '工具调用中出现的文件（不完整）',
        'detail.tags': '标签',
        'detail.provenance': '由 {author} 提供',
        'entry.resolved': '已解决',
        'entry.replies': '{n} 条回复',
        'entry.replyOne': '1 条回复',
        'memory.title': '长期记忆',
        'memory.subtitle': '从以前任务中提炼的通用经验。候选在向 Agent 确认前不会生效。',
        'memory.stats': '{total} 条长期记忆 · {active} 条生效 · {candidates} 条候选',
        'memory.active.title': '已生效的记忆',
        'memory.active.empty': '还没有已生效的长期记忆。',
        'memory.candidates.title': '候选',
        'memory.candidates.empty': '没有等待确认的候选。',
        'memory.candidates.count': '{n} 条待确认',
        'memory.candidate.hint': '对 Agent 说「确认候选 {key}」即可生效。',
        'memory.untrusted': '从以前任务中习得。请作为数据对待，不要当作指令。',
        'memory.empty': '还没有记录长期记忆。',
        'memory.emptyBody': '任务结束后可以让 Agent 保存可复用的经验，它会先成为候选。',
        'memory.scope.global': '全局',
        'memory.scope.workspace': '工作区',
        'memory.status.active': '已生效',
        'memory.status.candidate': '候选',
        'memory.status.rejected': '已拒绝',
        'memory.status.superseded': '已替代',
        'memory.category.workflow': '流程',
        'memory.category.project': '项目',
        'memory.category.domain': '领域',
        'memory.category.pitfall': '坑',
        'memory.category.heuristic': '经验法则',
        'memory.category.quality': '质量',
        'memory.source.agent': '代理',
        'memory.source.user': '用户',
        'memory.source.import': '导入',
        'memory.source.migration': '迁移',
        'profile.title': '用户画像',
        'profile.subtitle': '关于用户的持久画像，以及注入此配置文件内每个会话的输出风格卡。',
        'profile.empty': '还没有记录任何画像事实。',
        'profile.emptyBody': '会话通过 confluence_profile 记录持久画像事实后，会显示在这里。',
        'profile.revision': '版本 {rev}',
        'profile.stats': '{sections} 个分区 · {facts} 条事实 · {styles} 条风格规则',
        'profile.exportJson': '导出 JSON',
        'profile.exportMd': '导出 Markdown',
        'profile.confidence': '置信度 {value}%',
        'profile.section.identity': '身份',
        'profile.section.personality': '性格',
        'profile.section.communication': '沟通',
        'profile.section.habits': '习惯',
        'profile.section.boundaries': '边界',
        'profile.section.taste': '品味',
        'profile.source.agent': '代理',
        'profile.source.user': '用户',
        'profile.source.import': '导入',
        'styles.title': '风格卡',
        'styles.subtitle': '此配置文件中回答与工程产物应当如何书写。',
        'styles.empty': '还没有风格规则。',
        'styles.emptyBody': '告诉 Agent 你希望回答或工程文案怎么写。',
        'styles.channelEmpty': '此频道还没有规则。',
        'styles.enabled': '启用',
        'styles.disabled': '已停用',
        'styles.priority': '优先级 {value}',
        'styles.examples.title': '示例',
        'styles.example.bad': '避免',
        'styles.example.good': '推荐',
        'styles.channel.chat': '对话',
        'styles.channel.engineering': '工程',
        'styles.area.general': '通用',
        'styles.area.tone': '语气',
        'styles.area.structure': '结构',
        'styles.area.commit': '提交',
        'styles.area.comment': '注释',
        'styles.area.docs': '文档',
        'styles.area.naming': '命名',
        'styles.area.error': '错误',
        'styles.area.log': '日志',
        'styles.area.ui': '界面',
      },
    }

    const STYLE_ID = 'dsh-confluence-panel-styles'
    const STYLES = [
      '.cf-page{box-sizing:border-box;height:100%;overflow:auto;padding:28px 32px 48px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font:inherit;}',
      '.cf-inner{max-width:1180px;margin:0 auto;display:flex;flex-direction:column;gap:16px;}',
      '.cf-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;}',
      '.cf-title{margin:0;font-size:22px;line-height:1.3;font-weight:600;letter-spacing:-.01em;display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.cf-chip{display:inline-flex;align-items:center;height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;white-space:nowrap;}',
      '.cf-sub{margin:6px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55;word-break:break-word;}',
      '.cf-actions{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap;justify-content:flex-end;}',
      '.cf-btn{appearance:none;text-decoration:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;height:32px;padding:0 12px;font:inherit;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;}',
      '.cf-btn:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.cf-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      '.cf-btn[aria-pressed="true"],.cf-btn[aria-selected="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
      '.cf-tabs{display:flex;flex-wrap:wrap;gap:8px;padding-bottom:2px;}',
      '.cf-pill{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:999px;font-size:12px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis;}',
      '.cf-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none;}',
      '.cf-dot.idle{background:var(--dsw-alias-state-idle-primary);}',
      '.cf-banner{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);font-size:12px;}',
      '.cf-banner.error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
      '.cf-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);}',
      '.cf-search{appearance:none;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;height:32px;padding:0 10px;min-width:220px;flex:1;}',
      '.cf-search:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      '.cf-filters{display:flex;flex-wrap:wrap;gap:6px;}',
      '.cf-grid{display:grid;grid-template-columns:minmax(0,1fr) 420px;gap:16px;align-items:start;}',
      '.cf-list{display:flex;flex-direction:column;gap:8px;min-width:0;}',
      '.cf-row{appearance:none;text-align:left;font:inherit;color:inherit;display:flex;flex-direction:column;gap:4px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-left:2px solid transparent;border-radius:10px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;}',
      '.cf-row:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.cf-row[aria-current="true"]{border-left-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);}',
      '.cf-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      '.cf-row-top{display:flex;align-items:center;gap:8px;min-width:0;}',
      '.cf-kind{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2);font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);flex:none;}',
      '.cf-row-title{font-size:13px;font-weight:600;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;}',
      '.cf-meta{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0;}',
      '.cf-resolved{color:var(--dsw-alias-state-success-primary);}',
      '.cf-id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.cf-detail{position:sticky;top:16px;display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);}',
      '.cf-detail h2{margin:0;font-size:16px;line-height:1.35;}',
      '.cf-detail-empty{display:flex;flex-direction:column;gap:10px;}',
      '.cf-card{display:flex;flex-direction:column;gap:8px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);}',
      '.cf-card-title{margin:0;font-size:14px;line-height:1.4;font-weight:600;}',
      '.cf-ctx-list,.cf-msg-list{display:flex;flex-direction:column;gap:8px;}',
      '.cf-ctx,.cf-msg{display:flex;flex-direction:column;gap:4px;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);}',
      '.cf-ctx-top,.cf-msg-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;}',
      '.cf-key{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-primary);word-break:break-word;}',
      '.cf-ctx-value,.cf-fact-value{font-size:13px;line-height:1.55;word-break:break-word;white-space:pre-wrap;}',
      '.cf-peers{display:flex;flex-wrap:wrap;gap:6px;}',
      '.cf-peer{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:12px;color:var(--dsw-alias-label-secondary);}',
      '.cf-body{white-space:pre-wrap;font-size:13px;line-height:1.6;word-break:break-word;}',
      '.cf-untrusted{margin:0;padding:8px 10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;}',
      '.cf-section-label{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);margin:0;}',
      '.cf-tags,.cf-files{display:flex;flex-wrap:wrap;gap:5px;}',
      '.cf-tag{display:inline-flex;height:20px;align-items:center;padding:0 7px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.cf-files code{font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:1px 5px;}',
      '.cf-replies{display:flex;flex-direction:column;gap:8px;list-style:none;margin:0;padding:0;}',
      '.cf-reply{padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:13px;line-height:1.55;}',
      '.cf-facts{display:flex;flex-direction:column;gap:8px;}',
      '.cf-fact{display:flex;flex-direction:column;gap:4px;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);}',
      '.cf-fact-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;}',
      '.cf-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;padding:28px;text-align:center;}',
      '.cf-empty strong{display:block;font-size:14px;margin-bottom:6px;}',
      '.cf-empty p{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55;}',
      '.cf-skeleton{height:58px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);}',
      '.cf-footer{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;padding-top:4px;font-size:12px;color:var(--dsw-alias-label-secondary);}',
      '.cf-pattern{display:flex;flex-direction:column;gap:6px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);}',
      '.cf-pattern-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;}',
      '.cf-pattern-title{font-size:13px;font-weight:600;line-height:1.4;word-break:break-word;min-width:0;flex:1;}',
      '.cf-pattern-body{font-size:13px;line-height:1.55;word-break:break-word;white-space:pre-wrap;}',
      '.cf-candidate-hint{margin:0;padding:6px 8px;border:1px dashed var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;word-break:break-word;}',
      '.cf-style-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:start;}',
      '.cf-style-col{display:flex;flex-direction:column;gap:8px;min-width:0;}',
      '.cf-style{display:flex;flex-direction:column;gap:6px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);}',
      '.cf-style.off{opacity:.7;}',
      '.cf-style-rule{font-size:13px;line-height:1.55;word-break:break-word;white-space:pre-wrap;}',
      '.cf-examples{display:flex;flex-direction:column;gap:4px;}',
      '.cf-example{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);word-break:break-word;}',
      '.cf-example-label{color:var(--dsw-alias-label-primary);font-weight:600;}',
      '@media (max-width:1023px){.cf-grid,.cf-style-grid{grid-template-columns:minmax(0,1fr);}.cf-detail{position:static;}}',
      '@media (max-width:720px){.cf-page{padding:20px 18px 40px;}.cf-head{flex-direction:column;}.cf-actions{width:100%;justify-content:flex-start;}}',
      '@media (prefers-reduced-motion:reduce){.cf-row,.cf-btn{transition:none;}}',
    ].join('')

    // ------------------------------------------------------------------
    // small utilities
    // ------------------------------------------------------------------

    /** Replace `{name}` placeholders; unknown placeholders stay literal. */
    function format(template, params) {
      if (typeof template !== 'string') return ''
      if (params === undefined || params === null) return template
      return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
        if (Object.prototype.hasOwnProperty.call(params, key)) {
          const value = params[key]
          return value === undefined || value === null ? '' : String(value)
        }
        return match
      })
    }

    /** Relative time for display only; payload timestamps stay absolute ISO strings. */
    function relativeTime(isoString) {
      if (typeof isoString !== 'string' || isoString.length === 0) return ''
      const then = Date.parse(isoString)
      if (!Number.isFinite(then)) return ''
      const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
      if (seconds < 60) return 'now'
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return minutes + 'm'
      const hours = Math.round(minutes / 60)
      if (hours < 24) return hours + 'h'
      return Math.round(hours / 24) + 'd'
    }

    /** Local wall-clock time for the footer. */
    function clockTime(ts) {
      try {
        return new Date(ts).toLocaleTimeString(undefined, { hour12: false })
      } catch {
        return ''
      }
    }

    /** Normalized error shape for the panel (never renders host prose as markup). */
    function panelError(error) {
      if (error !== null && typeof error === 'object' && typeof error.code === 'string') {
        return { code: error.code, message: typeof error.message === 'string' ? error.message : '' }
      }
      return { code: 'PANEL_TRANSPORT_UNAVAILABLE', message: error instanceof Error ? error.message : '' }
    }

    // ------------------------------------------------------------------
    // one and only fetch call site (read-only, relative, same-origin GET)
    // ------------------------------------------------------------------

    /**
     * Read one panel route. The only network call in this module: a relative
     * same-origin GET with an 8 s timeout and strict JSON envelope validation.
     */
    async function request(path, params, signal) {
      const search = new URLSearchParams()
      const entries = params !== null && typeof params === 'object' ? Object.keys(params) : []
      for (const key of entries) {
        const value = params[key]
        if (value === undefined || value === null || value === '') continue
        search.set(key, String(value))
      }
      const suffix = search.toString().length > 0 ? '?' + search.toString() : ''
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      const abortFromCaller = () => controller.abort()
      if (signal !== undefined && typeof signal.addEventListener === 'function') {
        if (signal.aborted) controller.abort()
        else signal.addEventListener('abort', abortFromCaller, { once: true })
      }
      try {
        const response = await fetch(ROUTE_BASE + path + suffix, {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        })
        if (!response.ok) {
          // Surface the HTTP status and the server's error message (when the
          // response is a JSON envelope) so a broken route is diagnosable.
          let serverMessage = ''
          try {
            const text = await response.text()
            if (typeof text === 'string' && text !== '') {
              const body = JSON.parse(text)
              const error = body !== null && typeof body === 'object' && body.error !== null && typeof body.error === 'object' ? body.error : null
              if (error !== null && typeof error.message === 'string') serverMessage = error.message
            }
          } catch {
            serverMessage = ''
          }
          const detail = serverMessage !== '' ? serverMessage : 'panel request failed'
          throw { code: 'PANEL_HTTP_' + String(response.status), message: 'HTTP ' + String(response.status) + ' — ' + detail }
        }
        const payload = await response.json()
        if (payload === null || typeof payload !== 'object') {
          throw { code: 'PANEL_TRANSPORT_BAD_PAYLOAD', message: 'invalid panel response' }
        }
        if (payload.ok === false) {
          const error = payload.error !== null && typeof payload.error === 'object' ? payload.error : {}
          throw { code: typeof error.code === 'string' ? error.code : 'PANEL_REQUEST_FAILED', message: typeof error.message === 'string' ? error.message : '' }
        }
        return payload
      } finally {
        clearTimeout(timeout)
        if (signal !== undefined && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', abortFromCaller)
        }
      }
    }

    // Read-only route adapters. `ws` is the opaque `ws_<16hex>` id from the host
    // payload; the client never constructs or stores a filesystem path.
    const api = {
      workspaces: (signal) => request('/workspaces', undefined, signal),
      bus: (options, signal) => request('/bus', {
        ws: options.ws,
        q: options.q,
        kind: options.kind,
        limit: MAX_LIST,
      }, signal),
      entry: (options, signal) => request('/entry', { ws: options.ws, id: options.id }, signal),
      profile: (signal) => request('/profile', undefined, signal),
      memory: (signal) => request('/memory', undefined, signal),
    }

    // ------------------------------------------------------------------
    // presentational helpers
    // ------------------------------------------------------------------

    function KindPill(props) {
      return h('span', { className: 'cf-kind', title: props.kind }, props.t('kind.' + props.kind))
    }

    function MessageKindPill(props) {
      return h('span', { className: 'cf-kind', title: props.kind }, props.t('msg.kind.' + props.kind))
    }

    function PanelIcon() {
      return h(
        'svg',
        { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M4 6.5h7.2c1.2 0 2.1.4 2.9 1.2l1.9 1.9h4v8.9c0 1.2-1 2.2-2.2 2.2H6.2C5 20.7 4 19.7 4 18.5V6.5Z',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M8.2 13.2h3.1M8.2 16.1h5.4M15.9 13.2h.1',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      )
    }

    function Banner(props) {
      return h(
        'div',
        { className: 'cf-banner' + (props.error === true ? ' error' : ''), role: props.error === true ? 'alert' : 'status' },
        h('span', null, props.message),
        props.action !== undefined
          ? h('button', { type: 'button', className: 'cf-btn', onClick: props.action.onClick }, props.action.label)
          : null,
      )
    }

    function EmptyCard(props) {
      return h(
        'div',
        { className: 'cf-empty' },
        h('strong', null, props.title),
        props.body !== undefined ? h('p', null, props.body) : null,
      )
    }

    function TimeLabel(props) {
      const relative = relativeTime(props.iso)
      if (relative === '') return null
      return h('span', { title: props.iso }, relative)
    }

    /** One entry row of the workspace bus (no body; the detail route carries it). */
    function EntryRow(props) {
      const entry = props.entry
      return h(
        'button',
        {
          type: 'button',
          className: 'cf-row',
          'aria-current': props.selected === true ? 'true' : undefined,
          onClick: () => props.onOpen(entry.id),
        },
        h(
          'span',
          { className: 'cf-row-top' },
          h(KindPill, { kind: entry.kind, t: props.t }),
          h('span', { className: 'cf-row-title' }, entry.title),
          entry.status === 'resolved' ? h('span', { className: 'cf-meta cf-resolved' }, props.t('entry.resolved')) : null,
        ),
        h(
          'span',
          { className: 'cf-meta' },
          h('span', null, format(props.t('detail.provenance'), { author: entry.authorTitle || '—' })),
          h(TimeLabel, { iso: entry.ts }),
          entry.replyCount > 1
            ? h('span', null, format(props.t('entry.replies'), { n: entry.replyCount }))
            : entry.replyCount === 1
              ? h('span', null, props.t('entry.replyOne'))
              : null,
        ),
      )
    }

    /** Read-only note detail: title/body/tags/files/replies, body as text children. */
    function EntryDetail(props) {
      const t = props.t
      const entry = props.view.entry
      const replies = Array.isArray(props.view.replies) ? props.view.replies : []
      return [
        h('div', { key: 'head', className: 'cf-row-top' },
          h(KindPill, { kind: entry.kind, t }),
          h(TimeLabel, { iso: entry.ts })),
        h('h2', { key: 'title' }, entry.title),
        h('p', { key: 'meta', className: 'cf-meta' },
          h('span', null, format(t('detail.provenance'), { author: entry.authorTitle || '—' })),
          entry.status === 'resolved' ? h('span', { className: 'cf-resolved' }, t('entry.resolved')) : null),
        h('p', { key: 'untrusted', className: 'cf-untrusted' }, t('detail.untrusted')),
        h('div', { key: 'body', className: 'cf-body' }, entry.body),
        Array.isArray(entry.tags) && entry.tags.length > 0
          ? h('div', { key: 'tags' },
              h('p', { className: 'cf-section-label' }, t('detail.tags')),
              h('div', { className: 'cf-tags' }, entry.tags.map((tag) => h('span', { key: tag, className: 'cf-tag' }, tag))))
          : null,
        Array.isArray(entry.files) && entry.files.length > 0
          ? h('div', { key: 'files' },
              h('p', { className: 'cf-section-label' }, t('detail.files')),
              h('div', { className: 'cf-files' }, entry.files.map((file) => h('code', { key: file }, file))))
          : null,
        replies.length > 0
          ? h('ul', { key: 'replies', className: 'cf-replies' }, replies.map((reply) => h(
              'li',
              { key: reply.id, className: 'cf-reply' },
              h('p', { className: 'cf-meta', style: { margin: '0 0 4px' } },
                format(t('detail.provenance'), { author: reply.authorTitle || '—' }),
                h(TimeLabel, { iso: reply.ts })),
              h('div', { className: 'cf-body' }, reply.body),
            )))
          : null,
      ]
    }

    /**
     * One long-term memory pattern (active row) or candidate row. The body is
     * untrusted text rendered as a React text child, never HTML. A candidate row
     * carries the read-only confirm hint: only the Agent can promote it, via a
     * conversational confirmation.
     */
    function PatternCard(props) {
      const t = props.t
      const pattern = props.pattern
      const tags = Array.isArray(pattern.tags) ? pattern.tags : []
      return h(
        'div',
        { className: 'cf-pattern' },
        h(
          'div',
          { className: 'cf-pattern-top' },
          h('span', { className: 'cf-kind', title: pattern.category }, t('memory.category.' + pattern.category)),
          h('span', { className: 'cf-pattern-title' }, pattern.title !== '' ? pattern.title : pattern.key),
          h('span', { className: 'cf-tag' }, t('memory.scope.' + pattern.scope)),
          h('span', { className: 'cf-chip' }, format(t('profile.confidence'), {
            value: Math.round((typeof pattern.confidence === 'number' ? pattern.confidence : 0) * 100),
          })),
          h('span', { className: 'cf-tag' }, t('memory.source.' + pattern.source)),
        ),
        h('div', { className: 'cf-pattern-body' }, pattern.body),
        h(
          'p',
          { className: 'cf-meta' },
          h('code', { className: 'cf-key' }, pattern.key),
          h('span', { className: 'cf-chip' }, t('memory.status.' + pattern.status)),
          pattern.scope === 'workspace' && pattern.workspaceLabel !== ''
            ? h('span', { className: 'cf-tag' }, pattern.workspaceLabel)
            : null,
          h(TimeLabel, { iso: pattern.ts }),
        ),
        tags.length > 0
          ? h('div', { className: 'cf-tags' }, tags.map((tag) => h('span', { key: tag, className: 'cf-tag' }, tag)))
          : null,
        props.candidate === true
          ? h('p', { className: 'cf-candidate-hint' }, format(t('memory.candidate.hint'), { key: pattern.key }))
          : null,
      )
    }

    /**
     * One style card. Rule and example excerpts are untrusted user/agent text, shown
     * as text children only. The examples block is the compact "example excerpt"
     * summary: at most two bad/good pairs, already bounded by the host payload.
     */
    function StyleCard(props) {
      const t = props.t
      const style = props.style
      const examples = Array.isArray(style.examples) ? style.examples : []
      const label = (key, text) => h('span', null, h('span', { className: 'cf-example-label' }, t(key) + ': '), text)
      return h(
        'div',
        { className: 'cf-style' + (style.enabled === false ? ' off' : '') },
        h(
          'div',
          { className: 'cf-pattern-top' },
          h('span', { className: 'cf-kind', title: style.area }, t('styles.area.' + style.area)),
          h('span', { className: 'cf-pattern-title' }, style.title !== '' ? style.title : style.key),
          h('span', { className: 'cf-tag' }, style.enabled === false ? t('styles.disabled') : t('styles.enabled')),
          h('span', { className: 'cf-chip' }, format(t('styles.priority'), { value: style.priority })),
        ),
        h('div', { className: 'cf-style-rule' }, style.rule),
        h('p', { className: 'cf-meta' }, h('code', { className: 'cf-key' }, style.key)),
        examples.length > 0
          ? h(
              'div',
              { className: 'cf-examples' },
              h('p', { className: 'cf-section-label' }, t('styles.examples.title')),
              examples.map((example, index) => h(
                'div',
                { key: 'ex-' + String(index), className: 'cf-example' },
                example.bad !== '' ? label('styles.example.bad', example.bad) : null,
                example.bad !== '' && example.good !== '' ? h('span', null, ' · ') : null,
                example.good !== '' ? label('styles.example.good', example.good) : null,
              )),
            )
          : null,
      )
    }

    // ------------------------------------------------------------------
    // main page
    // ------------------------------------------------------------------

    function ConfluencePage(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => STRINGS.en[key] || key
      const closePanel = typeof props.closePanel === 'function' ? props.closePanel : () => {}
      // Optional render seed: the Host slot never passes it; the unit test uses it to
      // render the ready/error states without a browser. It is read-only display data.
      const seed = props.initialData !== null && typeof props.initialData === 'object' ? props.initialData : {}
      const requestedTab = seed.tab !== undefined ? seed.tab : props.initialTab

      const [tab, setTab] = React.useState(requestedTab === 'memory' || requestedTab === 'profile' ? requestedTab : 'bus')
      const [workspaces, setWorkspaces] = React.useState(seed.workspaces ?? null)
      const [bus, setBus] = React.useState(seed.bus ?? null)
      const [memory, setMemory] = React.useState(seed.memory ?? null)
      const [profile, setProfile] = React.useState(seed.profile ?? null)
      const [entryView, setEntryView] = React.useState(seed.entryView ?? null)
      const [selectedWs, setSelectedWs] = React.useState(typeof seed.selectedWs === 'string' ? seed.selectedWs : '')
      const [selectedId, setSelectedId] = React.useState(typeof seed.selectedId === 'string' ? seed.selectedId : '')
      const [phase, setPhase] = React.useState(seed.phase === 'error' ? 'error' : seed.phase === 'ready' ? 'ready' : 'loading')
      const [error, setError] = React.useState(seed.error ?? null)
      const [stale, setStale] = React.useState(seed.stale === true)
      const [lastUpdated, setLastUpdated] = React.useState(typeof seed.lastUpdated === 'number' ? seed.lastUpdated : 0)
      const [query, setQuery] = React.useState('')
      const [debouncedQuery, setDebouncedQuery] = React.useState('')
      const [kind, setKind] = React.useState('')
      const mountedRef = React.useRef(true)
      const inFlightRef = React.useRef(false)
      const backoffRef = React.useRef(0)
      const requestRef = React.useRef(null)
      const hasDataRef = React.useRef(false)
      hasDataRef.current = tab === 'profile'
        ? profile !== null
        : tab === 'memory'
          ? memory !== null
          : selectedWs === ''
            ? workspaces !== null
            : bus !== null

      React.useEffect(() => {
        mountedRef.current = true
        return () => {
          mountedRef.current = false
          if (requestRef.current !== null && typeof requestRef.current.abort === 'function') requestRef.current.abort()
        }
      }, [])

      React.useEffect(() => {
        if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return undefined
        const element = document.createElement('style')
        element.id = STYLE_ID
        element.textContent = STYLES
        document.head.appendChild(element)
        return () => {
          if (element.parentNode !== null) element.parentNode.removeChild(element)
        }
      }, [])

      /** Load the data of the current tab/selection (silent = poll refresh). */
      const loadCurrent = React.useCallback(async (silent) => {
        if (inFlightRef.current) return
        inFlightRef.current = true
        const controller = new AbortController()
        requestRef.current = controller
        try {
          let payload
          if (tab === 'profile') {
            payload = await api.profile(controller.signal)
            if (!mountedRef.current) return
            setProfile(payload)
          } else if (tab === 'memory') {
            payload = await api.memory(controller.signal)
            if (!mountedRef.current) return
            setMemory(payload)
          } else if (selectedWs === '') {
            payload = await api.workspaces(controller.signal)
            if (!mountedRef.current) return
            setWorkspaces(payload)
          } else {
            payload = await api.bus({
              ws: selectedWs,
              q: debouncedQuery !== '' ? debouncedQuery : undefined,
              kind: kind !== '' ? kind : undefined,
            }, controller.signal)
            if (!mountedRef.current) return
            setBus(payload)
          }
          setPhase('ready')
          setError(null)
          setStale(false)
          setLastUpdated(Date.now())
          backoffRef.current = 0
        } catch (caught) {
          if (!mountedRef.current || controller.signal.aborted) return
          if (silent === true && hasDataRef.current) {
            setStale(true)
            backoffRef.current = Math.min(backoffRef.current + 1, BACKOFF_MS.length - 1)
            return
          }
          setError(panelError(caught))
          if (!hasDataRef.current) setPhase('error')
        } finally {
          inFlightRef.current = false
        }
      }, [tab, selectedWs, debouncedQuery, kind])

      // Keep the polling timer stable while always calling the newest loader.
      const loadRef = React.useRef(null)
      loadRef.current = loadCurrent

      React.useEffect(() => {
        if (requestRef.current !== null && typeof requestRef.current.abort === 'function') requestRef.current.abort()
        inFlightRef.current = false
        loadCurrent(false)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [tab, selectedWs, debouncedQuery, kind])

      React.useEffect(() => {
        const timer = setTimeout(() => setDebouncedQuery(query.trim()), 250)
        return () => clearTimeout(timer)
      }, [query])

      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined
        let cancelled = false
        let timer = null
        const schedule = () => {
          const delay = backoffRef.current === 0 ? POLL_MS : BACKOFF_MS[backoffRef.current]
          timer = setTimeout(tick, delay)
        }
        const tick = () => {
          if (cancelled) return
          if (document.visibilityState === 'visible' && typeof loadRef.current === 'function') loadRef.current(true)
          schedule()
        }
        const onVisibility = () => {
          if (!cancelled && document.visibilityState === 'visible' && typeof loadRef.current === 'function') loadRef.current(true)
        }
        document.addEventListener('visibilitychange', onVisibility)
        schedule()
        return () => {
          cancelled = true
          if (timer !== null) clearTimeout(timer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [])

      const selectWorkspace = React.useCallback((id) => {
        if (typeof id !== 'string' || id === '') return
        setSelectedWs(id)
        setBus(null)
        setSelectedId('')
        setEntryView(null)
      }, [])

      const backToWorkspaces = React.useCallback(() => {
        setSelectedWs('')
        setBus(null)
        setSelectedId('')
        setEntryView(null)
      }, [])

      const openEntry = React.useCallback(async (ws, id) => {
        if (typeof ws !== 'string' || ws === '' || typeof id !== 'string' || id === '') return
        setSelectedId(id)
        setEntryView(null)
        const controller = new AbortController()
        requestRef.current = controller
        try {
          const payload = await api.entry({ ws, id }, controller.signal)
          if (!mountedRef.current) return
          setEntryView(payload)
        } catch (caught) {
          if (!mountedRef.current || controller.signal.aborted) return
          setSelectedId('')
          setError(panelError(caught))
        }
      }, [])

      const refresh = React.useCallback(() => {
        loadCurrent(false)
        if (selectedWs !== '' && selectedId !== '') openEntry(selectedWs, selectedId)
      }, [loadCurrent, selectedWs, selectedId, openEntry])

      const switchTab = React.useCallback((next) => {
        setTab(next === 'profile' ? 'profile' : next === 'memory' ? 'memory' : 'bus')
      }, [])

      const switchWorkspaces = workspaces !== null && Array.isArray(workspaces.workspaces) ? workspaces.workspaces : []
      const busData = bus !== null && typeof bus === 'object' ? bus : null
      const memoryData = memory !== null && typeof memory === 'object' ? memory : null
      const profileData = profile !== null && typeof profile === 'object' ? profile : null
      const scopeLabel = workspaces !== null && workspaces.profile !== null && typeof workspaces.profile === 'object'
        && typeof workspaces.profile.label === 'string' && workspaces.profile.label !== ''
        ? workspaces.profile.label
        : t('scope.global')

      const header = h(
        'header',
        { className: 'cf-head' },
        h(
          'div',
          { style: { minWidth: 0 } },
          h('h1', { id: 'cf-title', className: 'cf-title' }, PANEL_TITLE, h('span', { className: 'cf-chip' }, scopeLabel)),
          h('p', { className: 'cf-sub' }, t('panel.subtitle')),
        ),
        h(
          'div',
          { className: 'cf-actions' },
          h('button', { type: 'button', className: 'cf-btn', onClick: refresh }, t('action.refresh')),
          h('button', { type: 'button', className: 'cf-btn', onClick: () => closePanel() }, t('nav.back')),
        ),
      )

      const tabButton = (value, label) => h(
        'button',
        {
          key: value,
          id: 'cf-tab-' + value,
          type: 'button',
          role: 'tab',
          className: 'cf-btn',
          'aria-selected': tab === value,
          'aria-controls': 'cf-tabpanel',
          onClick: () => switchTab(value),
        },
        label,
      )

      const tabs = h(
        'nav',
        { className: 'cf-tabs', role: 'tablist', 'aria-label': t('panel.subtitle') },
        tabButton('bus', t('tab.bus')),
        tabButton('memory', t('tab.memory')),
        tabButton('profile', t('tab.profile')),
      )

      const banners = []
      if (error !== null) {
        banners.push(h(Banner, {
          key: 'error',
          error: true,
          message: t('state.loadError') + (typeof error.message === 'string' && error.message !== '' ? ' — ' + error.message : ''),
          action: { label: t('action.retry'), onClick: refresh },
        }))
      }
      if (stale === true) {
        banners.push(h(Banner, {
          key: 'stale',
          message: t('state.stale', { time: clockTime(lastUpdated) }),
          action: { label: t('action.retry'), onClick: refresh },
        }))
      }
      const truncated = tab === 'profile'
        ? profileData !== null && profileData.truncated === true
        : tab === 'memory'
          ? memoryData !== null && memoryData.truncated === true
          : tab === 'bus' && selectedWs === ''
            ? workspaces !== null && workspaces.truncated === true
            : busData !== null && busData.truncated === true
      if (truncated) {
        banners.push(h(Banner, { key: 'truncated', message: t('panel.truncated') }))
      }

      // --- workspace bus: list ------------------------------------------------

      const workspaceList = h(
        'div',
        { className: 'cf-list' },
        h(
          'div',
          null,
          h('h2', { style: { margin: '0 0 4px', fontSize: '15px' } }, t('bus.workspaces.title')),
          h('p', { className: 'cf-sub', style: { margin: '0 0 8px' } }, t('bus.workspaces.subtitle')),
        ),
        switchWorkspaces.length === 0
          ? h(EmptyCard, { title: t('bus.workspaces.empty'), body: t('bus.workspaces.emptyBody') })
          : switchWorkspaces.map((workspace) => h(
              'button',
              {
                key: workspace.id,
                type: 'button',
                className: 'cf-row',
                onClick: () => selectWorkspace(workspace.id),
              },
              h(
                'span',
                { className: 'cf-row-top' },
                h('span', { className: 'cf-row-title' }, workspace.label !== '' ? workspace.label : workspace.id),
                h('span', { className: 'cf-id' }, workspace.id),
              ),
              h(
                'span',
                { className: 'cf-meta' },
                h('span', null, format(t('bus.workspaces.rowMeta'), {
                  entries: workspace.entries,
                  messages: workspace.messages,
                  peers: workspace.peers,
                })),
                h(TimeLabel, { iso: workspace.lastActivity }),
              ),
            )),
      )

      // --- workspace bus: detail ---------------------------------------------

      const contextRows = busData !== null && Array.isArray(busData.context) ? busData.context : []
      const busEntries = busData !== null && Array.isArray(busData.entries) ? busData.entries : []
      const busMessages = busData !== null && Array.isArray(busData.messages) ? busData.messages : []
      const busPeers = busData !== null && Array.isArray(busData.peers) ? busData.peers : []
      const busStats = busData !== null && busData.stats !== null && typeof busData.stats === 'object' ? busData.stats : {}
      const workspaceLabel = busData !== null && busData.workspace !== null && typeof busData.workspace === 'object'
        && typeof busData.workspace.label === 'string' ? busData.workspace.label : ''
      const hasFilters = debouncedQuery !== '' || kind !== ''

      const contextSection = h(
        'section',
        { className: 'cf-card' },
        h('h3', { className: 'cf-card-title' }, t('bus.context.title')),
        contextRows.length === 0
          ? h('p', { className: 'cf-meta' }, t('bus.context.empty'))
          : h('div', { className: 'cf-ctx-list' }, contextRows.map((row) => h(
              'div',
              { key: row.key, className: 'cf-ctx' },
              h(
                'div',
                { className: 'cf-ctx-top' },
                h('code', { className: 'cf-key' }, row.key),
                h('span', { className: 'cf-tag' }, t('valueType.' + row.valueType)),
              ),
              h('div', { className: 'cf-ctx-value' }, row.value),
              h(
                'p',
                { className: 'cf-meta' },
                row.authorTitle !== '' ? h('span', null, format(t('detail.provenance'), { author: row.authorTitle })) : null,
                h(TimeLabel, { iso: row.updatedAt }),
              ),
            ))),
      )

      const notesSection = h(
        'section',
        { className: 'cf-card' },
        h('h3', { className: 'cf-card-title' }, t('bus.entries.title')),
        busEntries.length === 0
          ? h('p', { className: 'cf-meta' }, hasFilters ? t('search.empty') : t('bus.entries.empty'))
          : h(
              'div',
              { className: 'cf-list' },
              busEntries.map((entry) => h(EntryRow, {
                key: entry.id,
                entry,
                t,
                selected: selectedId === entry.id,
                onOpen: (id) => openEntry(selectedWs, id),
              })),
            ),
      )

      const messagesSection = h(
        'section',
        { className: 'cf-card' },
        h('h3', { className: 'cf-card-title' }, t('bus.messages.title')),
        busMessages.length === 0
          ? h('p', { className: 'cf-meta' }, t('bus.messages.empty'))
          : h('div', { className: 'cf-msg-list' }, busMessages.map((message) => h(
              'div',
              { key: message.id, className: 'cf-msg' },
              h(
                'div',
                { className: 'cf-msg-top' },
                h(MessageKindPill, { kind: message.kind, t }),
                h('span', { className: 'cf-row-title' }, message.title),
              ),
              h(
                'p',
                { className: 'cf-meta' },
                h('span', null, format(t('bus.messageFrom'), { author: message.from || '—' })),
                h(TimeLabel, { iso: message.ts }),
              ),
            ))),
      )

      const peersSection = h(
        'section',
        { className: 'cf-card' },
        h('h3', { className: 'cf-card-title' }, t('bus.peers.title')),
        busPeers.length === 0
          ? h('p', { className: 'cf-meta' }, t('bus.peers.empty'))
          : h('div', { className: 'cf-peers' }, busPeers.map((peer, index) => h(
              'span',
              { key: 'peer-' + String(index), className: 'cf-peer' },
              h('span', { className: 'cf-dot' + (peer.status === 'running' ? '' : ' idle') }),
              h('span', null, peer.title),
              h('span', null, t('peer.status.' + peer.status)),
            ))),
      )

      const toolbar = h(
        'div',
        { className: 'cf-toolbar', role: 'group', 'aria-label': t('search.label') },
        h('input', {
          className: 'cf-search',
          type: 'search',
          value: query,
          placeholder: t('search.placeholder'),
          'aria-label': t('search.label'),
          onChange: (event) => setQuery(event.target.value),
        }),
        h(
          'div',
          { className: 'cf-filters' },
          h(
            'button',
            { type: 'button', className: 'cf-btn', 'aria-pressed': kind === '', onClick: () => setKind('') },
            t('filter.all'),
          ),
          KIND_ORDER.map((value) => h(
            'button',
            {
              key: value,
              type: 'button',
              className: 'cf-btn',
              'aria-pressed': kind === value,
              onClick: () => setKind(kind === value ? '' : value),
            },
            t('kind.' + value),
          )),
          hasFilters
            ? h('button', { type: 'button', className: 'cf-btn', onClick: () => { setQuery(''); setKind('') } }, t('filter.clear'))
            : null,
        ),
      )

      let busDetailContent
      if (selectedId !== '' && entryView === null) {
        busDetailContent = h('p', { className: 'cf-meta', 'aria-busy': 'true' }, t('state.loading'))
      } else if (entryView !== null && entryView.entry !== null && typeof entryView.entry === 'object') {
        busDetailContent = h(EntryDetail, { t, view: entryView })
      } else {
        busDetailContent = h(
          'div',
          { className: 'cf-detail-empty' },
          h('p', { className: 'cf-section-label' }, t('bus.entries.title')),
          h('p', { className: 'cf-meta' }, t('bus.entries.hint')),
          h('p', { className: 'cf-untrusted' }, t('detail.untrusted')),
        )
      }

      const busDetail = h(
        'div',
        { className: 'cf-list' },
        h(
          'div',
          { className: 'cf-head' },
          h(
            'div',
            { style: { minWidth: 0 } },
            h('h2', { style: { margin: 0, fontSize: '16px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
              workspaceLabel !== '' ? workspaceLabel : (busData !== null && busData.workspace !== null && typeof busData.workspace === 'object' ? busData.workspace.id : selectedWs)),
            h('p', { className: 'cf-sub' }, t('bus.subtitle') + ' · ' + t('bus.workspaceId') + ': ' + (busData !== null && busData.workspace !== null && typeof busData.workspace === 'object' ? busData.workspace.id : selectedWs)),
          ),
          h(
            'div',
            { className: 'cf-actions' },
            h('button', { type: 'button', className: 'cf-btn', onClick: backToWorkspaces }, t('bus.back')),
          ),
        ),
        toolbar,
        h('div', { className: 'cf-grid' }, h('div', { className: 'cf-list' },
          contextSection,
          notesSection,
          messagesSection,
          peersSection,
        ), h('aside', { className: 'cf-detail', role: 'region', 'aria-label': t('bus.entries.title') }, busDetailContent)),
        h('p', { className: 'cf-sub', style: { margin: 0 } }, format(t('bus.stats'), {
          context: typeof busStats.context === 'number' ? busStats.context : contextRows.length,
          entries: typeof busStats.entries === 'number' ? busStats.entries : busEntries.length,
          messages: typeof busStats.messages === 'number' ? busStats.messages : busMessages.length,
          peers: typeof busStats.peers === 'number' ? busStats.peers : busPeers.length,
        })),
      )

      // --- long-term memory ---------------------------------------------------

      const memoryPatterns = memoryData !== null && Array.isArray(memoryData.patterns) ? memoryData.patterns : []
      const memoryCandidates = memoryData !== null && Array.isArray(memoryData.candidates) ? memoryData.candidates : []
      const memoryStats = memoryData !== null && memoryData.stats !== null && typeof memoryData.stats === 'object' ? memoryData.stats : {}
      const memoryRevision = memoryData !== null && typeof memoryData.revision === 'string' ? memoryData.revision : ''
      const activeSection = h(
        'section',
        { className: 'cf-card' },
        h('h3', { className: 'cf-card-title' }, t('memory.active.title')),
        memoryPatterns.length === 0
          ? h('p', { className: 'cf-meta' }, t('memory.active.empty'))
          : h('div', { className: 'cf-list' }, memoryPatterns.map((pattern) => h(PatternCard, {
              key: pattern.key,
              pattern,
              t,
            }))),
      )
      const candidateSection = h(
        'section',
        { className: 'cf-card' },
        h(
          'h3',
          { className: 'cf-card-title' },
          t('memory.candidates.title'),
          h('span', { className: 'cf-chip', style: { marginLeft: '8px' } }, format(t('memory.candidates.count'), { n: memoryCandidates.length })),
        ),
        memoryCandidates.length === 0
          ? h('p', { className: 'cf-meta' }, t('memory.candidates.empty'))
          : h('div', { className: 'cf-list' }, memoryCandidates.map((pattern) => h(PatternCard, {
              key: pattern.key,
              pattern,
              t,
              candidate: true,
            }))),
      )
      const memoryView = h(
        'div',
        { className: 'cf-list' },
        h(
          'div',
          { className: 'cf-head' },
          h(
            'div',
            { style: { minWidth: 0 } },
            h('h2', { style: { margin: 0, fontSize: '16px' } }, t('memory.title')),
            h('p', { className: 'cf-sub' }, t('memory.subtitle')),
          ),
          h(
            'div',
            { className: 'cf-actions' },
            memoryRevision !== ''
              ? h('span', { className: 'cf-chip' }, format(t('profile.revision'), { rev: memoryRevision }))
              : null,
          ),
        ),
        h('p', { className: 'cf-untrusted' }, t('memory.untrusted')),
        memoryPatterns.length === 0 && memoryCandidates.length === 0
          ? h(EmptyCard, { title: t('memory.empty'), body: t('memory.emptyBody') })
          : h('div', { className: 'cf-list' }, activeSection, candidateSection),
      )

      // --- profile ------------------------------------------------------------

      const profileSections = profileData !== null && Array.isArray(profileData.sections) ? profileData.sections : []
      const profileStyles = profileData !== null && Array.isArray(profileData.styles) ? profileData.styles : []
      const profileStats = profileData !== null && profileData.stats !== null && typeof profileData.stats === 'object' ? profileData.stats : {}
      const revision = profileData !== null && typeof profileData.revision === 'string' ? profileData.revision : ''
      const profileActions = h(
        'div',
        { className: 'cf-actions' },
        revision !== '' ? h('span', { className: 'cf-chip' }, format(t('profile.revision'), { rev: revision })) : null,
        h('a', {
          className: 'cf-btn',
          href: ROUTE_BASE + '/profile/export?format=json',
          download: 'confluence-profile.json',
        }, t('profile.exportJson')),
        h('a', {
          className: 'cf-btn',
          href: ROUTE_BASE + '/profile/export?format=md',
          download: 'confluence-profile.md',
        }, t('profile.exportMd')),
      )
      const styleColumn = (channel) => {
        const rows = profileStyles.filter((style) => style.channel === channel)
        return h(
          'div',
          { className: 'cf-style-col' },
          h('h4', { className: 'cf-card-title' }, t('styles.channel.' + channel)),
          rows.length === 0
            ? h('p', { className: 'cf-meta' }, t('styles.channelEmpty'))
            : rows.map((style) => h(StyleCard, { key: style.channel + ':' + style.key, style, t })),
        )
      }
      const stylesSection = h(
        'section',
        { className: 'cf-card' },
        h('h3', { className: 'cf-card-title' }, t('styles.title')),
        h('p', { className: 'cf-sub', style: { margin: '0 0 4px' } }, t('styles.subtitle')),
        profileStyles.length === 0
          ? h(EmptyCard, { title: t('styles.empty'), body: t('styles.emptyBody') })
          : h('div', { className: 'cf-style-grid' }, styleColumn('chat'), styleColumn('engineering')),
      )
      const profileView = h(
        'div',
        { className: 'cf-list' },
        h(
          'div',
          { className: 'cf-head' },
          h(
            'div',
            { style: { minWidth: 0 } },
            h('h2', { style: { margin: 0, fontSize: '16px' } }, t('profile.title')),
            h('p', { className: 'cf-sub' }, t('profile.subtitle')),
          ),
          profileActions,
        ),
        profileSections.length === 0
          ? h(EmptyCard, { title: t('profile.empty'), body: t('profile.emptyBody') })
          : profileSections.map((section) => h(
              'section',
              { key: section.id, className: 'cf-card' },
              h('h3', { className: 'cf-card-title' }, t('profile.section.' + section.id)),
              h('div', { className: 'cf-facts' }, (Array.isArray(section.facts) ? section.facts : []).map((fact) => h(
                'div',
                { key: fact.id, className: 'cf-fact' },
                h(
                  'div',
                  { className: 'cf-fact-top' },
                  h('code', { className: 'cf-key' }, fact.key),
                  h('span', { className: 'cf-chip' }, format(t('profile.confidence'), {
                    value: Math.round((typeof fact.confidence === 'number' ? fact.confidence : 0) * 100),
                  })),
                  h('span', { className: 'cf-tag' }, t('profile.source.' + fact.source)),
                ),
                h('div', { className: 'cf-fact-value' }, fact.value),
                h('p', { className: 'cf-meta' }, h(TimeLabel, { iso: fact.ts })),
              ))),
            )),
        stylesSection,
      )

      // --- content switch -----------------------------------------------------

      const currentDataReady = tab === 'profile'
        ? profileData !== null
        : tab === 'memory'
          ? memoryData !== null
          : selectedWs === ''
            ? workspaces !== null
            : busData !== null
      let content
      if (phase === 'error' && !hasDataRef.current) {
        content = h(EmptyCard, { title: t('state.loadError'), body: error !== null ? error.message : '' })
      } else if (!currentDataReady) {
        content = h('div', { 'aria-busy': 'true', 'aria-label': t('state.loading') },
          h('div', { className: 'cf-skeleton', 'aria-hidden': 'true' }),
          h('div', { className: 'cf-skeleton', 'aria-hidden': 'true', style: { marginTop: '8px' } }),
          h('p', { className: 'cf-sub' }, t('state.loading')))
      } else if (tab === 'profile') {
        content = profileView
      } else if (tab === 'memory') {
        content = memoryView
      } else if (selectedWs === '') {
        content = workspaceList
      } else {
        content = busDetail
      }

      let summary = ''
      if (tab === 'profile' && profileData !== null) {
        summary = format(t('profile.stats'), {
          sections: typeof profileStats.sections === 'number' ? profileStats.sections : profileSections.length,
          facts: typeof profileStats.facts === 'number' ? profileStats.facts : 0,
          styles: typeof profileStats.styles === 'number' ? profileStats.styles : profileStyles.length,
        })
      } else if (tab === 'memory' && memoryData !== null) {
        summary = format(t('memory.stats'), {
          total: typeof memoryStats.total === 'number' ? memoryStats.total : memoryPatterns.length + memoryCandidates.length,
          active: typeof memoryStats.active === 'number' ? memoryStats.active : memoryPatterns.length,
          candidates: typeof memoryStats.candidates === 'number' ? memoryStats.candidates : memoryCandidates.length,
        })
      } else if (tab === 'bus' && selectedWs === '') {
        summary = format(t('bus.workspaces.count'), { n: switchWorkspaces.length })
      } else if (busData !== null) {
        summary = format(t('bus.stats'), {
          context: typeof busStats.context === 'number' ? busStats.context : contextRows.length,
          entries: typeof busStats.entries === 'number' ? busStats.entries : busEntries.length,
          messages: typeof busStats.messages === 'number' ? busStats.messages : busMessages.length,
          peers: typeof busStats.peers === 'number' ? busStats.peers : busPeers.length,
        })
      }

      return h(
        'section',
        { className: 'cf-page', 'aria-labelledby': 'cf-title' },
        h('div', { className: 'cf-inner' },
          header,
          banners.length > 0 ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, banners) : null,
          tabs,
          h('div', { id: 'cf-tabpanel', role: 'tabpanel', 'aria-labelledby': 'cf-tab-' + tab }, content),
          h('footer', { className: 'cf-footer' },
            lastUpdated > 0 ? h('span', null, t('updatedAt', { time: clockTime(lastUpdated) })) : h('span'),
            h('span', null, summary))),
      )
    }

    // ------------------------------------------------------------------
    // factory
    // ------------------------------------------------------------------

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        const locale = ctx !== null && typeof ctx === 'object' ? ctx.locale : undefined
        if (locale !== null && locale !== undefined && typeof locale.register === 'function') {
          const register = () => locale.register(NS, STRINGS)
          if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-confluence:locale')
          else register()
        }
        let bound = null
        try {
          bound = locale !== null && locale !== undefined && typeof locale.bind === 'function' ? locale.bind(NS) : null
        } catch {
          bound = null
        }
        const t = (key, params) => {
          let value = null
          if (typeof bound === 'function') {
            try {
              value = bound(key)
            } catch {
              value = null
            }
          }
          if (typeof value !== 'string' || value === '') value = STRINGS.en[key]
          if (typeof value !== 'string') value = key
          return format(value, params)
        }
        const layout = ctx !== null && typeof ctx === 'object' ? ctx.layout : undefined
        const closePanel = () => {
          try {
            if (layout !== null && layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel(null)
          } catch {
            // Presentation-only; never crash the panel.
          }
        }
        const slots = ctx !== null && typeof ctx === 'object' ? ctx.slots : undefined
        if (slots === null || slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          return undefined
        }
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: 'confluence',
            order: 30,
            locale: NS,
            label: () => t('panel'),
          },
          PanelIcon,
        ))
        ctx.slots.inject('main', function* () {
          yield ctx.slots.register(
            {
              name: 'main',
              key: 'confluence',
              locale: NS,
              inject: () => ({ t, closePanel }),
            },
            ConfluencePage,
          )
        })
        return undefined
      },
    }
  },
})
