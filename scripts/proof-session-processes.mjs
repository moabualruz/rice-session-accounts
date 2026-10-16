// Owned native engine fixture. Run explicitly, outside the dependency-free Node tests.
// Authentication reads and model replies are synthetic. Environment mutation,
// the production command function, native agents and child processes are real.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { bootstrap, qualify } from '../native/launch.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const fixture = mkdtempSync(join(tmpdir(), 'rice-account-process-proof-'))
const plugin = join(fixture, 'plugin')
const configDir = join(fixture, '.claude')
const barriers = join(fixture, 'barriers')
const loginA = join(fixture, 'logins', 'a')
const loginB = join(fixture, 'logins', 'b')
const apiKey = 'fixture-launch-api-key'
const tokenA = 'fixture-account-a-oauth'
const tokenB = 'fixture-account-b-oauth'
const children = new Set()
const owned = []

function sourceHash(directory) {
  const digest = createHash('sha256')
  function visit(relative) {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) visit(name)
      else if (entry.isFile()) digest.update(name).update('\0').update(readFileSync(join(directory, name))).update('\0')
    }
  }
  visit('')
  return digest.digest('hex')
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function waitFor(path, ms = 30_000) {
  const deadline = Date.now() + ms
  while (!existsSync(path)) {
    assert.ok(Date.now() < deadline, `native fixture did not reach ${path.slice(fixture.length)}`)
    await delay(50)
  }
}

