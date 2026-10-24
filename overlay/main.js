// 鲸鱼娘陪玩 · 桌面浮层（S1.6：侧边漫画气泡 / 自适应尺寸 / 自动翻边 / 透明度可调）
// 运行参数（这台机器唯一能起窗口的组合）：Electron 44 + 软件渲染
//   --no-sandbox --in-process-gpu --use-angle=swiftshader
const { app, BrowserWindow, ipcMain, globalShortcut, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const LOG = path.join(__dirname, 'boot.log')
const LOG2 = path.join(process.env.APPDATA || __dirname, 'whale-overlay', 'boot.log')
const CONFIG = path.join(__dirname, 'config.json')
const ASSETS = path.join(__dirname, 'assets')

function log(step, extra) {
  const line = `[${new Date().toISOString()}] ${step}${extra === undefined ? '' : ' ' + JSON.stringify(extra)}\n`
  for (const p of [LOG, LOG2]) { try { fs.appendFileSync(p, line) } catch {} }
  try { process.stdout.write(line) } catch {}
}

log('module-load', { electron: process.versions.electron })
process.on('uncaughtException', (e) => log('uncaughtException', { m: String(e && e.message) }))

if (process.env.WHALE_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
}
if (process.env.WHALE_NO_SANDBOX === '1') app.commandLine.appendSwitch('no-sandbox')

// 布局常量必须与 style.css 一致
const PAD = 12
const BALL_W = 64
const GAP = 10
const COLLAPSED = { w: PAD * 2 + BALL_W, h: PAD * 2 + BALL_W }

const DEFAULT_CONFIG = {
  icon: 'assets/smile.gif',
  typeSpeedMs: 34,
  bubbleHoldMs: 6000,
  bubbleOpacity: 0.94,
  port: 8765,
  bridgePort: 8766,
  watchEnabled: false,
  watchSpeed: 'normal',
  watchIntervalMs: 120000,
  watchChangeTrigger: true,
  watchChangeThreshold: 0.12,
  watchFps: 2,
  minObserveGapMs: 5000,
  watchMaxWidth: 1024,
  greeting: '我先在这看着，需要我就双击我。',
}

const DEMO_LINES = [
  '哟，这波操作可以啊。',
  '别急，先看看血条。',
  '这关我见过，右边有个箱子。',
  '你今天手感不错嘛。',
]

let win = null
let interactive = false
let dragging = false
let watchTimer = null
let observing = false
let panelOpen = false
let inputOpen = false    // 输入条展开时整窗可交互
let dragGrab = null      // 按下时光标相对窗口左上角的偏移
let dragTimer = null
let pollTimer = null
let config = { ...DEFAULT_CONFIG }
let expanded = false
let side = 'left'          // 气泡在球的哪一侧：'left' 表示气泡在左边
let ballLocal = { x: PAD, y: PAD }
let anchor = null          // 球的屏幕坐标（左上角）

const stateFile = () => path.join(app.getPath('userData'), 'anchor.json')
function loadAnchor() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) } catch { return null } }
function saveAnchor() { try { fs.writeFileSync(stateFile(), JSON.stringify(anchor, null, 2)) } catch {} }

function loadConfig() { try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')) } } catch { return { ...DEFAULT_CONFIG } } }
function saveConfig() { try { fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2)) } catch {} }
function listIcons() {
  try { return fs.readdirSync(ASSETS).filter((f) => /\.(gif|png|jpe?g|webp)$/i.test(f)).sort().map((f) => 'assets/' + f) } catch { return [] }
}

function workArea() {
  const ref = anchor ? { x: anchor.x + BALL_W / 2, y: anchor.y + BALL_W / 2 } : { x: 0, y: 0 }
  return screen.getDisplayNearestPoint(ref).workArea
}

/** 根据球的屏幕位置决定气泡朝哪边（永远朝屏幕内侧）。 */
function sideForAnchor() {
  const wa = workArea()
  return anchor.x + BALL_W / 2 < wa.x + wa.width / 2 ? 'right' : 'left'
}

