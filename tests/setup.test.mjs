import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { loginEnvironment, runSetup } from '../scripts/account-setup.mjs'

function fixture(account, options = {}) {
  const calls = [], messages = [], prepared = []
  const deps = {
    platform: 'linux', major: 22, env: { HOME: '/fixture' },
    read: () => JSON.stringify({ accounts: { personal: account } }),
    prepare: path => prepared.push(path), prompt: async () => 'fixture-private-value', log: text => messages.push(text),
    exec: (command, args, init = {}) => { calls.push({ command, args, init }); return { status: 0, stdout: '' } },
    ...options,
  }
  return { deps, calls, messages, prepared, run: (...args) => runSetup(['--config-dir', '/fixture/.claude', 'personal', ...args], deps) }
}

test('isolated native login clears inherited session authentication and binds both storage directories', () => {
  const environment = { PATH: '/bin', CLAUDECODE: '1', ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_AUTH_TOKEN: 'fixture-token', CLAUDE_CODE_OAUTH_TOKEN: 'fixture-oauth', RICE_SESSION_ACCOUNTS_OAUTH_RELAY: 'fixture-parent-relay', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_HOST_CREDS_FILE: '/shared', CLAUDE_CODE_HOST_AUTH_ENV_VAR: 'MY_SECRET', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/shared', MY_SECRET: 'fixture-host-secret' }
  const isolated = loginEnvironment(environment, '/isolated login')
  assert.equal(isolated.PATH, '/bin')
  for (const key of ['CLAUDECODE', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'RICE_SESSION_ACCOUNTS_OAUTH_RELAY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_HOST_CREDS_FILE', 'CLAUDE_CODE_HOST_AUTH_ENV_VAR']) assert.equal(isolated[key], undefined)
  assert.equal(isolated.CLAUDE_CONFIG_DIR, '/isolated login')
  assert.equal(isolated.CLAUDE_SECURESTORAGE_CONFIG_DIR, '/isolated login')
  assert.equal(environment.CLAUDE_SECURESTORAGE_CONFIG_DIR, '/shared')
})

test('login checks readiness, starts native authentication, then verifies without account writes', async () => {
  const world = fixture({ kind: 'claudeai', loginDir: '/isolated login' })
  let signedIn = false
  world.deps.exec = (command, args, init) => {
    world.calls.push({ command, args, init })
    if (args[1] === 'login') { signedIn = true; return { status: 0 } }
    return { status: signedIn ? 0 : 1, stdout: JSON.stringify({ loggedIn: signedIn, authMethod: signedIn ? 'claude.ai' : 'none', apiProvider: 'firstParty' }) }
  }
  await world.run()
  assert.deepEqual(world.calls.map(call => call.args), [['auth', 'status', '--json'], ['auth', 'login', '--claudeai'], ['auth', 'status', '--json']])
  assert.equal(world.calls[1].init.interactive, true)
  assert.equal(world.calls[1].init.env.CLAUDE_CONFIG_DIR, '/isolated login')
  assert.deepEqual(world.prepared, ['/isolated login'])
  assert.match(world.messages.at(-1), /check personal[\s\S]*Then switch/)
})

test('ready login skips interactive auth, while --login explicitly reauthenticates', async () => {
  const world = fixture({ kind: 'claudeai', loginDir: '/isolated' })
  world.deps.exec = (command, args) => { world.calls.push(args); return { status: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}' } }
  await world.run()
  assert.equal(world.calls.length, 1)
  await world.run('--login')
  assert.deepEqual(world.calls[1], ['auth', 'login', '--claudeai'])
  assert.deepEqual(world.calls[2], ['auth', 'status', '--json'])
})

test('a third-party logged-in status cannot stand in for the isolated Claude subscription', async () => {
  const world = fixture({ kind: 'claudeai', loginDir: '/isolated' }, { env: { HOME: '/fixture', CLAUDE_CODE_USE_ANTHROPIC_AWS: '1', CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: '1', CLAUDE_CODE_USE_MANTLE: '1', CLAUDE_CODE_USE_GATEWAY: '1', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '10', CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR: '11', CLAUDE_BG_AUTH_SNAPSHOT_PATH: '/fixture/snapshot' } })
  let authenticated = false
  world.deps.exec = (_command, args, init) => {
    world.calls.push(args)
    for (const key of Object.keys(world.deps.env).filter(key => key !== 'HOME')) assert.equal(init.env[key], undefined)
    if (args[1] === 'login') authenticated = true
    return { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: authenticated ? 'claude.ai' : 'third_party', apiProvider: authenticated ? 'firstParty' : 'anthropicAws' }) }
  }
  await world.run()
  assert.equal(world.calls.some(args => args[1] === 'login'), true)
})

test('cancelled or incomplete login reports resumable failure', async () => {
  const world = fixture({ kind: 'claudeai', loginDir: '/isolated' }, { exec: () => ({ status: 1, stdout: '{"loggedIn":false}' }) })
  await assert.rejects(world.run(), /same setup command to resume/)
})

