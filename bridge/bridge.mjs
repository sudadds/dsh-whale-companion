// 陪玩 agent 桥：spawn `dsh --profile sdk`，把「聊天」变成 HTTP 接口。
// 设计：一个进程 = 一个持久会话；每次 /chat 入队一句，收集 assistant 文本后返回。
import { spawn } from 'node:child_process'
import * as execMod from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
// 会话开在哪个目录（= DSH 里哪个工作区）。留空则用本目录。
// 人格文件会同步到该目录下的 AGENTS.md（agent 从 cwd 读人格）。
const WORKSPACE_FILE = path.join(HERE, 'workspace-dir.txt')
const WORKSPACE_DIR = process.env.WHALE_WORKSPACE_DIR
  || (fs.existsSync(WORKSPACE_FILE) ? fs.readFileSync(WORKSPACE_FILE, 'utf8').trim() : '')
const SESSION_CWD = WORKSPACE_DIR && fs.existsSync(WORKSPACE_DIR) ? WORKSPACE_DIR : HERE

function syncPersona() {
  if (SESSION_CWD === HERE) return
  const src = path.join(HERE, 'AGENTS.md')
  const dst = path.join(SESSION_CWD, 'AGENTS.md')
  try {
    if (!fs.existsSync(src)) return
    fs.copyFileSync(src, dst)
    log('persona synced ->', dst)
  } catch (e) { log('persona sync failed', String(e.message)) }
}
// 怎么找到 dsh：
//   1) 环境变量 WHALE_DSH_BIN（指向 @deepseek-ai/dsh/lib/bin.js，用 node 直接跑）
//   2) 否则走 PATH 里的 `dsh`（Windows 上是 dsh.cmd，需要 shell:true）
const DSH_BIN = process.env.WHALE_DSH_BIN || ''

/** 找 dsh 可执行文件：环境变量 > PATH(where dsh) > 裸 'dsh'。
 *  起因：插件/WMI 起的进程 PATH 可能不含 npm 的 shim，裸 'dsh' 会 exit 1。 */
function resolveDsh() {
  if (DSH_BIN) return { kind: 'node', bin: DSH_BIN }
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
  const localappdata = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')

  // 1) PATH 里的 dsh
  try {
    const { execSync } = execMod
    const out = execSync('where dsh', { encoding: 'utf8', windowsHide: true })
    const hit = out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).find((x) => /\.(cmd|exe|bat)$/i.test(x))
    if (hit) return { kind: 'shell', bin: hit }
  } catch {}

  // 2) npm 全局 shim
  const globalShim = path.join(appdata, 'npm', 'dsh.cmd')
  if (fs.existsSync(globalShim)) return { kind: 'shell', bin: globalShim }

  // 3) npx 缓存（本机 dsh 实际所在）
  const npxRoot = path.join(localappdata, 'npm-cache', '_npx')
  try {
    for (const dir of fs.readdirSync(npxRoot)) {
      const base = path.join(npxRoot, dir, 'node_modules')
      const cmdShim = path.join(base, '.bin', 'dsh.cmd')
      if (fs.existsSync(cmdShim)) return { kind: 'shell', bin: cmdShim }
      const binJs = path.join(base, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      if (fs.existsSync(binJs)) return { kind: 'node', bin: binJs }
    }
  } catch {}

  return { kind: 'shell', bin: 'dsh' }
}

