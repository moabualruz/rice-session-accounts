import type { CommandRunInput, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { fixturePath } from './fixture-path'

import type { ActiveAccount, EnvSnapshot } from '../types'
import type { Config } from '../hooks/config'
import { defaultConfig, pathsFor, serializeConfig } from '../hooks/config'
import { headerToken } from '../hooks/env'

const home = '/fixture/lifecycle'
const configDir = `${home}/.claude`
const paths = pathsFor(configDir)
const now = 1_800_000_000_000
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const LOCK_MAKE = 'mkdir -p "$(dirname "$0")" && mkdir "$0"'
const LOCK_TOUCH = '[ -d "$0" ] && touch -c "$0"'
const LOCK_REMOVE = '[ ! -d "$0" ] || rmdir "$0"'
const START = { cwd: home, surface: 'terminal', isInteractive: true } as const
const B_LIMITS = [{ kind: 'five_hour', percentUsed: 2 }, { kind: 'seven_day', percentUsed: 2 }]
const MACHINE_LIMITS = [{ kind: 'five_hour', percentUsed: 95 }]

function command(args: string, name = 'rice-account'): CommandRunInput {
  return { command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }
}

function savedConfig(names: readonly string[] = ['account-a', 'account-b']): Config {
  return { ...defaultConfig(), accounts: { ...defaultConfig().accounts, ...Object.fromEntries(names.map(name => [name, { kind: 'claudeai' as const, loginDir: paths.loginDir(name) }])) } }
}

type Options = { launchToken?: string; expiresInMs?: Record<string, number>; isMachineUnreadable?: boolean }

/**
 * A whole session beneath the plugins. `$.session.start` again is a reload:
 * that hook reaches only a freshly loaded module, which starts from nothing in
 * memory while this state and environment stay. `clearState()` is a /clear.
 */
function fixture(on: On, options: Options = {}) {
  const environment = new Map<string, string>([['HOME', home], ['USER', 'fixture'], ['CLAUDE_CONFIG_DIR', configDir]])
  if (options.launchToken) environment.set('CLAUDE_CODE_OAUTH_TOKEN', options.launchToken)
  const documents = new Map<string, string>([[paths.config, serializeConfig(savedConfig())]])
  for (const name of ['account-a', 'account-b']) {
    documents.set(`${paths.loginDir(name)}/.credentials.json`, JSON.stringify({ claudeAiOauth: {
      accessToken: `fixture-access-${name}`, refreshToken: `fixture-refresh-${name}`, expiresAt: now + (options.expiresInMs?.[name] ?? 3_600_000), subscriptionType: 'pro',
    } }))
    documents.set(`${paths.loginDir(name)}/.claude.json`, JSON.stringify({ oauthAccount: { emailAddress: `${name}@example.test` } }))
  }
  documents.set(`${configDir}/.credentials.json`, options.isMachineUnreadable ? 'unreadable' : JSON.stringify({ claudeAiOauth: {
    accessToken: 'fixture-access-machine', refreshToken: 'fixture-refresh-machine', expiresAt: now + 3_600_000, subscriptionType: 'max',
  } }))
  documents.set(`${configDir}/.claude.json`, JSON.stringify({ oauthAccount: { emailAddress: 'machine@example.test' } }))
  const status: (string | undefined)[] = [], toasts: string[] = [], locks: string[] = [], usageCalls: string[] = []
  const profiles: { auth: string | undefined; authorization: string | undefined }[] = []
  // Lock directories as the file system keeps them: made by mkdir, renewed by touch, gone after rmdir.
  const lockTimes = new Map<string, number>()
  let tokenRequests = 0, isRefreshFailing = false, isUsageFailing = false
  let refusedActive: string | undefined, refusedHeader: string | undefined
  let active: ActiveAccount | null | undefined, activeVersion = 0
  let originals: EnvSnapshot | null | undefined, originalsVersion = 0
  let settings: Record<string, unknown> = {}

  const clock = mock.clock(on, { now })
  mock.store(on)
  on('settings.read', () => ({ value: settings }))
  on('state.get', { plugin: 'rice-session-accounts', key: 'active' }, () => ({ value: { value: active, version: activeVersion } }))
  on('state.set', { plugin: 'rice-session-accounts', key: 'active' }, (_host, input) => {
    if (input.ifVersion !== undefined && input.ifVersion !== activeVersion) return { value: { isSet: false, version: activeVersion } }
    // A refused write: the host keeps the value it had.
    if (refusedActive !== undefined && input.value?.name === refusedActive) { refusedActive = undefined; return { value: { isSet: true, version: activeVersion } } }
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
  on('env.get', (_host, input) => ({ value: environment.get(input.name) }))
  on('env.set', (_host, input) => {
    if (refusedHeader !== undefined && input.name === 'ANTHROPIC_CUSTOM_HEADERS' && headerToken(input.value) === refusedHeader) return { deny: 'Owned rollback refusal' }
    if (input.value === undefined) environment.delete(input.name)
    else environment.set(input.name, input.value)
    return { value: {} }
  })
  on('fs.exists', (_host, input) => ({ value: documents.has(fixturePath(input.path)) }))
  on('fs.read', (_host, input) => ({ value: documents.get(fixturePath(input.path)) ?? '{}' }))
  on('fs.write', (_host, input) => { documents.set(fixturePath(input.path), input.text); return { value: undefined } })
  on('fs.stat', (_host, input) => {
    const modified = lockTimes.get(fixturePath(input.path))
    if (modified === undefined) throw new Error('ENOENT: isolated fixture file')
    return { value: { kind: 'dir' as const, size: 0, mtimeMs: modified, isLink: false } }
  })
  on('fs.list', () => ({ value: [] }))
  on('process.run', (_host, input) => {
    const answer = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const [program, , script, operation, path = ''] = input.argv
    if (program === '/usr/bin/uname') return answer(0, 'Linux\n')
    if (program === '/bin/sh' && script === LOCK_MAKE) { locks.push(fixturePath(operation ?? '')); lockTimes.set(fixturePath(operation ?? ''), now); return answer(0) }
    if (program === '/bin/sh' && script === LOCK_TOUCH) { const key = fixturePath(operation ?? ''); lockTimes.set(key, (lockTimes.get(key) ?? now) + 1); return answer(0) }
    if (program === '/bin/sh' && script === LOCK_REMOVE) { lockTimes.delete(fixturePath(operation ?? '')); return answer(0) }
    if (program === '/bin/sh') return answer(0)
    if (program === 'node' && operation === 'read') {
      const text = documents.get(path)
      return text === undefined ? answer(44) : text === 'unreadable' ? answer(46) : answer(0, text)
    }
    // `examine` reports a missing store as null.
    if (program === 'node' && operation === 'examine') {
      const text = documents.get(path)
      return text === 'unreadable' ? answer(46) : answer(0, JSON.stringify({ stored: text === undefined ? null : JSON.parse(text), pending: null }))
    }
    if (program === 'node' && operation === 'write') {
      const current = JSON.parse(documents.get(path) ?? '{}') as { claudeAiOauth: Record<string, unknown> }
      const request = JSON.parse(input.init?.stdin ?? '{}') as { expectedRefreshToken: string; oauth: Record<string, unknown> }
      if (current.claudeAiOauth.refreshToken !== request.expectedRefreshToken) return answer(47)
      const saved = { ...current, claudeAiOauth: { ...current.claudeAiOauth, ...request.oauth } }
      documents.set(path, JSON.stringify(saved))
      return answer(0, JSON.stringify(saved))
    }
    return answer(44)
  })
  on('process.spawn', async function* () { throw new Error('The lifecycle fixture must not start a streamed child') })
  on('http.fetch', (_host, input) => {
    const authorization = input.init?.headers?.Authorization
    const json = (text: unknown, status = 200) => ({ value: { ok: status === 200, status, headers: {}, text: JSON.stringify(text) } })
    if (input.url === USAGE_URL) {
      usageCalls.push(authorization ?? '')
      if (isUsageFailing) return json({ error: 'owned' }, 500)
      const percent = authorization === 'Bearer fixture-access-account-a' ? 50 : authorization?.startsWith('Bearer fixture-access-account-b') ? 2 : 95
      return json({ five_hour: { utilization: percent }, seven_day: { utilization: percent } })
    }
    if (input.url === TOKEN_URL) {
      tokenRequests += 1
      if (isRefreshFailing) return json({ error: 'owned refusal' }, 500)
      const refresh = (JSON.parse(input.init?.body ?? '{}') as { refresh_token?: string }).refresh_token ?? ''
      const name = refresh.replace(/^fixture-refresh-/, '').replace(/-\d+$/, '')
      return json({ access_token: `fixture-access-${name}-renewed`, refresh_token: `fixture-refresh-${name}-${tokenRequests}`, expires_in: 3600 })
    }
    if (input.url === PROFILE_URL) {
      profiles.push({ auth: input.init?.auth, authorization })
      return json({ account: { email: 'profile@example.test' } })
    }
    return { deny: 'The lifecycle fixture has no such endpoint' }
  })
  on('session.start', (_host, input) => ({ cwd: input.cwd }))
  on('session.authorize', () => ({ value: { handle: 'owned-native-handle', kind: 'bearer' } }))
  on('session.usage', () => ({ value: { startedAt: now, context: { window: 200_000 }, rateLimits: MACHINE_LIMITS } }))
  on('session.end', (_host, input) => ({ sessionId: input.sessionId }))
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'Owned compaction summary', toolUses: [] }] }))
  on('turn.start', (_host, input) => ({ turnId: input.turnId }))
  on('turn.complete', (_host, input) => ({ text: input.answer }))
  on('model.*', () => ({ deny: 'Owned model backend reached' }))
  on('tool.call', { tool: 'WebFetch' }, () => ({ deny: 'Owned WebFetch backend reached' }))
  on('command.register', (_host, input) => ({ value: { command: input.name } }))
  on('ui.status', (_host, input) => { status.push(input.text); return { value: undefined } })
  on('ui.toast', (_host, input) => { toasts.push(input.text); return { value: undefined } })
  on('ui.log', () => ({ value: undefined }))

  return {
    environment, documents, status, toasts, locks, profiles, clock,
    active: () => active,
    originals: () => originals,
    header: () => headerToken(environment.get('ANTHROPIC_CUSTOM_HEADERS')),
    usageCount: (token: string) => usageCalls.filter(call => call === `Bearer ${token}`).length,
    tokenRequests: () => tokenRequests,
    /** /clear: the host empties the state while this process keeps its environment and module. */
    clearState() { active = undefined; originals = undefined },
    useSettings(value: Record<string, unknown>) { settings = value },
    failRefresh(isFailing: boolean) { isRefreshFailing = isFailing },
    failUsage(isFailing: boolean) { isUsageFailing = isFailing },
    /** The next state write for `name` is refused and a rollback to `header` is refused too: a lockout. */
    refuseSwitch(name: string, header: string) { refusedActive = name; refusedHeader = header },
    allow() { refusedActive = undefined; refusedHeader = undefined },
  }
}

