import type { CommandRunInput, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import type { ActiveAccount, EnvSnapshot } from '../types'
import { defaultConfig, pathsFor, serializeConfig } from '../hooks/config'
import { MANAGED } from '../hooks/env'

const home = '/fixture/session-isolation'
const configDir = `${home}/.claude`
const paths = pathsFor(configDir)
const now = 1_800_000_000_000
const RELAY = 'RICE_SESSION_ACCOUNTS_OAUTH_RELAY'

function command(args: string): CommandRunInput {
  return { command: 'rice-account', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } }
}

function fixture(on: On) {
  const environment = new Map<string, string>([
    ['HOME', home],
    ['USER', 'fixture'],
    ['CLAUDE_CONFIG_DIR', configDir],
    ['UNRELATED_SESSION_SETTING', 'keep-this-value'],
    ['RICE_SESSION_ACCOUNTS_NATIVE_ACTIVE', '1'],
  ])
  // Mix set and unset launch variables so returning to login must restore both.
  for (const [index, name] of MANAGED.entries()) {
    if (index % 3 !== 0) environment.set(name, `fixture-launch-${name}`)
  }
  const launchToken = environment.get('CLAUDE_CODE_OAUTH_TOKEN')
  if (launchToken) environment.set(RELAY, launchToken)
  const launched = new Map(environment)
  const config = {
    ...defaultConfig(),
    default: 'account-a',
    accounts: {
      ...defaultConfig().accounts,
      'account-a': { kind: 'claudeai' as const, loginDir: paths.loginDir('account-a') },
      'account-b': { kind: 'claudeai' as const, loginDir: paths.loginDir('account-b') },
    },
  }
  const documents = new Map<string, string>([
    [paths.config, serializeConfig(config)],
    [`${configDir}/settings.json`, JSON.stringify({ model: 'machine-model', permissions: { allow: ['Bash(pwd)'] } })],
    [`${paths.loginDir('account-a')}/settings.json`, JSON.stringify({ model: 'isolated-account-a-model' })],
    [`${paths.loginDir('account-b')}/settings.json`, JSON.stringify({ model: 'isolated-account-b-model' })],
    [`${paths.loginDir('account-a')}/.credentials.json`, JSON.stringify({ claudeAiOauth: {
      accessToken: 'fixture-access-a', refreshToken: 'fixture-refresh-a', expiresAt: now + 3_600_000,
    } })],
    [`${paths.loginDir('account-b')}/.credentials.json`, JSON.stringify({ claudeAiOauth: {
      accessToken: 'fixture-access-b', refreshToken: 'fixture-refresh-b', expiresAt: now + 3_600_000,
    } })],
  ])
  const originalDocuments = [...documents.entries()]
  const writes: string[] = []
  const envWrites: string[] = []
  const fileReads: string[] = []
  const processReads: string[] = []
  let active: ActiveAccount | null | undefined
  let activeVersion = 0
  let originals: EnvSnapshot | null | undefined
  let originalsVersion = 0

  mock.clock(on, { now })
  mock.store(on)
  on('env.get', (_host, input) => ({ value: environment.get(input.name) }))
  on('env.set', (_host, input) => {
    envWrites.push(input.name)
    if (input.value === undefined) environment.delete(input.name)
    else environment.set(input.name, input.value)
    return { value: undefined }
  })
  on('state.get', { plugin: 'rice-session-accounts', key: 'active' }, () => ({ value: { value: active, version: activeVersion } }))
  on('state.set', { plugin: 'rice-session-accounts', key: 'active' }, (_host, input) => {
    if (input.ifVersion !== undefined && input.ifVersion !== activeVersion) return { value: { isSet: false, version: activeVersion } }
    active = input.value
    activeVersion += 1
    return { value: { isSet: true, version: activeVersion } }
  })
  on('state.get', { plugin: 'rice-session-accounts', key: 'originals' }, () => ({ value: { value: originals, version: originalsVersion } }))
  on('state.set', { plugin: 'rice-session-accounts', key: 'originals' }, (_host, input) => {
    if (input.ifVersion !== undefined && input.ifVersion !== originalsVersion) return { value: { isSet: false, version: originalsVersion } }
    originals = input.value
    originalsVersion += 1
    return { value: { isSet: true, version: originalsVersion } }
  })
  on('fs.exists', (_host, input) => ({ value: documents.has(input.path) }))
  on('fs.read', (_host, input) => {
    fileReads.push(input.path)
    const text = documents.get(input.path)
    if (text === undefined) return { value: '{}' }
    return { value: text }
  })
  on('fs.write', (_host, input) => {
    writes.push(input.path)
    documents.set(input.path, input.text)
    return { value: undefined }
  })
  on('fs.stat', () => { throw new Error('No stat is required for unexpired fixture credentials') })
  on('fs.list', () => ({ value: [] }))
  on('process.run', (_host, input) => {
    if (input.argv[0] === '/usr/bin/uname' && input.argv[1] === '-s') {
      return { value: { exitCode: 0, stdout: 'Linux\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (input.argv.length === 5 && input.argv[0] === 'node' && input.argv[1] === '-e' && input.argv[3] === 'read') {
      const path = input.argv[4] ?? ''
      processReads.push(path)
      const text = documents.get(path)
      return { value: { exitCode: text === undefined ? 44 : 0, stdout: text ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    writes.push(`unexpected-process:${input.argv[0] ?? ''}`)
    return { value: { exitCode: 127, stdout: '', stderr: 'Unsupported fixture process', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* () { throw new Error('The lifecycle fixture must not start a real child') })
  on('http.fetch', () => { throw new Error('The lifecycle fixture must not make a network request') })
  on('session.start', (_host, input) => ({ cwd: input.cwd }))
  on('command.register', (_host, input) => ({ value: { command: input.name } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))

  return {
    environment,
    launched,
    envWrites,
    fileReads,
    writes,
    documents,
    originalDocuments,
    processReads,
    active: () => active,
  }
}

test('mid-session account A to B to login switches the process and restores every launch value without file writes', async ($, on) => {
  const world = fixture(on)
  await $.session.start({ cwd: home, surface: 'terminal', isInteractive: true })

  const accountA = await $.command.run(command('account-a'))
  expect(accountA.text ?? '').toContain('now uses account-a')
  expect(world.environment.get('CLAUDE_CODE_OAUTH_TOKEN')).toBe(undefined)
  expect(world.environment.get('CLAUDE_SECURESTORAGE_CONFIG_DIR')).toBe(paths.loginDir('account-a'))
  expect(world.environment.get(RELAY)).toBe(undefined)
  expect(world.environment.get('CLAUDE_CONFIG_DIR')).toBe(configDir)
  expect(world.environment.get('ANTHROPIC_API_KEY')).toBe(undefined)
  expect(world.environment.get('CLAUDE_CODE_USE_GATEWAY')).toBe(undefined)
  expect(world.active()?.name).toBe('account-a')

  const accountB = await $.command.run(command('account-b'))
  expect(accountB.text ?? '').toContain('now uses account-b')
  expect(world.environment.get('CLAUDE_CODE_OAUTH_TOKEN')).toBe(undefined)
  expect(world.environment.get('CLAUDE_SECURESTORAGE_CONFIG_DIR')).toBe(paths.loginDir('account-b'))
  expect(world.environment.get(RELAY)).toBe(undefined)
  expect(world.environment.get('CLAUDE_CONFIG_DIR')).toBe(configDir)
  expect(world.active()?.name).toBe('account-b')

  const login = await $.command.run(command('login'))
  expect(login.text ?? '').toContain("back on this machine's /login")
  expect(world.active()).toBe(null)
  expect(world.environment.get('CLAUDE_CONFIG_DIR')).toBe(configDir)
  expect(world.environment.get(RELAY)).toBe(world.launched.get('CLAUDE_CODE_OAUTH_TOKEN'))
  expect([...world.environment.entries()].filter(([name]) => name !== 'RICE_SESSION_ACCOUNTS_AUTH_REVISION').sort()).toEqual([...world.launched.entries()].sort())
  expect(world.envWrites).not.toContain('CLAUDE_CONFIG_DIR')
  expect(world.envWrites).toContain('CLAUDE_SECURESTORAGE_CONFIG_DIR')
  expect(world.fileReads.some(path => path.startsWith(`${paths.base}/logins/`) && path.endsWith('/settings.json'))).toBe(false)
  expect(world.envWrites.every(name => name === RELAY || name === 'RICE_SESSION_ACCOUNTS_AUTH_REVISION' || MANAGED.some(managed => managed === name))).toBe(true)
  expect(world.processReads).toEqual([
    `${paths.loginDir('account-a')}/.credentials.json`,
    `${paths.loginDir('account-b')}/.credentials.json`,
  ])
  expect(world.writes).toEqual([])
  expect([...world.documents.entries()]).toEqual(world.originalDocuments)
})

test('a new session keeps the machine login even when the saved default names another account', async ($, on) => {
  const world = fixture(on)
  await $.session.start({ cwd: home, surface: 'terminal', isInteractive: true })
  expect([...world.environment.entries()]).toEqual([...world.launched.entries()])
  expect(world.active() ?? null).toBe(null)
  expect(world.envWrites).toEqual([])
  expect(world.processReads).toEqual([])
  expect(world.writes).toEqual([])
  expect([...world.documents.entries()]).toEqual(world.originalDocuments)
})

test('only complete account transitions commit a native cache revision', async ($, on) => {
  const world = fixture(on)
  await $.session.start({ cwd: home, surface: 'terminal', isInteractive: true })
  await $.command.run(command('account-a'))
  expect(world.environment.get('RICE_SESSION_ACCOUNTS_AUTH_REVISION')).toBe('account-a')
  const commits = world.envWrites.filter(name => name === 'RICE_SESSION_ACCOUNTS_AUTH_REVISION').length
  await $.command.run(command('account-a'))
  expect(world.envWrites.filter(name => name === 'RICE_SESSION_ACCOUNTS_AUTH_REVISION').length).toBe(commits)
  world.documents.delete(`${paths.loginDir('account-b')}/.credentials.json`)
  const failed = await $.command.run(command('account-b'))
  expect(failed.text ?? '').toContain('not signed in yet')
  expect(world.environment.get('CLAUDE_CODE_OAUTH_TOKEN')).toBe(undefined)
  expect(world.environment.get('CLAUDE_SECURESTORAGE_CONFIG_DIR')).toBe(paths.loginDir('account-a'))
  expect(world.environment.get('RICE_SESSION_ACCOUNTS_AUTH_REVISION')).toBe('account-a')
  await $.command.run(command('login'))
  expect(world.environment.get('RICE_SESSION_ACCOUNTS_AUTH_REVISION')).toBe('login')
})

test('plain Claude refuses a named switch before auth mutation and keeps login restoration available', async ($, on) => {
  const world = fixture(on)
  world.environment.delete('RICE_SESSION_ACCOUNTS_NATIVE_ACTIVE')
  await $.session.start({ cwd: home, surface: 'terminal', isInteractive: true })
  const blocked = await $.command.run(command('account-a'))
  expect(blocked.text ?? '').toContain('/rice-account setup-native')
  expect(blocked.text ?? '').toContain('rice-account-claude')
  expect(world.processReads).toEqual([])
  expect(world.envWrites).toEqual([])
  const restored = await $.command.run(command('login'))
  expect(restored.text ?? '').toContain("back on this machine's /login")
  expect(restored.text ?? '').toContain('fresh rice-account-claude')
})