for (const platform of ['linux', 'darwin']) {
  test(`${platform} OAuth token setup sends the credential through stdin, reads it back, and never logs it`, async () => {
    const world = fixture({ kind: 'claudeai-token', secret: { service: 'rice-session-accounts', account: 'personal' } }, { platform })
    let stored = false
    world.deps.exec = (command, args, init = {}) => {
      world.calls.push({ command, args, init })
      if (command === 'claude' && args[0] === 'setup-token') return { status: 0 }
      if (args[0] === 'store' || args[0] === '-i') { stored = true; return { status: 0 } }
      return { status: stored ? 0 : platform === 'darwin' ? 44 : 1, stdout: stored ? 'fixture-private-value\n' : '' }
    }
    await world.run()
    assert.equal(world.calls.length, 4)
    assert.equal(world.calls[1].command, 'claude')
    assert.deepEqual(world.calls[1].args, ['setup-token'])
    assert.equal(world.calls[1].init.interactive, true)
    const store = world.calls[2]
    assert.ok(store.init.input)
    assert.equal(JSON.stringify(world.calls.map(call => [call.command, call.args])).includes('fixture-private-value'), false)
    assert.equal(world.messages.join('\n').includes('fixture-private-value'), false)
    if (platform === 'linux') {
      assert.equal(store.command, 'secret-tool')
      assert.deepEqual(store.args.slice(-4), ['service', 'rice-session-accounts', 'account', 'personal'])
    } else assert.equal(store.command, '/usr/bin/security')
  })
}

test('an unavailable Linux keyring is rejected before asking for a credential', async () => {
  const world = fixture({ kind: 'claudeai-token', secret: { service: 'rice', account: 'personal' } }, {
    exec: () => ({ status: 1, hasErrorOutput: true }),
    prompt: async () => { throw Error('must not prompt') },
  })
  await assert.rejects(world.run(), /Secret Service is unavailable or locked/)
})

test('existing named credential is reused without a prompt', async () => {
  const world = fixture({ kind: 'claudeai-token', secret: { service: 'rice', account: 'personal' } }, {
    exec: () => ({ status: 0, stdout: 'fixture-existing' }),
    prompt: async () => { throw Error('must not prompt') },
  })
  await world.run()
  assert.match(world.messages.join('\n'), /already stored/)
})

test('legacy provider accounts are rejected before starting a process, preparing a folder or prompting', async () => {
  for (const account of [
    { kind: 'api-key', secret: { service: 'fixture', account: 'key' } },
    { kind: 'gateway', baseUrl: 'https://gateway.example', secret: { service: 'fixture', account: 'gateway' } },
    { kind: 'bedrock', awsProfile: 'work' },
    { kind: 'vertex', projectId: 'project' },
    { kind: 'foundry', resource: 'resource' },
  ]) {
    const world = fixture(account, { prompt: async () => { throw Error('must not prompt') } })
    await assert.rejects(world.run(), /OAuth accounts only/)
    assert.deepEqual(world.calls, [])
    assert.deepEqual(world.prepared, [])
  }
})

test('bad args and unsupported runtimes fail before any account or credential operation', async () => {
  let reads = 0
  const deps = { major: 22, platform: 'linux', env: {}, read: () => { reads++; throw Error('unexpected') } }
  for (const args of [[], ['personal', 'extra'], ['--config-dir'], ['../bad'], ['--unknown']]) await assert.rejects(runSetup(args, deps), /Usage:|needs a directory/)
  await assert.rejects(runSetup(['personal'], { ...deps, major: 20 }), /22 or later/)
  await assert.rejects(runSetup(['personal'], { ...deps, platform: 'freebsd' }), /macOS, Linux/)
  assert.equal(reads, 0)
})

test('Windows browser setup uses USERPROFILE, drive-qualified credential storage and native login arguments', async () => {
  const calls = [], prepared = [], reads = []
  const loginDir = 'C:\\Users\\fixture user\\accounts\\personal'
  let ready = false
  await runSetup(['personal'], {
    platform: 'win32', major: 22, env: { USERPROFILE: 'C:\\Users\\fixture user', HOME: '/wrong-home', SystemRoot: 'C:\\Windows' },
    read: path => { reads.push(path); return JSON.stringify({ accounts: { personal: { kind: 'claudeai', loginDir } } }) },
    prepare: path => prepared.push(path), log: () => {},
    exec: (command, args, init) => {
      calls.push({ command, args, init })
      if (args[1] === 'login') ready = true
      return { status: ready ? 0 : 1, stdout: JSON.stringify({ loggedIn: ready, authMethod: ready ? 'claude.ai' : 'none', apiProvider: 'firstParty' }) }
    },
  })
  assert.deepEqual(reads, ['C:\\Users\\fixture user\\.claude\\rice-session-accounts\\accounts.json'])
  assert.deepEqual(prepared, [loginDir])
  assert.deepEqual(calls.map(call => call.args), [['auth', 'status', '--json'], ['auth', 'login', '--claudeai'], ['auth', 'status', '--json']])
  for (const call of calls) assert.equal(call.init.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, loginDir)
})