// The test Engine exposes events. This owned inline plugin supplies the
// operation nouns a consumer plugin calls.
const driver = { plugins: [{ name: 'lifecycle-driver', register(on: On) {
  let cached: string | undefined
  on('command.run', { command: 'lifecycle-probe' }, async ($, e) => {
    const attempt = async (run: () => Promise<unknown>) => {
      try { return { value: await run() } } catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
    }
    if (e.args === 'usage') return { text: JSON.stringify(await attempt(async () => (await $.session.usage()).rateLimits)) }
    if (e.args === 'model') return { text: JSON.stringify(await attempt(() => $.model.complete({ model: 'haiku', prompt: 'Owned lifecycle probe', maxTokens: 1 }))) }
    if (e.args === 'claude') return { text: JSON.stringify(await attempt(async () => (await $.process.run(['claude', '-p', 'owned'])).exitCode)) }
    if (e.args === 'child') return { text: JSON.stringify(await attempt(async () => (await $.process.run(['owned-child-probe'])).exitCode)) }
    if (e.args === 'authorize') return { text: JSON.stringify(await attempt(() => $.session.authorize())) }
    if (e.args === 'cache') return { text: JSON.stringify(await attempt(async () => { cached = (await $.session.authorize())?.handle; return cached })) }
    if (e.args === 'fetch-cached') return { text: JSON.stringify(await attempt(async () => (await $.http.fetch('https://api.anthropic.com/api/oauth/profile', { auth: cached })).status)) }
    return { text: JSON.stringify({ error: 'unknown probe' }) }
  })
} }] }

