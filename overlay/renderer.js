// 渲染层：单击聊天 / 双击设置 / 设置里编辑角色卡；气泡尺寸由自身驱动窗口。
const ball = document.getElementById('ball')
const avatar = document.getElementById('avatar')
const bubble = document.getElementById('bubble')
const bubbleText = document.getElementById('bubbleText')
const pulse = document.getElementById('pulse')
const composer = document.getElementById('composer')
const composerInput = document.getElementById('composerInput')
const composerSend = document.getElementById('composerSend')
const settings = document.getElementById('settings')
const setWatch = document.getElementById('setWatch')
const setOnce = document.getElementById('setOnce')
const setSpeedBtn = document.getElementById('setSpeed')
const usageEl = document.getElementById('usage')
const opaDown = document.getElementById('opaDown')
const opaUp = document.getElementById('opaUp')
const setIcon = document.getElementById('setIcon')
const opaValue = document.getElementById('opaValue')
const setPersona = document.getElementById('setPersona')
const persona = document.getElementById('persona')
const personaText = document.getElementById('personaText')
const personaCancel = document.getElementById('personaCancel')
const personaSaveBtn = document.getElementById('personaSave')

let dragging = false
let pressAt = null
let clickTimer = null
let typingTimer = null
let hideTimer = null
let typeSpeed = 34
let holdMs = 6000
let opacity = 0.94
let side = 'left'
let token = 0

const MAX_W = 300
const MAX_CHARS = 220
let lastSize = { w: 0, h: 0 }
let pendingAutoSay = ''
let greeted = false

// ui: none | composer | settings | persona
let ui = 'none'

let stat = { watchEnabled: false, watchIntervalMs: 60000, bubbleOpacity: 0.94 }
const INTERVALS = [30000, 60000, 120000, 300000]

function clearTimers() {
  if (typingTimer) { clearInterval(typingTimer); typingTimer = null }
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
}

function applySide(next) {
  side = next === 'right' ? 'right' : 'left'
  bubble.classList.toggle('side-right', side === 'right')
  bubble.classList.toggle('side-left', side === 'left')
  composer.classList.toggle('side-right', side === 'right')
  composer.classList.toggle('side-left', side === 'left')
  settings.classList.toggle('side-right', side === 'right')
  settings.classList.toggle('side-left', side === 'left')
  persona.classList.toggle('side-right', side === 'right')
  persona.classList.toggle('side-left', side === 'left')
}

function placeBall(local) {
  if (!local) return
  ball.style.left = local.x + 'px'
  ball.style.top = local.y + 'px'
  ball.style.right = 'auto'
  ball.style.bottom = 'auto'
}

function syncSize() {
  if (bubble.hidden) return
  const r = bubble.getBoundingClientRect()
  const w = Math.ceil(r.width)
  const h = Math.ceil(r.height)
  if (w === lastSize.w && h === lastSize.h) return
  lastSize = { w, h }
  window.overlay.syncSize({ w, h })
}

function say(text, holdOverride, opts = {}) {
  let full = String(text ?? '').trim()
  if (!full) return
  if (full.length > MAX_CHARS) full = full.slice(0, MAX_CHARS).replace(/\s+$/, '') + '…'

  // 面板开着时，自动消息不抢占界面：暂存一条，等面板关了再说
  if (ui !== 'none' && opts.auto) {
    pendingAutoSay = full
    window.overlay.trace('say-deferred', { chars: full.length })
    return
  }
  closeUi()
  clearTimers()
  token += 1
  const mine = token

  bubble.hidden = false
  bubble.style.opacity = String(opacity)
  bubble.style.maxWidth = MAX_W + 'px'
  bubbleText.textContent = ''
  bubble.classList.add('typing')
  applySide(side)
  lastSize = { w: 0, h: 0 }
  syncSize()

  const speed = Number.isFinite(typeSpeed) && typeSpeed > 0 ? typeSpeed : 34
  const hold = Number.isFinite(holdOverride) ? holdOverride
    : (Number.isFinite(holdMs) && holdMs > 0 ? holdMs : 6000)

  let i = 0
  typingTimer = setInterval(() => {
    if (mine !== token) { clearInterval(typingTimer); typingTimer = null; return }
    i += 1
    bubbleText.textContent = full.slice(0, i)
    syncSize()
    if (i >= full.length) {
      clearInterval(typingTimer)
      typingTimer = null
      bubble.classList.remove('typing')
      syncSize()
      window.overlay.trace('done', { chars: full.length, size: lastSize })
      hideTimer = setTimeout(() => { if (mine === token) closeBubble() }, hold)
    }
  }, speed)
}

