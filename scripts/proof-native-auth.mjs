// Actual native SDK authentication proof using owned synthetic accounts and HTTP.
// Never uses an installed account, original session, browser or provider service.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'
import { bootstrap, qualify } from '../native/launch.mjs'
import { prepareAccountLaunch } from '../native/startup.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const fixture = mkdtempSync(join(tmpdir(), 'rice-native-auth-'))
const plugin = join(fixture, 'plugin'), config = join(fixture, '.claude')
const release = join(fixture, 'release-agent'), observation = join(fixture, 'observations.json')
const releaseLate = join(fixture, 'release-late-agent')
const tokenA = 'fixture-native-oauth-account-a', tokenB = 'fixture-native-oauth-account-b'
const launchKey = 'fixture-native-launch-key'
const requests = []
// Real Windows Bash/native continuation took 23.4s after the first response.
// Keep its native tool budget inside the stage, HTTP hold and child deadlines.
const stageWaitMs = process.platform === 'win32' ? 45000 : 20000
const holdWaitMs = process.platform === 'win32' ? 90000 : 25000
const childWaitMs = process.platform === 'win32' ? 120000 : 45000
let child
const startedMs = Date.now()
const startedAt = new Date().toISOString()
let timedOut = false
function stopChild() {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10000 })
  else try { process.kill(-child.pid, 'SIGTERM') } catch {}
}
const pause = `const fs=require('node:fs');(async()=>{const end=Date.now()+20000;while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>end)throw Error('owned pause timed out');await new Promise(r=>setTimeout(r,25))}process.stdout.write('owned pause released')})().catch(()=>{process.exitCode=1})`
new Script(pause)
// $.clock.sleep counts against a hook's 10s own-time budget. A bounded native
// process wait pauses that budget, so Windows Bash startup cannot skip the hook.
const waitForFile = `const fs=require('node:fs');const [path,limit]=process.argv.slice(1);(async()=>{const end=Date.now()+Number(limit);while(!fs.existsSync(path)){if(Date.now()>end){process.exitCode=3;return}await new Promise(r=>setTimeout(r,25))}})().catch(()=>{process.exitCode=4})`
new Script(waitForFile)
const quote = value => `'${value.replace(/'/g, `'\\''`)}'`

function respond(response, model, tool, accountA = tool) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache',
    'anthropic-ratelimit-unified-5h-utilization': accountA ? '0.18' : '0.01',
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
    'anthropic-ratelimit-unified-7d-utilization': accountA ? '0.95' : '0.02',
    'anthropic-ratelimit-unified-7d-reset': String(Math.floor(Date.now() / 1000) + 86400),
  })
  const send = (event, value) => response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)
  send('message_start', { type: 'message_start', message: { id: `msg-${requests.length}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } })
  if (tool) {
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'owned-pause-tool', name: 'Bash', input: {} } })
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: `node -e ${quote(pause)}`, timeout: 25000, description: 'Owned account-switch barrier' }) } })
  } else {
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Owned native auth fixture complete.' } })
  }
  send('content_block_stop', { type: 'content_block_stop', index: 0 })
  send('message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } })
  send('message_stop', { type: 'message_stop' })
  response.end()
}

const server = createServer(async (request, response) => {
  if (!request.url?.startsWith('/v1/messages') || request.method !== 'POST') { response.writeHead(404); response.end(); return }
  let raw = ''
  for await (const part of request) raw += part
  const body = JSON.parse(raw)
  const messages = JSON.stringify(body.messages)
  const role = messages.includes('OWNED_LATE_AGENT') ? 'late' : messages.includes('OWNED_EXISTING_AGENT') ? 'agent' : 'main'
  const bearer = request.headers.authorization
  const account = bearer === `Bearer ${tokenA}` ? 'a' : bearer === `Bearer ${tokenB}` ? 'b' : request.headers['x-api-key'] === launchKey ? 'launch' : 'unexpected'
  const index = requests.filter(row => row.role === role).length
  const recorded = { role, index, account, elapsedMs: Date.now() - startedMs, ...(role==='agent'&&index>0?{pauseReleased:JSON.stringify(body.messages).includes('owned pause released')}: {}) }
  requests.push(recorded)
  writeFileSync(join(fixture, `${role}-${index}`), 'observed')
  if (role === 'late') {
    const deadline = Date.now() + holdWaitMs
    while (!existsSync(releaseLate)) {
      if (Date.now() > deadline) { recorded.holdTimedOut = true; response.writeHead(504); response.end(); return }
      await delay(25)
    }
  }
  respond(response, body.model, role === 'agent' && index === 0, role === 'late' || (role === 'agent' && index === 0))
})