async function probe($: Engine, args: string): Promise<{ value?: unknown; error?: string }> {
  return JSON.parse((await $.command.run(command(args, 'lifecycle-probe'))).text ?? '{}') as { value?: unknown; error?: string }
}

function complete($: Engine, agentId?: string) {
  return $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'owned-turn', reason: 'answer', ...(agentId ? { agentId } : {}) })
}

test('a reload puts the kept account back from $.state, even after accounts.json lost it, and never reports the machine login', driver, async ($, on) => {
  const world = fixture(on)
  await $.session.start(START)
  expect((await probe($, 'usage')).value).toEqual(MACHINE_LIMITS)
  expect((await $.command.run(command('account-b'))).text ?? '').toContain('now uses account-b')
  // Another session removes account-b; this session keeps the copy it took when it selected it.
  world.documents.set(paths.config, serializeConfig(savedConfig(['account-a'])))
  await $.session.start(START)
  expect(world.header()).toBe('fixture-access-account-b')
  expect(world.active()?.name).toBe('account-b')
  expect(world.status.at(-1) ?? '').toContain('account-b@example.test')
  expect((await probe($, 'usage')).value).toEqual(B_LIMITS)
  const usage = (await $.command.run(command('', 'usage'))).text ?? ''
  expect(usage).toContain('account-b usage:')
  expect(usage).not.toContain('95%')
})