function closeBubble() {
  clearTimers()
  bubble.classList.remove('typing')
  bubble.hidden = true
  lastSize = { w: 0, h: 0 }
  if (ui === 'none') window.overlay.bubbleClosed()
}

function hideBubbleNow() {
  clearTimers()
  token += 1
  bubble.classList.remove('typing')
  bubble.hidden = true
}

// ── 三种界面互斥：输入条 / 设置 / 角色卡 ──────────────
function closeUi(sendPanelState = true) {
  if (ui === 'none') return
  composer.hidden = true
  settings.hidden = true
  persona.hidden = true
  ui = 'none'
  if (sendPanelState) {
    window.overlay.panelState(false)
    if (bubble.hidden) window.overlay.bubbleClosed()
    // 面板关闭后补上刚才被压住的那句自动点评
    if (pendingAutoSay) {
      const t = pendingAutoSay
      pendingAutoSay = ''
      setTimeout(() => say(t), 220)
    }
  }
}

function enterUi(next, size) {
  const wasOpen = ui !== 'none'
  closeUi(false)
  ui = next
  window.overlay.prepareBubble(size)
  window.overlay.panelState(true)
  if (!wasOpen) setTimeout(() => { if (ui === next) placeUi(next) }, 20)
  else placeUi(next)
}

function placeUi(which) {
  if (which === 'composer') {
    composer.hidden = false
    composerInput.focus()
  } else if (which === 'settings') {
    settings.hidden = false
  } else if (which === 'persona') {
    persona.hidden = false
    personaText.focus()
  }
}

function openComposer() {
  if (ui === 'composer') return
  hideBubbleNow()
  enterUi('composer', { w: 214, h: 40 })
}

function openSettings() {
  if (ui === 'settings') return
  hideBubbleNow()
  enterUi('settings', { w: 214, h: 196 })
  refreshStatus()
}

async function openPersona() {
  hideBubbleNow()
  enterUi('persona', { w: 268, h: 252 })
  personaText.value = '载入中…'
  try {
    const r = await window.overlay.personaGet()
    personaText.value = r && r.text ? r.text : ''
  } catch {
    personaText.value = ''
  }
}

// ── 设置面板 ─────────────────────────────────────────
function renderSettings() {
  setWatch.textContent = stat.watchEnabled ? '开' : '关'
  setWatch.classList.toggle('on', Boolean(stat.watchEnabled))
  if (setSpeedBtn) setSpeedBtn.textContent = stat.speedLabel || '标准'
  if (usageEl) usageEl.textContent = (stat.observesLastHour ?? 0) + ' 次'
  if (opaValue) opaValue.textContent = opacity.toFixed(2)
}

async function refreshStatus() {
  try {
    const st = await window.overlay.settingsStatus()
    stat = { ...stat, ...st, bubbleOpacity: opacity }
    renderSettings()
  } catch {}
}

setWatch.addEventListener('click', () => {
  stat.watchEnabled = !stat.watchEnabled
  window.overlay.watchSet({ enabled: stat.watchEnabled })
  renderSettings()
})
setOnce.addEventListener('click', () => {
  closeUi()
  window.overlay.watchSet({ once: true, force: true })
  bubble.hidden = false
  bubbleText.textContent = '…'
  lastSize = { w: 0, h: 0 }
  syncSize()
})
const SPEEDS = ['quiet', 'normal', 'fast']
setSpeedBtn.addEventListener('click', () => {
  const cur = SPEEDS.indexOf(stat.watchSpeed || 'normal')
  const next = SPEEDS[(cur + 1 + SPEEDS.length) % SPEEDS.length]
  stat.watchSpeed = next
  window.overlay.speedSet(next)
  setTimeout(refreshStatus, 120)
})

function stepOpacity(delta) {
  const next = Math.min(1, Math.max(0.3, Math.round((opacity + delta) * 100) / 100))
  opacity = next
  stat.bubbleOpacity = next
  bubble.style.opacity = String(next)
  window.overlay.opacitySet(next)
  // 面板留在原处，只用数值反馈；下一次气泡就按新透明度出现
  if (opaValue) opaValue.textContent = next.toFixed(2)
  document.documentElement.style.setProperty('--bubble-alpha', String(next))
}
opaDown.addEventListener('click', () => stepOpacity(-0.08))
opaUp.addEventListener('click', () => stepOpacity(+0.08))
setIcon.addEventListener('click', () => window.overlay.cycleIcon())
setPersona.addEventListener('click', () => openPersona())

