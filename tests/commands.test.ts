import type { CommandRunInput, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import type { Config } from '../hooks/config'
import { defaultConfig, pathsFor, serializeConfig } from '../hooks/config'

const configDir = '/fixture/home/.claude'
const configPath = pathsFor(configDir).config

function command(args: string): CommandRunInput {
  return { command: 'rice-account', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } }
}

/** All account, credential and process effects stay inside the native test host. */
function fixture(on: On, initial?: Config) {
  const files = new Map<string, string>(initial ? [[configPath, serializeConfig(initial)]] : [])
  const reads: string[] = []
  const writes: { path: string; text: string }[] = []
  const processes: (readonly string[])[] = []
  mock.env(on, { HOME: '/fixture/home', USER: 'fixture', CLAUDE_CONFIG_DIR: configDir })
  mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('state.set', () => ({ value: { isSet: true, version: 1 } }))
  on('fs.exists', (_host, input) => ({ value: files.has(input.path) }))
  on('fs.read', (_host, input) => {
    reads.push(input.path)
    const text = files.get(input.path)
    if (text === undefined) throw new Error('ENOENT: isolated fixture file')
    return { value: text }
  })
  on('fs.write', (_host, input) => {
    writes.push(input)
    files.set(input.path, input.text)
    return { value: undefined }
  })
  on('fs.stat', () => { throw new Error('ENOENT: isolated fixture file') })
  on('fs.list', () => ({ value: [] }))
  on('process.run', (_host, input) => {
    processes.push(input.argv)
    if (input.argv[0] === '/usr/bin/uname' && input.argv[1] === '-s') {
      return { value: { exitCode: 0, stdout: 'Linux\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (input.argv.length === 5 && input.argv[0] === 'node' && input.argv[1] === '-e' && input.argv[3] === 'read'
      && input.argv[4] === '/fixture/separate-existing-login/.credentials.json') {
      return { value: { exitCode: 44, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
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
  expect(world.processes).toEqual([])
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

for (const args of ['setup personal-live unexpected', 'personal-live unexpected']) {
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