test('a native handle tracked before a reload is served with the kept account after it', driver, async ($, on) => {
  const world = fixture(on)
  await $.session.start(START)
  expect((await probe($, 'cache')).value).toBe('owned-native-handle')
  await $.command.run(command('account-b'))
  await $.session.start(START)
  expect((await probe($, 'fetch-cached')).value).toBe(200)
  expect(world.profiles).toEqual([{ auth: undefined, authorization: 'Bearer fixture-access-account-b' }])
  world.environment.set('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1')
  const refused = (await probe($, 'fetch-cached')).error ?? ''
  expect(refused).toContain('nonessential')
  expect(refused).toContain('will not help')
  expect(world.profiles.length).toBe(1)
})

test('a reload keeps a lockout, and every account-bearing event stays refused until a verified selection', driver, async ($, on) => {
  const world = fixture(on)
  await $.session.start(START)
  await $.command.run(command('account-a'))
  world.refuseSwitch('account-b', 'fixture-access-account-a')
  const failed = (await $.command.run(command('account-b'))).text ?? ''
  expect(failed).toContain('Rollback could not restore ANTHROPIC_CUSTOM_HEADERS')
  await $.session.start(START)
  expect(world.status.at(-1) ?? '').toContain('account not confirmed')
  expect((await probe($, 'model')).error ?? '').toContain('not confirmed')
  expect((await probe($, 'claude')).error ?? '').toContain('not confirmed')
  expect((await probe($, 'authorize')).error ?? '').toContain('not confirmed')
  expect((await probe($, 'child')).value).toBe(44)
  expect((await probe($, 'usage')).value).toEqual([])
  expect((await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'Owned compaction fixture', toolUses: [] }] })).skip ?? '').toContain('not confirmed')
  expect(JSON.stringify(await $.tool.call({ tool: 'WebFetch', url: 'https://example.test/', prompt: 'Owned probe' }))).toContain('not confirmed')
  expect((await $.command.run(command('', 'usage'))).text ?? '').toContain('not confirmed')
  const text: string[] = []
  for await (const chunk of $.turn.step({ turnId: 'owned-locked-turn', index: 0, model: 'haiku', messageCount: 0 })) if (chunk.kind === 'text') text.push(chunk.text)
  expect(text.join('')).toContain('not confirmed')
  world.allow()
  expect((await $.command.run(command('login'))).text ?? '').toContain("back on this machine's /login")
  expect((await probe($, 'model')).error ?? '').toContain('Owned model backend reached')
  expect((await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'Owned compaction fixture', toolUses: [] }] })).skip).toBe(undefined)
  expect((await probe($, 'claude')).value).toBe(44)
})

