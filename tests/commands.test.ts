import type { CommandRunInput, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { fixturePath } from './fixture-path'

import type { Config } from '../hooks/config'
import { defaultConfig, pathsFor, serializeConfig } from '../hooks/config'

const configDir = '/fixture/home/.claude'
const configPath = pathsFor(configDir).config
const LOCK_MAKE = 'mkdir -p "$(dirname "$0")" && mkdir "$0"'

function command(args: string): CommandRunInput {
  return { command: 'rice-account', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } }
}

function isLockOrPlatform(argv: readonly string[]): boolean {
  return argv[0] === '/usr/bin/uname' || argv[0] === '/bin/sh' && (argv[2] === LOCK_MAKE || argv[2]?.includes('rmdir') === true)
}

/** All account, credential and process effects stay inside the native test host. */
function fixture(on: On, initial?: Config, variables: Record<string, string> = { HOME: '/fixture/home', USER: 'fixture', CLAUDE_CONFIG_DIR: configDir }) {
  const files = new Map<string, string>(initial ? [[configPath, serializeConfig(initial)]] : [])
  const reads: string[] = []
  const writes: { path: string; text: string }[] = []
  const processes: (readonly string[])[] = []
  const locks: string[] = []
  let onLock: (() => void) | undefined
  mock.env(on, variables)
  mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('state.set', () => ({ value: { isSet: true, version: 1 } }))
  on('fs.exists', (_host, input) => ({ value: files.has(fixturePath(input.path)) }))
  on('fs.read', (_host, input) => {
    reads.push(fixturePath(input.path))
    const text = files.get(fixturePath(input.path))
    if (text === undefined) throw new Error('ENOENT: isolated fixture file')
    return { value: text }
  })
  on('fs.write', (_host, input) => {
    writes.push({ ...input, path: fixturePath(input.path) })
    files.set(fixturePath(input.path), input.text)
    return { value: undefined }
  })
  on('fs.stat', () => { throw new Error('ENOENT: isolated fixture file') })
  on('fs.list', () => ({ value: [] }))
  // No settings override the account: a switch is checked against them.
  on('settings.read', () => ({ value: {} }))
  on('process.run', (_host, input) => {
    processes.push(input.argv)
    if (input.argv[0] === '/usr/bin/uname' && input.argv[1] === '-s') {
      return { value: { exitCode: 0, stdout: 'Linux\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (input.argv[0] === '/bin/sh' && input.argv[2] === LOCK_MAKE) {
      locks.push(fixturePath(input.argv[3] ?? ''))
      onLock?.()
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (input.argv.length === 5 && input.argv[0] === 'node' && input.argv[1] === '-e' && input.argv[3] === 'read'
      && input.argv[4] === '/fixture/separate-existing-login/.credentials.json') {
      return { value: { exitCode: 44, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (input.argv.length === 5 && input.argv[0] === 'node' && input.argv[1] === '-e' && input.argv[3] === 'examine'
      && input.argv[4] === '/fixture/separate-existing-login/.credentials.json') {
      return { value: { exitCode: 0, stdout: '{"stored":null,"pending":null}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 127, stdout: '', stderr: 'No credential executables in this Linux fixture', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* () { throw new Error('The command fixture must not start a process') })
  on('http.fetch', () => { throw new Error('The command fixture must not make a network request') })

  return {
    files,
    reads,
    writes,
    processes,
    locks,
    /** Runs while the config lock is taken: another session's write that lands just before this one's. */
    whenLocked(run: () => void) { onLock = run },
    saved: () => JSON.parse(files.get(configPath) ?? '{}') as Config,
  }
}

function savedLogin(): Config {
  return {
    ...defaultConfig(),
    accounts: {
      ...defaultConfig().accounts,
      'personal-live': {
        kind: 'claudeai',
        loginDir: '/fixture/separate-existing-login',
        label: 'Personal subscription',
        models: { sonnet: 'account-sonnet' },
      },
    },
  }
}

function setupCommand(text: string): string {
  const commands = text.split('\n').filter(line => line.includes('scripts/account-setup.mjs'))
  expect(commands.length).toBe(1)
  expect(commands[0]).toContain('--config-dir')
  expect(commands[0]).toContain(configDir)
  expect(commands[0]).toContain('personal-live')
  return commands[0] ?? ''
}

test('add defaults to an isolated claude.ai login and prints one terminal setup command', async ($, on) => {
  const world = fixture(on)
  const result = await $.command.run(command('add personal-live'))
  expect(world.saved().accounts['personal-live']).toEqual({
    kind: 'claudeai',
    loginDir: `${configDir}/rice-session-accounts/logins/personal-live`,
  })
  expect(world.writes.length).toBe(1)
  setupCommand(result.text ?? '')
  // accounts.json is changed under a lock beside it; nothing else runs.
  expect(world.locks).toEqual([`${configPath}.lock`])
  expect(world.processes.filter(argv => !isLockOrPlatform(argv))).toEqual([])
})

test('an edit made by another session while this one waited for the lock is kept', async ($, on) => {
  const world = fixture(on, savedLogin())
  world.whenLocked(() => {
    const other = JSON.parse(world.files.get(configPath) ?? '{}') as { accounts: Record<string, unknown> }
    other.accounts['other-session'] = { kind: 'claudeai', loginDir: '/fixture/other-session' }
    world.files.set(configPath, JSON.stringify(other))
  })
  await $.command.run(command('add second-account'))
  expect(Object.keys(world.saved().accounts).sort()).toEqual(['login', 'other-session', 'personal-live', 'second-account'])
})

test('setup repeats the saved account helper command without changing its account', async ($, on) => {
  const initial = savedLogin()
  const world = fixture(on, initial)
  const first = await $.command.run(command('setup personal-live'))
  const second = await $.command.run(command('setup personal-live'))
  expect(setupCommand(second.text ?? '')).toBe(setupCommand(first.text ?? ''))
  expect(world.saved()).toEqual(initial)
  expect(world.writes).toEqual([])
  expect(world.processes).toEqual([])
})

test('setup of an unsaved name says to add it first', async ($, on) => {
  const world = fixture(on, savedLogin())
  const result = await $.command.run(command('setup new-account'))
  expect(result.text).toBe('new-account is not saved. Run /rice-account add new-account first.')
  expect(world.writes).toEqual([])
  expect(world.processes).toEqual([])
})

test('native setup refuses the withdrawn launcher path without starting a process', async ($, on) => {
  const world = fixture(on)
  const result = await $.command.run(command('setup-native "/owned/runtime with spaces/claude"'))
  expect(world.processes).toEqual([])
  expect(result.text ?? '').toContain('ordinary claude')
  expect(world.writes).toEqual([])
})

for (const args of ['add personal-live', 'add personal-live claudeai']) {
  test(`repeating ${args} preserves the existing login folder and account options`, async ($, on) => {
    const initial = savedLogin()
    const world = fixture(on, initial)
    const result = await $.command.run(command(args))
    setupCommand(result.text ?? '')
    expect(world.saved()).toEqual(initial)
    expect(world.writes).toEqual([])
    expect(result.text ?? '').not.toContain('/rice-account remove')
  })
}

test('a conflicting account kind is refused without telling the user to remove their login', async ($, on) => {
  const initial = savedLogin()
  const world = fixture(on, initial)
  const result = await $.command.run(command('add personal-live claudeai-token'))
  expect(result.text ?? '').toContain('already saved as claudeai')
  expect(result.text ?? '').toContain('/rice-account setup personal-live')
  expect(result.text ?? '').not.toContain('/rice-account remove')
  expect(world.saved()).toEqual(initial)
  expect(world.writes).toEqual([])
})

for (const [args, problem] of [
  ['add personal-live claudeai lable=Personal', 'Unknown option'],
  ['add personal-live claudeai unexpected', 'Expected key=value'],
  ['add personal-live claudeai label=', 'Expected key=value'],
  ['add personal-live claudeai label=One label=Two', 'Repeated option'],
] as const) {
  test(`${args} rejects the invalid option before saving`, async ($, on) => {
    const world = fixture(on)
    const result = await $.command.run(command(args))
    expect(result.text ?? '').toContain(problem)
    expect(world.files.has(configPath)).toBe(false)
    expect(world.writes).toEqual([])
    expect(world.processes).toEqual([])
  })
}

for (const args of ['setup personal-live unexpected', 'personal-live unexpected', 'use personal-live unexpected']) {
  test(`${args} refuses extra arguments without changing the saved account`, async ($, on) => {
    const initial = savedLogin()
    const world = fixture(on, initial)
    const result = await $.command.run(command(args))
    expect(result.text ?? '').toContain('Usage:')
    expect(world.saved()).toEqual(initial)
    expect(world.writes).toEqual([])
    expect(world.processes).toEqual([])
  })
}

for (const [args, usage] of [
  ['list extra', '/rice-account list'], ['usage extra', '/rice-account usage'], ['check one two', '/rice-account check [name]'],
  ['default extra', '/rice-account default'], ['use', '/rice-account use <name>'], ['remove', '/rice-account remove <name>'],
  ['remove one two', '/rice-account remove <name>'], ['set-default', '/rice-account set-default <name>'], ['setup', '/rice-account setup <name>'],
  ['add', '/rice-account add <name>'],
] as const) {
  test(`${args} answers with its usage line and changes nothing`, async ($, on) => {
    const initial = savedLogin()
    const world = fixture(on, initial)
    const result = await $.command.run(command(args))
    expect(result.text ?? '').toContain(`Usage: ${usage}`)
    expect(result.text ?? '').toContain('/rice-account help')
    expect(world.saved()).toEqual(initial)
    expect(world.writes).toEqual([])
    expect(world.processes).toEqual([])
  })
}

for (const args of ['help', '--help', '-h', '?']) {
  test(`${args} lists every subcommand without reading or changing anything`, async ($, on) => {
    const world = fixture(on, savedLogin())
    const text = (await $.command.run(command(args))).text ?? ''
    for (const usage of ['/rice-account <name>', 'use <name>', 'list', 'usage', 'check [name]', 'add <name> [kind]', 'setup <name>', 'remove <name>', 'default', 'set-default <name>', 'setup-native', 'help']) {
      expect(text).toContain(usage)
    }
    expect(text).toContain('this session only')
    expect(world.reads).toEqual([])
    expect(world.writes).toEqual([])
    expect(world.processes).toEqual([])
  })
}

test('use reaches a saved account by name, the same as the bare name', async ($, on) => {
  const world = fixture(on, savedLogin())
  const bare = await $.command.run(command('personal-live'))
  const used = await $.command.run(command('use personal-live'))
  expect(used.text).toBe(bare.text)
  expect(used.text ?? '').toContain('/rice-account setup personal-live')
  expect(world.writes).toEqual([])
})

test('remove and set-default edit accounts.json under its lock', async ($, on) => {
  const initial = savedLogin()
  initial.accounts['spare'] = { kind: 'claudeai', loginDir: '/fixture/spare-login' }
  const world = fixture(on, initial)
  expect((await $.command.run(command('set-default spare'))).text ?? '').toContain('The saved default account is now spare.')
  expect(world.saved().default).toBe('spare')
  const removed = (await $.command.run(command('remove personal-live'))).text ?? ''
  expect(removed).toContain('Removed personal-live from accounts.json.')
  expect(removed).toContain('Sessions already using it keep it')
  expect(Object.keys(world.saved().accounts).sort()).toEqual(['login', 'spare'])
  expect(world.locks).toEqual([`${configPath}.lock`, `${configPath}.lock`])
  expect((await $.command.run(command('remove missing'))).text).toBe('No account named missing.')
  expect((await $.command.run(command('set-default missing'))).text ?? '').toContain('missing is not a saved OAuth account.')
  expect((await $.command.run(command('remove login'))).text).toBe("This machine's login cannot be removed.")
  expect(world.locks.length).toBe(2)
})

test('switching an unsigned Linux account points to setup without a macOS executable error', async ($, on) => {
  const initial = savedLogin()
  const world = fixture(on, initial)
  const result = await $.command.run(command('personal-live'))
  expect(result.text ?? '').toContain('/rice-account setup personal-live')
  expect(result.text ?? '').not.toContain('/usr/bin/security')
  expect(result.text ?? '').not.toContain('posix_spawn')
  expect(world.processes.some(argv => argv[0] === '/usr/bin/security')).toBe(false)
  expect(world.saved()).toEqual(initial)
  expect(world.writes).toEqual([])
})

test('without HOME or CLAUDE_CONFIG_DIR the command names what is missing instead of using /.claude', async ($, on) => {
  const world = fixture(on, undefined, { USER: 'fixture' })
  const result = await $.command.run(command('list'))
  expect(result.text ?? '').toContain('cannot find the Claude configuration folder')
  expect(result.text ?? '').toContain('HOME')
  expect(world.reads.some(path => path.startsWith('/.claude'))).toBe(false)
  expect(world.writes).toEqual([])
})

for (const args of ['add personal-live', 'set-default login', 'remove personal-live']) {
  test(`${args} keeps an accounts.json that does not parse instead of replacing it with defaults`, async ($, on) => {
    const world = fixture(on)
    const broken = '{ "accounts": { "personal-live": { "kind": "claudeai", '
    world.files.set(configPath, broken)
    const result = await $.command.run(command(args))
    expect(result.text ?? '').toContain('accounts.json does not parse')
    expect(world.files.get(configPath)).toBe(broken)
    expect(world.writes).toEqual([])
    expect(world.processes).toEqual([])
  })
}

function withProvider(): Config {
  const initial = savedLogin()
  return {
    ...initial,
    accounts: {
      ...initial.accounts,
      'legacy-api': { kind: 'api-key', secret: { service: 'fixture-legacy-provider', account: 'legacy-api' } },
    },
  }
}

for (const args of ['legacy-api', 'check legacy-api', 'setup legacy-api', 'remove legacy-api']) {
  test(`${args} refuses a preserved provider entry before reading credentials or changing files`, async ($, on) => {
    const world = fixture(on, withProvider())
    const before = world.files.get(configPath)
    const result = await $.command.run(command(args))
    expect(result.text ?? '').toContain('OAuth accounts only')
    expect(world.processes).toEqual([])
    expect(world.reads.every(path => path === configPath)).toBe(true)
    expect(world.writes).toEqual([])
    expect(world.files.get(configPath)).toBe(before)
  })
}

test('the account list hides preserved provider entries without reading their credential store', async ($, on) => {
  const world = fixture(on, withProvider())
  const before = world.files.get(configPath)
  const result = await $.command.run(command('list'))
  expect(result.text ?? '').not.toContain('legacy-api')
  expect(result.text ?? '').toContain('personal-live')
  expect(result.text ?? '').toContain('/rice-account help')
  expect(world.processes.some(argv => argv.includes('fixture-legacy-provider'))).toBe(false)
  expect(world.writes).toEqual([])
  expect(world.files.get(configPath)).toBe(before)
})

test('adding a provider account exposes only the supported OAuth kinds and changes nothing', async ($, on) => {
  const world = fixture(on)
  const result = await $.command.run(command('add provider api-key'))
  expect(result.text ?? '').toContain('Kinds: claudeai, claudeai-token')
  expect(result.text ?? '').toContain('rice-multi-models')
  expect(world.processes).toEqual([])
  expect(world.writes).toEqual([])
})