function launch(role, env, args) {
  const child = spawn('claude', args, { cwd: fixture, env: { ...env, RICE_SESSION_ACCOUNT_PROOF_ROLE: role }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  children.add(child)
  const ownership = { role, pid: child.pid, startedAt: new Date().toISOString() }
  owned.push(ownership)
  process.stderr.write(JSON.stringify({ phase: 'native-process-started', ...ownership }) + '\n')
  let output = '', errors = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { errors += data })
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM') } catch {} }, 45_000)
  const done = once(child, 'close').then(([code]) => {
    children.delete(child)
    clearTimeout(timer)
    assert.equal(code, 0, `${role} failed: ${(output + errors).slice(-3500)}`)
    const result = JSON.parse(output)
    assert.equal(result.is_error, false, `${role} engine result`)
    const value = JSON.parse(result.result)
    assert.equal(value.fixtureError, undefined, `${role}: ${JSON.stringify(value)}`)
    return value
  })
  // A failed participant is awaited below after the fixture's bounded barrier.
  done.catch(() => {})
  return done
}

try {
  mkdirSync(plugin)
  mkdirSync(configDir)
  mkdirSync(barriers)
  mkdirSync(join(fixture, 'tmp'))
  for (const directory of ['.claude-plugin', 'hooks', 'types', 'scripts']) cpSync(join(root, directory), join(plugin, directory), { recursive: true })
  const inputSha256 = sourceHash(plugin)
  const proofSha256 = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex')
  writeFileSync(join(fixture, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ model: 'haiku', env: { RICE_PROOF_CONFIG_MARKER: 'machine-config' } }))
  for (const [folder, marker] of [[loginA, 'account-a-settings'], [loginB, 'account-b-settings']]) {
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'settings.json'), JSON.stringify({ model: 'sonnet', env: { RICE_PROOF_CONFIG_MARKER: marker } }))
    writeFileSync(join(folder, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: folder === loginA ? tokenA : tokenB, refreshToken: 'fixture-refresh', expiresAt: Date.now()+3600000, scopes: ['user:inference','user:profile'], subscriptionType: 'pro' } }))
  }
  const accountsDir = join(configDir, 'rice-session-accounts')
  mkdirSync(accountsDir)
  // A legacy saved shortcut must not choose another account in a new process.
  writeFileSync(join(accountsDir, 'accounts.json'), JSON.stringify({ default: 'account-a', accounts: {
    login: { kind: 'login' }, 'account-a': { kind: 'claudeai', loginDir: loginA }, 'account-b': { kind: 'claudeai', loginDir: loginB },
  } }))
  const service = folder => `Claude Code-credentials-${createHash('sha256').update(folder.normalize('NFC')).digest('hex').slice(0, 8)}`
  const fixtureCredentials = Object.fromEntries([[service(loginA), tokenA], [service(loginB), tokenB], [`${loginA}/.credentials.json`, tokenA], [`${loginB}/.credentials.json`, tokenB]])
  const environmentReader = 'process.stdout.write(JSON.stringify({apiKey:process.env.ANTHROPIC_API_KEY??null,oauth:process.env.CLAUDE_CODE_OAUTH_TOKEN??null,storage:process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR??null,configDir:process.env.CLAUDE_CONFIG_DIR??null,marker:process.env.RICE_PROOF_CONFIG_MARKER??null}))'
  const nativeArgs = ['-p', '--plugin-dir', plugin, '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', 'Agent,Bash', '--permission-mode', 'bypassPermissions', '--no-session-persistence', '--output-format', 'json', 'Owned account environment proof']
  const register = join(plugin, 'hooks', 'register.ts')
  const production = readFileSync(register, 'utf8')
  const turnStart = production.indexOf("  on('turn.step',")
  let copied = production
  if (turnStart >= 0) {
    const turnEnd = production.indexOf("  on('prompt.autocomplete',", turnStart)
    assert.ok(turnEnd > turnStart, 'legacy production turn hook boundaries')
    assert.match(production.slice(turnStart, turnEnd), /const model = remap\[e\.model\]/, 'refuse to replace an unknown production turn hook')
    copied = production.slice(0, turnStart) + production.slice(turnEnd)
  }
  const closing = copied.lastIndexOf('\n}')
  assert.ok(closing > 0, 'production register boundary')
  const probe = `
  const proofDirectory = ${JSON.stringify(barriers)}
  const proofCredentials: Record<string, string> = ${JSON.stringify(fixtureCredentials)}
  const proofReader = ${JSON.stringify(environmentReader)}
  const proofArgs = ${JSON.stringify(nativeArgs)}
  const proofBashReader = ${JSON.stringify('node -e ' + shellQuote(environmentReader))}
  const proofBashPrint = ${JSON.stringify('/usr/bin/env -u CLAUDECODE RICE_SESSION_ACCOUNT_PROOF_ROLE=child claude ' + nativeArgs.map(shellQuote).join(' '))}
  const proofLabel = (value: string | null | undefined) => value === ${JSON.stringify(apiKey)} ? 'launch' : value === ${JSON.stringify(tokenA)} ? 'a' : value === ${JSON.stringify(tokenB)} ? 'b' : value == null ? null : 'unexpected'
  const proofStorage = (value: string | null | undefined) => value === ${JSON.stringify(loginA)} ? 'a' : value === ${JSON.stringify(loginB)} ? 'b' : value === ${JSON.stringify(configDir)} ? 'machine' : 'unexpected'
  const proofDecode = (text: string) => {
    const parsed = JSON.parse(text) as { apiKey: string | null; oauth: string | null; storage: string | null; configDir: string | null; marker: string | null }
    return { apiKey: proofLabel(parsed.apiKey), oauth: proofLabel(parsed.oauth), storage: proofStorage(parsed.storage), config: parsed.configDir === ${JSON.stringify(configDir)} ? 'machine' : 'unexpected', marker: parsed.marker }
  }
  const proofSnapshot = async ($: EngineInterface, model: string) => {
    const host = { apiKey: proofLabel(await $.env.get('ANTHROPIC_API_KEY')), oauth: proofLabel(await $.env.get('CLAUDE_CODE_OAUTH_TOKEN')), storage: proofStorage(await $.env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR')), config: (await $.env.get('CLAUDE_CONFIG_DIR')) === ${JSON.stringify(configDir)} ? 'machine' : 'unexpected', marker: await $.env.get('RICE_PROOF_CONFIG_MARKER') }
    const child = await $.process.run(['node', '-e', proofReader], { timeoutMs: 10_000 })
    if (child.exitCode !== 0) throw new Error('owned environment child failed')
    let streamed = ''
    for await (const chunk of $.process.spawn({ argv: ['node', '-e', proofReader] })) {
      if (chunk.stream === 'stdout') streamed += chunk.text
    }
    const bash = await $.tool.call({ tool: 'Bash', command: proofBashReader, timeout: 10_000, description: 'Owned account environment fixture' })
    if (bash.deny || bash.isError) throw new Error('owned Bash environment child failed')
    return { host, child: proofDecode(child.stdout), streamed: proofDecode(streamed), bash: proofDecode(bash.result.stdout), model }
  }
  const proofWait = async ($: EngineInterface, name: string) => {
    const deadline = (await $.clock.now()) + 25_000
    while (!(await $.fs.exists(proofDirectory + '/' + name))) {
      if ((await $.clock.now()) >= deadline) throw new Error('owned fixture barrier timed out: ' + name)
      await $.clock.sleep(50)
    }
  }
  on('process.run', { argv: [/^(?:node|\\/usr\\/bin\\/security)$/] }, async ($, e, next) => {
    let reference: string | undefined
    if (e.argv[0] === '/usr/bin/security' && e.argv[1] === 'find-generic-password') reference = e.argv[e.argv.indexOf('-s') + 1]
    if (e.argv[0] === 'node' && e.argv[3] === 'read' && e.argv[4]?.endsWith('/.credentials.json')) reference = e.argv[4]
    if (reference === undefined) return next(e)
    const token = proofCredentials[reference]
    if (token === undefined) throw new Error('owned credential fixture refused unknown store')
    return { value: { exitCode: 0, stdout: JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3600000 } }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // This matcher excludes main, keeping the hook outside the spawning hook's
  // active ancestry. The real agent loop therefore reaches this response.
  on('turn.step', { agentId: /^(?!undefined$|null$).+$/ }, async function* ($, e) {
    const answer = JSON.stringify({ agentId: e.agentId, snapshot: await proofSnapshot($, e.model) })
    await $.fs.write(proofDirectory + '/agent-' + e.agentId, answer)
    yield { kind: 'text', index: 0, text: answer }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    let answer: string
    try {
      const role = await $.env.get('RICE_SESSION_ACCOUNT_PROOF_ROLE')
      if (role === 'child') {
        answer = JSON.stringify({ role, snapshot: await proofSnapshot($, e.model) })
      } else if (role === 'baseline') {
        const snapshot = await proofSnapshot($, e.model)
        await $.fs.write(proofDirectory + '/baseline-done', 'done')
        answer = JSON.stringify({ role, snapshot })
      } else if (role === 'sibling') {
        const before = await proofSnapshot($, e.model)
        await proofWait($, 'a-ready')
        const duringA = await proofSnapshot($, e.model)
        await $.fs.write(proofDirectory + '/sibling-a', 'done')
        await proofWait($, 'b-ready')
        const duringB = await proofSnapshot($, e.model)
        await $.fs.write(proofDirectory + '/sibling-b', 'done')
        answer = JSON.stringify({ role, before, duringA, duringB })
      } else if (role === 'switcher') {
        const before = await proofSnapshot($, e.model)
        // command.run cannot be scheduled inside a turn hook. Call the same
        // unmodified production command function; dispatch has separate tests.
        const switchedA = await runCommand($, 'account-a')
        const a = await proofSnapshot($, e.model)
        await $.fs.write(proofDirectory + '/a-ready', 'ready')
        await proofWait($, 'sibling-a')
        await proofWait($, 'baseline-done')
        const spawned = await $.agent.spawn({ prompt: 'Owned no-inference environment fixture', description: 'account environment fixture', subagentType: 'general-purpose', model: 'haiku' })
        if (spawned.deny || !spawned.agentId) throw new Error('native agent did not start: ' + (spawned.deny ?? 'missing id'))
        await proofWait($, 'agent-' + spawned.agentId)
        const agent = JSON.parse(await $.fs.read(proofDirectory + '/agent-' + spawned.agentId))
        const switchedB = await runCommand($, 'account-b')
        const b = await proofSnapshot($, e.model)
        await $.fs.write(proofDirectory + '/b-ready', 'ready')
        await proofWait($, 'sibling-b')
        const nested = await $.process.run(['/usr/bin/env', '-u', 'CLAUDECODE', 'claude', ...proofArgs], { env: { RICE_SESSION_ACCOUNT_PROOF_ROLE: 'child' }, timeoutMs: 25_000 })
        if (nested.exitCode !== 0) throw new Error('owned claude -p child failed: ' + nested.stderr.slice(-500))
        const nativeChild = JSON.parse(JSON.parse(nested.stdout).result)
        const bashNested = await $.tool.call({ tool: 'Bash', command: proofBashPrint, timeout: 25_000, description: 'Owned Claude print descendant fixture' })
        if (bashNested.deny || bashNested.isError) throw new Error('owned Bash claude -p child failed')
        const bashNativeChild = JSON.parse(JSON.parse(bashNested.result.stdout).result)
        const restored = await runCommand($, 'login')
        answer = JSON.stringify({ role, before, switchedA, a, agent, switchedB, b, nativeChild, bashNativeChild, restored, login: await proofSnapshot($, e.model) })
      } else throw new Error('unknown owned proof role')
    } catch (error) { answer = JSON.stringify({ fixtureError: error instanceof Error ? error.message : String(error) }) }
    yield { kind: 'text', index: 0, text: answer }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
  })
`
  const hooksAt = probe.indexOf("  on('process.run',")
  assert.ok(hooksAt > 0, 'owned fixture helper boundary')
  const helpers = probe.slice(0, hooksAt)
  const decorated = copied.replace('export const register: Register = on => {', helpers + '\nexport const register: Register = on => {')
  const decoratedClosing = decorated.lastIndexOf('\n}')
  writeFileSync(register, decorated.slice(0, decoratedClosing) + '\n' + probe.slice(hooksAt) + decorated.slice(decoratedClosing))
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'SystemDrive', 'LANG', 'LC_ALL'].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]))
  Object.assign(env, { HOME: fixture, USER: 'fixture', USERPROFILE: fixture, TMPDIR: join(fixture, 'tmp'), CLAUDE_CONFIG_DIR: configDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: apiKey, ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
  if (process.env.RICE_ACCOUNTS_PROOF_CLAUDE) {
    mkdirSync(join(fixture, 'bin'))
    symlinkSync(process.env.RICE_ACCOUNTS_PROOF_CLAUDE, join(fixture, 'bin/claude'))
    env.PATH = join(fixture, 'bin') + ':' + env.PATH
  }
  const preload = bootstrap(), qualified = qualify('claude', env, preload)
  Object.assign(env, { BUN_OPTIONS: '--preload ' + preload, RICE_SESSION_ACCOUNTS_NATIVE_VERSION: qualified.claudeVersion, RICE_SESSION_ACCOUNTS_NATIVE_EXECUTABLE: qualified.executable })
  const version = spawnSync('claude', ['--version'], { env, encoding: 'utf8', timeout: 10_000 })
  assert.equal(version.status, 0, 'native version probe')
  const validated = spawnSync('claude', ['plugin', 'validate', '--strict', plugin], { cwd: fixture, env, encoding: 'utf8', timeout: 15_000 })
  assert.equal(validated.status, 0, `owned native fixture validation: ${(validated.stdout + validated.stderr).slice(-5000)}`)
  const sibling = launch('sibling', env, nativeArgs)
  const switcher = launch('switcher', env, nativeArgs)
  await waitFor(join(barriers, 'a-ready'))
  const baseline = launch('baseline', env, nativeArgs)
  const [switched, unchanged, fresh] = await Promise.all([switcher, sibling, baseline])
  process.stderr.write(JSON.stringify({ phase: 'native-observations', switcher: switched, sibling: unchanged, baseline: fresh }) + '\n')
  const nativeModel = switched.before.model
  assert.match(nativeModel, /haiku/i, 'machine configuration selects the native model')
  const snapshot = (storage = 'machine', key = 'launch') => ({ host: { apiKey: key, oauth: null, storage, config: 'machine', marker: 'machine-config' }, child: { apiKey: key, oauth: null, storage, config: 'machine', marker: 'machine-config' }, streamed: { apiKey: key, oauth: null, storage, config: 'machine', marker: 'machine-config' }, bash: { apiKey: key, oauth: null, storage, config: 'machine', marker: 'machine-config' }, model: nativeModel })
  assert.deepEqual(switched.before, snapshot())
  assert.deepEqual(switched.a, snapshot('a', null))
  assert.deepEqual(switched.agent.snapshot, snapshot('a', null))
  assert.ok(switched.agent.agentId, 'actual native agent identity')
  assert.deepEqual(switched.b, snapshot('b', null))
  assert.deepEqual(switched.nativeChild.snapshot, snapshot('b', null))
  assert.deepEqual(switched.bashNativeChild.snapshot, snapshot('b', null))
  assert.deepEqual(switched.login, snapshot())
  assert.deepEqual(unchanged.before, snapshot())
  assert.deepEqual(unchanged.duringA, snapshot())
  assert.deepEqual(unchanged.duringB, snapshot())
  assert.deepEqual(fresh.snapshot, snapshot())
  assert.match(switched.switchedA, /This session now uses account-a/)
  assert.match(switched.switchedB, /This session now uses account-b/)
  assert.match(switched.restored, /back on this machine/)
  process.stdout.write(JSON.stringify({ version: 1, nativeVersion: version.stdout.trim(), node: process.version, platform: process.platform, inputSha256, proofSha256, scope: { productionCommandFunction: true, nativeSlashScheduling: false, nativeEnvironmentMutation: true, realNodeChildren: true, realStreamedChildren: true, realBashTool: true, realClaudePrintChild: true, realBashClaudePrintChild: true, realNativeSubagent: true, simultaneousSibling: true, newProcessLaunchAccount: true, authentication: 'synthetic credential reads', inference: 'synthetic turn replies, closed API base URL' }, checks: { selectedA: true, agentA: true, selectedB: true, printChildB: true, bashPrintChildB: true, loginRestored: true, siblingUnchangedDuringAAndB: true, newProcessUsesLaunchAccount: true, machineConfigUnchanged: true, machineModelRetained: true }, ownedProcesses: owned }) + '\n')
} finally {
  const active = [...children]
  const closed = active.map(child => once(child, 'close').catch(() => {}))
  for (const child of active) { try { process.kill(-child.pid, 'SIGTERM') } catch {} }
  const escalate = setTimeout(() => { for (const child of children) { try { process.kill(-child.pid, 'SIGKILL') } catch {} } }, 1000)
  await Promise.all(closed)
  clearTimeout(escalate)
  rmSync(fixture, { recursive: true, force: true })
}
