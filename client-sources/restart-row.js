/**
 * 「重启应用」设置行（合并客户端的一个 surface）。
 *
 * Windows 桌面端没有可用重启入口：应用菜单被替换为隐藏的开发者工具项，渲染层
 * 也不暴露重启 IPC。这里在 设置 → 通用 里加一行按钮，调用融合插件的
 * POST /assist-suite/restart：宿主会延迟拉起新的桌面实例，再退出旧进程。
 */
window.__ModuleLoader__.load({
  id: '@local/assist-restart-row',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'assistRestart'
    const ROW_ID = 'assist-restart-app'

    const STRINGS = {
      zh: {
        title: '重启应用',
        description: '修改需要重启才生效的配置（例如开发者工具开关、插件的安装与停用）后，点这里会关闭当前窗口并自动重新打开。已保存的会话不受影响。',
        button: '重启',
        confirming: '重启中…',
        failed: '重启请求失败，请稍后重试，或手动退出后重新打开。',
        canceled: '已取消。',
      },
      en: {
        title: 'Restart app',
        description: 'After changing settings that only apply on restart (developer tools, plugin installs or removals), this closes the window and reopens it automatically. Saved sessions are kept.',
        button: 'Restart',
        confirming: 'Restarting…',
        failed: 'The restart request failed. Try again, or quit and reopen manually.',
        canceled: 'Canceled.',
      },
    }

    const rowStyle = {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24,
      padding: '16px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
    }
    const textStyle = { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }
    const titleStyle = { fontSize: 14, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' }
    const descStyle = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px' }
    const buttonStyle = {
      flex: 'none', padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
      border: '0.5px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
    }

    function RestartRow({ t }) {
      const [phase, setPhase] = React.useState('idle')
      const restart = async () => {
        if (phase === 'restarting') return
        const confirmed = typeof window.confirm === 'function'
          ? window.confirm(t('title') + '：' + t('description'))
          : true
        if (!confirmed) return
        setPhase('restarting')
        try {
          const response = await fetch('/assist-suite/restart', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          if (!response.ok) throw new Error('HTTP ' + String(response.status))
          // The Host exits right after responding; keep the label until the window closes.
        } catch {
          setPhase('failed')
        }
      }
      return h('div', { style: rowStyle },
        h('div', { style: textStyle },
          h('span', { style: titleStyle }, t('title')),
          h('span', { style: descStyle }, t('description')),
          phase === 'failed' ? h('span', { style: { ...descStyle, color: 'var(--dsw-alias-state-error-primary)' }, role: 'alert' }, t('failed')) : null),
        h('button', {
          type: 'button',
          style: { ...buttonStyle, opacity: phase === 'restarting' ? 0.6 : 1 },
          disabled: phase === 'restarting',
          onClick: () => { restart() },
        }, phase === 'restarting' ? t('confirming') : t('button')))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        if (typeof ctx.locale?.register === 'function') ctx.locale.register(NS, STRINGS)
        const t = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : (key) => key
        const slots = ctx.slots
        if (slots === null || slots === undefined || typeof slots.register !== 'function') return
        ctx.slots.inject('settings.general.item', () => ctx.slots.register(
          { name: 'settings.general.item', id: ROW_ID, order: 27, locale: NS },
          () => h(RestartRow, { t }),
        ))
      },
    }
  },
})