personaCancel.addEventListener('click', () => { closeUi(); window.overlay.bubbleClosed() })
personaSaveBtn.addEventListener('click', () => {
  const text = personaText.value
  closeUi()
  window.overlay.personaSave(text)
  bubble.hidden = false
  bubbleText.textContent = '…'
  lastSize = { w: 0, h: 0 }
  syncSize()
})

composerSend.addEventListener('click', (e) => { e.stopPropagation(); submitComposer() })
composerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitComposer() }
  if (e.key === 'Escape') { e.preventDefault(); closeUi(); window.overlay.bubbleClosed() }
})

function submitComposer() {
  const text = composerInput.value.trim()
  if (!text) return
  composerInput.value = ''
  closeUi()
  bubble.hidden = false
  bubbleText.textContent = '…'
  lastSize = { w: 0, h: 0 }
  syncSize()
  window.overlay.chatSend(text)
}

// 点击窗口内空白处：收起面板（球和面板本身除外）
document.getElementById('root').addEventListener('mousedown', (e) => {
  if (ui === 'none') return
  const t = e.target
  if (ball.contains(t) || settings.contains(t) || persona.contains(t) || composer.contains(t)) return
  e.preventDefault()
  closeUi()
})

// 窗口失焦（点到游戏/桌面）也收起，等同“点外面关闭”
window.addEventListener('blur', () => {
  if (ui !== 'none') closeUi()
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ui !== 'none') {
    e.preventDefault()
    closeUi()
    window.overlay.bubbleClosed()
  }
})

// ── 单击 / 双击仲裁 ──────────────────────────────────
ball.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  pressAt = { x: e.screenX, y: e.screenY, t: Date.now() }
  dragging = true
  ball.classList.add('dragging')
  window.overlay.dragStart()
  e.preventDefault()
})

window.addEventListener('mouseup', (e) => {
  if (!dragging) return
  dragging = false
  ball.classList.remove('dragging')
  window.overlay.dragEnd()
  if (!pressAt) return
  const dx = Math.abs(e.screenX - pressAt.x)
  const dy = Math.abs(e.screenY - pressAt.y)
  const quick = Date.now() - pressAt.t < 400
  pressAt = null
  if (dx >= 4 || dy >= 4 || !quick) return
  // 延迟 230ms 判定单击；双击到来时会取消它
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return }
  clickTimer = setTimeout(() => {
    clickTimer = null
    if (ui === 'composer') { closeUi(); window.overlay.bubbleClosed() } else { openComposer() }
  }, 230)
})

ball.addEventListener('dblclick', (e) => {
  e.stopPropagation()
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null }
  // 双击 = 开关；再双击同一个球就是关掉
  if (ui === 'settings' || ui === 'persona') { closeUi(); return }
  openSettings()
})

ball.addEventListener('contextmenu', (e) => { e.preventDefault(); window.overlay.cycleIcon() })

// ── 主进程事件 ───────────────────────────────────────
window.overlay.onLayout((l) => {
  if (!l) return
  applySide(l.side)
  placeBall(l.ballLocal)
})
window.overlay.onSay((text) => {
  if (bubbleText.textContent === '…') { bubble.hidden = true; lastSize = { w: 0, h: 0 } }
  // 主进程推来的都是自动消息（陪看/问候），面板开着就延后
  say(text, undefined, { auto: ui !== 'none' })
})
window.overlay.onHideBubble(() => hideBubbleNow())
window.overlay.onConfig((cfg) => {
  if (Number.isFinite(cfg?.typeSpeedMs)) typeSpeed = cfg.typeSpeedMs
  if (Number.isFinite(cfg?.bubbleHoldMs)) holdMs = cfg.bubbleHoldMs
  if (Number.isFinite(cfg?.bubbleOpacity)) { opacity = cfg.bubbleOpacity; bubble.style.opacity = String(opacity) }
  if (cfg?.icon) avatar.src = cfg.icon
  // 只在首次加载说开场白；配置热重载不能再念一遍（那会把面板顶掉）
  if (!greeted && cfg?.greeting) { greeted = true; setTimeout(() => say(cfg.greeting), 600) }
})
window.overlay.onIcon((src) => { if (src) avatar.src = src })
window.overlay.onOpacity((v) => {
  opacity = v
  bubble.style.opacity = String(v)
  stat.bubbleOpacity = v
})
window.overlay.onInteractive((next) => pulse.classList.toggle('active', next))
window.overlay.onHotkey(() => {
  pulse.classList.remove('active')
  void pulse.offsetWidth
  pulse.classList.add('active')
  setTimeout(() => pulse.classList.remove('active'), 700)
})