/** 由球锚点 + 内容尺寸算出窗口矩形，保证球在屏幕上的位置不变。 */
const CONTENT_MARGIN = 10   // 描边 + 阴影 + 余量，防止气泡被窗口裁掉
function boundsFor(contentW, contentH) {
  const wa = workArea()
  const maxH = Math.max(COLLAPSED.h, wa.height - 24)
  const w = expanded
    ? PAD + BALL_W + GAP + Math.min(contentW, 300) + CONTENT_MARGIN
    : COLLAPSED.w
  // 长文本按真实高度给窗口，只保证不超过屏幕
  const h = expanded
    ? Math.min(maxH, Math.max(BALL_W + PAD * 2, contentH + PAD * 2))
    : COLLAPSED.h
  const localX = expanded && side === 'left' ? w - PAD - BALL_W : PAD
  // 球贴窗口顶部：气泡向下生长时，球的屏幕位置不变
  const localY = PAD
  return { x: Math.round(anchor.x - localX), y: Math.round(anchor.y - localY), width: w, height: h, localX, localY }
}

function applyLayout(contentW, contentH) {
  if (!win || win.isDestroyed()) return
  const b = boundsFor(contentW, contentH)
  const wa = workArea()
  const y = Math.min(Math.max(b.y, wa.y), wa.y + wa.height - b.height)
  ballLocal = { x: b.localX, y: b.localY - (y - b.y) }
  win.setBounds({ x: b.x, y, width: b.width, height: b.height }, false)
  try { win.webContents.send('layout', { side, ballLocal, width: b.width, height: b.height }) } catch {}
  log('layout', { side, w: b.width, h: b.height, ballLocal })
}

function collapse() {
  if (!win || win.isDestroyed()) return
  expanded = false
  applyLayout(0, 0)
}

function setInteractive(next) {
  if (!win || win.isDestroyed() || interactive === next) return
  interactive = next
  win.setIgnoreMouseEvents(!next, { forward: true })
  try { win.webContents.send('interactive', next) } catch {}
}

// 只有球可交互；气泡纯展示，不挡游戏点击
function hitTest() {
  if (!win || win.isDestroyed()) return false
  if (inputOpen) return true
  const b = win.getBounds()
  const p = screen.getCursorScreenPoint()
  const left = b.x + ballLocal.x
  const top = b.y + ballLocal.y
  return p.x >= left && p.x <= left + BALL_W && p.y >= top && p.y <= top + BALL_W
}

function startPolling() {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return
    if (dragging) { if (!interactive) setInteractive(true); return }
    setInteractive(hitTest())
  }, 60)
}

function say(text) { if (win && !win.isDestroyed()) win.webContents.send('say', text) }
function demoSay() { say(DEMO_LINES[Math.floor(Math.random() * DEMO_LINES.length)]) }

function cycleIcon() {
  const icons = listIcons()
  if (!icons.length) return
  const idx = icons.indexOf(config.icon)
  config.icon = icons[(idx + 1 + icons.length) % icons.length]
  saveConfig()
  win?.webContents.send('icon', config.icon)
}

function cycleOpacity() {
  const steps = [0.94, 0.82, 0.7, 0.58, 1]
  const idx = steps.indexOf(config.bubbleOpacity)
  config.bubbleOpacity = steps[(idx + 1 + steps.length) % steps.length]
  saveConfig()
  win?.webContents.send('opacity', config.bubbleOpacity)
  log('opacity', config.bubbleOpacity)
}

function recenter() {
  if (!win || win.isDestroyed()) return
  const wa = screen.getPrimaryDisplay().workArea
  anchor = { x: wa.x + wa.width - PAD - BALL_W, y: wa.y + wa.height - PAD - BALL_W }
  expanded = false
  applyLayout(0, 0)
  saveAnchor()
}

/** 本机 HTTP 入口：让 DSH 插件 / Agent / 脚本把台词推给浮层。
 *  只绑 127.0.0.1，端口在 config.json 的 port（默认 8765）。
 *  POST /say      {"text":"..."}      让她说一句
 *  POST /opacity  {"value":0.7}       改气泡透明度
 *  GET  /health                      探活
 */
/** 把一句用户输入交给陪玩 agent（桥在 8766），把她的回复直接冒泡。 */
async function askCompanion(text) {
  const url = 'http://127.0.0.1:' + (Number(config.bridgePort) || 8766) + '/chat'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(120000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status))
  const reply = String(data.reply ?? '').trim()
  if (reply) say(reply)
  return reply
}