const DSH = resolveDsh()
const SESSION_FILE = path.join(HERE, 'session-id.txt')
const PORT = Number(process.env.WHALE_BRIDGE_PORT || 8766)
const MODEL = process.env.WHALE_MODEL || 'deepseek-flash'
const PROVIDER = process.env.WHALE_PROVIDER || 'deepseek-account'

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`
  fs.appendFileSync(path.join(HERE, 'bridge.log'), line + '\n')
  console.log(line)
}

let sessionId = (fs.existsSync(SESSION_FILE) && fs.readFileSync(SESSION_FILE, 'utf8').trim()) || ('whale-' + Date.now())
// session/resume 会保留会话原本的工作目录：换了工作区就必须换会话，
// 否则新 cwd 不生效（表现是她还以为自己在旧目录）。
const META_FILE = path.join(HERE, 'session-meta.json')
try {
  const meta = fs.existsSync(META_FILE) ? JSON.parse(fs.readFileSync(META_FILE, 'utf8')) : null
  if (meta && meta.cwd && meta.cwd !== SESSION_CWD) {
    const prev = sessionId
    sessionId = 'whale-' + Date.now()
    fs.writeFileSync(SESSION_FILE + '.prev', prev)
    log('workspace changed, new session:', prev, '->', sessionId)
  }
} catch (e) { log('session-meta failed', String(e.message)) }
fs.writeFileSync(SESSION_FILE, sessionId)
fs.writeFileSync(META_FILE, JSON.stringify({ sessionId, cwd: SESSION_CWD }))
log('session', sessionId, '@', SESSION_CWD)

let child = null
let reloading = false
let seq = 0
const pending = new Map()
let buf = ''
let turnDone = null          // 当前等待中的 turn 结束 resolve
let ready = false

function spawnSdk() {
  log('dsh:', DSH.kind, DSH.bin)
  const c = DSH.kind === 'shell'
    ? spawn(DSH.bin, ['--profile', 'sdk'], { cwd: HERE, env: process.env, shell: true, windowsHide: true })
    : spawn(process.execPath, [DSH.bin, '--profile', 'sdk'], { cwd: HERE, env: process.env })
  child = c
  const rl = readline.createInterface({ input: c.stdout })
  // 只有在“不是主动重载”且仍是当前子进程时，异常退出才算致命
  c.on('exit', (code) => {
    log('sdk exited', code)
    if (reloading || child !== c) return
    // 异常退出不自杀：标记未就绪并自动重开（带退避）
    child = null
    ready = false
    setTimeout(() => {
      if (reloading || child) return
      log('sdk auto-restart')
      boot().catch((e) => log('auto-restart failed', String(e.message)))
    }, 3000)
  })
  c.stderr.on('data', (d) => log('sdk stderr', d.toString().slice(0, 300).replace(/\n/g, ' ')))
  rl.on('line', onLine)
}

function onLine(line) {
  let msg
  try { msg = JSON.parse(line) } catch { return }

  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id)
    pending.delete(msg.id)
    resolve(msg)
    return
  }
  if (msg.method === 'session.event') {
    const ev = msg.params?.event
    if (!ev) return
    if (ev.type === 'assistant/message') {
      const blocks = ev.data?.message?.content ?? []
      for (const b of blocks) if (b?.type === 'text' && b.text) buf += b.text
    }
    if (ev.type === 'turn/end' && turnDone) { const r = turnDone; turnDone = null; r() }
  }
}

function call(method, params, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timeout')) } }, timeoutMs)
  })
}

async function boot() {
  log('booting sdk…', { sessionId, model: MODEL })
  if (!child) spawnSdk()
  syncPersona()
  const init = await call('initialize', { cwd: SESSION_CWD, provider: PROVIDER, model: MODEL })
  log('session cwd =', SESSION_CWD)
  if (init.error) throw new Error('initialize: ' + JSON.stringify(init.error))
  ready = true
  log('initialized', JSON.stringify(init.result?.serverInfo ?? {}))
  // 持久会话要先 resume，否则 session/prompt 会报 "already exists"
  const resumed = await call('session/resume', { sessionId }, 60000).catch((e) => ({ error: { message: e.message } }))
  log('resume', resumed.error ? 'skipped: ' + JSON.stringify(resumed.error).slice(0, 120) : 'ok')
}

// ── ALTM 长期记忆（桥自己写，不依赖那个沉默的自动钩子）─────────────
const ALTM_ENDPOINT = process.env.ALTM_MCP_ENDPOINT || 'http://127.0.0.1:8000/mcp'
const ALTM_KEY = process.env.ALTM_MCP_API_KEY || ''
const ALTM_SCOPE = {
  tenant_id: process.env.ALTM_TENANT_ID || 'local',
  workspace_id: process.env.ALTM_WORKSPACE_ID || 'whale-companion',
  user_id: process.env.ALTM_USER_ID || 'local',
  agent_id: process.env.ALTM_AGENT_ID || 'whale-companion',
}
let altmReady = false
let altmSeq = 0

async function altmRpc(method, params) {
  if (!ALTM_KEY) throw new Error('ALTM_MCP_API_KEY missing')
  const res = await fetch(ALTM_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer ' + ALTM_KEY,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++altmSeq, method, params }),
    signal: AbortSignal.timeout(20000),
  })
  const text = await res.text()
  try { return JSON.parse(text) } catch { return null }
}

async function altmInit() {
  if (altmReady) return
  await altmRpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'whale-bridge', version: '1' } })
  await altmRpc('notifications/initialized', {})
  altmReady = true
}

/** 把这一问一答写进她的长期记忆（失败只记日志，不影响聊天）。 */
async function rememberTurn(sessionId, turnId, userText, assistantText) {
  try {
    await altmInit()
    const prep = await altmRpc('tools/call', {
      name: 'memory_prepare_turn',
      arguments: { ...ALTM_SCOPE, session_id: String(sessionId), turn_id: String(turnId), content: String(userText) },
    })
    const payload = prep?.result?.content?.[0]?.text
    const cycleId = payload ? JSON.parse(payload).cycle_id : undefined
    if (!cycleId) throw new Error('no cycle_id')
    await altmRpc('tools/call', {
      name: 'memory_commit_turn',
      arguments: { ...ALTM_SCOPE, cycle_id: cycleId, assistant_content: String(assistantText) },
    })
    log('memory+', String(userText).slice(0, 30))
  } catch (e) {
    log('memory-write-failed', String(e.message).slice(0, 120))
  }
}

/** 一句一问：返回她的完整回复文本。 */
async function chatBlocks(blocks, sid) {
  if (!ready) throw new Error('bridge not ready')
  buf = ''
  const done = new Promise((r) => { turnDone = r })
  const res = await call('session/prompt', { sessionId: sid || sessionId, contentBlocks: blocks })
  if (res.error) throw new Error(JSON.stringify(res.error))
  await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('turn timeout')), 150000))])
  const reply = buf.trim()
  const userText = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  if (reply && userText) rememberTurn(sid || sessionId, Date.now(), userText, reply)
  return reply
}

async function chat(text) { return chatBlocks([{ type: 'text', text }]) }

const OBSERVE_HINT =
  '这是玩家此刻的屏幕。用一句话在旁边点评，不超过 30 字，像朋友随口说一句。' +
  '看到具体画面就说具体的；看不出名堂就轻轻搪塞一句，别编造细节。' +
  '不要提“截图”“画面”“游戏名”这类词，也不要复述你看到的每个细节。'

let recent = []   // 最近几条点评，防止重复同一句
// 看图专用会话：定期换新，避免历史里堆满图片把每轮输入撑爆
const OBSERVE_SESSION_FILE = path.join(HERE, 'observe-session-id.txt')
// ⚠️ 看图会话**不跨进程复用**：持久化的 id 会让新进程收到 "session already exists"
//    （SDK 要求先 resume，而 resume 对不存在的会话会 reject，两头都不舒服）
//    看图是短上下文，重启即丢弃完全可接受。
let observeSessionId = 'see-' + Date.now()
let observeTurns = 0
const OBSERVE_MAX_TURNS = Number(process.env.WHALE_OBSERVE_TURNS || 8)

function buildHint(windowTitle, hint) {
  const parts = []
  if (windowTitle) parts.push(`当前窗口标题：${windowTitle}`)
  if (hint) parts.push(hint)

  // ⚠️ 用户反馈：每句开头都报游戏名，很啰嗦。
  //    只在"第一次"或"换了游戏"时才允许点名，其余时候直接说事。
  if (recent.length === 0) {
    parts.push('这是你第一次看他的屏幕：如果认得出是什么游戏，可以顺口点一次名字。')
  } else {
    parts.push('注意：已经聊过几轮了。除非画面明显换成了另一款游戏，否则**不要再报游戏名**，直接说这一下发生了什么。')
    parts.push(`你最近说过：${recent.slice(-3).join(' / ')}（不要重复，也别再用同样的开场）`)
  }
  return parts.join('\n')
}

async function observe(imageB64, mimeType, hint, windowTitle) {
  const text = buildHint(windowTitle, hint || OBSERVE_HINT)
  // 到点就换新会话：上下文清零，token 不再滚雪球
  if (observeTurns >= OBSERVE_MAX_TURNS) {
    observeSessionId = 'see-' + Date.now()
    fs.writeFileSync(OBSERVE_SESSION_FILE, observeSessionId)
    observeTurns = 0
    recent = []
    log('observe session rotated ->', observeSessionId)
  }
  observeTurns += 1
  const blocks = [
    { type: 'image', data: imageB64, mimeType: mimeType || 'image/jpeg' },
    { type: 'text', text },
  ]
  let reply
  try {
    reply = await chatBlocks(blocks, observeSessionId)
  } catch (e) {
    if (/already exists/.test(String(e.message))) {
      observeSessionId = 'see-' + Date.now()
      fs.writeFileSync(OBSERVE_SESSION_FILE, observeSessionId)
      log('observe session collided, rotated ->', observeSessionId)
      reply = await chatBlocks(blocks, observeSessionId)
    } else throw e
  }
  if (reply) { recent.push(reply.slice(0, 40)); if (recent.length > 8) recent = recent.slice(-8) }
  return reply
}

/** 人格或配置改了：杀掉子进程、换新 sessionId 重开，确保新人格生效。 */
async function reload(reason) {
  log('reload:', reason || '')
  reloading = true
  ready = false
  buf = ''
  turnDone = null
  pending.clear()
  const old = child
  child = null
  if (old) { try { old.kill() } catch {} }
  await new Promise((r) => setTimeout(r, 600))
  const newId = 'whale-' + Date.now()
  fs.writeFileSync(SESSION_FILE, newId)
  sessionId = newId
  await boot()
  reloading = false
  return sessionId
}

const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  if (req.method === 'GET' && req.url === '/health') {
    return send(200, { ok: true, ready, sessionId, observeSessionId, observeTurns, model: MODEL })
  }
  if (req.method === 'POST' && req.url === '/reload') {
    return reload(String(req.headers['x-reason'] || 'manual'))
      .then((id) => send(200, { ok: true, sessionId: id }))
      .catch((e) => send(500, { ok: false, error: String(e.message) }))
  }
  if (req.method !== 'POST' || !['/chat', '/observe'].includes(req.url)) {
    return send(404, { ok: false, error: 'not found' })
  }

  let body = ''
  req.on('data', (c) => { body += c; if (body.length > 12 * 1024 * 1024) req.destroy() })
  req.on('end', async () => {
    let data
    try { data = JSON.parse(body || '{}') } catch { return send(400, { ok: false, error: 'bad json' }) }
    const text = String(data.text ?? '').trim()
    const image = String(data.image ?? '').trim()

    if (req.url === '/observe') {
      if (!image) return send(400, { ok: false, error: 'image (base64) required' })
      log('observe in:', Math.round(image.length / 1024) + 'KB')
      try {
        const reply = await observe(image, data.mimeType, data.hint, data.windowTitle)
        log('observe out:', reply.slice(0, 60))
        return send(200, { ok: true, reply })
      } catch (e) {
        log('observe error', String(e.message))
        return send(500, { ok: false, error: String(e.message) })
      }
    }

    if (!text) return send(400, { ok: false, error: 'text required' })
    log('chat in:', text.slice(0, 60))
    try {
      const reply = await chat(text)
      log('chat out:', reply.slice(0, 60))
      send(200, { ok: true, reply })
    } catch (e) {
      log('chat error', String(e.message))
      send(500, { ok: false, error: String(e.message) })
    }
  })
})

boot()
  .then(() => server.listen(PORT, '127.0.0.1', () => log('listening', PORT)))
  .catch((e) => { log('boot failed', String(e.message)); process.exit(1) })
