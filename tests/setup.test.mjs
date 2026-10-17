import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { Script } from 'node:vm'
import { accountNameProblem, isAccountName, isStoredAccountName, RESERVED_NAMES } from '../scripts/account-names.mjs'
import { derivedLoginDir, homeDirectory, isWsl, loginEnvironment, onWindowsDrive, runSetup, windowsNodeInWsl } from '../scripts/account-setup-main.mjs'
import { CLAUDE_OVERRIDE, claudeInvocation, resolveClaude, shimTarget, windowsExtensions, windowsPathEntries } from '../scripts/claude-command.mjs'
import { quoteCmd, quoteFish, quoteFor, quotePortable, quotePosix, quotePowerShell, UnquotableError } from '../scripts/shell-quote.mjs'
import { WINDOWS_CREDENTIAL_STORE, WINDOWS_EXIT, WINDOWS_PRIVATE_DIRECTORY, windowsStoreProblem } from '../scripts/windows-store-payloads.mjs'

const CONFIG = { linux: '/fixture/.claude', darwin: '/fixture/.claude', win32: 'C:\\fixture\\.claude' }
/** The login folder setup derives for "personal", written the way the plugin saves it (pathsFor joins with /). */
const SAVED_LOGIN = { linux: '/fixture/.claude/rice-session-accounts/logins/personal', darwin: '/fixture/.claude/rice-session-accounts/logins/personal', win32: 'C:\\fixture\\.claude/rice-session-accounts/logins/personal' }
const PREPARED_LOGIN = { ...SAVED_LOGIN, win32: 'C:\\fixture\\.claude\\rice-session-accounts\\logins\\personal' }

function fixture(account, options = {}) {
  const calls = [], messages = [], prepared = []
  const platform = options.platform ?? 'linux'
  const deps = {
    platform, major: 22, env: platform === 'win32' ? { USERPROFILE: 'C:\\fixture' } : { HOME: '/fixture' },
    osRelease: '6.8.0-generic', cwd: () => '', script: '', uid: undefined,
    homedir: () => { throw Error('the fixture home comes from the environment') },
    inspect: () => ({ directory: true, symlink: false }), realpath: path => path,
    read: () => JSON.stringify({ accounts: { personal: account } }),
    prepare: (path, context) => prepared.push(path) && context, prompt: async () => 'fixture-private-value',
    log: text => messages.push(text), warn: text => messages.push(text),
    exec: (command, args, init = {}) => { calls.push({ command, args, init }); return { status: 0, stdout: '' } },
    ...options,
  }
  return { deps, calls, messages, prepared, run: (...args) => runSetup(['--config-dir', CONFIG[platform], 'personal', ...args], deps) }
}

const READY = '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'

test('isolated native login clears inherited session authentication and binds both storage directories', () => {
  const environment = { PATH: '/bin', CLAUDECODE: '1', ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_AUTH_TOKEN: 'fixture-token', ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer fixture-parent', CLAUDE_CODE_OAUTH_TOKEN: 'fixture-oauth', RICE_SESSION_ACCOUNTS_OAUTH_RELAY: 'fixture-parent-relay', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_HOST_CREDS_FILE: '/shared', CLAUDE_CODE_HOST_AUTH_ENV_VAR: 'MY_SECRET', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/shared', MY_SECRET: 'fixture-host-secret' }
  const isolated = loginEnvironment(environment, '/isolated login')
  assert.equal(isolated.PATH, '/bin')
  for (const key of ['CLAUDECODE', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_OAUTH_TOKEN', 'RICE_SESSION_ACCOUNTS_OAUTH_RELAY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_HOST_CREDS_FILE', 'CLAUDE_CODE_HOST_AUTH_ENV_VAR']) assert.equal(isolated[key], undefined)
  assert.equal(isolated.CLAUDE_CONFIG_DIR, '/isolated login')
  assert.equal(isolated.CLAUDE_SECURESTORAGE_CONFIG_DIR, '/isolated login')
  assert.equal(environment.CLAUDE_SECURESTORAGE_CONFIG_DIR, '/shared')
})

test('login checks readiness, starts native authentication, then verifies without account writes', async () => {
  const world = fixture({ kind: 'claudeai', loginDir: SAVED_LOGIN.linux })
  let signedIn = false
  world.deps.exec = (command, args, init) => {
    world.calls.push({ command, args, init })
    if (args[1] === 'login') { signedIn = true; return { status: 0 } }
    return { status: signedIn ? 0 : 1, stdout: JSON.stringify({ loggedIn: signedIn, authMethod: signedIn ? 'claude.ai' : 'none', apiProvider: 'firstParty' }) }
  }
  await world.run()
  assert.deepEqual(world.calls.map(call => call.args), [['auth', 'status', '--json'], ['auth', 'login', '--claudeai'], ['auth', 'status', '--json']])
  assert.equal(world.calls[1].init.interactive, true)
  assert.equal(world.calls[1].init.env.CLAUDE_CONFIG_DIR, SAVED_LOGIN.linux)
  assert.deepEqual(world.prepared, [PREPARED_LOGIN.linux])
  assert.match(world.messages.at(-1), /check personal[\s\S]*Then switch/)
})

test('ready login skips interactive auth, while --login explicitly reauthenticates', async () => {
  const world = fixture({ kind: 'claudeai', loginDir: SAVED_LOGIN.linux })
  world.deps.exec = (command, args) => { world.calls.push(args); return { status: 0, stdout: READY } }
  await world.run()
  assert.equal(world.calls.length, 1)
  await world.run('--login')
  assert.deepEqual(world.calls[1], ['auth', 'login', '--claudeai'])
  assert.deepEqual(world.calls[2], ['auth', 'status', '--json'])
})

for (const platform of ['linux', 'darwin', 'win32']) {
  test(`${platform} login forwards the expected email and verifies the isolated identity before readiness`, async () => {
    const loginDir = SAVED_LOGIN[platform]
    const world = fixture({ kind: 'claudeai', loginDir }, { platform })
    world.deps.exec = (command, args, init) => {
      world.calls.push({ command, args, init })
      return { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'Personal@Example.com' }) }
    }
    await world.run('--login', '--email', 'personal@example.com', '--manual')
    assert.deepEqual(world.calls.map(call => call.args), [['auth', 'login', '--claudeai', '--email', 'personal@example.com'], ['auth', 'status', '--json']])
    for (const call of world.calls) {
      // The saved spelling is what Claude Code names its credential store after, so it is passed verbatim.
      assert.equal(call.init.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, loginDir)
      assert.equal(call.init.env.CLAUDE_CONFIG_DIR, loginDir)
      assert.equal(call.init.env.BROWSER, 'true')
    }
    assert.deepEqual(world.prepared, [PREPARED_LOGIN[platform]])
    assert.match(world.messages.join('\n'), /isolated Claude login is ready/)
  })
}

test('a chosen browser is passed as one process-local executable without changing the parent environment', async () => {
  const world = fixture({ kind: 'claudeai', loginDir: SAVED_LOGIN.linux }, { env: { HOME: '/fixture', BROWSER: 'original-browser' } })
  world.deps.exec = (_command, args, init) => {
    world.calls.push({ args, init })
    return { status: 0, stdout: READY }
  }
  await world.run('--login', '--browser', '/Applications/Chosen Browser.app/Contents/MacOS/Browser')
  for (const call of world.calls) assert.equal(call.init.env.BROWSER, '/Applications/Chosen Browser.app/Contents/MacOS/Browser')
  assert.equal(world.deps.env.BROWSER, 'original-browser')
})

