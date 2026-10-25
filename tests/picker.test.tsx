import type { CommandRunInput, On, PaneOpenArgs } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { fixturePath } from './fixture-path'
import type { Mounted, MountTarget } from 'claude-code/testing'

import { defaultConfig, pathsFor, serializeConfig } from '../hooks/config'
import { headerToken } from '../hooks/env'
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

/** A surface without a Select: there each account is a Button. */
function mobilePane(): MountTarget<'mobile', 'Pane'> {
  return { ...pane(), surface: 'mobile' }
}

type Option = { value: string; label: string }

async function waitForPicker<Surface extends 'terminal' | 'mobile'>(ui: Mounted<Surface, 'Pane'>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const accountsLoading = await ui.find({ type: 'Text', text: 'Loading saved accounts...' })
    const detailsLoading = await ui.find({ type: 'Text', text: 'Loading account details...' })
    if (!accountsLoading && !detailsLoading) return
    await Promise.resolve()
  }
}

async function options(ui: Mounted<'terminal', 'Pane'>): Promise<Option[]> {
  await waitForPicker(ui)
  return ((await ui.find({ type: 'Select', key: 'account-picker-select' }))?.props.options ?? []) as Option[]
}

function fixture(on: On, isPlaced = true, launchToken?: string, accountCount = 12, holdCredentialReads = false) {
  const environment = new Map<string, string>([
    ['HOME', home], ['USER', 'fixture'], ['CLAUDE_CONFIG_DIR', configDir],
  ])
  if (launchToken) environment.set('CLAUDE_CODE_OAUTH_TOKEN', launchToken)
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
  for (let index = 1; index <= accountCount; index += 1) {
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
  const readPaths: string[] = []
  let configReads = 0
  let replaceConfigReadAt: { read: number; text: string } | undefined
  let releaseReads = () => {}
  const readsReleased = new Promise<void>(resolve => { releaseReads = resolve })
  let heldRead: { path: string; start: () => void; wait: Promise<void>; finish: () => void } | undefined
  let heldEnvSet: { start: () => void; wait: Promise<void>; finish: () => void } | undefined
  function holdRead(path: string) {
    let start = () => {}, release = () => {}, finish = () => {}
    const started = new Promise<void>(resolve => { start = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    const finished = new Promise<void>(resolve => { finish = resolve })
    heldRead = { path, start, wait, finish }
    return { started, release, finished }
  }
  function holdEnvSet() {
    let start = () => {}, release = () => {}, finish = () => {}
    const started = new Promise<void>(resolve => { start = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    const finished = new Promise<void>(resolve => { finish = resolve })
    heldEnvSet = { start, wait, finish }
    return { started, release, finished }
  }
  const clock = mock.clock(on, { now })
  mock.store(on)
  on('env.get', (_host, input) => ({ value: environment.get(input.name) }))
  on('env.set', async (_host, input) => {
    envWrites.push(input.name)
    if (heldEnvSet) {
      const held = heldEnvSet
      heldEnvSet = undefined
      held.start()
      await held.wait
      held.finish()
    }
    if (input.value === undefined) environment.delete(input.name)
    else environment.set(input.name, input.value)
    return { value: {} }
  })
  on('fs.exists', (_host, input) => ({ value: documents.has(fixturePath(input.path)) }))
  on('fs.read', async (_host, input) => {
    const path = fixturePath(input.path)
    readPaths.push(path)
    if (path === paths.config) {
      configReads += 1
      if (replaceConfigReadAt?.read === configReads) {
        documents.set(path, replaceConfigReadAt.text)
        return { value: replaceConfigReadAt.text }
      }
    }
    const text = documents.get(path)
    if (heldRead?.path === path) {
      const held = heldRead
      heldRead = undefined
      held.start()
      await held.wait
      held.finish()
    }
    if (holdCredentialReads && path.endsWith('.credentials.json')) await readsReleased
    return { value: text ?? '{}' }
  })
  on('fs.write', (_host, input) => {
    writes.push(fixturePath(input.path))
    documents.set(fixturePath(input.path), input.text)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('fs.stat', () => { throw new Error('No stat is needed for fixture credentials') })
  // No settings override the account: a switch is checked against them.
  on('settings.read', () => ({ value: {} }))
  on('process.run', async (_host, input) => {
    if (input.argv[0] === '/usr/bin/uname' && input.argv[1] === '-s') {
      return { value: { exitCode: 0, stdout: 'Linux\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (input.argv.length === 5 && input.argv[0] === 'node' && input.argv[1] === '-e' && input.argv[3] === 'read') {
      const path = input.argv[4] ?? ''
      readPaths.push(path)
      if (holdCredentialReads && path.endsWith('.credentials.json')) await readsReleased
      const value = documents.get(path)
      return { value: { exitCode: value === undefined ? 44 : 0, stdout: value ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (input.argv.length === 5 && input.argv[0] === 'node' && input.argv[1] === '-e' && input.argv[3] === 'examine') {
      const value = documents.get(input.argv[4] ?? '')
      return { value: { exitCode: 0, stdout: JSON.stringify({ stored: value === undefined ? null : JSON.parse(value), pending: null }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 127, stdout: '', stderr: 'Unsupported fixture process', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', (_host, input) => ({ cwd: input.cwd }))
  on('session.end', (_host, input) => ({ sessionId: input.sessionId }))
  on('command.register', (_host, input) => ({ value: { command: input.name } }))
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
  return {
    environment, documents, originalDocuments, writes, envWrites, opened, closed, notices, readPaths, releaseReads, clock,
    configReadCount: () => configReads,
    replaceConfigReadAt: (read: number, text: string) => { replaceConfigReadAt = { read, text } },
    allowConfigReads: () => { replaceConfigReadAt = undefined },
    holdRead,
    holdEnvSet,
  }
}

test('the native account picker shows every saved account email and tier once, before changing anything', async ($, on) => {
  const world = fixture(on)
  await $.command.run(command())
  expect(world.readPaths.filter(path => path.endsWith('.credentials.json'))).toEqual([])
  const ui = await $.ui.mount(pane())
  expect(world.opened[0]).toEqual({ id: PANE, title: 'Choose account', focus: true, closeOnEscape: true })
  const rows = await options(ui)
  expect(rows.length).toBe(13)
  expect(new Set(rows.map(row => row.value)).size).toBe(13)
  // The Select is the list; the only Button is Cancel, so no account row is drawn twice.
  expect((await ui.findAll({ type: 'Button' })).map(button => button.key)).toEqual(['account-picker-close'])
  const label = (name: string) => rows.find(row => row.value === name)?.label ?? ''
  expect(label('login')).toContain('machine@example.test')
  expect(label('login')).toContain('Max (20x)')
  expect(label('login')).toContain('current session')
  expect(label('extra-1')).toContain('extra-1@example.test')
  expect(label('extra-1')).toContain('Pro')
  expect(label('extra-2')).toContain('Team')
  expect(label('extra-12')).toContain('extra-12@example.test')
  expect((await ui.find({ type: 'Select', key: 'account-picker-select' }))?.props.value).toBe('login')
  expect(world.envWrites).toEqual([])
  expect(world.writes).toEqual([])
  expect([...world.documents.entries()]).toEqual(world.originalDocuments)
  await ui.unmount()
})

test('large account lists load and render bounded local windows without eager identity reads', async ($, on) => {
  const world = fixture(on, true, undefined, 500)
  const ui = await $.ui.mount(pane())
  let rows = await options(ui)
  expect(rows).toHaveLength(50)
  expect(rows.find(row => row.value === 'login')?.label).toContain('current session')
  expect((await ui.find({ type: 'Select', key: 'account-picker-select' }))?.props.value).toBe('login')
  expect(world.readPaths.some(path => path === `${paths.loginDir('extra-1')}/.credentials.json`)).toBe(false)

  for (let page = 0; page < 8; page += 1) {
    await ui.press({ key: 'account-picker-previous' })
    await waitForPicker(ui)
  }
  rows = await options(ui)
  expect(rows).toHaveLength(64)
  expect(new Set(rows.map(row => row.value)).size).toBe(64)

  await ui.press({ key: 'account-picker-load-more' })
  await waitForPicker(ui)
  rows = await options(ui)
  expect(rows).toHaveLength(50)
  expect((await ui.find({ key: 'account-picker-previous' }))?.text).toContain('Previous 64 accounts')
  expect((await ui.find({ key: 'account-picker-load-more' }))?.text).toContain('115-128 of 501')

  const extraCredential = `${paths.loginDir('extra-500')}/.credentials.json`
  await ui.input({ key: 'account-picker-search', text: 'extra', kind: 'change' })
  await world.clock.advance(250)
  rows = await options(ui)
  expect(rows).toHaveLength(50)
  expect((await ui.find({ type: 'Select', key: 'account-picker-select' }))?.props.value).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: 'Current session account: login is not in these results.' }))?.text).toBeDefined()
  expect((await ui.find({ key: 'account-picker-load-more' }))?.text).toContain('51-64 of 500')

  await ui.input({ key: 'account-picker-search', text: 'login', kind: 'change' })
  await world.clock.advance(250)
  rows = await options(ui)
  expect(rows.map(row => row.value)).toEqual(['login'])
  expect((await ui.find({ type: 'Select', key: 'account-picker-select' }))?.props.value).toBe('login')

  await ui.input({ key: 'account-picker-search', text: 'extra-500', kind: 'change' })
  expect(world.readPaths.filter(path => path === extraCredential)).toHaveLength(1)
  await world.clock.advance(250)
  rows = await options(ui)
  expect(rows.map(row => row.value)).toEqual(['extra-500'])
  expect(world.readPaths).toContain(extraCredential)

  await ui.input({ key: 'account-picker-search', text: 'extra-4', kind: 'change' })
  await world.clock.advance(250)
  await options(ui)
  await ui.input({ key: 'account-picker-search', text: 'extra-500', kind: 'change' })
  await world.clock.advance(250)
  rows = await options(ui)
  expect(rows.map(row => row.value)).toEqual(['extra-500'])
  expect(world.readPaths.filter(path => path === extraCredential)).toHaveLength(3)
  await ui.unmount()
})

test('account switches evict metadata outside the visible window', async ($, on) => {
  const world = fixture(on, true, undefined, 500)
  const ui = await $.ui.mount(pane())
  const initialRows = await options(ui)
  expect(initialRows).toHaveLength(50)
  await ui.press({ key: 'account-picker-previous' })
  const expandedRows = await options(ui)
  expect(expandedRows).toHaveLength(64)
  const switchedNames = ['extra-1', 'extra-100', 'extra-200', 'extra-300', 'extra-400']
  const cachedName = expandedRows.find(row => row.value !== 'login' && !switchedNames.includes(row.value))?.value
  expect(cachedName).toBeDefined()
  const account = cachedName ?? 'login'
  expect(expandedRows.find(row => row.value === account)?.label).toContain(`${account}@example.test`)

  for (const name of switchedNames) {
    const switched = await $.command.run({ ...command(), args: name })
    expect(switched.text ?? '').toContain(`now uses ${name}`)
    await ui.redraw()
    const rows = await options(ui)
    expect(rows).toHaveLength(50)
  }

  world.documents.set(`${paths.loginDir(account)}/.claude.json`, JSON.stringify({ oauthAccount: { emailAddress: 'updated@example.test' } }))
  const restored = await $.command.run({ ...command(), args: account })
  expect(restored.text ?? '').toContain(`now uses ${account}`)
  await ui.redraw()
  const rows = await options(ui)
  expect(rows.find(row => row.value === account)?.label).toContain('updated@example.test')
  await ui.unmount()
})

test('failed metadata loading stays visible until retry refreshes the account inventory', async ($, on) => {
  const world = fixture(on, true, undefined, 500)
  const ui = await $.ui.mount(pane())
  await options(ui)
  await ui.press({ key: 'account-picker-previous' })
  await options(ui)
  world.replaceConfigReadAt(4, serializeConfig(defaultConfig()))
  await ui.press({ key: 'account-picker-previous' })
  const visibleError = async () => (await ui.findAll({ type: 'Text' })).find(element => element.props.color === 'red' && element.text.includes('Saved accounts changed while the picker was loading'))
  for (let attempt = 0; attempt < 100 && !(await visibleError()); attempt += 1) await Promise.resolve()
  expect(await visibleError()).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'End of saved accounts.' })).toBeUndefined()
  expect(world.configReadCount()).toBe(4)
  await world.clock.advance(1000)
  expect(world.configReadCount()).toBe(4)

  world.documents.set(paths.config, serializeConfig(defaultConfig()))
  world.allowConfigReads()
  await ui.press({ key: 'account-picker-retry' })
  const rows = await options(ui)
  expect(rows.map(row => row.value)).toEqual(['login'])
  expect(world.configReadCount()).toBe(6)
  await ui.unmount()
})

test('failed command-line switches preserve pending picker metadata loads', async ($, on) => {
  const world = fixture(on, true, undefined, 12, true)
  const ui = await $.ui.mount(pane())
  const credentialReads = () => world.readPaths.filter(path => path.endsWith('.credentials.json')).length
  for (let attempt = 0; attempt < 100 && credentialReads() < 13; attempt += 1) await Promise.resolve()
  expect(credentialReads()).toBe(13)

  const failedSwitch = await $.command.run({ ...command(), args: 'missing-account' })
  expect(failedSwitch.text ?? '').toContain('No account named missing-account')
  expect(credentialReads()).toBe(13)

  world.releaseReads()
  const rows = await options(ui)
  expect(rows.find(row => row.value === 'login')?.label).toContain('machine@example.test')
  expect(await ui.find({ type: 'Text', text: 'Loading account details...' })).toBeUndefined()
  await ui.unmount()
})

test('retry resets an out-of-range picker window when the account inventory shrinks', async ($, on) => {
  const world = fixture(on, true, undefined, 500)
  const ui = await $.ui.mount(pane())
  await options(ui)

  for (let page = 0; page < 3; page += 1) {
    await ui.press({ key: 'account-picker-previous' })
    await options(ui)
  }
  await ui.press({ key: 'account-picker-load-more' })
  await options(ui)

  world.documents.set(paths.config, serializeConfig(defaultConfig()))
  await ui.press({ key: 'account-picker-load-more' })
  const changed = 'Saved accounts changed while the picker was loading. Retry to refresh the list.'
  for (let attempt = 0; attempt < 100 && !(await ui.find({ type: 'Text', text: changed })); attempt += 1) {
    await Promise.resolve()
  }
  expect((await ui.find({ type: 'Text', text: changed }))?.text).toContain('Retry to refresh the list')

  await ui.press({ key: 'account-picker-retry' })
  const rows = await options(ui)
  expect(rows.map(row => row.value)).toEqual(['login'])
  expect((await ui.find({ type: 'Text', text: 'Showing 1-1 of 1 saved accounts.' }))?.text).toBeDefined()
  await ui.unmount()
})

test('closing a picker ignores account details still loading for its old render', async ($, on) => {
  const world = fixture(on, true, undefined, 12)
  const staleRead = world.holdRead(`${configDir}/.claude.json`)
  const ui = await $.ui.mount(pane())
  await staleRead.started
  expect(await ui.find({ type: 'Text', text: 'Loading account details...' })).toBeDefined()
  const closing = ui.press({ key: 'account-picker-close' })
  for (let attempt = 0; attempt < 100 && world.closed.length === 0; attempt += 1) await Promise.resolve()
  await closing
  expect(world.closed).toEqual([PANE])

  world.documents.set(paths.config, serializeConfig(defaultConfig()))
  world.documents.set(`${configDir}/.claude.json`, JSON.stringify({ oauthAccount: { emailAddress: 'reopened@example.test' } }))
  await ui.unmount()
  await $.command.run(command())
  const reopened = await $.ui.mount(pane())
  const rows = await options(reopened)
  expect(rows.map(row => row.value)).toEqual(['login'])
  expect(rows[0]?.label).toContain('reopened@example.test')

  staleRead.release()
  await staleRead.finished
  const afterStaleRead = await options(reopened)
  expect(afterStaleRead.map(row => row.value)).toEqual(['login'])
  expect(afterStaleRead[0]?.label).toContain('reopened@example.test')
  expect(world.envWrites).toEqual([])
  await reopened.unmount()
})

test('clearing and resuming a session reloads picker rows without stale metadata', async ($, on) => {
  const world = fixture(on, true, undefined, 12)
  const staleRead = world.holdRead(`${configDir}/.claude.json`)
  const ui = await $.ui.mount(pane())
  await staleRead.started
  expect(await ui.find({ type: 'Text', text: 'Loading account details...' })).toBeDefined()

  await $.session.end({ reason: 'clear', sessionId: 'fixture-session', resume: { id: 'fixture-session' } } as never)
  world.documents.set(paths.config, serializeConfig(defaultConfig()))
  world.documents.set(`${configDir}/.claude.json`, JSON.stringify({ oauthAccount: { emailAddress: 'resumed@example.test' } }))
  await $.session.start({ cwd: home, surface: 'terminal', isInteractive: true } as never)
  await ui.redraw()
  const rows = await options(ui)
  expect(rows.map(row => row.value)).toEqual(['login'])
  expect(rows[0]?.label).toContain('resumed@example.test')

  staleRead.release()
  await staleRead.finished
  const afterStaleRead = await options(ui)
  expect(afterStaleRead.map(row => row.value)).toEqual(['login'])
  expect(afterStaleRead[0]?.label).toContain('resumed@example.test')
  await ui.unmount()
})

test('selecting an account supersedes metadata loads from the prior picker render', async ($, on) => {
  const world = fixture(on, true, undefined, 12, true)
  const ui = await $.ui.mount(pane())
  for (let attempt = 0; attempt < 100 && !(await ui.find({ type: 'Select', key: 'account-picker-select' })); attempt += 1) {
    await Promise.resolve()
  }
  expect(await ui.find({ type: 'Select', key: 'account-picker-select' })).toBeDefined()
  const selecting = ui.select({ key: 'account-picker-select', value: 'extra-1' })
  await Promise.resolve()
  world.releaseReads()
  await selecting
  expect(headerToken(world.environment.get('ANTHROPIC_CUSTOM_HEADERS'))).toBe('fixture-access-extra-1')
  expect(world.closed).toEqual([PANE])
  await ui.unmount()
})

test('closing and reopening during an account switch keeps the selection guard active', async ($, on) => {
  const world = fixture(on)
  const ui = await $.ui.mount(pane())
  await options(ui)
  const switchWrite = world.holdEnvSet()
  const selecting = ui.select({ key: 'account-picker-select', value: 'extra-1' })
  await switchWrite.started
  expect(await ui.find({ type: 'Text', text: 'Switching account...' })).toBeDefined()

  const closing = ui.press({ key: 'account-picker-close' })
  for (let attempt = 0; attempt < 100 && world.closed.length === 0; attempt += 1) await Promise.resolve()
  await closing
  await ui.unmount()
  await $.command.run(command())
  const reopened = await $.ui.mount(pane())
  expect(await reopened.find({ type: 'Text', text: 'Switching account...' })).toBeDefined()
  expect(await reopened.find({ type: 'Select', key: 'account-picker-select' })).toBeUndefined()

  switchWrite.release()
  await selecting
  await switchWrite.finished
  expect(headerToken(world.environment.get('ANTHROPIC_CUSTOM_HEADERS'))).toBe('fixture-access-extra-1')
  expect(world.closed).toEqual([PANE])
  const rows = await options(reopened)
  expect((await reopened.find({ type: 'Select', key: 'account-picker-select' }))?.props.value).toBe('extra-1')
  expect(rows.map(row => row.value)).toHaveLength(13)
  await reopened.unmount()
})

test('a machine login launched with CLAUDE_CODE_OAUTH_TOKEN is not shown as the stored login', async ($, on) => {
  const world = fixture(on, true, 'fixture-machine-launch')
  const ui = await $.ui.mount(pane())
  const login = (await options(ui)).find(row => row.value === 'login')?.label ?? ''
  expect(login).toContain('Set by CLAUDE_CODE_OAUTH_TOKEN')
  expect(login).not.toContain('machine@example.test')
  expect(world.environment.get('CLAUDE_CODE_OAUTH_TOKEN')).toBe('fixture-machine-launch')
  expect(world.envWrites).toEqual([])
  await ui.unmount()
})

test('large mobile account inventories render bounded Button windows', async ($, on) => {
  const world = fixture(on, true, undefined, 500)
  const ui = await $.ui.mount(mobilePane())
  await waitForPicker(ui)

  let accountKeys = (await ui.findAll({ type: 'Button' })).map(button => button.key).filter(key => key?.startsWith('account:'))
  expect(accountKeys).toHaveLength(50)
  expect(world.readPaths.some(path => path === `${paths.loginDir('extra-1')}/.credentials.json`)).toBe(false)

  await ui.press({ key: 'account-picker-previous' })
  await waitForPicker(ui)
  accountKeys = (await ui.findAll({ type: 'Button' })).map(button => button.key).filter(key => key?.startsWith('account:'))
  expect(accountKeys).toHaveLength(200)
  expect(new Set(accountKeys).size).toBe(200)
  expect((await ui.find({ type: 'Text', text: 'Current session account: login is outside this page.' }))?.text).toBeDefined()
  expect(world.readPaths.filter(path => path.endsWith('.credentials.json')).length).toBeLessThanOrEqual(250)
  await ui.unmount()
})

test('on a surface without a Select each account is one Button, and pressing it switches that exact account', async ($, on) => {
  const world = fixture(on)
  const ui = await $.ui.mount(mobilePane())
  await waitForPicker(ui)
  expect((await ui.findAll({ type: 'Button' })).length).toBe(14)
  expect((await ui.find({ key: 'account:extra-12' }))?.text).toContain('extra-12@example.test')
  await ui.press({ key: 'account:extra-2' })
  expect(headerToken(world.environment.get('ANTHROPIC_CUSTOM_HEADERS'))).toBe('fixture-access-extra-2')
  expect(world.environment.get('CLAUDE_SECURESTORAGE_CONFIG_DIR')).toBe(undefined)
  expect(world.environment.get('CLAUDE_CONFIG_DIR')).toBe(configDir)
  expect(world.closed).toEqual([PANE])
  expect(world.notices.join('\n')).toContain('now uses extra-2')
  expect(world.writes).toEqual([])
  await ui.unmount()
})

test('the native keyboard select reaches accounts beyond digit shortcuts', async ($, on) => {
  const world = fixture(on)
  const ui = await $.ui.mount(pane())
  await options(ui)
  expect((await ui.find({ type: 'Select', key: 'account-picker-select' }))?.props.label).toContain('Account')
  await ui.select({ key: 'account-picker-select', value: 'extra-12' })
  expect(headerToken(world.environment.get('ANTHROPIC_CUSTOM_HEADERS'))).toBe('fixture-access-extra-12')
  expect(world.environment.get('CLAUDE_SECURESTORAGE_CONFIG_DIR')).toBe(undefined)
  expect(world.closed).toEqual([PANE])
  expect(world.writes).toEqual([])
  await ui.unmount()
})

test('a failed account selection keeps its error visible and leaves the session on its existing account', async ($, on) => {
  const world = fixture(on)
  const ui = await $.ui.mount(pane())
  await options(ui)
  world.documents.delete(`${paths.loginDir('extra-2')}/.credentials.json`)
  await ui.select({ key: 'account-picker-select', value: 'extra-2' })
  expect((await ui.find({ type: 'Text', text: '/rice-account setup extra-2' }))?.text).toContain('not signed in yet')
  expect(world.environment.get('ANTHROPIC_CUSTOM_HEADERS')).toBe(undefined)
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
