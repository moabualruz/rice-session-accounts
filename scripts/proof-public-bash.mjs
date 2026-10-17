// Ordinary Claude with the production Accounts hooks, a synthetic machine login,
// a synthetic selected account and a local capture server. It proves two things
// with the real binary: an allowed Bash command still runs exactly as written
// with an account selected (no rewrite reaches the permission check), and a
// child `claude -p` started from Bash sends the selected account's bearer.
// No real account, network provider, launcher or owner configuration is used.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform === 'win32') {
  console.log(JSON.stringify({ scope: 'public Bash permission and child bearer proof', skipped: true, reason: 'The Bash permission proof drives POSIX printf and a /bin/sh claude wrapper; native Windows is covered by the unit cohorts and proof-public-auth.' }))
  process.exit(0)
}

const root = fileURLToPath(new URL('../', import.meta.url))
const allowedVersions = ['2.1.301', '2.1.302']
const requested = process.env.RICE_ACCOUNTS_PROOF_CLAUDE || 'claude'
const fixture = mkdtempSync(join(tmpdir(), 'rice-public-bash-'))
const plugin = join(fixture, 'plugin'), config = join(fixture, '.claude'), bin = join(fixture, 'bin'), accountB = join(fixture, 'account-b')
const tokenMachine = 'owned-bash-machine-token', tokenB = 'owned-bash-selected-b'
const marker = 'RICE_BASH_OK', childAnswer = 'OWNED_PUBLIC_BASH_CHILD_OK'
const childPrompt = 'OWNED_CHILD_BASH: answer briefly.'
const childCommand = `claude -p --setting-sources user --strict-mcp-config --no-session-persistence '${childPrompt}'`
const limitMs = 120000
const requests = [], results = []
let child, timedOut = false

function resolveExecutable(name) {
  if (isAbsolute(name)) return name
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, name)
    try { if (statSync(candidate).isFile()) return candidate } catch {}
  }
  throw new Error(`Cannot find the native Claude executable ${JSON.stringify(name)} on PATH. Set RICE_ACCOUNTS_PROOF_CLAUDE.`)
}

function stop(running) {
  if (!running || running.exitCode !== null) return
  try { process.kill(-running.pid, 'SIGTERM') } catch {}
}

function text(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => typeof block?.text === 'string' ? block.text : typeof block?.content === 'string' ? block.content : Array.isArray(block?.content) ? text(block.content) : '').join('\n')
}

function toolResults(messages) {
  return messages.flatMap(message => Array.isArray(message?.content) ? message.content.filter(block => block?.type === 'tool_result').map(block => ({ text: text(block.content), isError: block.is_error === true })) : [])
}