try {
  for (const directory of ['.claude-plugin', 'hooks', 'types', 'native', 'scripts']) cpSync(join(root, directory), join(plugin, directory), { recursive: true })
  mkdirSync(join(config, 'rice-session-accounts'), { recursive: true })
  mkdirSync(join(fixture, 'tmp'))
  writeFileSync(join(fixture, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { emailAddress: 'launch@example.test', accountUuid: 'fixture-launch-account', organizationUuid: 'fixture-org' } }))
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ model: 'haiku' }))
  const locations = { 'account-a': join(fixture, 'account-a'), 'account-b': join(fixture, 'account-b') }
  for (const [name, folder] of Object.entries(locations)) {
    mkdirSync(folder)
    writeFileSync(join(folder, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: name === 'account-a' ? tokenA : tokenB, refreshToken: 'fixture-refresh', expiresAt: Date.now()+3600000, scopes: ['user:inference','user:profile'], subscriptionType: 'pro' } }))
  }
  writeFileSync(join(config, 'rice-session-accounts/accounts.json'), JSON.stringify({ default: 'login', accounts: { login: { kind: 'login' }, ...Object.fromEntries(Object.entries(locations).map(([name, loginDir]) => [name, { kind: 'claudeai', loginDir }])) } }))
  const credentials = Object.fromEntries(Object.entries(locations).flatMap(([name, folder]) => {
    const token = name === 'account-a' ? tokenA : tokenB
    const service = `Claude Code-credentials-${createHash('sha256').update(folder.normalize('NFC')).digest('hex').slice(0, 8)}`
    return [[service, token], [`${folder}/.credentials.json`, token]]
  }))
  const register = join(plugin, 'hooks/register.ts')
  const production = readFileSync(register, 'utf8')
  const helpers = `
const proofDirectory = ${JSON.stringify(fixture)}
const proofCredentials: Record<string,string> = ${JSON.stringify(credentials)}
const proofStartedAt = Date.now()
const proofProgress: Array<{ phase: string, elapsedMs: number }> = []
let proofPhase = 'plugin-loaded'
const proofMark = async ($: EngineInterface, phase: string) => {
  proofPhase = phase
  proofProgress.push({ phase, elapsedMs: Date.now() - proofStartedAt })
  await $.fs.write(proofDirectory + '/progress.json', JSON.stringify(proofProgress))
}
const proofRecordFailure = async ($: EngineInterface, error: unknown) => {
  const reason = error instanceof Error && error.message.startsWith('owned native barrier timed out:') ? 'owned-native-barrier-timeout' : 'native-operation-failed'
  try { await $.fs.write(proofDirectory + '/failure.json', JSON.stringify({ phase: proofPhase, elapsedMs: Date.now() - proofStartedAt, reason })) } catch {}
}
const proofWait = async ($: EngineInterface, name: string) => {
  const result = await $.process.run(['node', '-e', ${JSON.stringify(waitForFile)}, proofDirectory + '/' + name, ${JSON.stringify(String(stageWaitMs))}], { timeoutMs: ${stageWaitMs + 5000} })
  if (result.exitCode === 3) throw new Error('owned native barrier timed out: ' + name)
  if (result.exitCode !== 0) throw new Error('owned native barrier process failed')
}
`
  const hooks = `
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) await $.fs.write(proofDirectory + '/completed-' + e.agentId, e.reason)
    else if (await $.fs.exists(proofDirectory + '/observations.json')) {
      try {
        await proofMark($, 'restoring-launch-account')
        const saved = JSON.parse(await $.fs.read(proofDirectory + '/observations.json'))
        await runCommand($, 'login')
        saved.loginRestoresLaunch = (await $.env.get('ANTHROPIC_API_KEY')) === ${JSON.stringify(launchKey)} && (await $.env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR')) === ${JSON.stringify(config)}
        await $.fs.write(proofDirectory + '/observations.json', JSON.stringify(saved))
        await proofMark($, 'launch-account-restored')
      } catch (error) { await proofRecordFailure($, error); throw error }
    }
    return next(e)
  })
  on('process.run', { argv: [/^(?:node|\\/usr\\/bin\\/security)$/] }, async ($, e, next) => {
    let reference: string | undefined
    if (e.argv[0] === '/usr/bin/security' && e.argv[1] === 'find-generic-password') reference = e.argv[e.argv.indexOf('-s') + 1]
    if (e.argv[0] === 'node' && e.argv[3] === 'read' && e.argv[4]?.endsWith('/.credentials.json')) reference = e.argv[4]
    if (reference === undefined) return next(e)
    const token = proofCredentials[reference]
    if (token === undefined) throw new Error('unknown owned credential fixture')
    return { value: { exitCode: 0, stdout: JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'fixture-refresh', expiresAt: Date.now()+3600000, subscriptionType: 'pro' } }), stderr:'', isStdoutTruncated:false,isStderrTruncated:false } }
  })
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    try {
    await proofMark($, 'checking-startup-account')
    const startup = { account: mirror.active?.name, nativeStorageSelected: (await $.env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR')) === ${JSON.stringify(locations['account-a'])}, initialMetadataConsumed: (await $.env.get('RICE_SESSION_ACCOUNTS_INITIAL_ORIGINALS')) === undefined }
    await runCommand($, 'account-a')
    await proofMark($, 'spawning-existing-agent')
    const agent = await $.agent.spawn({ prompt: 'OWNED_EXISTING_AGENT: follow the owned pause tool then answer briefly.', description:'Owned native auth fixture',subagentType:'general-purpose',model:'haiku' })
    if (agent.deny || !agent.agentId) throw new Error('owned native agent not spawned')
    await proofMark($, 'waiting-existing-agent-http')
    await proofWait($, 'agent-0')
    await proofMark($, 'spawning-late-agent')
    const lateAgent = await $.agent.spawn({ prompt: 'OWNED_LATE_AGENT: answer briefly.', description:'Owned delayed account A response',subagentType:'general-purpose',model:'haiku' })
    if (lateAgent.deny || !lateAgent.agentId) throw new Error('owned delayed native agent not spawned')
    await proofMark($, 'waiting-late-agent-http')
    await proofWait($, 'late-0')
    const usageA = await $.session.usage()
    await proofMark($, 'switching-account-b')
    const switched = await runCommand($, 'account-b')
    const usageAfterSwitch = await $.session.usage()
    await $.fs.write(proofDirectory + '/release-agent', 'release')
    await proofMark($, 'waiting-existing-agent-complete')
    await proofWait($, 'completed-' + agent.agentId)
    const usageAfterAgentB = await $.session.usage()
    await $.fs.write(proofDirectory + '/release-late-agent', 'release')
    await proofMark($, 'waiting-late-agent-complete')
    await proofWait($, 'completed-' + lateAgent.agentId)
    await $.fs.write(proofDirectory + '/observations.json', JSON.stringify({ startup, switched, usageA, usageAfterSwitch, usageAfterAgentB, usageAfterLateA:await $.session.usage(), agentId:agent.agentId, lateAgentId:lateAgent.agentId }))
    await proofMark($, 'main-native-inference')
    return yield* next(e)
    } catch (error) { await proofRecordFailure($, error); throw error }
  })
`
  const decorated = production.replace('export const register: Register = on => {', helpers + '\nexport const register: Register = on => {')
  const closing = decorated.lastIndexOf('\n}')
  writeFileSync(register, decorated.slice(0, closing) + hooks + decorated.slice(closing))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'SystemRoot', 'SystemDrive', 'ComSpec', 'PATHEXT', 'ProgramFiles', 'ProgramFiles(x86)'].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]))
  Object.assign(env, { HOME: fixture, USER: 'fixture', USERPROFILE: fixture, TMPDIR: join(fixture, 'tmp'), CLAUDE_CONFIG_DIR: config, CLAUDE_SECURESTORAGE_CONFIG_DIR: config, ANTHROPIC_API_KEY: launchKey, ANTHROPIC_BASE_URL: baseUrl, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' })
  if (process.platform === 'win32') Object.assign(env, { OS: 'Windows_NT', USERNAME: 'fixture', TEMP: join(fixture, 'tmp'), TMP: join(fixture, 'tmp') })
  const native = process.env.RICE_ACCOUNTS_PROOF_CLAUDE || 'claude'
  const args = ['--account', 'account-a', '-p','--plugin-dir',plugin,'--setting-sources','user','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--tools','Agent,Bash','--permission-mode','bypassPermissions','--no-session-persistence','--output-format','json','Owned main native authentication fixture']
  const modelsLauncher = process.env.RICE_ACCOUNTS_PROOF_MODELS_LAUNCHER
  if (modelsLauncher) {
    mkdirSync(join(config, 'plugins'))
    writeFileSync(join(config, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'rice-session-accounts@rice-mods': [{ scope: 'user', installPath: plugin }] } }))
    child = spawn(process.execPath, [modelsLauncher, ...args], { cwd:fixture,env:{...env,RICE_CLAUDE_EXECUTABLE:native},stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32',windowsHide:true })
  } else {
    const prepared = prepareAccountLaunch(args, env, config)
    const preload = bootstrap(), selection = qualify(native, prepared.env, preload)
    Object.assign(prepared.env, { BUN_OPTIONS: '--preload ' + preload, RICE_SESSION_ACCOUNTS_NATIVE_VERSION: selection.claudeVersion, RICE_SESSION_ACCOUNTS_NATIVE_EXECUTABLE: selection.executable })
    child = spawn(native, prepared.args, {cwd:fixture,env:prepared.env,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32',windowsHide:true})
  }
  console.error(JSON.stringify({phase:'owned-native-started',pid:child.pid,startedAt,native}))
  let output='',errors=''
  child.stdout.on('data',bytes=>{output+=bytes})
  child.stderr.on('data',bytes=>{errors+=bytes})
  const timer=setTimeout(()=>{timedOut=true;stopChild()},childWaitMs)
  const [code]=await once(child,'close')
  clearTimeout(timer)
  const observations=existsSync(observation)?JSON.parse(readFileSync(observation,'utf8')):null
  const progress=existsSync(join(fixture,'progress.json'))?JSON.parse(readFileSync(join(fixture,'progress.json'),'utf8')):[]
  const hookFailure=existsSync(join(fixture,'failure.json'))?JSON.parse(readFileSync(join(fixture,'failure.json'),'utf8')):undefined
  const result={scope:'actual native SDK headers with synthetic owned accounts and local HTTP',modelsComposition:Boolean(modelsLauncher),sourceSha256:createHash('sha256').update(production).digest('hex'),nativeExitCode:code,elapsedMs:Date.now()-startedMs,timedOut,requests,observations,progress,hookFailure,fixtureError:code!==0?{output:output.slice(-2500),stderr:errors.slice(-1000)}:undefined}
  console.log(JSON.stringify(result))
  assert.equal(hookFailure,undefined,'owned native fixture hook must complete')
  assert.equal(code,0,'owned native fixture must finish')
  assert.deepEqual(observations.startup, { account: 'account-a', nativeStorageSelected: true, initialMetadataConsumed: true }, 'launcher selection must be active before the first turn')
  assert.equal(observations.loginRestoresLaunch, true, 'login must restore the preselection launch authentication')
  assert.equal(requests.find(row=>row.role==='agent'&&row.index===0)?.account,'a','initial native agent request must use account A')
  assert.equal(requests.find(row=>row.role==='agent'&&row.index===1)?.account,'b','existing native agent NEXT request must use account B')
  assert.equal(requests.find(row=>row.role==='agent'&&row.index===1)?.pauseReleased,true,'existing agent must complete its real pause tool after account B is selected')
  assert.equal(requests.find(row=>row.role==='main')?.account,'b','main native SDK request after switch must use account B')
  assert.equal(requests.find(row=>row.role==='late')?.account,'a','delayed native agent request must originate under account A')
  assert.equal(observations.usageAfterLateA.rateLimits.some(row=>row.percentUsed===18||row.percentUsed===95),false,'delayed account A response must not repopulate account B usage')
  assert.equal(observations.usageAfterSwitch.rateLimits.some(row=>row.percentUsed===18||row.percentUsed===95),false,'native usage immediately after switch must not report account A limits')
} finally {
  if(child&&child.exitCode===null){stopChild();await once(child,'close').catch(()=>{})}
  server.closeAllConnections()
  await new Promise(resolve=>server.close(resolve))
  rmSync(fixture,{recursive:true,force:true})
}