// ── 自动陪看：定时抓屏（GDI，不含浮层）→ 带图问她 → 冒泡 ──
// 陪玩 agent 目录（bridge.mjs / capture.py 在这里）。默认是包内的 ../bridge。
// 用函数而非常量：config 是稍后才从 config.json 读进来的。
const companionDir = () => path.resolve(config.companionDir || path.join(__dirname, '..', 'bridge'))
// Python 解释器：配置优先，其次包内 venv，最后退回 PATH 里的 python
const pythonExe = () => {
  if (config.pythonPath) return config.pythonPath
  const v = path.join(companionDir(), '.venv', 'Scripts', 'python.exe')
  return fs.existsSync(v) ? v : 'python'
}

function captureFrame() {
  return new Promise((resolve, reject) => {
    const out = path.join(companionDir(), 'frame.jpg')
    const { spawn } = require('node:child_process')
    const p = spawn(pythonExe(), ['capture.py', 'frame.jpg', String(config.watchMaxWidth || 1280)], { cwd: companionDir() })
    let outText = ''
    let err = ''
    p.stdout.on('data', (d) => { outText += d.toString('utf8') })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', reject)
    p.on('exit', (code) => {
      if (code !== 0) return reject(new Error('capture failed: ' + err.slice(0, 200)))
      let meta = {}
      try { meta = JSON.parse(outText.trim().split('\n').pop()) } catch {}
      try { resolve({ image: fs.readFileSync(out).toString('base64'), title: meta.title || '', cropped: Boolean(meta.cropped) }) }
      catch (e) { reject(e) }
    })
  })
}

let lastFrameHash = ''

function hashStr(str) {
  let h = 5381
  for (let i = 0; i < str.length; i += 97) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0
  return h.toString(16)
}

async function observeOnce(force = false) {
  if (!win || win.isDestroyed()) return { ok: false, error: 'no window' }
  const started = Date.now()
  const frame = await captureFrame()
  const image = frame.image
  const h = hashStr(image)
  if (!force && h === lastFrameHash) {
    log('observe-skip', { reason: 'frame unchanged' })
    return { ok: false, skipped: true, error: 'frame unchanged' }
  }
  lastFrameHash = h
  const url = 'http://127.0.0.1:' + (Number(config.bridgePort) || 8766) + '/observe'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      image,
      mimeType: 'image/jpeg',
      windowTitle: frame.title,
      hint: config.observeHint,
    }),
    signal: AbortSignal.timeout(180000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status))
  const reply = String(data.reply ?? '').trim()
  if (reply) say(reply)
  log('observe-done', { ms: Date.now() - started, chars: reply.length, title: frame.title.slice(0, 40), cropped: frame.cropped })
  return { ok: true, reply }
}

function applyWatchOpts(o) {
  const opts = o || {}
  if (Number.isFinite(opts.intervalMs)) {
    config.watchIntervalMs = Math.max(15000, Math.round(opts.intervalMs))
    saveConfig()
  }
  if (opts.enabled === true) { config.watchEnabled = true; saveConfig(); stopWatch(); startWatch() }
  if (opts.enabled === false) { config.watchEnabled = false; saveConfig(); stopWatch() }
}

let watcherProc = null
const observeLog = []   // 每次实际看图的时间戳
let lastObserveAt = 0

function maybeObserve(reason) {
  if (observing) return
  // 用户正在面板里调设置：别打断，也别白花一次看图
  if (panelOpen) { log('observe-skip', { reason: 'panel-open' }); return }
  const gap = Math.max(1000, Number(config.minObserveGapMs) || 5000)
  if (Date.now() - lastObserveAt < gap) return
  if (!watchTimer && !watcherProc) return
  lastObserveAt = Date.now()
  observing = true
  observeLog.push(Date.now())
  log('observe-trigger', { reason })
  observeOnce()
    .catch((e) => log('observe-failed', { m: String(e).slice(0, 160) }))
    .finally(() => { observing = false })
}

