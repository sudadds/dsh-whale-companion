/**
 * dsh-whale-companion —— 浏览器半端（设置里的一页）
 *
 * 自注册约定：window.__ModuleLoader__.load({ id: <包名>, factory: (require) => ({ inject, apply }) })
 * 进「设置」：slots.inject('settings.section', () => slots.register({...}, () => h(Panel)))
 */
window.__ModuleLoader__.load({
  id: 'dsh-whale-companion',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const API = '/api/whale'

    const jget = async (p) => {
      const r = await fetch(API + p, { credentials: 'same-origin' })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    }
    const jpost = async (p, body) => {
      const r = await fetch(API + p, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status))
      return j
    }

    const S = {
      card: { border: '1px solid var(--dsh-border, #2a3550)', borderRadius: 10, padding: '12px 14px', marginBottom: 12 },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '5px 0' },
      title: { fontSize: 13, opacity: 0.75, marginBottom: 8, letterSpacing: '.5px' },
      btn: (on) => ({
        border: '1px solid var(--dsh-border, #2a3550)', borderRadius: 8, padding: '4px 12px', cursor: 'pointer',
        background: on ? 'var(--dsh-accent, #2f6fd0)' : 'transparent',
        color: on ? '#fff' : 'inherit', fontSize: 12,
      }),
      dot: (ok) => ({ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', marginRight: 6, background: ok ? '#3ecf8e' : '#8a94a6' }),
      hint: { fontSize: 11.5, opacity: 0.6 },
      avatar: (sel) => ({
        width: 40, height: 40, borderRadius: '50%', objectFit: 'cover', cursor: 'pointer',
        border: sel ? '2px solid var(--dsh-accent, #2f6fd0)' : '2px solid transparent',
      }),
    }

    const SPEEDS = [['quiet', '安静'], ['normal', '标准'], ['fast', '灵敏']]

    function Panel() {
      const [st, setSt] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [busy, setBusy] = React.useState('')

      const load = async () => {
        try { setSt(await jget('/status')); setErr('') } catch (e) { setErr(String(e.message || e)) }
      }
      React.useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t) }, [])

      const cfg = st?.config || {}
      const det = st?.detail || {}
      const overlayOn = Boolean(st?.overlay)
      const bridgeOn = Boolean(st?.bridge)

      const act = async (name, fn) => {
        setBusy(name); setErr('')
        try { await fn(); await load() } catch (e) { setErr(String(e.message || e)) } finally { setBusy('') }
      }

      const send = (patch) => act('cfg', () => jpost('/config', patch))

      const pickIcon = async (icon) => act('icon', () => jpost('/config', { icon }))

      const uploadIcon = (ev) => {
        const file = ev.target.files && ev.target.files[0]
        if (!file) return
        const reader = new FileReader()
        reader.onload = () => {
          const name = 'custom-' + Date.now() + (file.name.match(/\.(gif|png|jpg|jpeg|webp)$/i)?.[0] || '.gif')
          act('upload', () => jpost('/icon', { name, data: reader.result }))
        }
        reader.readAsDataURL(file)
        ev.target.value = ''
      }

      if (!st) return h('div', { style: S.card }, err ? '读取状态失败：' + err : '读取中…')

      return h('div', {},
        h('div', { style: S.card },
          h('div', { style: S.title }, '鲸鱼娘陪玩'),
          h('div', { style: S.row },
            h('span', {}, h('span', { style: S.dot(overlayOn) }), '悬浮球'),
            h('span', {}, h('span', { style: S.dot(bridgeOn) }), '对话桥')),
          h('div', { style: S.row },
            h('span', { style: S.hint }, overlayOn ? '近 1 小时看过 ' + (det.observesLastHour ?? 0) + ' 次' : '未启动'),
            h('span', { style: { display: 'flex', gap: 8 } },
              h('button', { style: S.btn(!overlayOn), disabled: busy === 'start', onClick: () => act('start', () => jpost('/start')) }, '启动'),
              h('button', { style: S.btn(overlayOn), disabled: busy === 'stop', onClick: () => act('stop', () => jpost('/stop')) }, '停止'))),
          err ? h('div', { style: { ...S.hint, color: '#e0556b', marginTop: 6 } }, err) : null),

        h('div', { style: S.card },
          h('div', { style: S.title }, '陪玩行为'),
          h('div', { style: S.row },
            h('span', {}, '自动陪看'),
            h('button', { style: S.btn(Boolean(det.watch)), onClick: () => send({ watchEnabled: !det.watch }) },
              det.watch ? '开' : '关')),
          h('div', { style: S.row },
            h('span', {}, '反应速度'),
            h('span', { style: { display: 'flex', gap: 6 } },
              SPEEDS.map(([k, label]) =>
                h('button', {
                  key: k,
                  style: S.btn((det.speed || 'normal') === k),
                  onClick: () => send({ watchSpeed: k }),
                }, label)))),
          h('div', { style: S.row },
            h('span', {}, '气泡透明度'),
            h('span', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('button', { style: S.btn(false), onClick: () => send({ bubbleOpacity: Math.max(0.3, Math.round(((det.opacity ?? 0.94) - 0.08) * 100) / 100) }) }, '−'),
              h('span', { style: { minWidth: 34, textAlign: 'center', fontSize: 12 } }, Number(det.opacity ?? 0.94).toFixed(2)),
              h('button', { style: S.btn(false), onClick: () => send({ bubbleOpacity: Math.min(1, Math.round(((det.opacity ?? 0.94) + 0.08) * 100) / 100) }) }, '＋')))),

        h('div', { style: S.card },
          h('div', { style: S.title }, '悬浮球头像'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' } },
            (st.icons || []).map((icon) => h('img', {
              key: icon,
              src: API + '/asset?p=' + encodeURIComponent(icon),
              alt: icon,
              style: S.avatar(det.icon === icon),
              onClick: () => pickIcon(icon),
            }))),
          h('div', { style: { ...S.row, marginTop: 8 } },
            h('span', { style: S.hint }, '把 gif/png 塞进浮层 assets 目录，或直接上传'),
            h('label', { style: S.btn(false) }, busy === 'upload' ? '上传中…' : '上传图片',
              h('input', { type: 'file', accept: 'image/*', style: { display: 'none' }, onChange: uploadIcon })))),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'whale-companion', order: 31, label: '鲸鱼娘' },
          () => h(Panel),
        ))
      },
    }
  },
})
