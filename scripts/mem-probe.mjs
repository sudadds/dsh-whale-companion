// 记忆探针：**只写 whale-test 池**，绝不碰真实记忆（whale-companion）。
//   node scripts/mem-probe.mjs write "测试一句话"
//   node scripts/mem-probe.mjs list
//   node scripts/mem-probe.mjs clean          # 物理删除 whale-test 池里的记录
const KEY = process.env.ALTM_MCP_API_KEY
const URL = process.env.ALTM_MCP_ENDPOINT || 'http://127.0.0.1:8000/mcp'
const scope = { tenant_id: 'local', workspace_id: 'whale-test', user_id: 'local', agent_id: 'whale-test' }
if (!KEY) { console.error('需要 ALTM_MCP_API_KEY'); process.exit(1) }
let id = 0
const rpc = async (method, params) => {
  const r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + KEY }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
  return JSON.parse(await r.text())
}
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args })
  const t = r.result?.content?.[0]?.text || ''
  try { return JSON.parse(t) } catch { return { raw: t } }
}
await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mem-probe', version: '1' } })
await rpc('notifications/initialized', {})

const [cmd, text] = process.argv.slice(2)
if (cmd === 'write') {
  const prep = await call('memory_prepare_turn', { ...scope, session_id: 'probe-' + Date.now(), turn_id: '1', content: text || '探针写入' })
  console.log('写入:', JSON.stringify(prep).slice(0, 160))
} else if (cmd === 'list') {
  const r = await call('memory_ui_layers', scope)
  console.log(JSON.stringify(r).slice(0, 800))
} else if (cmd === 'clean') {
  console.log('清理由 memory_delete 逐条删除，或直接删库中的 whale-test 行；此处只提示。')
  console.log('SQL: delete from memory_units where workspace_id=\'whale-test\';')
} else {
  console.log('用法: node scripts/mem-probe.mjs write|list|clean')
}