/** 常驻抓屏比较：画面剧变就立刻看一眼，不用等轮询。 */
function startWatcher() {
  if (watcherProc) return
  const { spawn } = require('node:child_process')
  const args = [
    'watcher.py',
    '--fps', String(Number(config.watchFps) || 2),
    '--threshold', String(Number(config.watchChangeThreshold) || 0.12),
    '--cooldown', String(Math.max(1, (Number(config.minObserveGapMs) || 5000) / 1000)),
  ]
  watcherProc = spawn(pythonExe(), args, { cwd: companionDir() })
  let buf = ''
  watcherProc.stdout.on('data', (d) => {
    buf += d.toString('utf8')
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      try {
        const ev = JSON.parse(line)
        if (ev.event === 'change') maybeObserve('screen-change:' + ev.ratio)
      } catch {}
    }
  })
  watcherProc.stderr.on('data', (d) => log('watcher-stderr', d.toString().slice(0, 160)))
  watcherProc.on('exit', (code) => { log('watcher-exit', code); watcherProc = null })
  log('watcher-started', args.slice(1).join(' '))
}

function stopWatcher() {
  if (!watcherProc) return
  try { watcherProc.kill() } catch {}
  watcherProc = null
  log('watcher-stopped')
}

// 反应速度档位：灵敏=更常看图、更贵；安静=更省钱
const SPEED_PRESETS = {
  quiet:  { label: '安静', watchChangeTrigger: false, watchChangeThreshold: 0.3, minObserveGapMs: 60000, watchIntervalMs: 300000 },
  normal: { label: '标准', watchChangeTrigger: true,  watchChangeThreshold: 0.12, minObserveGapMs: 5000, watchIntervalMs: 120000 },
  fast:   { label: '灵敏', watchChangeTrigger: true,  watchChangeThreshold: 0.07, minObserveGapMs: 2500, watchIntervalMs: 60000 },
}

function applySpeed(name) {
  const preset = SPEED_PRESETS[name] || SPEED_PRESETS.normal
  const { label: _label, ...presetValues } = preset   // label 只给日志和 UI，别写进配置
  Object.assign(config, presetValues)
  config.watchSpeed = name in SPEED_PRESETS ? name : 'normal'
  saveConfig()
  if (watchTimer) { stopWatch(); startWatch() }
  log('speed-set', { speed: config.watchSpeed, ...preset })
  return config.watchSpeed
}

function startWatch() {
  if (watchTimer) return
  const ms = Math.max(15000, Number(config.watchIntervalMs) || 120000)
  watchTimer = setInterval(() => maybeObserve('timer'), ms)
  if (config.watchChangeTrigger !== false) startWatcher()
  log('watch-started', { timerMs: ms, changeTrigger: config.watchChangeTrigger !== false })
}

function stopWatch() {
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null }
  stopWatcher()
  log('watch-stopped')
}

