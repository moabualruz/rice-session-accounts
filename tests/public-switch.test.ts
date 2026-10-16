import type { CommandRunInput, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { defaultConfig, pathsFor, serializeConfig } from '../hooks/config'
import { headerToken } from '../hooks/env'

const directory = '/fixture/public-accounts/.claude'
const paths = pathsFor(directory)
const now = 1_800_000_000_000

function command(args: string): CommandRunInput {
  return { command: 'rice-account', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }
}

const safetyDriver = { plugins: [{ name: 'account-safety-observer', register(on: On) {
  let cachedReference: string | undefined
  on('command.run', { command: 'account-safety' }, async ($, e) => {
    if (e.args === 'cache-reference') { cachedReference = (await $.session.authorize())?.handle; return { text: 'cached' } }
    if (e.args === 'authorize-only') return { text: (await $.session.authorize()) ? 'authorized' : 'no authorization' }
    if (e.args === 'fetch-reference') {
      try { await $.http.fetch('https://api.anthropic.com/owned-cached-probe', { auth: cachedReference }); return { text: 'native dispatched' } }
      catch { return { text: 'refused' } }
    }
    if (e.args === 'recovered') {
      const authorization = await $.session.authorize()
      const child = await $.process.run(['owned-child-probe'])
      return { text: JSON.stringify({ authorized: authorization !== null, exitCode: child.exitCode }) }
    }
    const failures: Record<string, string> = {}
    const capture = async (name: string, run: () => Promise<unknown>) => {
      try { await run(); failures[name] = 'unexpected dispatch' }
      catch (error) { failures[name] = error instanceof Error ? error.message : String(error) }
    }
    const authorization = await $.session.authorize()
    await capture('http', () => $.http.fetch('https://api.anthropic.com/owned-probe'))
    await capture('model', () => $.model.complete({ model: 'haiku', prompt: 'Owned synthetic blocked request', maxTokens: 1 }))
    await capture('run', () => $.process.run(['owned-child-probe']))
    await capture('spawn', async () => { for await (const _chunk of $.process.spawn({ argv: ['owned-child-probe'] })) {} })
    const bash = await $.tool.call({ tool: 'Bash', command: 'printf owned-probe' })
    return { text: JSON.stringify({ authorization, failures, bashDeny: bash.deny }) }
  })
} }] }

function fixture(on: On) {
  const environment = new Map<string, string>([
    ['HOME', '/fixture/public-accounts'], ['USER', 'fixture'], ['CLAUDE_CONFIG_DIR', directory],
    ['CLAUDE_CODE_OAUTH_TOKEN', 'fixture-machine-token'],
  ])
  const documents = new Map<string, string>([[paths.config, serializeConfig({
    ...defaultConfig(), accounts: {
      ...defaultConfig().accounts,
      'account-a': { kind: 'claudeai', loginDir: paths.loginDir('account-a') },
      'account-b': { kind: 'claudeai', loginDir: paths.loginDir('account-b') },
    },
  })]])
  for (const name of ['account-a', 'account-b']) {
    documents.set(`${paths.loginDir(name)}/.credentials.json`, JSON.stringify({ claudeAiOauth: {
      accessToken: `fixture-${name}`, refreshToken: `fixture-refresh-${name}`, expiresAt: now + 3_600_000, subscriptionType: 'max',
    } }))
    documents.set(`${paths.loginDir(name)}/.claude.json`, JSON.stringify({ oauthAccount: { emailAddress: `${name}@example.test` } }))
  }
  const writes: string[] = [], processes: (readonly string[])[] = [], status: (string | undefined)[] = []
  let held: { started: () => void; wait: Promise<void> } | undefined
  let heldTokenRead: { started: () => void; wait: Promise<void> } | undefined
  let refuseTokenRead = false
  let refuseCachedProbe = false
  const cachedRequests: { auth: string | undefined; authorization: string | undefined }[] = []
  let refuseB = false
  let failRelay = false, failState = false, refuseRollback = false
  const activeWrites: (string | null)[] = []
  mock.clock(on, { now }); mock.store(on)
  on('env.get', async (_host, e) => {
    const value = environment.get(e.name)
    if (e.name === 'ANTHROPIC_CUSTOM_HEADERS' && refuseTokenRead) { refuseTokenRead = false; return { deny: 'Owned token read refusal' } }
    if (e.name === 'ANTHROPIC_CUSTOM_HEADERS' && heldTokenRead) { const h = heldTokenRead; heldTokenRead = undefined; h.started(); await h.wait }
    return { value }
  })
  on('env.set', (_host, e) => {
    if (failRelay && e.name === 'RICE_SESSION_ACCOUNTS_OAUTH_RELAY' && e.value === 'fixture-account-b') { failRelay = false; return { value: { deny: 'Owned post-env relay refusal' } } }
    if (refuseRollback && e.name === 'ANTHROPIC_CUSTOM_HEADERS' && headerToken(e.value) === 'fixture-account-a') return { value: { deny: 'Owned rollback refusal' } }
    if (refuseB && e.name === 'ANTHROPIC_CUSTOM_HEADERS' && headerToken(e.value) === 'fixture-account-b') return { value: { deny: 'Owned policy refusal' } }
    if (e.value === undefined) environment.delete(e.name); else environment.set(e.name, e.value)
    return { value: {} }
  })
  on('state.set', { plugin: 'rice-session-accounts', key: 'active' }, (_host, e, next) => {
    activeWrites.push(e.value?.name ?? null)
    if (failState && e.value?.name === 'account-b') { failState = false; return next({ ...e, value: e.previous ?? null }) }
    return next(e)
  })
  on('fs.exists', (_host, e) => ({ value: documents.has(e.path) }))
  on('fs.read', (_host, e) => ({ value: documents.get(e.path) ?? '{}' }))
  on('fs.write', (_host, e) => { writes.push(e.path); return { value: undefined } })
  on('fs.list', () => ({ value: [] }))
  on('process.run', (_host, e) => {
    processes.push(e.argv)
    const text = e.argv[0] === 'node' && e.argv[3] === 'read' ? documents.get(e.argv[4] ?? '') : undefined
    const stdout = e.argv[0] === '/usr/bin/uname' ? 'Linux\n' : text ?? ''
    return { value: { exitCode: stdout ? 0 : 44, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', async (_host, e) => {
    if (e.url === 'https://api.anthropic.com/owned-cached-probe') {
      cachedRequests.push({ auth: e.init?.auth, authorization: e.init?.headers?.Authorization })
      if (refuseCachedProbe) return { deny: 'Owned downstream HTTP refusal' }
    }
    const account = e.init?.headers?.Authorization === 'Bearer fixture-account-a' ? 'a' : e.init?.headers?.Authorization === 'Bearer fixture-account-b' ? 'b' : 'machine'
    if (account === 'a' && held) { const h = held; held = undefined; h.started(); await h.wait }
    const percent = account === 'a' ? 100 : account === 'b' ? 2 : 95
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ five_hour: { utilization: percent }, seven_day: { utilization: percent } }) } }
  })
  on('session.start', (_host, e) => ({ cwd: e.cwd }))
  on('session.version', () => ({ value: { version: '2.1.301' } }))
  on('session.model', () => ({ value: 'haiku' }))
  on('session.cwd', () => ({ value: '/fixture/public-accounts' }))
  on('command.register', (_host, e) => ({ value: { command: e.name } }))
  on('ui.status', (_host, e) => { status.push(e.text); return { value: undefined } })
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  return { environment, writes, processes, status, activeWrites, cachedRequests, refuseCachedProbe() { refuseCachedProbe = true }, refuseTokenRead() { refuseTokenRead = true }, holdTokenRead() {
    let started = () => {}, release = () => {}
    const seen = new Promise<void>(resolve => { started = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    heldTokenRead = { started, wait }
    return { seen, release }
  }, refuseB() { refuseB = true }, allowRecovery() { refuseRollback = false }, failRelay(denyRollback = false) { failRelay = true; refuseRollback = denyRollback }, failState() { failState = true }, holdA() {
    let started = () => {}, release = () => {}
    const seen = new Promise<void>(resolve => { started = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    held = { started, wait }
    return { seen, release }
  } }
}

test('ordinary Claude switches browser accounts through session OAuth without a launcher or machine writes', async ($, on) => {
  const world = fixture(on)
  await $.session.start({ cwd: '/fixture/public-accounts', surface: 'terminal', isInteractive: true })
  const switched = await $.command.run(command('account-b'))
  expect(switched.text ?? '').toContain('now uses account-b')
  expect(headerToken(world.environment.get('ANTHROPIC_CUSTOM_HEADERS'))).toBe('fixture-account-b')
  expect(world.environment.get('CLAUDE_CONFIG_DIR')).toBe(directory)
  expect(world.status.join('\n')).toContain('account-b@example.test')
  expect(world.status.join('\n')).toContain('Max')
  const usage = await $.command.run({ ...command(''), command: 'usage' })
  expect(usage.text ?? '').toContain('account-b usage:')
  expect(usage.text ?? '').toContain('wk 2%')
  expect(usage.text ?? '').not.toContain('100%')
  const status = await $.command.run({ ...command(''), command: 'status' })
  expect(status.text ?? '').toContain('Email: account-b@example.test')
  expect(status.text ?? '').toContain('Plan: Max')
  expect(status.text ?? '').toContain('Claude Code: 2.1.301')
  expect(status.text ?? '').toContain('Model: haiku')
  expect(status.text ?? '').toContain('Working directory: /fixture/public-accounts')
  expect(status.text ?? '').not.toContain('100%')
  await $.command.run(command('login'))
  expect(world.environment.get('CLAUDE_CODE_OAUTH_TOKEN')).toBe('fixture-machine-token')
  expect(world.writes).toEqual([])
})

test('a cached native A authorization cannot fall through when B supersedes its held preparation', safetyDriver, async ($, on) => {
  const world = fixture(on)
  on('session.authorize', () => ({ value: { handle: 'owned-native-startup-a', kind: 'bearer' } }))
  await $.session.start({ cwd: '/fixture/public-accounts', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...command('cache-reference'), command: 'account-safety' })
  await $.command.run(command('account-a'))
  const hold = world.holdTokenRead()
  const pending = $.command.run({ ...command('fetch-reference'), command: 'account-safety' })
  await hold.seen
  await $.command.run(command('account-b'))
  hold.release()
  expect((await pending).text).toBe('refused')
  expect(world.cachedRequests).toEqual([])
  expect(headerToken(world.environment.get('ANTHROPIC_CUSTOM_HEADERS'))).toBe('fixture-account-b')
})

test('failed credential preparation withholds authorization and cached native references before dispatch', safetyDriver, async ($, on) => {
  const world = fixture(on)
  on('session.authorize', () => ({ value: { handle: 'owned-native-startup-a', kind: 'bearer' } }))
  await $.session.start({ cwd: '/fixture/public-accounts', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...command('cache-reference'), command: 'account-safety' })
  await $.command.run(command('account-a'))
  world.refuseTokenRead()
  expect((await $.command.run({ ...command('authorize-only'), command: 'account-safety' })).text).toBe('no authorization')
  world.refuseTokenRead()
  expect((await $.command.run({ ...command('fetch-reference'), command: 'account-safety' })).text).toBe('refused')
  expect(world.cachedRequests).toEqual([])
})

test('a downstream HTTP failure replays its settled result without dispatching the original native A request again', safetyDriver, async ($, on) => {
  const world = fixture(on)
  on('session.authorize', () => ({ value: { handle: 'owned-native-startup-a', kind: 'bearer' } }))
  await $.session.start({ cwd: '/fixture/public-accounts', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...command('cache-reference'), command: 'account-safety' })
  await $.command.run(command('account-b'))
  world.refuseCachedProbe()
  expect((await $.command.run({ ...command('fetch-reference'), command: 'account-safety' })).text).toBe('refused')
  expect(world.cachedRequests).toEqual([{ auth: undefined, authorization: 'Bearer fixture-account-b' }])
})

test('a late usage response for A cannot replace the selected B reporting', async ($, on) => {
  const world = fixture(on)
  await $.session.start({ cwd: '/fixture/public-accounts', surface: 'terminal', isInteractive: true })
  const held = world.holdA()
  const selectingA = $.command.run(command('account-a'))
  await held.seen
  const selectingB = await $.command.run(command('account-b'))
  expect(selectingB.text ?? '').toContain('now uses account-b')
  held.release()
  await selectingA
  expect(headerToken(world.environment.get('ANTHROPIC_CUSTOM_HEADERS'))).toBe('fixture-account-b')
  const usage = await $.command.run({ ...command(''), command: 'usage' })
  expect(usage.text ?? '').toContain('account-b usage:')
  expect(usage.text ?? '').toContain('wk 2%')
  expect(usage.text ?? '').not.toContain('100%')
  expect(world.status.at(-1) ?? '').toContain('account-b')
  expect(world.writes).toEqual([])
})

test('the withdrawn setup-native command cannot recreate a launcher', async ($, on) => {
  const world = fixture(on)
  const result = await $.command.run(command('setup-native /fixture/claude'))
  expect(result.text ?? '').toContain('ordinary claude')
  expect(world.processes).toEqual([])
  expect(world.writes).toEqual([])
})

test('a native environment refusal keeps the previous account and its credential selectors', async ($, on) => {
  const world = fixture(on)
  await $.session.start({ cwd: '/fixture/public-accounts', surface: 'terminal', isInteractive: true })
  await $.command.run(command('account-a'))
  const before = [...world.environment.entries()].sort()
  world.refuseB()
  const result = await $.command.run(command('account-b'))
  expect(result.text ?? '').toContain('account was not switched')
  expect([...world.environment.entries()].sort()).toEqual(before)
  expect(world.status.at(-1) ?? '').toContain('account-a')
  expect(world.writes).toEqual([])
})

for (const phase of ['relay', 'state']) {
  test(`a post-environment ${phase} failure restores the previous credential, descendant relay and selected report`, async ($, on) => {
    const world = fixture(on)
    await $.session.start({ cwd: '/fixture/public-accounts', surface: 'terminal', isInteractive: true })
    await $.command.run(command('account-a'))
    const before = [...world.environment.entries()].sort()
    if (phase === 'relay') world.failRelay(); else world.failState()
    const result = await $.command.run(command('account-b'))
    expect(result.text ?? '').toContain(phase === 'relay' ? 'refused the session descendant credential change' : 'refused the session account state change')
    expect([...world.environment.entries()].sort()).toEqual(before)
    expect(world.status.at(-1) ?? '').toContain('account-a')
    expect((await $.command.run({ ...command(''), command: 'usage' })).text ?? '').toContain('account-a usage:')
    expect(world.activeWrites.at(-1)).toBe('account-a')
    expect(world.writes).toEqual([])
  })
}

test('a refused rollback blocks dispatch until an explicit verified account selection recovers', safetyDriver, async ($, on) => {
  const world = fixture(on)
  let modelDispatches = 0, toolDispatches = 0, turnDispatches = 0, httpDispatches = 0
  on('model.*', () => { modelDispatches++; return { deny: 'Owned model backend reached' } })
  on('http.fetch', { url: 'https://api.anthropic.com/owned-probe' }, () => { httpDispatches++; return { deny: 'Owned HTTP backend reached' } })
  on('tool.call', { tool: 'Bash' }, () => { toolDispatches++; return { deny: 'Owned Bash backend reached' } })
  on('turn.step', async function* (_host, e) { turnDispatches++; return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } })
  await $.session.start({ cwd: '/fixture/public-accounts', surface: 'terminal', isInteractive: true })
  await $.command.run(command('account-a'))
  world.failRelay(true)
  const result = await $.command.run(command('account-b'))
  expect(result.text ?? '').toContain('refused the session descendant credential change')
  expect(result.text ?? '').toContain('Rollback could not restore ANTHROPIC_CUSTOM_HEADERS')
  expect(result.text ?? '').toContain('session account is not confirmed')
  expect(headerToken(world.environment.get('ANTHROPIC_CUSTOM_HEADERS'))).toBe('fixture-account-b')
  expect(world.status.at(-1) ?? '').toContain('account switch incomplete')
  expect(world.status.at(-1) ?? '').not.toContain('account-a@')
  const processCount = world.processes.length
  const probe = JSON.parse((await $.command.run({ ...command(''), command: 'account-safety' })).text ?? '{}')
  expect(probe.authorization).toBe(null)
  for (const kind of ['http', 'model', 'run', 'spawn']) expect(probe.failures[kind]).toContain('session account is not confirmed')
  expect(probe.bashDeny).toContain('session account is not confirmed')
  const text: string[] = []
  for await (const chunk of $.turn.step({ turnId: 'owned-uncertain-turn', index: 0, model: 'haiku', messageCount: 0 })) if (chunk.kind === 'text') text.push(chunk.text)
  expect(text.join('')).toContain('session account is not confirmed')
  expect(world.processes.length).toBe(processCount)
  expect([modelDispatches, toolDispatches, turnDispatches, httpDispatches]).toEqual([0, 0, 0, 0])
  for (const name of ['usage', 'status']) expect((await $.command.run({ ...command(''), command: name })).text ?? '').toContain('session account is not confirmed')
  world.allowRecovery()
  const recovered = await $.command.run(command('account-b'))
  expect(recovered.text ?? '').toContain('now uses account-b')
  const afterRecovery = JSON.parse((await $.command.run({ ...command('recovered'), command: 'account-safety' })).text ?? '{}')
  expect(afterRecovery.authorized).toBe(true)
  expect(afterRecovery.exitCode).toBe(44)
  expect(world.status.at(-1) ?? '').toContain('account-b')
})