test('a locked session refuses a typed prompt before it enters, and leaves slash commands and machine-made messages to their own handling', driver, async ($, on) => {
  const world = fixture(on)
  // The engine's side: a prompt that reaches the bottom enters as typed.
  on('prompt.submit', (_host, e) => ({ text: e.text }))
  await $.session.start(START)
  await $.command.run(command('account-a'))
  world.refuseSwitch('account-b', 'fixture-access-account-a')
  await $.command.run(command('account-b'))
  await $.session.start(START)
  expect(world.status.at(-1) ?? '').toContain('account not confirmed')
  // The person's own prompt: dropped with the reason, so no row is written into the conversation.
  for (const origin of [{ kind: 'composer' }, { kind: 'bridge' }, { kind: 'sdk' }] as const) {
    const typed = await $.prompt.submit({ text: 'keep going', origin, wait: false })
    expect(typed.drop ?? '').toContain('not confirmed')
    expect(typed.text).toBe(undefined)
  }
  // A slash command, a notification and a scheduled task are not dropped here (turn.step still refuses their model request).
  const command_ = await $.prompt.submit({ text: '/rice-account login', origin: { kind: 'composer' }, wait: false, command: { name: 'rice-account', args: 'login' } })
  expect(command_.drop).toBe(undefined)
  for (const origin of [{ kind: 'task-notification' }, { kind: 'scheduled-trigger' }] as const) {
    expect((await $.prompt.submit({ text: 'machine-made', origin, wait: false })).drop).toBe(undefined)
  }
  world.allow()
  expect((await $.command.run(command('login'))).text ?? '').toContain("back on this machine's /login")
  expect((await $.prompt.submit({ text: 'keep going', origin: { kind: 'composer' }, wait: false })).drop).toBe(undefined)
})

test('back on the machine login, /usage and /status are the engine\'s own again; with an account selected they are not', async ($, on) => {
  const world = fixture(on)
  on('command.run', { command: 'usage' }, () => ({ text: 'NATIVE_USAGE' }))
  on('command.run', { command: 'status' }, () => ({ text: 'NATIVE_STATUS' }))
  await $.session.start(START)
  expect(world.status.at(-1) ?? '').not.toContain('account-b')
  await $.command.run(command('account-b'))
  expect((await $.command.run(command('', 'usage'))).text ?? '').not.toBe('NATIVE_USAGE')
  expect((await $.command.run(command('', 'status'))).text ?? '').not.toBe('NATIVE_STATUS')
  await $.command.run(command('login'))
  expect((await $.command.run(command('', 'usage'))).text).toBe('NATIVE_USAGE')
  expect((await $.command.run(command('', 'status'))).text).toBe('NATIVE_STATUS')
})