function startHttpApi() {
  const port = Number(config.port) || 8765
  const server = http.createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(obj))
    }
    if (req.method === 'GET' && req.url === '/health') {
      return send(200, { ok: true, expanded, side, anchor, config: { bubbleOpacity: config.bubbleOpacity } })
    }
    if (req.method !== 'POST') return send(404, { ok: false, error: 'not found' })

    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy() })
    req.on('end', () => {
      let data = {}
      try { data = body ? JSON.parse(body) : {} } catch { return send(400, { ok: false, error: 'bad json' }) }

      if (req.url === '/say') {
        const text = String(data.text ?? '').trim()
        if (!text) return send(400, { ok: false, error: 'text required' })
        log('http-say', { chars: text.length })
        say(text)
        return send(200, { ok: true })
      }
      if (req.url === '/chat') {
        const text = String(data.text ?? '').trim()
        if (!text) return send(400, { ok: false, error: 'text required' })
        log('http-chat', { chars: text.length })
        askCompanion(text)
          .then((reply) => send(200, { ok: true, reply }))
          .catch((e) => { log('chat-failed', { m: String(e) }); send(502, { ok: false, error: String(e.message) }) })
        return
      }
      if (req.url === '/watch') {
        if (data.once === true) {
          observing = true
          return observeOnce(data.force === true)
            .then((r) => send(200, { ok: true, ...r }))
            .catch((e) => send(502, { ok: false, error: String(e.message) }))
            .finally(() => { observing = false })
        }
        applyWatchOpts(data)
        return send(200, { ok: true, enabled: Boolean(watchTimer), intervalMs: config.watchIntervalMs })
      }
      if (req.url === '/config') {
        // 允许外部（DSH 插件设置页）在运行时改这些键
        const allowed = ['icon', 'bubbleOpacity', 'typeSpeedMs', 'bubbleHoldMs', 'watchEnabled', 'watchSpeed', 'watchIntervalMs', 'watchChangeThreshold', 'minObserveGapMs', 'watchMaxWidth']
        const applied = {}
        for (const k of allowed) {
          if (!(k in data)) continue
          config[k] = data[k]
          applied[k] = data[k]
          if (k === 'bubbleOpacity') win?.webContents.send('opacity', Number(config.bubbleOpacity))
          if (k === 'icon') win?.webContents.send('icon', String(config.icon))
        }
        if ('watchSpeed' in applied) applySpeed(String(config.watchSpeed))
        if ('watchEnabled' in applied) applyWatchOpts({ enabled: Boolean(config.watchEnabled) })
        saveConfig()
        log('http-config', applied)
        return send(200, { ok: true, applied, config: { bubbleOpacity: config.bubbleOpacity, icon: config.icon, watchEnabled: Boolean(watchTimer), watchSpeed: config.watchSpeed } })
      }
      if (req.url === '/status') {
        return send(200, {
          ok: true,
          running: true,
          expanded, side, anchor,
          watch: Boolean(watchTimer),
          speed: config.watchSpeed || 'normal',
          opacity: config.bubbleOpacity,
          icon: config.icon,
          bridgePort: config.bridgePort,
          observesLastHour: observeLog.filter((t) => Date.now() - t < 3600_000).length,
        })
      }
      if (req.url === '/icons') {
        return send(200, { ok: true, icons: listIcons() })
      }
      if (req.url === '/opacity') {
        const v = Number(data.value)
        if (!Number.isFinite(v) || v < 0.05 || v > 1) return send(400, { ok: false, error: 'value 0.05..1' })
        config.bubbleOpacity = v
        saveConfig()
        win?.webContents.send('opacity', v)
        log('http-opacity', v)
        return send(200, { ok: true, value: v })
      }
      return send(404, { ok: false, error: 'not found' })
    })
  })
  server.on('error', (e) => log('http-error', { m: String(e) }))
  server.listen(port, '127.0.0.1', () => log('http-listening', { port }))
}

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea
  anchor = loadAnchor() || { x: wa.x + wa.width - PAD - BALL_W, y: wa.y + wa.height - PAD - BALL_W }
  // 夹紧到工作区，防止旧坐标把球放到屏幕外
  anchor.x = Math.min(Math.max(anchor.x, wa.x), wa.x + wa.width - BALL_W)
  anchor.y = Math.min(Math.max(anchor.y, wa.y), wa.y + wa.height - BALL_W)
  side = sideForAnchor()

  const b = boundsFor(0, 0)
  ballLocal = { x: b.localX, y: b.localY }
  log('create-window', { anchor, side, bounds: b })

  win = new BrowserWindow({
    width: b.width, height: b.height, x: b.x, y: b.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    show: false,
    roundedCorners: false,
    ...(process.platform === 'win32' ? { thickFrame: false } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setIgnoreMouseEvents(true, { forward: true })
  startPolling()

  win.once('ready-to-show', () => { try { win.showInactive() } catch {} log('shown', win.getBounds()) })
  setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) { try { win.showInactive() } catch {} log('fallback-show') }
  }, 1500)

  win.webContents.on('did-finish-load', () => {
    log('did-finish-load')
    win.webContents.send('config', { ...config, icons: listIcons() })
    win.webContents.send('layout', { side, ballLocal, width: b.width, height: b.height })
  })
  win.webContents.on('render-process-gone', (_e, d) => log('render-process-gone', d))

  win.loadFile('index.html').catch((e) => log('load-file-failed', { m: String(e) }))

  // 配置热加载：改 config.json 立刻生效（不用重启）
  try {
    fs.watch(CONFIG, { persistent: false }, () => {
      config = loadConfig()
      log('config-reloaded', config)
      try { win?.webContents.send('config', { ...config, icons: listIcons(), greeting: undefined }) } catch {}
    })
  } catch (e) { log('config-watch-failed', { m: String(e) }) }

  // 开发期热重载：改前端文件自动刷新（不重启进程，免得反复手动启动）
  for (const f of ['renderer.js', 'style.css', 'index.html']) {
    try {
      fs.watch(path.join(__dirname, f), { persistent: false }, () => {
        log('hot-reload', f)
        try { win?.webContents.reloadIgnoringCache() } catch {}
      })
    } catch (e) { log('watch-failed', { f, m: String(e) }) }
  }
}

