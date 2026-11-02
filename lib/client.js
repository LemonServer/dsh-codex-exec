/* Browser half of dsh-codex-exec: a compact selector in the composer toolbar
 * (same row as the model picker) that chooses the Codex model, reasoning
 * effort and role used by the host's `codex_exec` tool.
 *
 * Styling uses DSH's own design tokens (--dsw-*) so the control matches the
 * native toolbar instead of looking bolted on. Loaded as a plain script, so it
 * must not rely on CommonJS globals, and every failure is contained. */
window.__ModuleLoader__.load({
  id: 'dsh-codex-exec',
  factory: (require) => {
    try {
      const React = require('react')
      const h = React.createElement

      const SLOT_NAME = 'conversation.input.right'
      const ENTRY_ID = 'codex-exec-selector'
      const ENTRY_ORDER = 60
      const ROUTE = '/dsh-codex-exec'
      const STYLE_ID = 'dsh-codex-exec-styles'
      const ROLE_LABELS = { executor: '执行者', reviewer: '审查者', planner: '规划者' }
      // Set once the widget has actually rendered: a slot that accepted the
      // registration but never mounted it keeps the retries alive instead.
      let mounted = false

      const CSS = `
.dsh-codex-exec { position: relative; display: inline-flex; align-items: center; flex: 0 1 auto; min-width: 0; font-family: var(--dsw-font-family, inherit); }
.dsh-codex-exec__trigger {
  display: inline-flex; align-items: center; gap: 4px;
  height: 24px; padding: 0 8px; max-width: 148px; min-width: 0;
  border: 0; border-radius: var(--dsw-radius-md, 6px);
  background: transparent; color: var(--dsw-alias-label-secondary, inherit);
  font: inherit; font-size: 12px; line-height: 1; white-space: nowrap; cursor: pointer;
}
.dsh-codex-exec__label { overflow: hidden; text-overflow: ellipsis; }
.dsh-codex-exec__trigger:hover { background: var(--dsw-alias-button-tool-bar-hover, rgba(127,127,127,.14)); }
.dsh-codex-exec__trigger[aria-expanded="true"] { background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.2)); }
.dsh-codex-exec__trigger:disabled { opacity: .55; cursor: default; }
.dsh-codex-exec__trigger:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color); outline-offset: 2px; }
.dsh-codex-exec__caret { display: block; flex: none; opacity: .6; transition: transform .12s ease; }
.dsh-codex-exec__trigger[aria-expanded="true"] .dsh-codex-exec__caret { transform: rotate(180deg); }
.dsh-codex-exec__panel {
  position: absolute; bottom: calc(100% + 6px); right: 0; z-index: 40;
  min-width: 240px; padding: 8px; display: grid; gap: 6px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28));
  border-radius: var(--dsw-radius-lg, 10px);
  background: var(--dsw-menu-surface-fill, var(--dsw-alias-bg-layer-2));
  box-shadow: var(--dsw-elevation-panel, 0 8px 24px rgba(0,0,0,.35));
  backdrop-filter: var(--dsw-menu-backdrop-filter, none);
}
.dsh-codex-exec__row { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
.dsh-codex-exec__select {
  min-width: 118px; height: 24px; padding: 0 6px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.24));
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit; font-size: 12px; cursor: pointer;
}
.dsh-codex-exec__hint { font-size: 11px; line-height: 1.45; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.8)); }
`

      function installStyles() {
        if (typeof document === 'undefined') return
        if (document.getElementById(STYLE_ID)) return
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        ;(document.head || document.documentElement).appendChild(style)
      }

      function useSelection(ctx) {
        const [state, setState] = React.useState(null)
        React.useEffect(() => {
          let alive = true
          let timer = null
          let attempt = 0
          const load = async () => {
            try {
              const result = await ctx.connection.rpc.call(ROUTE, 'state', { args: {} })
              if (!alive) return
              if (result && result.ok) {
                setState(result.value)
                return
              }
            } catch {
              // The host route may not be mounted yet on a cold start; retried below.
            }
            if (!alive) return
            attempt += 1
            if (attempt <= 12) timer = setTimeout(load, Math.min(5000, 400 * attempt))
          }
          void load()
          return () => {
            alive = false
            if (timer) clearTimeout(timer)
          }
        }, [ctx])
        const select = (patch) => {
          void (async () => {
            try {
              const result = await ctx.connection.rpc.call(ROUTE, 'select', { args: patch })
              if (result && result.ok) setState(result.value)
            } catch {
              // Keep the previous selection visible on failure.
            }
          })()
        }
        return [state, select]
      }

      function CodexExecSelector(props) {
        const [state, select] = useSelection(props.__ctx)
        const [open, setOpen] = React.useState(false)
        const holderRef = React.useRef(null)

        React.useEffect(() => {
          mounted = true
        }, [])

        React.useEffect(() => {
          if (!open) return undefined
          const onDown = (event) => {
            const node = holderRef.current
            if (node && !node.contains(event.target)) setOpen(false)
          }
          const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
          document.addEventListener('mousedown', onDown)
          document.addEventListener('keydown', onKey)
          return () => {
            document.removeEventListener('mousedown', onDown)
            document.removeEventListener('keydown', onKey)
          }
        }, [open])

        const chevron = h('svg', {
          className: 'dsh-codex-exec__caret',
          width: 10,
          height: 10,
          viewBox: '0 0 10 10',
          'aria-hidden': 'true',
          focusable: 'false',
        }, h('path', {
          d: 'M2 4l3 3 3-3',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }))

        if (!state) {
          // Never disappear while the host route is still coming up: show a
          // disabled placeholder and let useSelection keep retrying.
          return h('div', { ref: holderRef, className: 'dsh-codex-exec' },
            h('button', {
              type: 'button',
              className: 'dsh-codex-exec__trigger',
              disabled: true,
              title: '正在读取 Codex 配置…',
            }, 'Codex …', chevron))
        }

        const selection = state.selection || {}
        const roles = state.roles || ['executor', 'reviewer', 'planner']
        const models = state.models || []
        const current = models.find((entry) => entry.id === selection.model) || models[0]
        // Effort levels come from the model itself: luna stops at max, astra has ultra.
        const efforts = current?.efforts || ['low', 'medium', 'high']
        const roleText = ROLE_LABELS[selection.role] || selection.role
        // The role leads the trigger: it says what Codex is doing in this
        // session, and it is shorter than spelling out the product name.
        const label = `${roleText} · ${selection.model} · ${selection.effort}`
        const tooltip = `Codex ${roleText}｜模型：${selection.model}｜努力：${selection.effort}`

        const option = (value, text) => h('option', { key: value, value }, text)
        const row = (key, title, values, format) => h('label', { className: 'dsh-codex-exec__row', key },
          h('span', null, title),
          h('select', {
            className: 'dsh-codex-exec__select',
            value: selection[key] || '',
            onChange: (event) => select({ [key]: event.target.value }),
          }, ...values.map((value) => option(value, format ? format(value) : value))))

        const modelIds = models.map((entry) => entry.id)

        return h('div', { ref: holderRef, className: 'dsh-codex-exec' },
          h('button', {
            type: 'button',
            className: 'dsh-codex-exec__trigger',
            'aria-haspopup': 'dialog',
            'aria-expanded': open ? 'true' : 'false',
            title: tooltip,
            onClick: () => setOpen((value) => !value),
          }, h('span', { className: 'dsh-codex-exec__label' }, label), chevron),
          open ? h('div', { className: 'dsh-codex-exec__panel', role: 'dialog', 'aria-label': 'Codex 执行参数' },
            row('role', '角色', roles, (value) => ROLE_LABELS[value] || value),
            row('model', '模型', modelIds),
            row('effort', '努力', efforts),
            h('div', { className: 'dsh-codex-exec__hint' }, '作用于下一次 codex_exec；审查者与规划者强制只读。'),
          ) : null)
      }

      return {
        inject: ['slots', 'connection'],
        apply(ctx) {
          let disposed = false
          let disposer = null

          const register = () => {
            if (disposed) return true
            if (mounted && disposer) return true
            try {
              installStyles()
              // Replace any previous registration so a re-register never doubles up.
              if (disposer) {
                try { disposer() } catch {}
                disposer = null
              }
              disposer = ctx.slots.inject(SLOT_NAME, () => ctx.slots.register(
                {
                  name: SLOT_NAME,
                  id: ENTRY_ID,
                  order: ENTRY_ORDER,
                  label: () => 'Codex 执行参数',
                  inject: (sessionId) => ({ sessionId }),
                },
                (props) => h(CodexExecSelector, Object.assign({}, props, { __ctx: ctx })),
              ))
              return true
            } catch (error) {
              // The slot host may not be mounted yet on a cold start; retried below.
              return false
            }
          }

          // On a fresh app start this module can apply before the composer slot
          // exists, which used to leave the widget missing until a manual plugin
          // restart. Register immediately, then retry while the UI comes up.
          register()
          const timers = [400, 1200, 3000, 6000, 10000].map((ms) => setTimeout(() => {
            if (!disposed) register()
          }, ms))

          return () => {
            disposed = true
            for (const timer of timers) {
              try { clearTimeout(timer) } catch {}
            }
            try { disposer?.() } catch {}
          }
        },
      }
    } catch (error) {
      try { console.error('[dsh-codex-exec] client module failed to initialise:', error) } catch {}
      return { inject: [], apply() {} }
    }
  },
})