test('a kept account that cannot be put back after a reload locks the session instead of reporting the machine login', driver, async ($, on) => {
  const world = fixture(on)
  await $.session.start(START)
  await $.command.run(command('account-b'))
  world.documents.delete(`${paths.loginDir('account-b')}/.credentials.json`)
  await $.session.start(START)
  expect(world.status.at(-1) ?? '').toContain('account not confirmed')
  expect(world.toasts.join('\n')).toContain('account-b could not be put back')
  expect((await probe($, 'model')).error ?? '').toContain('could not be put back')
  expect((await probe($, 'usage')).value).toEqual([])
  const usage = (await $.command.run(command('', 'usage'))).text ?? ''
  expect(usage).toContain('could not be put back')
  expect(usage).not.toContain('95%')
  expect((await $.command.run(command('login'))).text ?? '').toContain("back on this machine's /login")
  expect(world.header()).toBe(undefined)
  expect((await probe($, 'model')).error ?? '').toContain('Owned model backend reached')
})

test('after /clear empties the state, the next turn puts the kept account back', driver, async ($, on) => {
  const world = fixture(on)
  await $.session.start(START)
  await $.command.run(command('account-b'))
  world.clearState()
  await $.turn.start({ text: 'Owned turn after clear', turnId: 'owned-turn-after-clear' })
  expect(world.active()?.name).toBe('account-b')
  expect(world.originals()).not.toBe(undefined)
  expect(world.header()).toBe('fixture-access-account-b')
  expect((await probe($, 'usage')).value).toEqual(B_LIMITS)
})

test('renewal on its timer swaps in the renewed token without a toast', async ($, on) => {
  const world = fixture(on, { expiresInMs: { 'account-b': 360_000 } })
  await $.session.start(START)
  await $.command.run(command('account-b'))
  expect(world.header()).toBe('fixture-access-account-b')
  await world.clock.advance(60_000)
  await world.clock.settle()
  expect(world.tokenRequests()).toBe(1)
  expect(world.header()).toBe('fixture-access-account-b-renewed')
  expect(world.locks).toContain(paths.lock('account-b'))
  expect(world.toasts).toEqual([])
})

test('a turn that starts after the renewal is due renews before its first request', async ($, on) => {
  const world = fixture(on, { expiresInMs: { 'account-b': 310_000 } })
  await $.session.start(START)
  await $.command.run(command('account-b'))
  await world.clock.advance(15_000)
  expect(world.tokenRequests()).toBe(0)
  await $.turn.start({ text: 'Owned due turn', turnId: 'owned-due-turn' })
  expect(world.tokenRequests()).toBe(1)
  expect(world.header()).toBe('fixture-access-account-b-renewed')
})

test('failed renewals back off from 30 seconds, toast once per run of failures, and recover', async ($, on) => {
  const world = fixture(on, { expiresInMs: { 'account-b': 360_000 } })
  await $.session.start(START)
  await $.command.run(command('account-b'))
  world.failRefresh(true)
  await world.clock.advance(60_000); await world.clock.settle()
  expect(world.tokenRequests()).toBe(1)
  await world.clock.advance(29_000); await world.clock.settle()
  expect(world.tokenRequests()).toBe(1)
  await world.clock.advance(1_000); await world.clock.settle()
  expect(world.tokenRequests()).toBe(2)
  // Due, but inside the 60 second backoff: a turn does not retry.
  await $.turn.start({ text: 'Owned backoff turn', turnId: 'owned-backoff-turn' })
  expect(world.tokenRequests()).toBe(2)
  world.failRefresh(false)
  await world.clock.advance(60_000); await world.clock.settle()
  expect(world.tokenRequests()).toBe(3)
  expect(world.header()).toBe('fixture-access-account-b-renewed')
  expect(world.toasts.filter(text => text.includes('could not renew account-b'))).toHaveLength(1)
})