app.whenReady().then(() => {
  config = loadConfig()
  if (!fs.existsSync(CONFIG)) saveConfig()
  createWindow()
  startHttpApi()
  if (config.watchEnabled) startWatch()

  const hotkeys = [
    ['Control+Alt+W', () => { setInteractive(!interactive); win?.webContents.send('hotkey-flash') }],
    ['Control+Alt+B', () => demoSay()],
    ['Control+Alt+I', () => cycleIcon()],
    ['Control+Alt+O', () => cycleOpacity()],
    ['Control+Alt+R', () => recenter()],
    ['Control+Alt+G', () => {
      if (watchTimer) { stopWatch(); config.watchEnabled = false } else { startWatch(); config.watchEnabled = true }
      saveConfig()
      say(watchTimer ? '我开始盯着你玩啦。' : '好，我先歇会儿。')
    }],
    ['Control+Alt+P', () => { try { win?.webContents.send('capture-request') } catch {} }],
  ]
  for (const [acc, fn] of hotkeys) { try { globalShortcut.register(acc, fn) } catch {} }

  // 拖动由主进程按光标位置驱动：每个 mousemove 算一次位移会抖、会丢事件。
  ipcMain.on('drag-start', () => {
    if (!win || win.isDestroyed()) return
    dragging = true
    setInteractive(true)
    const p = screen.getCursorScreenPoint()
    const b = win.getBounds()
    // moved 只在真的拖动后才置真：单纯点击不能收窗口，否则会把面板裁没
    dragGrab = { x: p.x - b.x, y: p.y - b.y, moved: false }
    if (dragTimer) clearInterval(dragTimer)
    dragTimer = setInterval(() => {
      if (!dragging || !dragGrab || !win || win.isDestroyed()) return
      const q = screen.getCursorScreenPoint()
      const nx = Math.round(q.x - dragGrab.x)
      const ny = Math.round(q.y - dragGrab.y)
      const cur = win.getBounds()
      if (!dragGrab.moved && (Math.abs(nx - cur.x) > 3 || Math.abs(ny - cur.y) > 3)) {
        dragGrab.moved = true
        // 软件渲染下拖大窗口重绘跟不上：真要拖了才收成球
        if (expanded) {
          expanded = false
          applyLayout(0, 0)
          try { win.webContents.send('hide-bubble') } catch {}
        }
      }
      win.setPosition(nx, ny, false)
    }, 16)
  })
  ipcMain.on('drag-end', () => {
    dragging = false
    dragGrab = null
    if (dragTimer) { clearInterval(dragTimer); dragTimer = null }
    if (!win || win.isDestroyed()) return
    const b = win.getBounds()
    anchor = { x: b.x + ballLocal.x, y: b.y + ballLocal.y }
    const wa = workArea()
    anchor.x = Math.min(Math.max(anchor.x, wa.x), wa.x + wa.width - BALL_W)
    anchor.y = Math.min(Math.max(anchor.y, wa.y), wa.y + wa.height - BALL_W)
    side = sideForAnchor()
    saveAnchor()
    applyLayout(expanded ? lastContent.w : 0, expanded ? lastContent.h : 0)
  })

  // 渲染层量好内容尺寸后，主进程据此重排窗口（球的位置保持不动）
  let lastContent = { w: 0, h: 0 }
  ipcMain.on('prepare-bubble', (_e, size) => {
    expanded = true
    side = sideForAnchor()
    lastContent = { w: Math.max(80, Math.round(size?.w ?? 160)), h: Math.max(40, Math.round(size?.h ?? 60)) }
    applyLayout(lastContent.w, lastContent.h)
  })
  ipcMain.on('bubble-closed', () => { if (expanded) collapse() })
  // 打字过程中气泡每长一行，按真实尺寸重排窗口（球锚点不变）
  ipcMain.on('sync-size', (_e, size) => {
    if (!win || win.isDestroyed()) return
    expanded = true
    applyLayout(Math.round(size?.w ?? 160), Math.round(size?.h ?? 40))
  })

  ipcMain.on('input-state', (_e, open) => {
    inputOpen = Boolean(open)
    log('input-state', inputOpen)
    if (inputOpen) setInteractive(true)
  })
  ipcMain.on('chat-send', (_e, text) => {
    const t = String(text ?? '').trim()
    if (!t) return
    log('ui-chat', { chars: t.length })
    askCompanion(t).catch((e) => log('ui-chat-failed', { m: String(e) }))
  })
  ipcMain.handle('settings-status', () => ({
    watchEnabled: Boolean(watchTimer),
    watchIntervalMs: Number(config.watchIntervalMs) || 60000,
    bubbleOpacity: Number(config.bubbleOpacity) || 0.94,
    icon: config.icon,
    icons: listIcons(),
    watchSpeed: config.watchSpeed || 'normal',
    speedLabel: SPEED_PRESETS[config.watchSpeed || 'normal'].label,
    observesLastHour: observeLog.filter((t) => Date.now() - t < 3600_000).length,
  }))

  ipcMain.on('speed-set', (_e, name) => {
    const applied = applySpeed(String(name || ''))
    win?.webContents.send('speed-changed', applied)
  })

  ipcMain.on('watch-set', (_e, opts) => {
    const o = opts || {}
    if (o.once === true) {
      observing = true
      observeOnce(true)
        .catch((e) => log('observe-failed', { m: String(e).slice(0, 160) }))
        .finally(() => { observing = false })
      return
    }
    applyWatchOpts(o)
  })

  ipcMain.on('opacity-set', (_e, v) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return
    config.bubbleOpacity = Math.min(1, Math.max(0.3, Math.round(n * 100) / 100))
    saveConfig()
    win?.webContents.send('opacity', config.bubbleOpacity)
  })

  ipcMain.handle('persona-get', () => {
    try { return { ok: true, text: fs.readFileSync(path.join(companionDir(), 'AGENTS.md'), 'utf8') } }
    catch (e) { return { ok: false, error: String(e.message), text: '' } }
  })

  ipcMain.on('persona-save', async (_e, text) => {
    try {
      fs.writeFileSync(path.join(companionDir(), 'AGENTS.md'), String(text ?? ''), 'utf8')
      log('persona-saved', { chars: String(text ?? '').length })
      // 人格在会话创建时读取，必须换新会话才生效
      const url = 'http://127.0.0.1:' + (Number(config.bridgePort) || 8766) + '/reload'
      const res = await fetch(url, { method: 'POST', headers: { 'x-reason': 'persona' }, signal: AbortSignal.timeout(90000) })
      const data = await res.json().catch(() => ({}))
      if (data.ok) say('角色卡换好了，我照这个来。')
      else say('角色卡存了，但重开会话失败。')
    } catch (e) {
      log('persona-save-failed', { m: String(e).slice(0, 160) })
      win?.webContents.send('persona-save-result', { ok: false, error: String(e) })
    }
  })

  ipcMain.on('panel-state', (_e, open) => {
    panelOpen = Boolean(open)
    inputOpen = Boolean(open)
    if (inputOpen) setInteractive(true)
    log('panel-state', inputOpen)
  })

  ipcMain.on('demo-say', () => demoSay())
  ipcMain.on('cycle-icon', () => cycleIcon())
  ipcMain.on('trace', (_e, name, data) => log('renderer:' + name, data))

  // 让 Electron 自己截自己：透明分层窗口不会被 GDI 截屏捕获，只能用 capturePage
  ipcMain.on('capture', async () => {
    if (!win || win.isDestroyed()) return
    try {
      const img = await win.webContents.capturePage()
      fs.writeFileSync(path.join(__dirname, 'page.png'), img.toPNG())
      log('captured', { bytes: img.toPNG().length })
    } catch (e) { log('capture-failed', { m: String(e) }) }
  })
  ipcMain.handle('get-info', () => ({ side, ballLocal, anchor }))
}).catch((e) => log('whenReady-failed', { m: String(e) }))

app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => { if (pollTimer) clearInterval(pollTimer); globalShortcut.unregisterAll() })
