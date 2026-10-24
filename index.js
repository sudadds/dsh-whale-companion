/**
 * dsh-whale-companion —— host 半端
 * ============================================================================
 * 它做的事：
 *   1. 起/停两个子进程：`bridge.mjs`（陪玩 agent，stdio JSON-RPC 驱动 dsh --profile sdk）
 *      与 `electron`（桌面悬浮球）。
 *   2. 给设置页开 `/api/whale/*` 路由：状态、开关、陪看/速度/透明度、头像上传。
 *   3. 插件被停用时把子进程收掉，不留孤儿。
 *
 * 目录约定（都能在设置里改）：
 *   overlayDir  = .../whale-overlay      （Electron 浮层）
 *   companionDir= .../whale-companion    （桥 + AGENTS.md 人格 + .venv）
 *
 * 注意：这里只用 node 标准库，不依赖 schemastery —— 设置页由本包的 client.js 自己画。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

export const name = 'whale-companion'
export const inject = ['webServer']

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const HOME = join(DSH_HOME, 'whale-companion')
const CFG = join(HOME, 'config.json')

const DEFAULTS = {
  enabled: false,           // 总开关：是否拉起浮层+桥
  autoStart: false,         // DSH 启动时自动拉起
  overlayDir: join(PLUGIN_DIR, 'overlay'),   // 包内自带
  companionDir: join(PLUGIN_DIR, 'bridge'),
  overlayPort: 8765,
  bridgePort: 8766,
  pythonPath: '',           // 留空=用 <companionDir>/.venv 或 PATH 里的 python
}

function readCfg() {
  try { return { ...DEFAULTS, ...JSON.parse(readFileSync(CFG, 'utf8')) } } catch { return { ...DEFAULTS } }
}
function writeCfg(c) {
  try { mkdirSync(HOME, { recursive: true }); writeFileSync(CFG, JSON.stringify(c, null, 2)) } catch {}
}

const req = (url, opts = {}) => new Promise((resolve) => {
  const r = http.request(url, { timeout: opts.timeout ?? 8000, method: opts.method || 'GET', headers: opts.headers }, (res) => {
    let b = ''
    res.on('data', (d) => { b += d })
    res.on('end', () => { try { resolve(JSON.parse(b)) } catch { resolve(null) } })
  })
  r.on('error', () => resolve(null))
  r.on('timeout', () => { r.destroy(); resolve(null) })
  if (opts.body) r.write(opts.body)
  r.end()
})

export function apply(ctx) {
  const log = (...a) => { try { ctx.logger?.info?.('[whale] ' + a.join(' ')) } catch {} }
  let cfg = readCfg()
  let bridgeProc = null
  let overlayProc = null

  const overlayUrl = (p) => `http://127.0.0.1:${cfg.overlayPort}${p}`
  const bridgeUrl = (p) => `http://127.0.0.1:${cfg.bridgePort}${p}`

  async function overlayAlive() {
    const st = await req(overlayUrl('/health'))
    return Boolean(st && st.ok)
  }

  async function bridgeAlive() {
    const st = await req(bridgeUrl('/health'))
    return Boolean(st && st.ok)
  }

  function startBridge() {
    if (bridgeProc && !bridgeProc.killed) return
    const script = join(cfg.companionDir, 'bridge.mjs')
    if (!existsSync(script)) return log('bridge.mjs 不存在:', script)
    bridgeProc = spawn(process.execPath, [script], {
      cwd: cfg.companionDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, WHALE_BRIDGE_PORT: String(cfg.bridgePort) },
    })
    bridgeProc.unref()
    log('bridge 启动 pid=', bridgeProc.pid)
  }

  function startOverlay() {
    if (overlayProc && !overlayProc.killed) return
    const exe = join(cfg.overlayDir, 'node_modules', 'electron', 'dist', 'electron.exe')
    if (!existsSync(exe)) {
      return log('electron 未安装；先跑 scripts/install.ps1（或 cd overlay && npm i）:', exe)
    }
    overlayProc = spawn(exe, ['.', '--no-sandbox', '--in-process-gpu', '--use-angle=swiftshader',
      `--user-data-dir=${join(cfg.overlayDir, 'udd')}`], {
      cwd: cfg.overlayDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, WHALE_DISABLE_GPU: '1', WHALE_NO_SANDBOX: '1' },
    })
    overlayProc.unref()
    log('overlay 启动 pid=', overlayProc.pid)
  }

  function kill(p, name) {
    if (!p || p.killed) return
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true })
      else p.kill()
      log(name, '已停止')
    } catch (e) { log(name, '停止失败', e?.message) }
  }

  async function startAll() {
    // 已经有人在跑就不要再起一份（避免 8766 端口抢绑）
    if (!(await bridgeAlive())) startBridge()
    if (!(await overlayAlive())) startOverlay()
    await new Promise((r) => setTimeout(r, 1800))
    return { bridge: await bridgeAlive(), overlay: await overlayAlive() }
  }

  function stopAll() {
    kill(bridgeProc, 'bridge'); bridgeProc = null
    kill(overlayProc, 'overlay'); overlayProc = null
  }

  async function pushOverlayConfig(patch) {
    const body = JSON.stringify(patch)
    return req(overlayUrl('/config'), { method: 'POST', body, headers: { 'content-type': 'application/json' } })
  }

  // ── HTTP 路由 ────────────────────────────────────────
  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  const readBody = (reqObj) => new Promise((resolve) => {
    let b = ''
    reqObj.on('data', (d) => { b += d; if (b.length > 16 * 1024 * 1024) reqObj.destroy() })
    reqObj.on('end', () => { try { resolve(JSON.parse(b || '{}')) } catch { resolve({}) } })
  })

  async function handle(httpReq, res) {
    const url = new URL(httpReq.url, 'http://127.0.0.1')
    const p = url.pathname.replace(/^\/api\/whale/, '') || '/'

    if (httpReq.method === 'GET' && p === '/status') {
      const [ov, br] = await Promise.all([overlayAlive(), bridgeAlive()])
      const detail = ov ? await req(overlayUrl('/status')) : null
      const icons = ov ? ((await req(overlayUrl('/icons')))?.icons ?? []) : []
      // 浮层目录里能用的头像（含用户上传的）
      const assetsDir = join(cfg.overlayDir, 'assets')
      let files = []
      try { files = icons } catch {}
      return sendJson(res, 200, { ok: true, overlay: ov, bridge: br, detail, icons: files, config: cfg, assetsDir })
    }

    if (httpReq.method === 'POST' && p === '/config') {
      const body = await readBody(httpReq)
      const patch = {}
      for (const k of ['overlayDir', 'companionDir', 'overlayPort', 'bridgePort', 'autoStart', 'enabled']) {
        if (k in body) patch[k] = body[k]
      }
      cfg = { ...cfg, ...patch }
      writeCfg(cfg)
      const orb = {}
      for (const k of ['bubbleOpacity', 'watchEnabled', 'watchSpeed', 'icon', 'typeSpeedMs', 'bubbleHoldMs']) {
        if (k in body) orb[k] = body[k]
      }
      if (Object.keys(orb).length) await pushOverlayConfig(orb)
      return sendJson(res, 200, { ok: true, config: cfg })
    }

    if (httpReq.method === 'POST' && p === '/start') {
      cfg = { ...cfg, enabled: true }
      writeCfg(cfg)
      const r = await startAll()
      return sendJson(res, 200, { ok: true, ...r })
    }

    if (httpReq.method === 'POST' && p === '/stop') {
      cfg = { ...cfg, enabled: false }
      writeCfg(cfg)
      stopAll()
      return sendJson(res, 200, { ok: true })
    }

    if (httpReq.method === 'GET' && p === '/asset') {
      const rel = String(url.searchParams.get('p') || '')
      if (!/^assets\/[\w.\-]+$/.test(rel)) return sendJson(res, 400, { ok: false, error: 'bad path' })
      const file = join(cfg.overlayDir, rel)
      try {
        const buf = readFileSync(file)
        const ext = (file.split('.').pop() || '').toLowerCase()
        const type = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/gif'
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' })
        res.end(buf)
      } catch { sendJson(res, 404, { ok: false, error: 'not found' }) }
      return
    }

    if (httpReq.method === 'POST' && p === '/icon') {
      const body = await readBody(httpReq)
      const name = String(body.name || '').replace(/[^\w.\-]/g, '')
      const data = String(body.data || '')
      if (!name || !data) return sendJson(res, 400, { ok: false, error: 'name/data required' })
      const assetsDir = join(cfg.overlayDir, 'assets')
      try {
        mkdirSync(assetsDir, { recursive: true })
        const buf = Buffer.from(data.replace(/^data:[^;]+;base64,/, ''), 'base64')
        writeFileSync(join(assetsDir, name), buf)
        const r = await pushOverlayConfig({ icon: 'assets/' + name })
        return sendJson(res, 200, { ok: true, icon: 'assets/' + name, applied: Boolean(r?.ok) })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) })
      }
    }

    if (httpReq.method === 'POST' && p === '/say') {
      const body = await readBody(httpReq)
      const r = await req(overlayUrl('/say'), {
        method: 'POST',
        body: JSON.stringify({ text: String(body.text || '') }),
        headers: { 'content-type': 'application/json' },
      })
      return sendJson(res, 200, r || { ok: false })
    }

    return sendJson(res, 404, { ok: false, error: `unknown ${httpReq.method} ${p}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/whale',
      handler: async (rq, rs) => {
        try { await handle(rq, rs) } catch (e) { sendJson(rs, 500, { ok: false, error: String(e?.message ?? e) }) }
      },
    }), 'whale: /api/whale 路由')
  } catch (e) { log('路由没挂上：', e?.message) }

  // 自动拉起（默认关，设置页里开）
  if (cfg.enabled || cfg.autoStart) {
    startAll().then((r) => log('自动启动结果', JSON.stringify(r)))
  }

  ctx.effect(() => () => { stopAll() }, 'whale: 收子进程')
  log('已挂载 家=', HOME, '浮层=', cfg.overlayDir)
}