test('a committed return to the login is reported as done even when the login cannot be read for usage', async ($, on) => {
  const world = fixture(on, { isMachineUnreadable: true })
  await $.session.start(START)
  expect((await $.command.run(command('account-b'))).text ?? '').toContain('now uses account-b')
  const back = (await $.command.run(command('login'))).text ?? ''
  expect(back).toContain("back on this machine's /login")
  expect(world.header()).toBe(undefined)
  const shown = world.status.at(-1) ?? ''
  expect(shown).toContain('account login')
  expect(shown).toContain('usage unavailable')
  expect(shown).not.toContain('Loading account')
})

test('usage after a turn: main loop only, at most once a minute, never while nonessential traffic is off, stale on failure', driver, async ($, on) => {
  const world = fixture(on)
  await $.session.start(START)
  await $.command.run(command('account-b'))
  expect(world.usageCount('fixture-access-account-b')).toBe(1)
  await complete($)
  expect(world.usageCount('fixture-access-account-b')).toBe(1)
  await world.clock.advance(61_000)
  await complete($, 'owned-subagent')
  expect(world.usageCount('fixture-access-account-b')).toBe(1)
  await complete($)
  expect(world.usageCount('fixture-access-account-b')).toBe(2)
  world.environment.set('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1')
  await world.clock.advance(61_000)
  await complete($)
  expect(world.usageCount('fixture-access-account-b')).toBe(2)
  world.environment.delete('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')
  await $.command.run(command('', 'usage'))
  expect(world.usageCount('fixture-access-account-b')).toBe(3)
  await complete($)
  expect(world.usageCount('fixture-access-account-b')).toBe(3)
  world.failUsage(true)
  await world.clock.advance(61_000)
  await complete($)
  expect(world.usageCount('fixture-access-account-b')).toBe(4)
  const shown = world.status.at(-1) ?? ''
  expect(shown).toContain('5h 2%')
  expect(shown).toContain('(stale)')
  expect(shown).toContain('usage not refreshed (HTTP 500)')
  expect((await probe($, 'usage')).value).toEqual(B_LIMITS)
})

test('a switch says when the session talks to a gateway, naming only its host', async ($, on) => {
  const world = fixture(on)
  world.environment.set('ANTHROPIC_BASE_URL', 'https://user:secret@gateway.example.test:8443/v1')
  await $.session.start(START)
  const text = (await $.command.run(command('account-b'))).text ?? ''
  expect(text).toContain('gateway.example.test:8443')
  expect(text).toContain('receives the account')
  expect(text).not.toContain('secret')
  expect(text).not.toContain('user:')
})

test('a switch on the default endpoint adds no gateway notice', async ($, on) => {
  fixture(on)
  await $.session.start(START)
  expect((await $.command.run(command('account-b'))).text ?? '').not.toContain('receives the account')
})

test('a lockout puts a bearer no server accepts in place of the unconfirmed one, and a verified switch replaces it', async ($, on) => {
  const world = fixture(on)
  await $.session.start(START)
  await $.command.run(command('account-a'))
  expect(headerToken(world.environment.get('ANTHROPIC_CUSTOM_HEADERS'))).toBe('fixture-access-account-a')
  world.refuseSwitch('account-b', 'fixture-access-account-a')
  await $.command.run(command('account-b'))
  expect(headerToken(world.environment.get('ANTHROPIC_CUSTOM_HEADERS'))).toBe('rice-session-accounts-account-not-confirmed')
  world.allow()
  await $.command.run(command('account-b'))
  expect(headerToken(world.environment.get('ANTHROPIC_CUSTOM_HEADERS'))).toBe('fixture-access-account-b')
})

test('after /clear and a reload the selected account is not mistaken for the launch login', async ($, on) => {
  const world = fixture(on)
  await $.session.start(START)
  await $.command.run(command('account-b'))
  // /clear: the conversation ends under a new id, the state is emptied, no session.start follows.
  await $.session.end({ reason: 'clear', sessionId: 'owned-session-before-clear', resume: { id: 'owned-session-before-clear' } } as never)
  world.clearState()
  // A plugin reload before the next prompt.
  await $.session.start(START)
  expect(world.status.at(-1) ?? '').toContain('account not confirmed')
  expect(headerToken(world.environment.get('ANTHROPIC_CUSTOM_HEADERS'))).toBe('rice-session-accounts-account-not-confirmed')
  expect((await $.command.run(command('login'))).text ?? '').toContain("back on this machine's /login")
  expect(headerToken(world.environment.get('ANTHROPIC_CUSTOM_HEADERS'))).toBe(undefined)
})