function respond(response, model, reply) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (event, value) => response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)
  send('message_start', { type: 'message_start', message: { id: `owned-bash-${requests.length}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } })
  if (reply.command) {
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `owned-bash-tool-${requests.length}`, name: 'Bash', input: {} } })
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: reply.command, description: 'Owned fixture command' }) } })
  } else {
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply.text } })
  }
  send('content_block_stop', { type: 'content_block_stop', index: 0 })
  send('message_delta', { type: 'message_delta', delta: { stop_reason: reply.command ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
  send('message_stop', { type: 'message_stop' })
  response.end()
}

const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || !request.url?.startsWith('/v1/messages')) { response.writeHead(404); response.end(); return }
  let body = ''
  for await (const bytes of request) body += bytes
  if (request.url.startsWith('/v1/messages/count_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":10}'); return }
  const parsed = JSON.parse(body), messages = Array.isArray(parsed.messages) ? parsed.messages : []
  // The main conversation names OWNED_MAIN_BASH (and later the child's prompt
  // inside its own tool call); the child's conversation names only its prompt.
  const conversation = JSON.stringify(messages)
  const role = conversation.includes('OWNED_MAIN_BASH') ? 'main' : conversation.includes('OWNED_CHILD_BASH') ? 'child' : 'other'
  const bearer = request.headers.authorization
  const account = bearer === `Bearer ${tokenB}` ? 'b' : bearer === `Bearer ${tokenMachine}` ? 'machine' : bearer === undefined ? 'none' : 'unexpected'
  const outputs = toolResults(messages)
  const step = outputs.length
  requests.push({ role, step, account, apiKey: request.headers['x-api-key'] !== undefined, toolResults: outputs })
  if (role === 'main' && step === 0) respond(response, parsed.model, { command: `printf ${marker}` })
  else if (role === 'main' && step === 1) respond(response, parsed.model, { command: childCommand })
  else if (role === 'child') respond(response, parsed.model, { text: childAnswer })
  else respond(response, parsed.model, { text: 'OWNED_PUBLIC_BASH_DONE' })
})

try {
  const native = resolveExecutable(requested)
  for (const directory of ['.claude-plugin', 'hooks', 'types', 'scripts']) cpSync(join(root, directory), join(plugin, directory), { recursive: true })
  mkdirSync(join(config, 'rice-session-accounts'), { recursive: true }); mkdirSync(accountB, { recursive: true }); mkdirSync(bin); mkdirSync(join(fixture, 'tmp'))
  const metadata = { hasCompletedOnboarding: true, oauthAccount: { emailAddress: 'machine@example.test', accountUuid: 'owned-machine', organizationUuid: 'owned-org' } }
  writeFileSync(join(fixture, '.claude.json'), JSON.stringify(metadata))
  writeFileSync(join(config, '.claude.json'), JSON.stringify(metadata))
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ model: 'haiku' }))
  writeFileSync(join(accountB, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'account-b@example.test' } }))
  const credential = token => ({ claudeAiOauth: { accessToken: token, refreshToken: `${token}-refresh`, expiresAt: Date.now() + 3600000, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' } })
  const references = {}
  for (const [folder, token] of [[config, tokenMachine], [accountB, tokenB]]) {
    const value = credential(token)
    references[folder + '/.credentials.json'] = value
    references['Claude Code-credentials-' + createHash('sha256').update(folder.normalize('NFC')).digest('hex').slice(0, 8)] = value
    writeFileSync(join(folder, '.credentials.json'), JSON.stringify(value), { mode: 0o600 })
  }
  writeFileSync(join(config, 'rice-session-accounts/accounts.json'), JSON.stringify({ default: 'login', accounts: { login: { kind: 'login' }, 'account-b': { kind: 'claudeai', loginDir: accountB } } }))
  // A `claude` command word on PATH, as a person's shell has one.
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\nunset CLAUDECODE\nexec ${JSON.stringify(native)} "$@"\n`)
  chmodSync(join(bin, 'claude'), 0o755)

  // Production hooks, with only the synthetic credential store and usage
  // endpoint answered in place: the Bash path itself is not touched.
  const register = join(plugin, 'hooks/register.ts'), production = readFileSync(register, 'utf8')
  const helpers = `\nconst proofCredentials:Record<string,unknown>=${JSON.stringify(references)}\n`
  const hooks = `
  on('http.fetch',{url:USAGE_URL},async()=>({value:{ok:true,status:200,headers:{},text:JSON.stringify({five_hour:{utilization:1},seven_day:{utilization:2}})}}))
  on('process.run',{argv:[/^(?:node|\\/usr\\/bin\\/security)$/]},async($,e,next)=>{
    let ref:string|undefined
    if(e.argv[0]==='/usr/bin/security'&&e.argv[1]==='find-generic-password')ref=e.argv[e.argv.indexOf('-s')+1]
    if(e.argv[0]==='node'&&e.argv[3]==='read'&&e.argv[4]?.endsWith('/.credentials.json'))ref=e.argv[4]
    if(ref===undefined)return next(e)
    if(!Object.hasOwn(proofCredentials,ref))throw Error('unowned credential reference')
    return {value:{exitCode:0,stdout:JSON.stringify(proofCredentials[ref]),stderr:'',isStdoutTruncated:false,isStderrTruncated:false}}
  })
`
  const decorated = production.replace('export const register: Register = on => {', helpers + '\nexport const register: Register = on => {')
  assert.notEqual(decorated, production, 'production registration seam must be found')
  const closing = decorated.lastIndexOf('\n}')
  writeFileSync(register, decorated.slice(0, closing) + hooks + decorated.slice(closing))

  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const env = Object.fromEntries(['LANG', 'LC_ALL'].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]))
  Object.assign(env, {
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, SHELL: existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh',
    HOME: fixture, USER: 'fixture', TMPDIR: join(fixture, 'tmp'), CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_OAUTH_TOKEN: tokenMachine, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
  })
  const version = spawnSync(native, ['--version'], { cwd: fixture, env, encoding: 'utf8', timeout: 10000 })
  assert.equal(version.status, 0, 'ordinary Claude prerequisite must run')
  const nativeVersion = /^(\S+) \(Claude Code\)$/.exec(version.stdout.trim())?.[1]
  assert.ok(allowedVersions.includes(nativeVersion), `public Bash proof requires a qualified native cohort (${allowedVersions.join(', ')}); found ${JSON.stringify(version.stdout.trim())}.`)
  const validated = spawnSync(native, ['plugin', 'validate', plugin], { cwd: fixture, env, encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 })
  assert.equal(validated.status, 0, validated.stdout || 'owned production fixture validation failed')

  // Default permission mode: only the allow rules below let Bash run.
  child = spawn(native, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--plugin-dir', plugin, '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', 'Bash', '--allowedTools', 'Bash(printf:*)', 'Bash(claude:*)', '--no-session-persistence'], { cwd: fixture, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
  console.error(JSON.stringify({ phase: 'owned-native-started', pid: child.pid, platform: process.platform, nativeVersion }))
  const send = line => child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: line } }) + '\n')
  let pending = '', stderr = ''
  child.stderr.on('data', bytes => { stderr += bytes })
  child.stdout.on('data', bytes => {
    pending += bytes
    let newline
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (event.type !== 'result') continue
      results.push({ subtype: event.subtype, isError: event.is_error, text: event.result })
      if (results.length === 1) send('OWNED_MAIN_BASH: run the owned fixture commands.')
      else child.stdin.end()
    }
  })
  send('/rice-account account-b')
  const timer = setTimeout(() => { timedOut = true; stop(child) }, limitMs)
  const [exitCode] = await once(child, 'close'); clearTimeout(timer)

  const main = requests.filter(row => row.role === 'main'), children = requests.filter(row => row.role === 'child')
  const printed = main.find(row => row.step === 1)?.toolResults[0]
  const spawned = main.find(row => row.step === 2)?.toolResults[1]
  const receipt = { scope: 'production hooks in ordinary Claude; synthetic logins; local capture server', platform: process.platform, nativeVersion, exitCode, timedOut, requests: requests.map(({ toolResults: _, ...row }) => row), printed, spawned, results, stderrChars: stderr.length }
  console.log(JSON.stringify(receipt))
  assert.equal(timedOut, false, 'the owned session must finish')
  assert.equal(exitCode, 0)
  assert.match(results[0]?.text ?? '', /now uses account-b/, 'the session must select the synthetic account through /rice-account')
  assert.equal(main.find(row => row.step === 0)?.account, 'b', 'the main request after the selection must carry the selected bearer')
  assert.equal(printed?.isError, false, `Bash(printf:*) must still allow the exact command in default permission mode with an account selected: ${printed?.text ?? 'no result'}`)
  assert.equal(printed?.text.trim(), marker, 'the allowed command must run exactly as written')
  assert.equal(children.length > 0, true, 'the Bash child claude -p must reach the capture server')
  assert.deepEqual([...new Set(children.map(row => row.account))], ['b'], 'the child claude -p started from Bash must send only the selected bearer')
  assert.equal(children.some(row => row.apiKey), false, 'the child must not fall back to an API key')
  assert.equal(spawned?.isError, false, 'the allowed child claude command must run')
  assert.match(spawned?.text ?? '', new RegExp(childAnswer), 'the child answer must come back through Bash')
} finally {
  if (child && child.exitCode === null) { stop(child); await once(child, 'close').catch(() => {}) }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  rmSync(fixture, { recursive: true, force: true })
}
