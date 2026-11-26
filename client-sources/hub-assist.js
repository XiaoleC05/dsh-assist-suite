/**
 * 对话助手 — 唯一侧栏入口与主区页（合并客户端的一个 surface）。
 *
 * 页面内是标签页：概览 + 完全迁移进来的成员页面（高级记忆 / 输入增强）。
 * 旧插件的独立侧栏图标与独立主区页已不再注册。
 */
window.__ModuleLoader__.load({
  id: '@local/assist-hub',
  factory(require, pageSources) {
    const React = require('react')
    const h = React.createElement
    const NS = 'assistHub'
    const PANEL_ID = 'assist-hub'

    const STRINGS = {
      zh: {
        panelName: '对话助手',
        subtitle: '长期记忆 · 输入增强 · 质量门禁，一个入口管齐',
        overviewTab: '概览',
        memoryTitle: '长期记忆（Confluence）',
        memoryBody: [
          '工作区总线：共享状态、便签、跨会话消息（同工作区的会话能看到彼此）。',
          '长期记忆：从历次任务里抽象出的可复用经验，候选需要你确认后才生效。',
          '用户画像与风格卡：记录你的偏好，并注入到之后的会话。',
          '工具：confluence_board / context / send / inbox / profile / memory / style / recall。',
        ],
        promptTitle: '输入增强（pro-prompt）',
        promptBody: [
          '输入框左侧两个按钮：语音输入（转写）与提示词优化（润色 / 结构化）。',
          '面板里可以选择默认优化模式；配置由 profile 提供。',
        ],
        crispTitle: '输出质量技能',
        crispBody: [
          '技能名 output-quality：交付回答前做输出优化与统一规范（结论先行、结构一致、术语统一、格式规范、未验证项标注）。',
          '随插件自动加载，不依赖外部可执行文件或额外凭据。',
        ],
      },
      en: {
        panelName: 'Assistant',
        subtitle: 'Long-term memory, input enhancement and a quality gate in one entry',
        overviewTab: 'Overview',
        memoryTitle: 'Long-term memory (Confluence)',
        memoryBody: [
          'Workspace bus: shared state, notes and cross-session messages within one workspace.',
          'Long-term memory: reusable patterns abstracted from past tasks; candidates need your confirmation.',
          'Persona and style cards: recorded user preferences injected into later sessions.',
          'Tools: confluence_board / context / send / inbox / profile / memory / style / recall.',
        ],
        promptTitle: 'Input enhancement (pro-prompt)',
        promptBody: [
          'Two buttons left of the composer: voice input (transcription) and prompt optimization (polish / structure).',
          'The panel lets you pick the default optimization mode; configuration comes from the profile.',
        ],
        crispTitle: 'Output quality skill',
        crispBody: [
          'Skill "output-quality": polishes and standardizes answers before delivery (conclusion first, consistent structure and terms, clean formatting, unverified claims marked).',
          'Loaded with the plugin; it needs no external executable or extra credentials.',
        ],
      },
    }

    const cardStyle = {
      border: '0.5px solid var(--dsw-alias-border-l2)',
      borderRadius: 10,
      padding: '14px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }
    const listStyle = { margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }
    const titleStyle = { margin: 0, fontSize: 14, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' }
    const tabStyle = { padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13, border: '0.5px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)' }
    const tabActiveStyle = { ...tabStyle, background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontWeight: 500 }

    function Card({ title, items }) {
      return h('section', { style: cardStyle },
        h('h3', { style: titleStyle }, title),
        h('ul', { style: listStyle }, items.map((text, index) => h('li', { key: index }, text))))
    }

    function Overview({ t }) {
      return h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12, paddingTop: 4 } },
        h(Card, { title: t('memoryTitle'), items: t('memoryBody') }),
        h(Card, { title: t('promptTitle'), items: t('promptBody') }),
        h(Card, { title: t('crispTitle'), items: t('crispBody') }))
    }

    function PanelIcon({ size = 16 }) {
      const s = size
      return h('svg', { width: s, height: s, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2v-7Z',
          stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round',
        }))
    }

    function HubPage(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      const tabs = Array.isArray(props?.pageTabs) ? props.pageTabs : []
      const [active, setActive] = React.useState(-1)
      const current = active >= 0 ? tabs[active] : null
      let body
      if (current === null) {
        body = h(Overview, { t })
      } else {
        let pageProps = {}
        try { pageProps = current.getProps() } catch { pageProps = { t } }
        body = h(current.component, pageProps)
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
        h('header', { style: { padding: '20px 28px 10px', display: 'flex', flexDirection: 'column', gap: 10, flex: 'none' } },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
            h('h1', { style: { margin: 0, fontSize: 20, lineHeight: '28px', color: 'var(--dsw-alias-label-primary)' } }, t('panelName')),
            h('p', { style: { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' } }, t('subtitle'))),
          h('nav', { role: 'tablist', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('button', { type: 'button', role: 'tab', 'aria-selected': active === -1, style: active === -1 ? tabActiveStyle : tabStyle, onClick: () => setActive(-1) }, t('overviewTab')),
            tabs.map((tab, index) => h('button', {
              key: tab.id,
              type: 'button',
              role: 'tab',
              'aria-selected': active === index,
              style: active === index ? tabActiveStyle : tabStyle,
              onClick: () => setActive(index),
            }, tab.label())))),
        h('div', { role: 'tabpanel', style: { flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 28px 28px' } }, body))
    }

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        if (typeof ctx.locale?.register === 'function') ctx.locale.register(NS, STRINGS)
        const t = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : (key) => key
        const pageTabs = []
        const sources = Array.isArray(pageSources) ? pageSources : []
        for (const pages of sources) {
          if (!Array.isArray(pages)) continue
          for (const page of pages) {
            if (page === null || typeof page !== 'object' || page.component === undefined) continue
            let pageT = t
            try {
              if (typeof ctx.locale?.bind === 'function' && typeof page.locale === 'string') pageT = ctx.locale.bind(page.locale)
            } catch {
              pageT = t
            }
            pageTabs.push({
              id: String(page.id ?? page.labelKey ?? pageTabs.length),
              label: () => { try { return String(pageT(page.labelKey)) } catch { return String(page.labelKey) } },
              component: page.component,
              getProps: () => {
                let extra = {}
                try { extra = typeof page.props === 'function' ? (page.props() ?? {}) : {} } catch { extra = {} }
                return { ...extra, t: pageT }
              },
            })
          }
        }
        const slots = ctx.slots
        if (slots === null || slots === undefined || typeof slots.register !== 'function') return
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 25, locale: NS, label: () => t('panelName') },
          PanelIcon,
        ))
        ctx.slots.inject('main', function* () {
          yield ctx.slots.register(
            { name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ pageTabs }) },
            HubPage,
          )
        })
      },
    }
  },
})