test('Windows token setup uses Credential Manager through stdin, with no token in arguments or logs', async () => {
  const world = fixture({ kind: 'claudeai-token', secret: { service: 'rice-session-accounts', account: 'personal' } }, { platform: 'win32', env: { USERPROFILE: 'C:\\Users\\fixture', SystemRoot: 'C:\\Windows' } })
  let stored = false
  world.deps.exec = (command, args, init = {}) => {
    world.calls.push({ command, args, init })
    if (command === 'claude') return { status: 0 }
    const request = JSON.parse(init.input)
    if (request.operation === 'write') { stored = true; assert.equal(request.secret, 'fixture-private-value'); return { status: 0 } }
    return { status: stored ? 0 : 44, stdout: stored ? 'fixture-private-value' : '' }
  }
  await world.run()
  assert.equal(world.calls.length, 4)
  assert.equal(world.calls[0].command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.deepEqual(world.calls[1].args, ['setup-token'])
  assert.equal(JSON.stringify(world.calls.map(call => [call.command, call.args])).includes('fixture-private-value'), false)
  assert.equal(world.messages.join('\n').includes('fixture-private-value'), false)
})

test('Windows rejects drive-relative login directories before preparing storage or launching authentication', async () => {
  const world = fixture({ kind: 'claudeai', loginDir: '\\relative-to-current-drive' }, { platform: 'win32' })
  await assert.rejects(world.run(), /absolute loginDir/)
  assert.deepEqual(world.prepared, [])
  assert.deepEqual(world.calls, [])
})

test('a requested unsupported Windows vendor store is rejected before login preparation', async () => {
  const world = fixture({ kind: 'claudeai', loginDir: 'C:\\fixture\\login' }, { platform: 'win32', env: { USERPROFILE: 'C:\\fixture', FORCE_WINDOWS_CREDMAN: '1' } })
  await assert.rejects(world.run(), /FORCE_WINDOWS_CREDMAN/)
  assert.deepEqual(world.prepared, [])
  assert.deepEqual(world.calls, [])
})

test('the actual CLI exits nonzero with a useful missing-account error', () => {
  const result = spawnSync(process.execPath, ['scripts/account-setup.mjs', '--config-dir', '/nonexistent/rice-account-fixture', 'personal'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /First run \/rice-account add/)
  assert.equal(result.stdout, '')
})

test('the actual terminal helper isolates native subprocess auth and resumes from paths containing spaces', () => {
  const root = mkdtempSync(join(tmpdir(), 'rice account setup '))
  try {
    const configDir = join(root, 'main config'), loginDir = join(root, 'isolated login'), bin = join(root, 'bin')
    mkdirSync(join(configDir, 'rice-session-accounts'), { recursive: true })
    mkdirSync(bin)
    const configPath = join(configDir, 'rice-session-accounts', 'accounts.json')
    const config = JSON.stringify({ accounts: { personal: { kind: 'claudeai', loginDir } } })
    writeFileSync(configPath, config)
    const fake = `#!${process.execPath}\nimport {existsSync,writeFileSync} from 'node:fs';\nimport{join}from'node:path';\nconst[a,b]=process.argv.slice(2),e=process.env;\nif(e.CLAUDE_CONFIG_DIR!==e.CLAUDE_SECURESTORAGE_CONFIG_DIR||e.CLAUDECODE||e.CLAUDE_CODE_OAUTH_TOKEN||e.CLAUDE_CODE_USE_MANTLE||e.CLAUDE_BG_AUTH_SNAPSHOT_PATH)process.exit(12);\nconst p=join(e.CLAUDE_CONFIG_DIR,'fixture-auth-ready');\nif(a==='auth'&&b==='login'){writeFileSync(p,'ready');console.log('fixture native login');}\nelse if(a==='auth'&&b==='status'){const ok=existsSync(p);console.log(JSON.stringify({loggedIn:ok,authMethod:ok?'claude.ai':'none',apiProvider:'firstParty'}));process.exitCode=ok?0:1;}else process.exit(13);\n`
    writeFileSync(join(bin, 'claude'), fake)
    chmodSync(join(bin, 'claude'), 0o700)
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDECODE: '1', CLAUDE_CODE_OAUTH_TOKEN: 'fixture-parent-token', CLAUDE_CODE_USE_MANTLE: '1', CLAUDE_BG_AUTH_SNAPSHOT_PATH: '/fixture-parent-snapshot' }
    const args = [resolve('scripts/account-setup.mjs'), '--config-dir', configDir, 'personal']
    const first = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 10_000 })
    assert.equal(first.status, 0, first.stderr)
    assert.match(first.stdout, /fixture native login/)
    assert.equal(existsSync(join(configDir, 'fixture-auth-ready')), false)
    assert.equal(existsSync(join(loginDir, 'fixture-auth-ready')), true)
    assert.equal(readFileSync(configPath, 'utf8'), config)
    const second = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 10_000 })
    assert.equal(second.status, 0, second.stderr)
    assert.equal(second.stdout.includes('fixture native login'), false)
    assert.equal(readFileSync(configPath, 'utf8'), config)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
