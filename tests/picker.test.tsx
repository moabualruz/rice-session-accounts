import type { CommandRunInput, On, PaneOpenArgs } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { MountTarget } from 'claude-code/testing'

import { defaultConfig, pathsFor, serializeConfig } from '../hooks/config'
import type { AccountConfig } from '../hooks/config'

const PANE = 'rice-account-picker'
const home = '/fixture/account-picker'
const configDir = `${home}/.claude`
const paths = pathsFor(configDir)
const now = 1_800_000_000_000

function command(): CommandRunInput {
  return { command: 'rice-account', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }
}

function pane(): MountTarget<'terminal', 'Pane'> {
  return {
    plugin: 'rice-session-accounts', surface: 'terminal', component: 'Pane', requestId: PANE,
    viewport: { columns: 120, rows: 40, isFullscreen: false },
    props: { title: 'Choose account', isFocused: true, bodyColumns: 118, placement: 'inline', scroll: { offset: 0, bodyRows: 36 }, view: {} },
  }
}

function fixture(on: On, isPlaced = true) {
  const environment = new Map<string, string>([
    ['HOME', home], ['USER', 'fixture'], ['CLAUDE_CONFIG_DIR', configDir], ['CLAUDE_CODE_OAUTH_TOKEN', 'fixture-machine-launch'],
  ])
  const accounts: Record<string, AccountConfig> = { ...defaultConfig().accounts }
  const documents = new Map<string, string>()
  function identity(folder: string, name: string, subscriptionType: string) {
    documents.set(`${folder}/.claude.json`, JSON.stringify({ oauthAccount: { emailAddress: `${name}@example.test` } }))
    documents.set(`${folder}/.credentials.json`, JSON.stringify({ claudeAiOauth: {
      accessToken: `fixture-access-${name}`, refreshToken: `fixture-refresh-${name}`,
      expiresAt: now + 3_600_000, subscriptionType,
      ...(subscriptionType === 'max' ? { rateLimitTier: 'default_claude_max_20x' } : {}),
    } }))
  }
  identity(configDir, 'machine', 'max')
  for (let index = 1; index <= 12; index += 1) {
    const name = `extra-${index}`
    accounts[name] = { kind: 'claudeai', loginDir: paths.loginDir(name) }
    identity(paths.loginDir(name), name, index === 2 ? 'team' : 'pro')
  }
  documents.set(paths.config, serializeConfig({ ...defaultConfig(), accounts }))
  const originalDocuments = [...documents.entries()]
  const writes: string[] = []
  const envWrites: string[] = []
  const opened: PaneOpenArgs[] = []
  const closed: string[] = []
  const notices: string[] = []
  mock.clock(on, { now })
  mock.store(on)
  on('env.get', (_host, input) => ({ value: environment.get(input.name) }))
  on('env.set', (_host, input) => {
    envWrites.push(input.name)
    if (input.value === undefined) environment.delete(input.name)
    else environment.set(input.name, input.value)
    return { value: undefined }
  })
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('state.set', () => ({ value: { isSet: true, version: 1 } }))
  on('fs.exists', (_host, input) => ({ value: documents.has(input.path) }))
  on('fs.read', (_host, input) => ({ value: documents.get(input.path) ?? '{}' }))
  on('fs.write', (_host, input) => {
    writes.push(input.path)
    documents.set(input.path, input.text)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('fs.stat', () => { throw new Error('No stat is needed for fixture credentials') })
  on('process.run', (_host, input) => {
    if (input.argv[0] === '/usr/bin/uname' && input.argv[1] === '-s') {
      return { value: { exitCode: 0, stdout: 'Linux\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (input.argv.length === 5 && input.argv[0] === 'node' && input.argv[1] === '-e' && input.argv[3] === 'read') {
      const value = documents.get(input.argv[4] ?? '')
      return { value: { exitCode: value === undefined ? 44 : 0, stdout: value ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 127, stdout: '', stderr: 'Unsupported fixture process', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* () { throw new Error('The picker fixture must not launch a real child') })
  on('http.fetch', () => { throw new Error('The picker fixture must not make a network request') })
  on('ui.open', (_host, input) => {
    opened.push(input)
    return { value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'no-surface' } }
  })
  on('ui.close', (_host, input) => { closed.push(input.id); return { value: undefined } })
  on('ui.log', (_host, input) => { notices.push(input.text); return { value: undefined } })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  return { environment, documents, originalDocuments, writes, envWrites, opened, closed, notices }
}

test('the native account picker shows every saved account email and tier before changing anything', async ($, on) => {
  const world = fixture(on)
  await $.command.run(command())
  const ui = await $.ui.mount(pane())
  expect(world.opened[0]).toEqual({ id: PANE, title: 'Choose account', focus: true, closeOnEscape: true })
  expect((await ui.findAll({ type: 'Button' })).length).toBe(14)
  expect((await ui.find({ key: 'account:login' }))?.text).toContain('machine@example.test')
  expect((await ui.find({ key: 'account:login' }))?.text).toContain('Max (20x)')
  expect((await ui.find({ key: 'account:login' }))?.text).toContain('current session')
  expect((await ui.find({ key: 'account:extra-1' }))?.text).toContain('extra-1@example.test')
  expect((await ui.find({ key: 'account:extra-1' }))?.text).toContain('Pro')
  expect((await ui.find({ key: 'account:extra-2' }))?.text).toContain('Team')
  expect((await ui.find({ key: 'account:extra-12' }))?.text).toContain('extra-12@example.test')
  expect(world.environment.get('CLAUDE_CODE_OAUTH_TOKEN')).toBe('fixture-machine-launch')
  expect(world.envWrites).toEqual([])
  expect(world.writes).toEqual([])
  expect([...world.documents.entries()]).toEqual(world.originalDocuments)
  await ui.unmount()
})

test('pressing an account row switches that exact account and closes the picker', async ($, on) => {
  const world = fixture(on)
  const ui = await $.ui.mount(pane())
  await ui.press({ key: 'account:extra-2' })
  expect(world.environment.get('CLAUDE_CODE_OAUTH_TOKEN')).toBe('fixture-access-extra-2')
  expect(world.environment.get('CLAUDE_CONFIG_DIR')).toBe(configDir)
  expect(world.closed).toEqual([PANE])
  expect(world.notices.join('\n')).toContain('now uses extra-2')
  expect(world.writes).toEqual([])
  await ui.unmount()
})

test('the native keyboard select reaches accounts beyond digit shortcuts', async ($, on) => {
  const world = fixture(on)
  const ui = await $.ui.mount(pane())
  expect((await ui.find({ type: 'Select', key: 'account-picker-select' }))?.props.label).toContain('Account')
  await ui.select({ key: 'account-picker-select', value: 'extra-12' })
  expect(world.environment.get('CLAUDE_CODE_OAUTH_TOKEN')).toBe('fixture-access-extra-12')
  expect(world.closed).toEqual([PANE])
  expect(world.writes).toEqual([])
  await ui.unmount()
})

test('a failed account selection keeps its error visible and leaves the session on its existing account', async ($, on) => {
  const world = fixture(on)
  const ui = await $.ui.mount(pane())
  world.documents.delete(`${paths.loginDir('extra-2')}/.credentials.json`)
  await ui.press({ key: 'account:extra-2' })
  expect((await ui.find({ type: 'Text', text: '/rice-account setup extra-2' }))?.text).toContain('not signed in yet')
  expect(world.environment.get('CLAUDE_CODE_OAUTH_TOKEN')).toBe('fixture-machine-launch')
  expect(world.envWrites).toEqual([])
  expect(world.closed).toEqual([])
  expect(world.writes).toEqual([])
  await ui.unmount()
})

test('cancel closes the account picker without switching', async ($, on) => {
  const world = fixture(on)
  const ui = await $.ui.mount(pane())
  await ui.press({ key: 'account-picker-close' })
  expect(world.closed).toEqual([PANE])
  expect(world.envWrites).toEqual([])
  expect(world.writes).toEqual([])
  await ui.unmount()
})

test('a session without a native surface receives the account names, email and tier as text', async ($, on) => {
  const world = fixture(on, false)
  const result = await $.command.run(command())
  expect(result.text ?? '').toContain('machine@example.test')
  expect(result.text ?? '').toContain('Max (20x)')
  expect(result.text ?? '').toContain('extra-12@example.test')
  expect(world.envWrites).toEqual([])
  expect(world.writes).toEqual([])
})