test('browser control options reject malformed or conflicting input before reading account data', async () => {
  let reads = 0
  const deps = { major: 22, platform: 'linux', env: {}, read: () => { reads++; throw Error('must not read') } }
  for (const args of [['--manual', '--manual'], ['--manual', '--browser', 'firefox'], ['--browser'], ['--browser', '--login'], ['--browser', 'a\nb'], ['--browser', 'a', '--browser', 'b']]) {
    await assert.rejects(runSetup(['personal', ...args], deps), /--manual|--browser/)
  }
  assert.equal(reads, 0)
})

test('expected-email mismatch after successful native login fails without claiming readiness', async () => {
  const world = fixture({ kind: 'claudeai', loginDir: SAVED_LOGIN.linux })
  world.deps.exec = () => ({ status: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"other@example.com"}' })
  await assert.rejects(world.run('--login', '--email', 'personal@example.com'), /Expected personal@example\.com, but Claude is signed in as other@example\.com[\s\S]*--login/)
  assert.equal(world.messages.some(message => /is ready|Then switch/.test(message)), false)
})

test('an existing different identity needs an explicit login instead of silently accepting or replacing it', async () => {
  const world = fixture({ kind: 'claudeai', loginDir: SAVED_LOGIN.linux })
  world.deps.exec = (_command, args) => {
    world.calls.push(args)
    return { status: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"other@example.com"}' }
  }
  await assert.rejects(world.run('--email', 'personal@example.com'), /other@example\.com[\s\S]*--login/)
  assert.deepEqual(world.calls, [['auth', 'status', '--json']])
  assert.equal(world.messages.some(message => /is ready/.test(message)), false)
})

test('an existing matching identity is reused without interactive login', async () => {
  const world = fixture({ kind: 'claudeai', loginDir: SAVED_LOGIN.linux })
  world.deps.exec = (_command, args) => {
    world.calls.push(args)
    return { status: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"personal@example.com"}' }
  }
  await world.run('--email', 'personal@example.com')
  assert.deepEqual(world.calls, [['auth', 'status', '--json']])
  assert.match(world.messages.join('\n'), /isolated Claude login is ready/)
})

test('an expected email cannot be verified using a missing or unsafe native identity', async () => {
  for (const email of [undefined, 'unsafe@example.com\ncredential-like-output']) {
    const world = fixture({ kind: 'claudeai', loginDir: SAVED_LOGIN.linux })
    world.deps.exec = () => ({ status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email }) })
    await assert.rejects(world.run('--login', '--email', 'personal@example.com'), error => {
      assert.match(error.message, /Expected personal@example\.com[\s\S]*email is unavailable[\s\S]*--login/)
      assert.equal(error.message.includes('credential-like-output'), false)
      return true
    })
    assert.equal(world.messages.some(message => /is ready/.test(message)), false)
  }
})

test('the browser email hint is rejected for setup tokens before credential operations', async () => {
  const world = fixture({ kind: 'claudeai-token', secret: { service: 'rice', account: 'personal' } })
  await assert.rejects(world.run('--email', 'personal@example.com'), /--email is supported only for claudeai browser login/)
  assert.deepEqual(world.calls, [])
  assert.deepEqual(world.prepared, [])
})

test('a third-party logged-in status cannot stand in for the isolated Claude subscription', async () => {
  const world = fixture({ kind: 'claudeai', loginDir: SAVED_LOGIN.linux }, { env: { HOME: '/fixture', CLAUDE_CODE_USE_ANTHROPIC_AWS: '1', CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: '1', CLAUDE_CODE_USE_MANTLE: '1', CLAUDE_CODE_USE_GATEWAY: '1', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '10', CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR: '11', CLAUDE_BG_AUTH_SNAPSHOT_PATH: '/fixture/snapshot' } })
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
  const world = fixture({ kind: 'claudeai', loginDir: SAVED_LOGIN.linux }, { exec: () => ({ status: 1, stdout: '{"loggedIn":false}' }) })
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
    assert.equal(world.calls[1].init.env.CLAUDE_CONFIG_DIR, PREPARED_LOGIN[platform])
    assert.deepEqual(world.prepared, [PREPARED_LOGIN[platform]])
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
  const deps = { major: 22, platform: 'linux', env: {}, read: () => { reads++; throw Error('unexpected') }, inspect: () => { throw Error('unexpected inspection') } }
  for (const args of [[], ['personal', 'extra'], ['--config-dir'], ['../bad'], ['--unknown'], ['--config-dir', '/a', '--config-dir', '/b', 'personal']]) await assert.rejects(runSetup(args, deps), /Usage:|needs a directory/)
  for (const args of [['personal', '--email'], ['personal', '--email', '--login'], ['personal', '--email', 'invalid'], ['personal', '--email', 'a@b\nunsafe'], ['personal', '--email', 'a@b', '--email', 'c@d']]) await assert.rejects(runSetup(args, deps), /--email/)
  await assert.rejects(runSetup(['personal'], { ...deps, major: 20 }), /22 or later/)
  await assert.rejects(runSetup(['personal'], { ...deps, platform: 'freebsd' }), /macOS, Linux/)
  assert.equal(reads, 0)
})