test('a fresh load with no /clear record, such as a child claude that inherits the environment, is not locked', async ($, on) => {
  const world = fixture(on)
  await $.session.start(START)
  await $.command.run(command('account-b'))
  world.clearState()
  await $.session.start(START)
  expect(world.status.at(-1) ?? '').not.toContain('account not confirmed')
})

test('an explicit selection made while a restore is waiting is not undone by it', async ($, on) => {
  const world = fixture(on)
  await $.session.start(START)
  await $.command.run(command('account-a'))
  world.clearState()
  const switching = $.command.run(command('account-b'))
  await $.turn.start({ text: 'Owned turn after /clear', turnId: 'owned-restore-race' })
  await switching
  expect(world.active()?.name).toBe('account-b')
  expect(headerToken(world.environment.get('ANTHROPIC_CUSTOM_HEADERS'))).toBe('fixture-access-account-b')
})

test('a session not signed in with a Claude subscription refuses a switch before anything changes, and the login stays', async ($, on) => {
  const world = fixture(on)
  world.documents.delete(`${configDir}/.credentials.json`)
  world.environment.set('ANTHROPIC_API_KEY', 'fixture-launch-api-key')
  await $.session.start(START)
  const statuses = world.status.length
  const refused = (await $.command.run(command('account-b'))).text ?? ''
  expect(refused).toContain('This session cannot switch accounts: Claude Code was not started signed in with a Claude subscription')
  expect(refused).toContain('claude auth login')
  expect(world.header()).toBe(undefined)
  expect(world.environment.get('ANTHROPIC_API_KEY')).toBe('fixture-launch-api-key')
  expect(world.active()).toBe(undefined)
  expect(world.status.length).toBe(statuses)
  expect(world.locks).toEqual([])
  expect(world.usageCount('fixture-access-account-b')).toBe(0)
  expect((await $.command.run(command('login'))).text ?? '').toContain("back on this machine's /login")
})

test('an API key at launch beside a stored subscription login still switches: the switch clears the key', async ($, on) => {
  const world = fixture(on)
  world.environment.set('ANTHROPIC_API_KEY', 'fixture-launch-api-key')
  await $.session.start(START)
  expect((await $.command.run(command('account-b'))).text ?? '').toContain('now uses account-b')
  expect(world.header()).toBe('fixture-access-account-b')
  expect(world.environment.get('ANTHROPIC_API_KEY')).toBe(undefined)
  expect((await $.command.run(command('login'))).text ?? '').toContain("back on this machine's /login")
  expect(world.environment.get('ANTHROPIC_API_KEY')).toBe('fixture-launch-api-key')
})

test('a selection in effect is kept across a reload and renewals when a refusing source appears later', async ($, on) => {
  const world = fixture(on, { expiresInMs: { 'account-b': 360_000 } })
  await $.session.start(START)
  expect((await $.command.run(command('account-b'))).text ?? '').toContain('now uses account-b')
  world.useSettings({ apiKeyHelper: '/fixture/owned-helper' })
  await $.session.start(START)
  expect(world.header()).toBe('fixture-access-account-b')
  expect(world.status.at(-1) ?? '').not.toContain('account not confirmed')
  await world.clock.advance(60_000)
  await world.clock.settle()
  expect(world.header()).toBe('fixture-access-account-b-renewed')
  // A new selection is refused and leaves the one in effect as it was.
  expect((await $.command.run(command('account-a'))).text ?? '').toContain('apiKeyHelper')
  expect(world.header()).toBe('fixture-access-account-b-renewed')
  expect(world.active()?.name).toBe('account-b')
})
