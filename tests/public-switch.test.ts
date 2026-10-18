import type { CommandRunInput, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { fixturePath } from './fixture-path'

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
    const reason = (error: unknown) => error instanceof Error ? error.message : String(error)
    if (e.args === 'cache-reference') { cachedReference = (await $.session.authorize())?.handle; return { text: 'cached' } }
    if (e.args === 'authorize-only') {
      try { return { text: (await $.session.authorize()) ? 'authorized' : 'no authorization' } } catch (error) { return { text: `refused: ${reason(error)}` } }
    }
    if (e.args === 'fetch-reference') {
      try { await $.http.fetch('https://api.anthropic.com/owned-cached-probe', { auth: cachedReference }); return { text: 'native dispatched' } }
      catch (error) { return { text: `refused: ${reason(error)}` } }
    }
    if (e.args === 'fetch-unknown') {
      try { await $.http.fetch('https://api.anthropic.com/owned-cached-probe', { auth: 'owned-never-issued-handle' }); return { text: 'native dispatched' } }
      catch (error) { return { text: `refused: ${reason(error)}` } }
    }
    if (e.args === 'recovered') {
      const authorization = await $.session.authorize()
      const child = await $.process.run(['claude', '-p', 'owned-recovered-probe'])
      return { text: JSON.stringify({ authorized: authorization !== null, exitCode: child.exitCode }) }
    }
    const failures: Record<string, string> = {}
    const capture = async (name: string, run: () => Promise<unknown>) => {
      try { await run(); failures[name] = 'unexpected dispatch' }
      catch (error) { failures[name] = reason(error) }
    }
    await capture('authorize', () => $.session.authorize())
    await capture('http', () => $.http.fetch('https://api.anthropic.com/owned-probe'))
    await capture('model', () => $.model.complete({ model: 'haiku', prompt: 'Owned synthetic blocked request', maxTokens: 1 }))
    await capture('run', () => $.process.run(['claude', '-p', 'owned-blocked-probe']))
    await capture('spawn', async () => { for await (const _chunk of $.process.spawn({ argv: ['/usr/local/bin/claude', '-p', 'owned-blocked-probe'] })) {} })
    let plainExitCode: number | string
    try { plainExitCode = (await $.process.run(['owned-child-probe'])).exitCode } catch (error) { plainExitCode = reason(error) }
    const bash = await $.tool.call({ tool: 'Bash', command: 'claude -p owned-probe' })
    const plainBash = await $.tool.call({ tool: 'Bash', command: 'printf owned-probe' })
    return { text: JSON.stringify({ failures, plainExitCode, bashDeny: bash.deny, plainBashDeny: plainBash.deny ?? null }) }
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
  let failState = false, refuseRollback = false
  const activeWrites: (string | null)[] = []
  let settings: Record<string, unknown> = {}
  mock.clock(on, { now }); mock.store(on)
  on('settings.read', () => ({ value: settings }))
  on('env.get', async (_host, e) => {
    const value = environment.get(e.name)
    if (e.name === 'ANTHROPIC_CUSTOM_HEADERS' && refuseTokenRead) { refuseTokenRead = false; return { deny: 'Owned token read refusal' } }
    if (e.name === 'ANTHROPIC_CUSTOM_HEADERS' && heldTokenRead) { const h = heldTokenRead; heldTokenRead = undefined; h.started(); await h.wait }
    return { value }
  })
  // The SDK's own shapes: `{ deny }` refuses the write, `{ value: undefined }` made it.
  on('env.set', (_host, e) => {
    if (refuseRollback && e.name === 'ANTHROPIC_CUSTOM_HEADERS' && headerToken(e.value) === 'fixture-account-a') return { deny: 'Owned rollback refusal' }
    if (refuseB && e.name === 'ANTHROPIC_CUSTOM_HEADERS' && headerToken(e.value) === 'fixture-account-b') return { deny: 'Owned policy refusal' }
    if (e.value === undefined) environment.delete(e.name); else environment.set(e.name, e.value)
    return { value: {} }
  })
  on('state.set', { plugin: 'rice-session-accounts', key: 'active' }, (_host, e, next) => {
    activeWrites.push(e.value?.name ?? null)
    if (failState && e.value?.name === 'account-b') { failState = false; return next({ ...e, value: e.previous ?? null }) }
    return next(e)
  })
  on('fs.exists', (_host, e) => ({ value: documents.has(fixturePath(e.path)) }))
  on('fs.read', (_host, e) => ({ value: documents.get(fixturePath(e.path)) ?? '{}' }))
  on('fs.write', (_host, e) => { writes.push(fixturePath(e.path)); return { value: undefined } })
  on('fs.list', () => ({ value: [] }))
  on('process.run', (_host, e) => {
    processes.push(e.argv)
    const text = e.argv[0] === 'node' && (e.argv[3] === 'read' || e.argv[3] === 'examine') ? documents.get(e.argv[4] ?? '') : undefined
    // `examine` reports a missing store as null; `read` as exit 44.
    if (e.argv[0] === 'node' && e.argv[3] === 'examine') return { value: { exitCode: 0, stdout: JSON.stringify({ stored: text === undefined ? null : JSON.parse(text), pending: null }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
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
  return { environment, documents, writes, processes, status, activeWrites, cachedRequests, useSettings(value: Record<string, unknown>) { settings = value }, refuseCachedProbe() { refuseCachedProbe = true }, refuseTokenRead() { refuseTokenRead = true }, holdTokenRead() {
    let started = () => {}, release = () => {}
    const seen = new Promise<void>(resolve => { started = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    heldTokenRead = { started, wait }
    return { seen, release }
  }, refuseB() { refuseB = true }, allowRecovery() { refuseRollback = false }, failState(denyRollback = false) { failState = true; refuseRollback = denyRollback }, holdA() {
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
  const refused = (await pending).text ?? ''
  expect(refused).toContain('refused: ')
  // A retryable cause: the selection changed under the request.
  expect(refused).toContain('changed while this request was prepared')
  expect(refused).toContain('Retry after the account selection completes')
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
  const authorization = (await $.command.run({ ...command('authorize-only'), command: 'account-safety' })).text ?? ''
  expect(authorization).toContain('Rice Accounts could not prepare the session account for this request')
  world.refuseTokenRead()
  expect((await $.command.run({ ...command('fetch-reference'), command: 'account-safety' })).text ?? '').toContain('refused: ')
  expect(world.cachedRequests).toEqual([])
})

test('an authorization never seen is refused while another account is selected, and stays native on the login', safetyDriver, async ($, on) => {
  const world = fixture(on)
  await $.session.start({ cwd: '/fixture/public-accounts', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ ...command('fetch-unknown'), command: 'account-safety' })).text).toBe('native dispatched')
  expect(world.cachedRequests).toEqual([{ auth: 'owned-never-issued-handle', authorization: undefined }])
  await $.command.run(command('account-b'))
  const refused = (await $.command.run({ ...command('fetch-unknown'), command: 'account-safety' })).text ?? ''
  // A permanent cause: retrying the same request cannot pick up account-b.
  expect(refused).toContain('not one Rice Accounts can serve')
  expect(refused).toContain('will not help')
  expect(world.cachedRequests.length).toBe(1)
})

test('a downstream HTTP failure replays its settled result without dispatching the original native A request again', safetyDriver, async ($, on) => {
  const world = fixture(on)
  on('session.authorize', () => ({ value: { handle: 'owned-native-startup-a', kind: 'bearer' } }))
  await $.session.start({ cwd: '/fixture/public-accounts', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...command('cache-reference'), command: 'account-safety' })
  await $.command.run(command('account-b'))
  world.refuseCachedProbe()
  expect((await $.command.run({ ...command('fetch-reference'), command: 'account-safety' })).text ?? '').toContain('Owned downstream HTTP refusal')
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

test('a failed selected-account report never falls back to the machine account in /usage or /status', async ($, on) => {
  const world = fixture(on)
  on('command.run', { command: 'usage' }, () => ({ text: 'native machine usage' }))
  on('command.run', { command: 'status' }, () => ({ text: 'native machine status' }))
  await $.session.start({ cwd: '/fixture/public-accounts', surface: 'terminal', isInteractive: true })
  expect((await $.command.run(command('account-b'))).text ?? '').toContain('now uses account-b')
  world.documents.delete(`${paths.loginDir('account-b')}/.credentials.json`)
  for (const name of ['usage', 'status']) {
    const text = (await $.command.run({ ...command(''), command: name })).text ?? ''
    expect(text).toContain('account-b is not signed in yet')
    expect(text).toContain('machine login was not reported')
    expect(text).not.toContain('native machine')
  }
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

test('a post-environment state failure restores the previous credential and selected report', async ($, on) => {
  const world = fixture(on)
  await $.session.start({ cwd: '/fixture/public-accounts', surface: 'terminal', isInteractive: true })
  await $.command.run(command('account-a'))
  const before = [...world.environment.entries()].sort()
  world.failState()
  const result = await $.command.run(command('account-b'))
  expect(result.text ?? '').toContain('refused the session account state change')
  expect([...world.environment.entries()].sort()).toEqual(before)
  expect(world.status.at(-1) ?? '').toContain('account-a')
  expect((await $.command.run({ ...command(''), command: 'usage' })).text ?? '').toContain('account-a usage:')
  expect(world.activeWrites.at(-1)).toBe('account-a')
  expect(world.writes).toEqual([])
})

test('a refused rollback blocks every account-bearing dispatch until an explicit verified account selection recovers', safetyDriver, async ($, on) => {
  const world = fixture(on)
  let modelDispatches = 0, toolDispatches = 0, turnDispatches = 0, httpDispatches = 0
  on('model.*', () => { modelDispatches++; return { deny: 'Owned model backend reached' } })
  on('http.fetch', { url: 'https://api.anthropic.com/owned-probe' }, () => { httpDispatches++; return { deny: 'Owned HTTP backend reached' } })
  on('tool.call', { tool: 'Bash' }, () => { toolDispatches++; return { deny: 'Owned Bash backend reached' } })
  on('turn.step', async function* (_host, e) { turnDispatches++; return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } })
  await $.session.start({ cwd: '/fixture/public-accounts', surface: 'terminal', isInteractive: true })
  await $.command.run(command('account-a'))
  world.failState(true)
  const result = await $.command.run(command('account-b'))
  expect(result.text ?? '').toContain('refused the session account state change')
  expect(result.text ?? '').toContain('Rollback could not restore ANTHROPIC_CUSTOM_HEADERS')
  expect(result.text ?? '').toContain('session account is not confirmed')
  expect(headerToken(world.environment.get('ANTHROPIC_CUSTOM_HEADERS'))).toBe('rice-session-accounts-account-not-confirmed')
  expect(world.status.at(-1) ?? '').toContain('account not confirmed')
  expect(world.status.at(-1) ?? '').not.toContain('account-a@')
  const processCount = world.processes.length
  const probe = JSON.parse((await $.command.run({ ...command(''), command: 'account-safety' })).text ?? '{}')
  for (const kind of ['authorize', 'http', 'model', 'run', 'spawn']) expect(probe.failures[kind]).toContain('session account is not confirmed')
  expect(probe.bashDeny).toContain('session account is not confirmed')
  // Children that do not start claude keep native behavior, unchanged.
  expect(probe.plainExitCode).toBe(44)
  expect(probe.plainBashDeny).toBe('Owned Bash backend reached')
  const text: string[] = []
  for await (const chunk of $.turn.step({ turnId: 'owned-uncertain-turn', index: 0, model: 'haiku', messageCount: 0 })) if (chunk.kind === 'text') text.push(chunk.text)
  expect(text.join('')).toContain('session account is not confirmed')
  expect(world.processes.length).toBe(processCount + 1)
  expect([modelDispatches, toolDispatches, turnDispatches, httpDispatches]).toEqual([0, 1, 0, 0])
  for (const name of ['usage', 'status']) expect((await $.command.run({ ...command(''), command: name })).text ?? '').toContain('session account is not confirmed')
  world.allowRecovery()
  const recovered = await $.command.run(command('account-b'))
  expect(recovered.text ?? '').toContain('now uses account-b')
  const afterRecovery = JSON.parse((await $.command.run({ ...command('recovered'), command: 'account-safety' })).text ?? '{}')
  expect(afterRecovery.authorized).toBe(true)
  expect(afterRecovery.exitCode).toBe(44)
  expect(world.status.at(-1) ?? '').toContain('account-b')
})

test('a credential Claude Code sends in place of the selected bearer refuses the switch before anything changes', async ($, on) => {
  const world = fixture(on)
  await $.session.start({ cwd: '/fixture/public-accounts', surface: 'terminal', isInteractive: true })
  expect((await $.command.run(command('account-a'))).text ?? '').toContain('now uses account-a')
  const sources: [string, () => void, () => void][] = [
    ['apiKeyHelper', () => world.useSettings({ apiKeyHelper: '/fixture/owned-helper' }), () => world.useSettings({})],
    ['CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', () => world.environment.set('CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', '3'), () => world.environment.delete('CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR')],
    ['workload identity federation', () => { world.environment.set('ANTHROPIC_FEDERATION_RULE_ID', 'fdrl_owned'); world.environment.set('ANTHROPIC_ORGANIZATION_ID', 'owned-org') }, () => { world.environment.delete('ANTHROPIC_FEDERATION_RULE_ID'); world.environment.delete('ANTHROPIC_ORGANIZATION_ID') }],
  ]
  for (const [cause, apply, remove] of sources) {
    apply()
    const environment = [...world.environment.entries()].sort()
    const [activeWrites, statuses, processes] = [world.activeWrites.length, world.status.length, world.processes.length]
    const refused = (await $.command.run(command('account-b'))).text ?? ''
    expect(refused).toContain('This session cannot switch accounts: ')
    expect(refused).toContain(cause)
    expect(refused).not.toContain('now uses')
    // Nothing was read for account-b, written, or put back: the selection in effect is untouched.
    expect([...world.environment.entries()].sort()).toEqual(environment)
    expect([world.activeWrites.length, world.status.length, world.processes.length]).toEqual([activeWrites, statuses, processes])
    expect(headerToken(world.environment.get('ANTHROPIC_CUSTOM_HEADERS'))).toBe('fixture-account-a')
    expect((await $.command.run({ ...command(''), command: 'usage' })).text ?? '').toContain('account-a usage:')
    remove()
  }
  expect(world.writes).toEqual([])
  expect((await $.command.run(command('account-b'))).text ?? '').toContain('now uses account-b')
})

test('while a switch would be refused, login, list, check, usage, default and the listing keep working', async ($, on) => {
  const world = fixture(on)
  world.useSettings({ apiKeyHelper: '/fixture/owned-helper' })
  await $.session.start({ cwd: '/fixture/public-accounts', surface: 'terminal', isInteractive: true })
  const list = (await $.command.run(command('list'))).text ?? ''
  expect(list).toContain('account-b@example.test')
  expect(list).toContain('[this session]')
  // This fixture answers no profile endpoint: the lookup ran, and nothing refused it.
  const check = (await $.command.run(command('check account-b'))).text ?? ''
  expect(check).toContain('profile')
  expect(check).not.toContain('cannot switch')
  expect((await $.command.run(command('usage'))).text ?? '').toContain('login usage:')
  expect((await $.command.run(command('default'))).text ?? '').toContain("back on this machine's /login")
  expect((await $.command.run(command('login'))).text ?? '').toContain("back on this machine's /login")
  expect((await $.command.run(command('account-b'))).text ?? '').toContain('apiKeyHelper')
  expect(headerToken(world.environment.get('ANTHROPIC_CUSTOM_HEADERS'))).toBe(undefined)
  expect(world.environment.get('CLAUDE_CODE_OAUTH_TOKEN')).toBe('fixture-machine-token')
  expect(world.writes).toEqual([])
})