test('Windows browser setup uses USERPROFILE, drive-qualified credential storage and native login arguments', async () => {
  const calls = [], prepared = [], reads = [], inspected = []
  const loginDir = 'C:\\Users\\fixture user\\.claude\\rice-session-accounts\\logins\\personal'
  let ready = false
  await runSetup(['personal'], {
    platform: 'win32', major: 22, env: { USERPROFILE: 'C:\\Users\\fixture user', HOME: '/wrong-home', SystemRoot: 'C:\\Windows' },
    cwd: () => 'C:\\Users\\fixture user', script: 'C:\\plugin\\scripts\\account-setup.mjs',
    inspect: path => { inspected.push(path); return { directory: true, symlink: false } }, realpath: path => path,
    read: path => { reads.push(path); return JSON.stringify({ accounts: { personal: { kind: 'claudeai', loginDir } } }) },
    prepare: path => prepared.push(path), log: () => {},
    exec: (command, args, init) => {
      calls.push({ command, args, init })
      if (args[1] === 'login') ready = true
      return { status: ready ? 0 : 1, stdout: JSON.stringify({ loggedIn: ready, authMethod: ready ? 'claude.ai' : 'none', apiProvider: 'firstParty' }) }
    },
  })
  assert.deepEqual(inspected, ['C:\\Users\\fixture user\\.claude'])
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

test('Windows Credential Manager failures name their cause instead of a generic lock message', async () => {
  for (const [status, pattern] of [[WINDOWS_EXIT.CONSTRAINED_LANGUAGE, /ConstrainedLanguage/], [WINDOWS_EXIT.NO_LOGON_SESSION, /no interactive Windows sign-in/], [WINDOWS_EXIT.ACCESS_DENIED, /denied access/]]) {
    const world = fixture({ kind: 'claudeai-token', secret: { service: 'rice', account: 'personal' } }, { platform: 'win32', exec: () => ({ status, stdout: '' }), prompt: async () => { throw Error('must not prompt') } })
    await assert.rejects(world.run(), pattern)
  }
})

test('Windows rejects drive-relative login directories before preparing storage or launching authentication', async () => {
  const world = fixture({ kind: 'claudeai', loginDir: '\\relative-to-current-drive' }, { platform: 'win32' })
  await assert.rejects(world.run(), /absolute loginDir/)
  assert.deepEqual(world.prepared, [])
  assert.deepEqual(world.calls, [])
})

test('a requested unsupported Windows vendor store is rejected before login preparation', async () => {
  const world = fixture({ kind: 'claudeai', loginDir: SAVED_LOGIN.win32 }, { platform: 'win32', env: { USERPROFILE: 'C:\\fixture', FORCE_WINDOWS_CREDMAN: '1' } })
  await assert.rejects(world.run(), /FORCE_WINDOWS_CREDMAN/)
  assert.deepEqual(world.prepared, [])
  assert.deepEqual(world.calls, [])
})

// Item 3: setup prepares only folders it derives itself.

test('a saved loginDir that names another folder is refused before any folder or process is touched', async () => {
  for (const [platform, loginDir] of [
    ['linux', '/isolated login'],
    ['linux', '/etc'],
    ['linux', '/fixture/.claude/rice-session-accounts/logins/other'],
    ['linux', '/fixture/.claude/rice-session-accounts/logins/../logins/personal'],
    ['darwin', '/fixture/.claude/rice-session-accounts/logins/PERSONAL'],
    ['win32', 'C:\\Windows\\System32'],
    ['win32', 'D:\\fixture\\.claude\\rice-session-accounts\\logins\\personal'],
  ]) {
    const world = fixture({ kind: 'claudeai', loginDir }, { platform })
    await assert.rejects(world.run(), error => {
      assert.match(error.message, /setup only prepares the folder it derives/)
      assert.ok(error.message.includes(PREPARED_LOGIN[platform]), error.message)
      assert.match(error.message, /\/rice-account remove personal/)
      return true
    })
    assert.deepEqual(world.prepared, [])
    assert.deepEqual(world.calls, [])
  }
})

test('a saved loginDir is accepted in any separator or letter-case spelling Windows treats as the same folder', async () => {
  for (const loginDir of ['C:\\fixture\\.claude\\rice-session-accounts\\logins\\personal', 'c:/FIXTURE/.claude/rice-session-accounts/logins/Personal', 'C:\\fixture\\.claude\\rice-session-accounts\\logins\\personal\\']) {
    const world = fixture({ kind: 'claudeai', loginDir }, { platform: 'win32', exec: () => ({ status: 0, stdout: READY }) })
    await world.run()
    assert.deepEqual(world.prepared, [PREPARED_LOGIN.win32])
  }
})

test('a setup token folder is derived, and a saved token loginDir elsewhere is refused', async () => {
  const world = fixture({ kind: 'claudeai-token', loginDir: '/elsewhere', secret: { service: 'rice', account: 'personal' } }, { exec: () => ({ status: 1, stdout: '' }) })
  await assert.rejects(world.run(), /setup only prepares the folder it derives/)
  assert.deepEqual(world.prepared, [])
})

test('the config folder must be absolute, exist, be a folder, and not be a link out of the home folder', async () => {
  const account = { kind: 'claudeai', loginDir: SAVED_LOGIN.linux }
  const relative = fixture(account, { read: () => { throw Error('must not read') }, inspect: () => { throw Error('must not inspect') } })
  await assert.rejects(runSetup(['--config-dir', 'relative/.claude', 'personal'], relative.deps), /--config-dir must be an absolute path/)
  await assert.rejects(runSetup(['personal'], { ...relative.deps, env: { HOME: '/fixture', CLAUDE_CONFIG_DIR: '.claude' } }), /CLAUDE_CONFIG_DIR must be an absolute path/)
  await assert.rejects(runSetup(['--config-dir', 'C:relative', 'personal'], { ...relative.deps, platform: 'win32', env: { USERPROFILE: 'C:\\fixture' } }), /--config-dir must be an absolute path/)

  const missing = fixture(account, { inspect: () => undefined, read: () => { throw Error('must not read') } })
  await assert.rejects(missing.run(), /Cannot find the Claude config folder \/fixture\/\.claude\. First run \/rice-account add personal/)
  const file = fixture(account, { inspect: () => ({ directory: false, symlink: false }) })
  await assert.rejects(file.run(), /is not a folder/)

  const links = { '/fixture/.claude': '/srv/shared/claude', '/fixture': '/fixture' }
  const outside = fixture(account, { inspect: path => path === '/fixture/.claude' ? { directory: false, symlink: true } : { directory: true, symlink: false }, realpath: path => links[path] })
  await assert.rejects(outside.run(), /link to \/srv\/shared\/claude, outside your home folder \/fixture/)
  assert.deepEqual(outside.prepared, [])
  const insideLinks = { '/fixture/.claude': '/fixture/dotfiles/claude', '/fixture': '/fixture' }
  const inside = fixture(account, { inspect: path => path === '/fixture/.claude' ? { directory: false, symlink: true } : { directory: true, symlink: false }, realpath: path => insideLinks[path], exec: () => ({ status: 0, stdout: READY }) })
  await inside.run()
  assert.deepEqual(inside.prepared, [PREPARED_LOGIN.linux])

  const foreign = fixture(account, { uid: 501, inspect: () => ({ directory: true, symlink: false, uid: 0, mode: 0o40755 }) })
  await assert.rejects(foreign.run(), /belongs to another user/)
  const shared = fixture(account, { uid: 501, inspect: () => ({ directory: true, symlink: false, uid: 501, mode: 0o41777 }) })
  await assert.rejects(shared.run(), /can be changed by every user/)
})

test('the actual CLI exits nonzero with a useful missing-account error', () => {
  const result = spawnSync(process.execPath, ['scripts/account-setup.mjs', '--config-dir', '/nonexistent/rice-account-fixture', 'personal'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /First run \/rice-account add/)
  assert.equal(result.stdout, '')
  assert.equal(existsSync('/nonexistent/rice-account-fixture'), false)
})

// Item 4: names. Existing accounts keep the rule they were saved under.

test('the helper accepts every saved name, refuses Windows device names on Windows, and shares the plugin name rules', async () => {
  for (const name of ['list', 'toString', 'con']) {
    const loginDir = `/fixture/.claude/rice-session-accounts/logins/${name}`
    const deps = { ...fixture({}).deps, read: () => JSON.stringify({ accounts: { [name]: { kind: 'claudeai', loginDir } } }), exec: () => ({ status: 0, stdout: READY }) }
    await runSetup(['--config-dir', CONFIG.linux, name], deps)
  }
  for (const name of ['con', 'NUL.txt', 'lpt1', 'work.']) {
    const deps = { ...fixture({}, { platform: 'win32' }).deps, read: () => { throw Error('must not read') } }
    await assert.rejects(runSetup(['--config-dir', CONFIG.win32, name], deps), /cannot be a folder name on Windows/)
  }
  const deps = fixture({}).deps
  const prototype = { ...deps, read: () => '{"accounts":{}}' }
  await assert.rejects(runSetup(['--config-dir', CONFIG.linux, 'toString'], prototype), /toString is not saved/)
  await assert.rejects(runSetup(['--config-dir', CONFIG.linux, 'constructor'], { ...deps, read: () => '{"accounts":null}' }), /constructor is not saved/)
  assert.equal(isStoredAccountName('list'), true)
  assert.equal(isAccountName('list'), false)
  assert.match(accountNameProblem('aux'), /Windows device name/)
  assert.ok(RESERVED_NAMES.includes('setup-native'))
})

// Item 8: home and config folder discovery.

test('the home folder comes from HOME or USERPROFILE, else from the operating system, with spaces and non-ASCII names', () => {
  assert.equal(homeDirectory('linux', { HOME: '/home/Zoë Ånström' }), '/home/Zoë Ånström')
  assert.equal(homeDirectory('linux', {}, () => '/home/名 user'), '/home/名 user')
  assert.equal(homeDirectory('linux', { HOME: '' }, () => '/home/fallback'), '/home/fallback')
  assert.equal(homeDirectory('linux', { HOME: 'relative' }, () => '/home/fallback'), '/home/fallback')
  assert.equal(homeDirectory('darwin', {}, () => { throw Error('no passwd entry') }), undefined)
  assert.equal(homeDirectory('win32', { USERPROFILE: 'C:\\Users\\Zoë Ånström', HOME: 'C:\\other' }), 'C:\\Users\\Zoë Ånström')
  assert.equal(homeDirectory('win32', { HOME: '/c/Users/msys' }, () => 'C:\\Users\\from os'), 'C:\\Users\\from os')
  assert.equal(homeDirectory('win32', { HOME: 'D:\\Home Folder' }), 'D:\\Home Folder')
})

test('without --config-dir, setup reads CLAUDE_CONFIG_DIR, else <home>/.claude from the OS home when variables are unset', async () => {
  for (const [platform, env, homedir, expected] of [
    ['linux', {}, () => '/home/名 user', '/home/名 user/.claude'],
    ['darwin', { HOME: '/Users/Zoë Ånström' }, undefined, '/Users/Zoë Ånström/.claude'],
    ['linux', { HOME: '/home/me', CLAUDE_CONFIG_DIR: '/data/claude config/' }, undefined, '/data/claude config'],
    ['win32', {}, () => 'C:\\Users\\Zoë Ånström', 'C:\\Users\\Zoë Ånström\\.claude'],
    ['win32', { USERPROFILE: 'C:\\Users\\fixture user', CLAUDE_CONFIG_DIR: 'D:\\claude/' }, undefined, 'D:\\claude'],
  ]) {
    const reads = []
    const world = fixture({}, { platform, env, ...(homedir ? { homedir } : {}), read: path => { reads.push(path); throw Error('stop after the read') } })
    await assert.rejects(runSetup(['personal'], world.deps), /Cannot read accounts\.json/)
    const paths = platform === 'win32' ? '\\' : '/'
    assert.deepEqual(reads, [`${expected}${paths}rice-session-accounts${paths}accounts.json`])
    assert.equal(derivedLoginDir(expected, 'personal', platform), `${expected}${paths}rice-session-accounts${paths}logins${paths}personal`)
  }
  const homeless = fixture({}, { env: {}, homedir: () => { throw Error('no home') } })
  await assert.rejects(runSetup(['personal'], homeless.deps), /Cannot find your home folder/)
})

// Item 7: WSL.

test('WSL config folders on a Windows drive get a privacy warning; Linux folders and other hosts do not', async () => {
  assert.equal(isWsl('linux', { WSL_DISTRO_NAME: 'Ubuntu' }), true)
  assert.equal(isWsl('linux', {}, '5.15.167.4-microsoft-standard-WSL2'), true)
  assert.equal(isWsl('linux', {}, '6.8.0-generic'), false)
  assert.equal(isWsl('darwin', { WSL_DISTRO_NAME: 'Ubuntu' }), false)
  assert.equal(onWindowsDrive('/mnt/c/Users/me/.claude'), true)
  assert.equal(onWindowsDrive('/mnt/data/claude'), false)
  for (const [osRelease, configDir, warned] of [
    ['5.15.167.4-microsoft-standard-WSL2', '/mnt/c/Users/me/.claude', true],
    ['5.15.167.4-microsoft-standard-WSL2', '/home/me/.claude', false],
    ['6.8.0-generic', '/mnt/c/Users/me/.claude', false],
  ]) {
    const loginDir = `${configDir}/rice-session-accounts/logins/personal`
    const contexts = []
    const world = fixture({ kind: 'claudeai', loginDir }, { osRelease, exec: () => ({ status: 0, stdout: READY }), prepare: (path, context) => contexts.push(context) })
    await runSetup(['--config-dir', configDir, 'personal'], world.deps)
    const warning = world.messages.find(message => message.startsWith('Warning:'))
    assert.equal(Boolean(warning), warned, configDir)
    assert.equal(contexts[0].drvfs, warned)
    if (warned) assert.match(warning, /cannot be made private[\s\S]*Linux file system/)
  }
  // DrvFs reports every folder as 0777; the warning stands in for the world-writable refusal there, and only there.
  const drvfs = fixture({ kind: 'claudeai', loginDir: '/mnt/c/Users/me/.claude/rice-session-accounts/logins/personal' }, { osRelease: '5.15.167.4-microsoft-standard-WSL2', uid: 1000, inspect: () => ({ directory: true, symlink: false, uid: 1000, mode: 0o40777 }), exec: () => ({ status: 0, stdout: READY }) })
  await runSetup(['--config-dir', '/mnt/c/Users/me/.claude', 'personal'], drvfs.deps)
  assert.deepEqual(drvfs.prepared, ['/mnt/c/Users/me/.claude/rice-session-accounts/logins/personal'])
  const linuxSide = fixture({ kind: 'claudeai', loginDir: '/home/me/.claude/rice-session-accounts/logins/personal' }, { osRelease: '5.15.167.4-microsoft-standard-WSL2', uid: 1000, inspect: () => ({ directory: true, symlink: false, uid: 1000, mode: 0o40777 }) })
  await assert.rejects(runSetup(['--config-dir', '/home/me/.claude', 'personal'], linuxSide.deps), /can be changed by every user/)
})

test('Windows Node.js started from WSL is told to use a Linux Node.js before any file access', async () => {
  assert.equal(windowsNodeInWsl('win32', {}, '/home/me/.claude'), true)
  assert.equal(windowsNodeInWsl('win32', {}, 'C:\\Users\\me\\.claude', '\\\\wsl.localhost\\Ubuntu\\home\\me'), true)
  assert.equal(windowsNodeInWsl('win32', {}, 'C:\\Users\\me\\.claude', 'C:\\', '\\\\wsl$\\Ubuntu\\plugin\\scripts\\account-setup.mjs'), true)
  assert.equal(windowsNodeInWsl('win32', {}, 'C:\\Users\\me\\.claude', 'C:\\work'), false)
  assert.equal(windowsNodeInWsl('linux', {}, '/home/me/.claude'), false)
  for (const overrides of [{}, { cwd: () => '\\\\wsl.localhost\\Ubuntu\\home\\me' }]) {
    const world = fixture({ kind: 'claudeai', loginDir: SAVED_LOGIN.win32 }, { platform: 'win32', inspect: () => { throw Error('must not inspect') }, ...overrides })
    const args = overrides.cwd ? ['--config-dir', CONFIG.win32, 'personal'] : ['--config-dir', '/home/me/.claude', 'personal']
    await assert.rejects(runSetup(args, world.deps), /Windows Node\.js \(node\.exe\)[\s\S]*Linux Node\.js 22 or newer/)
  }
})

// Item 2: an ES5 entry that old Node.js versions can parse.

test('the entry is ES5 syntax with no static imports, and an old Node.js gets the friendly version message', () => {
  const entry = readFileSync('scripts/account-setup.mjs', 'utf8')
  const code = entry.replace(/^#!.*\n/, '').replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  for (const pattern of [/=>/, /\?\./, /\?\?/, /\bconst\b/, /\blet\b/, /`/, /\basync\b/, /\bawait\b/, /\bclass\b/, /\.\.\./, /^\s*import\s/m, /^\s*export\s/m]) {
    assert.equal(pattern.test(code), false, `entry uses ${pattern}`)
  }
  assert.match(code, /import\(''\)/)
  new Script(code)
  const root = mkdtempSync(join(tmpdir(), 'rice account node version '))
  try {
    const wrapper = join(root, 'old-node.cjs')
    writeFileSync(wrapper, `const real = process
const versions = Object.assign({}, real.versions, { node: process.env.RICE_FIXTURE_NODE_VERSION })
globalThis.process = new Proxy(real, {
  get(target, key) { return key === 'versions' ? versions : Reflect.get(target, key) },
  set(target, key, value) { target[key] = value; return true },
})
if (globalThis.process.versions.node !== process.env.RICE_FIXTURE_NODE_VERSION) throw new Error('the fixture could not stub the Node.js version')
`)
    for (const version of ['12.22.12', '16.20.2', '21.7.3']) {
      const result = spawnSync(process.execPath, ['--require', wrapper, 'scripts/account-setup.mjs', '--config-dir', '/nonexistent/rice-account-fixture', 'personal'], { encoding: 'utf8', env: { ...process.env, RICE_FIXTURE_NODE_VERSION: version }, timeout: 10_000 })
      assert.equal(result.status, 1, result.stderr)
      assert.equal(result.stdout, '')
      assert.ok(result.stderr.includes(`rice-session-accounts: Node.js 22 or newer is required (found ${version}). Install a current Node.js LTS release, open a new terminal, then rerun this command.\n`), result.stderr)
      assert.doesNotMatch(result.stderr, /SyntaxError|ERR_|Cannot find|accounts\.json/)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// Item 1: finding Claude Code on Windows without a shell.

const NPM_JS_SHIM = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n'
const NPM_EXE_SHIM = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n'
const NPM6_SHIM = '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n) ELSE (\r\n  @SETLOCAL\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n)\r\n'
const LOCAL_BIN_SHIM = NPM_JS_SHIM.replace('%dp0%\\node_modules\\@anthropic-ai', '%dp0%\\..\\@anthropic-ai')

function windowsWorld(files, env = {}) {
  const map = new Map(Object.entries(files).map(([path, text]) => [path.toLowerCase(), text]))
  return {
    platform: 'win32', execPath: 'C:\\Program Files\\nodejs\\node.exe',
    env: { Path: 'C:\\Windows\\System32;.;relative\\bin;"C:\\Users\\Zoë Ånström\\AppData\\Roaming\\npm"', PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS', SystemRoot: 'C:\\Windows', ...env },
    isFile: path => map.has(path.toLowerCase()),
    read: path => { const text = map.get(path.toLowerCase()); if (text === undefined) throw Error('ENOENT'); return text },
  }
}

const NPM_DIR = 'C:\\Users\\Zoë Ånström\\AppData\\Roaming\\npm'
const CLI = `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`
const PACKAGE_EXE = `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`

test('Windows PATH and PATHEXT are searched in order, without the current folder or non-runnable extensions', () => {
  assert.deepEqual(windowsPathEntries({ PATH: 'C:\\a; ;.;"C:\\b c";\\\\server\\share\\bin;D:relative' }), ['C:\\a', 'C:\\b c', '\\\\server\\share\\bin'])
  assert.deepEqual(windowsExtensions({ PATHEXT: '.JS;.CMD;.EXE;.cmd' }), ['.cmd', '.exe'])
  assert.deepEqual(windowsExtensions({}), ['.com', '.exe', '.bat', '.cmd'])
  assert.deepEqual(resolveClaude(windowsWorld({ '.\\claude.exe': 'x', [`${NPM_DIR}\\claude.js`]: 'x' })), { kind: 'missing', searched: ['claude.com', 'claude.exe', 'claude.bat', 'claude.cmd'] })
  assert.deepEqual(resolveClaude(windowsWorld({ 'C:\\Windows\\System32\\claude.exe': 'x', [`${NPM_DIR}\\claude.cmd`]: NPM_JS_SHIM })), { kind: 'direct', file: 'C:\\Windows\\System32\\claude.exe' })
  assert.equal(resolveClaude({ platform: 'linux', env: { PATH: '/bin' } }).file, 'claude')
})

test('an npm claude.cmd shim is mapped to the executable or cli.js it launches and run without a shell', () => {
  assert.deepEqual(resolveClaude(windowsWorld({ [`${NPM_DIR}\\claude.cmd`]: NPM_JS_SHIM, [CLI]: '' })), { kind: 'node', file: 'C:\\Program Files\\nodejs\\node.exe', script: CLI, shim: `${NPM_DIR}\\claude.cmd` })
  assert.equal(resolveClaude(windowsWorld({ [`${NPM_DIR}\\claude.cmd`]: NPM_JS_SHIM, [CLI]: '', [`${NPM_DIR}\\node.exe`]: '' })).file, `${NPM_DIR}\\node.exe`)
  assert.deepEqual(resolveClaude(windowsWorld({ [`${NPM_DIR}\\claude.cmd`]: NPM_EXE_SHIM, [PACKAGE_EXE]: '' })), { kind: 'direct', file: PACKAGE_EXE, shim: `${NPM_DIR}\\claude.cmd` })
  assert.equal(resolveClaude(windowsWorld({ [`${NPM_DIR}\\claude.cmd`]: NPM6_SHIM, [CLI]: '' })).script, CLI)
  const local = 'C:\\work\\node_modules\\.bin'
  const localCli = 'C:\\work\\node_modules\\@anthropic-ai\\claude-code\\cli.js'
  assert.equal(resolveClaude(windowsWorld({ [`${local}\\claude.cmd`]: LOCAL_BIN_SHIM, [localCli]: '' }, { Path: local })).script, localCli)
  assert.equal(shimTarget(`${NPM_DIR}\\claude.cmd`, NPM_JS_SHIM, () => false), undefined)
  assert.equal(shimTarget(`${NPM_DIR}\\claude.cmd`, '"%dp0%\\..\\..\\Windows\\System32\\calc.exe" %*', () => true), undefined)
  const invocation = claudeInvocation({ kind: 'node', file: 'C:\\node.exe', script: CLI }, ['auth', 'status', '--json'], { Path: 'C:\\a' })
  assert.deepEqual([invocation.file, invocation.args, invocation.windowsVerbatimArguments], ['C:\\node.exe', [CLI, 'auth', 'status', '--json'], undefined])
})

test('an unrecognized shim runs through cmd.exe with a fixed command line and every value in an environment variable', () => {
  const resolved = resolveClaude(windowsWorld({ [`${NPM_DIR}\\claude.cmd`]: '@echo off\r\n"%~dp0custom-claude.exe" %*\r\n' }))
  assert.deepEqual(resolved, { kind: 'cmd', file: 'C:\\Windows\\System32\\cmd.exe', shim: `${NPM_DIR}\\claude.cmd` })
  const email = 'a&calc^|%PATH%!x@example.com'
  const invocation = claudeInvocation(resolved, ['auth', 'login', '--claudeai', '--email', email], { Path: 'C:\\a', rice_accounts_claude_arg9: 'stale' })
  assert.equal(invocation.file, 'C:\\Windows\\System32\\cmd.exe')
  assert.equal(invocation.windowsVerbatimArguments, true)
  assert.deepEqual(invocation.args, ['/d', '/v:off', '/s', '/c', '""%RICE_ACCOUNTS_CLAUDE_SHIM%" "%RICE_ACCOUNTS_CLAUDE_ARG0%" "%RICE_ACCOUNTS_CLAUDE_ARG1%" "%RICE_ACCOUNTS_CLAUDE_ARG2%" "%RICE_ACCOUNTS_CLAUDE_ARG3%" "%RICE_ACCOUNTS_CLAUDE_ARG4%""'])
  assert.equal(invocation.args.join(' ').includes(email), false)
  assert.equal(invocation.args.join(' ').includes(NPM_DIR), false)
  assert.equal(invocation.env.RICE_ACCOUNTS_CLAUDE_SHIM, `${NPM_DIR}\\claude.cmd`)
  assert.equal(invocation.env.RICE_ACCOUNTS_CLAUDE_ARG4, email)
  assert.equal(invocation.env.rice_accounts_claude_arg9, undefined)
  assert.equal(invocation.env.Path, 'C:\\a')
  for (const value of ['say "hi"', '', 'line\nbreak']) assert.throws(() => claudeInvocation(resolved, ['auth', value], {}), /cannot pass through cmd\.exe safely/)
})

test('RICE_ACCOUNTS_CLAUDE overrides the search only with an absolute existing file', () => {
  assert.deepEqual(resolveClaude(windowsWorld({ 'D:\\tools\\claude.exe': '' }, { [CLAUDE_OVERRIDE]: 'D:\\tools\\claude.exe' })), { kind: 'direct', file: 'D:\\tools\\claude.exe', override: true })
  assert.equal(resolveClaude(windowsWorld({ 'D:\\npm\\claude.cmd': NPM_EXE_SHIM, 'D:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe': '' }, { rice_accounts_claude: 'D:\\npm\\claude.cmd' })).file, 'D:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe')
  for (const value of ['claude.exe', 'D:\\missing\\claude.exe']) assert.throws(() => resolveClaude(windowsWorld({}, { [CLAUDE_OVERRIDE]: value })), /must be the absolute path/)
  assert.deepEqual(resolveClaude({ platform: 'darwin', env: { [CLAUDE_OVERRIDE]: '/opt/claude/bin/claude' }, isFile: () => true }), { kind: 'direct', file: '/opt/claude/bin/claude', override: true })
  assert.throws(() => resolveClaude({ platform: 'linux', env: { [CLAUDE_OVERRIDE]: 'bin/claude' }, isFile: () => true }), /must be the absolute path/)
})

test('a resolved npm cli.js really starts under Node with its arguments intact', () => {
  const root = mkdtempSync(join(tmpdir(), 'rice claude shim '))
  try {
    const cli = join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    mkdirSync(dirname(cli), { recursive: true })
    writeFileSync(cli, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
    const invocation = claudeInvocation({ kind: 'node', file: process.execPath, script: cli }, ['auth', 'login', '--email', 'a&b %PATH% "q"@example.com'], process.env)
    const result = spawnSync(invocation.file, invocation.args, { env: invocation.env, encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), ['auth', 'login', '--email', 'a&b %PATH% "q"@example.com'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('on Windows, a real npm-style claude.cmd and a custom batch shim both run the helper end to end', { skip: process.platform !== 'win32' && 'needs native Windows' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'rice claude cmd '))
  try {
    const payload = join(root, 'fake claude.cjs')
    writeFileSync(payload, 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), config: process.env.CLAUDE_CONFIG_DIR }))\n')
    const npm = join(root, 'npm bin'), custom = join(root, 'custom bin')
    const cli = join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    mkdirSync(dirname(cli), { recursive: true })
    mkdirSync(custom, { recursive: true })
    copyFileSync(payload, cli)
    writeFileSync(join(npm, 'claude.cmd'), NPM_JS_SHIM)
    writeFileSync(join(custom, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${payload}" %*\r\n`)
    const email = 'a&b^c%PATH%!d@example.com'
    for (const bin of [npm, custom]) {
      const env = { ...process.env }
      for (const key of Object.keys(env)) if (key.toLowerCase() === 'path' || key.toUpperCase() === CLAUDE_OVERRIDE) delete env[key]
      env.Path = `${bin};${process.env.SystemRoot}\\System32`
      const resolved = resolveClaude({ platform: 'win32', env })
      assert.equal(resolved.kind, bin === npm ? 'node' : 'cmd')
      const invocation = claudeInvocation(resolved, ['auth', 'login', '--email', email], env)
      const result = spawnSync(invocation.file, invocation.args, { env: invocation.env, encoding: 'utf8', timeout: 20_000, windowsVerbatimArguments: invocation.windowsVerbatimArguments })
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout).argv, ['auth', 'login', '--email', email])
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// Item 5: quoting for each target shell.

/** sh, dash, bash and zsh read one word: single quotes are literal, a backslash outside them escapes one character. */
function readPosixWord(word) {
  let out = '', at = 0
  while (at < word.length) {
    const char = word[at]
    if (char === "'") {
      const end = word.indexOf("'", at + 1)
      if (end < 0) throw Error('unterminated quote')
      out += word.slice(at + 1, end)
      at = end + 1
    } else if (char === '\\') { if (at + 1 >= word.length) throw Error('dangling escape'); out += word[at + 1]; at += 2 }
    else if (/[\s$`"*?[\]{}()|;&<>~#%!=]/.test(char)) throw Error(`unquoted ${char}`)
    else { out += char; at += 1 }
  }
  return out
}

/** fish reads \\ and \' as escapes inside single quotes; outside, a backslash escapes one character. */
function readFishWord(word) {
  let out = '', at = 0
  while (at < word.length) {
    const char = word[at]
    if (char === "'") {
      at += 1
      for (;;) {
        if (at >= word.length) throw Error('unterminated quote')
        if (word[at] === '\\' && (word[at + 1] === '\\' || word[at + 1] === "'")) { out += word[at + 1]; at += 2; continue }
        if (word[at] === "'") { at += 1; break }
        out += word[at]; at += 1
      }
    } else if (char === '\\') { if (at + 1 >= word.length) throw Error('dangling escape'); out += word[at + 1]; at += 2 }
    else if (/[\s$`"*?[\]{}()|;&<>~#%]/.test(char)) throw Error(`unquoted ${char}`)
    else { out += char; at += 1 }
  }
  return out
}

/** PowerShell single-quoted string: any of five quote characters ends it, and two in a row stand for the second. */
function readPowerShellWord(word) {
  const quote = /['\u2018\u2019\u201a\u201b]/
  if (!quote.test(word[0] ?? '')) throw Error('not quoted')
  let out = '', at = 1
  for (;;) {
    if (at >= word.length) throw Error('unterminated quote')
    if (quote.test(word[at])) {
      if (at + 1 < word.length && quote.test(word[at + 1])) { out += word[at + 1]; at += 2; continue }
      at += 1
      break
    }
    out += word[at]; at += 1
  }
  if (at !== word.length) throw Error('text after the closing quote')
  return out
}

/** cmd.exe: a %NAME% pair could expand, ^ escapes outside quotes; then the Microsoft C runtime splits arguments. */
function readCmdWord(word) {
  if (/%[A-Za-z0-9_]+%/.test(word)) throw Error('expandable variable')
  let line = '', quoted = false
  for (let at = 0; at < word.length; at++) {
    const char = word[at]
    if (char === '"') { quoted = !quoted; line += char }
    else if (!quoted && char === '^') { line += word[at + 1] ?? ''; at += 1 }
    else if (!quoted && /[&|<>()\s]/.test(char)) throw Error(`unquoted ${char}`)
    else line += char
  }
  let out = '', inside = false
  for (let at = 0; at < line.length;) {
    let slashes = 0
    while (line[at] === '\\') { slashes += 1; at += 1 }
    if (line[at] === '"') {
      out += '\\'.repeat(Math.floor(slashes / 2))
      if (slashes % 2) out += '"'
      else inside = !inside
      at += 1
    } else {
      out += '\\'.repeat(slashes)
      if (at < line.length) {
        if (!inside && /\s/.test(line[at])) throw Error('more than one argument')
        out += line[at]
        at += 1
      }
    }
  }
  return out
}

const QUOTING_VALUES = [
  'plain', 'with space', "it's", "''", "\\'", 'a\\b', 'trailing\\', '\\\\server\\share', 'C:\\Users\\Zoë Ånström\\.claude',
  '$HOME', '${HOME}', '`id`', '$(id)', '%PATH%', '%', '100%', '!event', '!!', 'a&b|c<d>e^f', '*?[x]', '~/x', '{a,b}', '; rm', '#hash', '=equals', '-dash',
  '\u2018left\u2019 right', 'it\u2019s', '\u201alow\u201b', 'é名', '"double"', '',
]

test('each quoting function gives one word its shell reads back exactly', () => {
  for (const value of QUOTING_VALUES) {
    assert.equal(readPosixWord(quotePosix(value)), value, `posix ${value}`)
    assert.equal(readPosixWord(quotePortable(value)), value, `portable in sh ${value}`)
    assert.equal(readFishWord(quotePortable(value)), value, `portable in fish ${value}`)
    assert.equal(readFishWord(quoteFish(value)), value, `fish ${value}`)
    assert.equal(readPowerShellWord(quotePowerShell(value)), value, `powershell ${value}`)
    if (!value.includes('"') && value !== '') assert.equal(readCmdWord(quoteCmd(value)), value, `cmd ${value}`)
  }
})

test('quoting tables for unicode quotes, backslashes, $, backticks, % and !', () => {
  for (const [shell, value, expected] of [
    ['portable', "it's", "'it'\\''s'"],
    ['portable', 'a\\b', "'a'\\\\'b'"],
    ['portable', 'trailing\\', "'trailing'\\\\"],
    ['portable', '', "''"],
    ['portable', '$HOME `id` 100% !x', "'$HOME `id` 100% !x'"],
    ['posix', 'a\\b', "'a\\b'"],
    ['posix', "it's", "'it'\\''s'"],
    ['fish', 'a\\b', "'a\\\\b'"],
    ['fish', "it's", "'it\\'s'"],
    ['powershell', "it's", "'it''s'"],
    ['powershell', 'it\u2019s', "'it\u2019\u2019s'"],
    ['powershell', '\u2018x\u201b', "'\u2018\u2018x\u201b\u201b'"],
    ['powershell', '$HOME `id` "q"', "'$HOME `id` \"q\"'"],
    ['cmd', '100%', '"100"^%""'],
    ['cmd', '%PATH%', '""^%"PATH"^%""'],
    ['cmd', 'C:\\dir with space\\', '"C:\\dir with space\\\\"'],
    ['cmd', 'a&b!c', '"a&b!c"'],
  ]) assert.equal(quoteFor(shell, value), expected, `${shell} ${value}`)
  for (const shell of ['portable', 'posix', 'fish', 'powershell', 'cmd']) {
    for (const value of ['line\nbreak', 'carriage\rreturn', 'nul\u0000', 'tab\there', 'escape\u001b[31m', 'separator\u2028']) {
      assert.throws(() => quoteFor(shell, value), UnquotableError, `${shell} ${JSON.stringify(value)}`)
    }
  }
  assert.throws(() => quoteCmd('say "hi"'), UnquotableError)
  assert.throws(() => quoteFor('csh', 'x'), UnquotableError)
})

function shellAvailable(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 })
  return !result.error && result.status === 0
}

const POSIX_SHELLS = process.platform === 'win32' ? [] : [
  ['sh', ['-c']], ['dash', ['-c']], ['bash', ['--norc', '--noprofile', '-c']], ['zsh', ['-f', '-c']], ['fish', ['--no-config', '-c']],
].filter(([command, flags]) => shellAvailable(command, [...flags, 'exit 0']))
const SHELL_ENV = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/' }

test('installed POSIX shells and fish read the portable form back exactly', { skip: POSIX_SHELLS.length === 0 && 'no POSIX shell available' }, () => {
  for (const [command, flags] of POSIX_SHELLS) {
    for (const value of QUOTING_VALUES) {
      const result = spawnSync(command, [...flags, `printf '%s' ${quotePortable(value)}`], { encoding: 'utf8', env: SHELL_ENV, timeout: 10_000 })
      assert.equal(result.status, 0, `${command}: ${result.stderr}`)
      assert.equal(result.stdout, value, `${command} ${JSON.stringify(value)}`)
    }
  }
})

const POWERSHELL = ['pwsh', ...(process.platform === 'win32' ? ['powershell'] : [])].find(command => shellAvailable(command, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']))

test('an installed PowerShell reads the PowerShell form back exactly, including unicode quotes', { skip: !POWERSHELL && 'no PowerShell available' }, () => {
  for (const value of QUOTING_VALUES) {
    const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::Out.Write(${quotePowerShell(value)})`
    const result = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 30_000 })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, value, JSON.stringify(value))
  }
})

test('Command Prompt passes the cmd form to a program exactly', { skip: process.platform !== 'win32' && 'needs native Windows' }, () => {
  const comspec = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
  for (const value of QUOTING_VALUES.filter(each => !each.includes('"') && each !== '')) {
    const line = `"${process.execPath}" -e "process.stdout.write(process.argv[1])" ${quoteCmd(value)}`
    const result = spawnSync(comspec, ['/d', '/v:off', '/s', '/c', `"${line}"`], { encoding: 'utf8', windowsVerbatimArguments: true, timeout: 20_000 })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, value, JSON.stringify(value))
  }
})

const setupModule = process.features?.typescript ? await import('../hooks/setup.ts').catch(() => undefined) : undefined
const TRICKY_FOLDER = "it's a \\ \"dir\" $HOME `id` 100% !x 名"

test('the printed setup and sign-out commands run correctly in every installed POSIX shell', { skip: (!setupModule && 'this Node.js cannot load hooks/setup.ts') || (POSIX_SHELLS.length === 0 && 'no POSIX shell available') }, () => {
  const root = mkdtempSync(join(tmpdir(), 'rice printed commands '))
  try {
    // Node refuses to load an .mjs file from a folder whose path holds a backslash (an encoded %5C),
    // so the script's own folder keeps every other hostile character and the config folder keeps the backslash.
    const plugin = join(root, TRICKY_FOLDER.replace(' \\ ', ' '))
    const bin = join(root, 'bin')
    mkdirSync(join(plugin, 'scripts'), { recursive: true })
    mkdirSync(bin)
    writeFileSync(join(plugin, 'scripts', 'account-setup.mjs'), 'process.stdout.write(JSON.stringify({ script: process.argv[1], args: process.argv.slice(2) }))\n')
    writeFileSync(join(bin, 'claude'), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ args: process.argv.slice(2), config: process.env.CLAUDE_CONFIG_DIR, storage: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, nested: process.env.CLAUDECODE ?? null }))\n`)
    chmodSync(join(bin, 'claude'), 0o700)
    const configDir = join(root, `config ${TRICKY_FOLDER}`)
    const loginDir = join(configDir, 'rice-session-accounts', 'logins', 'personal')
    const env = { ...SHELL_ENV, PATH: `${bin}${delimiter}${dirname(process.execPath)}${delimiter}${SHELL_ENV.PATH}`, CLAUDECODE: '1' }
    for (const [command, flags] of POSIX_SHELLS) {
      const setup = spawnSync(command, [...flags, setupModule.setupCommand(plugin, `${configDir}/`, 'personal')], { encoding: 'utf8', env, timeout: 10_000 })
      assert.equal(setup.status, 0, `${command}: ${setup.stderr}`)
      assert.deepEqual(JSON.parse(setup.stdout), { script: join(plugin, 'scripts', 'account-setup.mjs'), args: ['--config-dir', configDir, 'personal'] })
      const signOut = spawnSync(command, [...flags, setupModule.signOutHint(loginDir, 'posix')], { encoding: 'utf8', env, timeout: 10_000 })
      assert.equal(signOut.status, 0, `${command}: ${signOut.stderr}`)
      const seen = JSON.parse(signOut.stdout)
      assert.deepEqual(seen.args, ['auth', 'logout'])
      assert.equal(seen.config, loginDir)
      assert.equal(seen.storage, loginDir)
      assert.ok(!seen.nested, `${command} left CLAUDECODE set`)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// Item 6: Windows payload structure, checked on every host; scripts/proof-windows-storage.mjs runs them on Windows.

test('the Windows payloads guard ConstrainedLanguage first, repair existing folders, expand short names and keep distinct exits', () => {
  for (const payload of [WINDOWS_PRIVATE_DIRECTORY, WINDOWS_CREDENTIAL_STORE]) {
    assert.equal(payload.includes('${'), false)
    assert.equal(payload.includes('`'), false)
    assert.equal((payload.match(/\{/g) ?? []).length, (payload.match(/\}/g) ?? []).length)
    assert.ok(payload.indexOf("LanguageMode -ne 'FullLanguage'") < payload.indexOf('[Console]::InputEncoding'))
    assert.match(payload, /exit 49/)
    assert.match(payload, /\$code = 48/)
    assert.match(payload, /\$code = 51/)
    assert.match(payload, /\$code = 52/)
    assert.match(payload, /exit \$code/)
    assert.equal(/\n\s*(?:else|elseif)\b/.test(payload), false, 'else must follow its closing brace on the same line')
  }
  assert.match(WINDOWS_PRIVATE_DIRECTORY, /SetAccessControl\(\$path, \$repair\)/)
  assert.match(WINDOWS_PRIVATE_DIRECTORY, /GetFileSystemInfos\(\$part\)/)
  assert.match(WINDOWS_PRIVATE_DIRECTORY, /\$path\.Length -ge 248/)
  assert.match(WINDOWS_PRIVATE_DIRECTORY, /S-1-5-18/)
  assert.match(WINDOWS_CREDENTIAL_STORE, /Add-Type/)
  assert.match(WINDOWS_CREDENTIAL_STORE, /\$code = 53/)
  const messages = [WINDOWS_EXIT.PATH_TOO_LONG, WINDOWS_EXIT.CONSTRAINED_LANGUAGE, WINDOWS_EXIT.ACCESS_DENIED, WINDOWS_EXIT.NOT_FOUND, WINDOWS_EXIT.NO_LOGON_SESSION, WINDOWS_EXIT.FAILED].map(code => windowsStoreProblem(code))
  assert.equal(new Set(messages).size, messages.length)
  assert.match(messages[0], /too long[\s\S]*247 characters/)
  assert.match(messages[1], /ConstrainedLanguage/)
  assert.match(messages[2], /denied access/)
  assert.match(messages[3], /does not exist/)
  assert.match(windowsStoreProblem(46, 'the isolated login folder', 'The login folder is a link, junction or file, not a folder.'), /link, junction or file/)
})

test('the actual terminal helper isolates native subprocess auth and resumes from paths containing spaces', () => {
  const root = mkdtempSync(join(tmpdir(), 'rice account setup '))
  try {
    const configDir = join(root, 'main config'), bin = join(root, 'bin')
    const loginDir = join(configDir, 'rice-session-accounts', 'logins', 'personal')
    mkdirSync(join(configDir, 'rice-session-accounts'), { recursive: true })
    mkdirSync(bin)
    const configPath = join(configDir, 'rice-session-accounts', 'accounts.json')
    const config = JSON.stringify({ accounts: { personal: { kind: 'claudeai', loginDir } } })
    writeFileSync(configPath, config)
    const payloadPath = join(root, 'fixture auth.cjs')
    const payload = `const { existsSync, writeFileSync } = require('node:fs');
const { basename, join } = require('node:path');
module.exports = ([a, b]) => {
  const e = process.env;
  if (e.CLAUDE_CONFIG_DIR !== e.CLAUDE_SECURESTORAGE_CONFIG_DIR || e.CLAUDECODE || e.CLAUDE_CODE_OAUTH_TOKEN || e.CLAUDE_CODE_USE_MANTLE || e.CLAUDE_BG_AUTH_SNAPSHOT_PATH) process.exit(12);
  const p = join(e.CLAUDE_CONFIG_DIR, 'fixture-auth-ready');
  if (a === 'auth' && b === 'login') { writeFileSync(p, 'ready'); console.log('fixture native login'); }
  else if (a === 'auth' && b === 'status') { const ok = existsSync(p); console.log(JSON.stringify({ loggedIn: ok, authMethod: ok ? 'claude.ai' : 'none', apiProvider: 'firstParty', email: ok ? 'other@example.com' : undefined })); process.exitCode = ok ? 0 : 1; }
  else process.exit(13);
};
if (basename(process.argv[1] ?? '') === 'auth') { module.exports(['auth', ...process.argv.slice(2)]); process.exit(process.exitCode ?? 0); }
`
    new Script(payload, { filename: payloadPath })
    writeFileSync(payloadPath, payload)
    const preload = `--require ${JSON.stringify(payloadPath.replaceAll('\\', '/'))}`
    const env = { ...process.env, CLAUDECODE: '1', CLAUDE_CODE_OAUTH_TOKEN: 'fixture-parent-token', CLAUDE_CODE_USE_MANTLE: '1', CLAUDE_BG_AUTH_SNAPSHOT_PATH: '/fixture-parent-snapshot' }
    const inheritedPath = process.env.PATH ?? process.env.Path ?? ''
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path' || key.toUpperCase() === CLAUDE_OVERRIDE) delete env[key]
    env.PATH = `${bin}${delimiter}${inheritedPath}`
    if (process.platform === 'win32') {
      // CreateProcess needs a real executable. This owned copy uses the same
      // synthetic auth code through a test-only preload, without a shell.
      copyFileSync(process.execPath, join(bin, 'claude.exe'))
      env.NODE_OPTIONS = preload
    } else {
      const fake = `#!${process.execPath}\nrequire(${JSON.stringify(payloadPath)})(process.argv.slice(2));\n`
      new Script(fake, { filename: join(bin, 'claude') })
      writeFileSync(join(bin, 'claude'), fake)
      chmodSync(join(bin, 'claude'), 0o700)
    }
    // Exercise the Windows preload prerequisite on every host, before Node
    // tries to resolve the deliberately absent script named "auth".
    const probe = spawnSync(process.execPath, ['auth', 'status', '--json'], { env: { ...loginEnvironment(env, loginDir), NODE_OPTIONS: preload }, encoding: 'utf8', timeout: 10_000 })
    assert.equal(probe.status, 1, probe.stderr)
    assert.equal(JSON.parse(probe.stdout).loggedIn, false)
    const args = [resolve('scripts/account-setup.mjs'), '--config-dir', configDir, 'personal']
    const first = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 10_000 })
    assert.equal(first.status, 0, first.stderr)
    assert.match(first.stdout, /fixture native login/)
    assert.equal(existsSync(join(configDir, 'fixture-auth-ready')), false)
    assert.equal(existsSync(join(loginDir, 'fixture-auth-ready')), true)
    if (process.platform !== 'win32') assert.equal(statSync(loginDir).mode & 0o777, 0o700)
    assert.equal(readFileSync(configPath, 'utf8'), config)
    const second = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 10_000 })
    assert.equal(second.status, 0, second.stderr)
    assert.equal(second.stdout.includes('fixture native login'), false)
    assert.equal(readFileSync(configPath, 'utf8'), config)
    const mismatch = spawnSync(process.execPath, [...args, '--login', '--email', 'personal@example.com'], { env, encoding: 'utf8', timeout: 10_000 })
    assert.equal(mismatch.status, 1, mismatch.stderr)
    assert.match(mismatch.stdout, /fixture native login/)
    assert.equal(/is ready|Then switch/.test(mismatch.stdout), false)
    assert.match(mismatch.stderr, /Expected personal@example\.com, but Claude is signed in as other@example\.com[\s\S]*--login/)
    assert.equal(readFileSync(configPath, 'utf8'), config)
    // A loginDir edited to point elsewhere is refused without creating or changing that folder.
    const elsewhere = join(root, 'elsewhere')
    writeFileSync(configPath, JSON.stringify({ accounts: { personal: { kind: 'claudeai', loginDir: elsewhere } } }))
    const refused = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 10_000 })
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /setup only prepares the folder it derives/)
    assert.equal(existsSync(elsewhere), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
