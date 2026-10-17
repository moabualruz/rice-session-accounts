// Partly adapted from simplecore-inc/claude-mods mods/accounts/tests/keychain.test.ts at 722763c
// (MIT, Copyright (c) 2026 SimpleCORE Inc., see LICENSES/simplecore-claude-mods.MIT.txt).
import { expect, test } from 'claude-code/testing'

import type { Io } from '../hooks/io'
import { runFailure, trustedRun } from '../hooks/io'
import type { Credential } from '../hooks/keychain'
import { addLine, addLineLength, fitCredential, itemText, keychainAccountName, KeychainLimitError, LIVE_SERVICE, liveServiceName, parseCredential, readItem, resolveKeychainAccount, SECURITY_LINE_LIMIT, writeItem } from '../hooks/keychain'
import { applyRefresh, MAX_TOKEN_LIFETIME_S, needsRefresh, parseUsage, RefreshResponseError, refreshFailure, refreshInit, tokenErrorCode, UNKNOWN_TOKEN_LIFETIME_S } from '../hooks/oauth'

test('the keychain service is named as Claude Code names it for its config directory', async () => {
  const home = '/home/me/.claude'
  expect(await liveServiceName({}, home)).toBe(LIVE_SERVICE)
  expect(await liveServiceName({ configDir: '/home/me/.claude' }, home)).toBe('Claude Code-credentials-cb67f5c9')
  expect(await liveServiceName({ configDir: '/home/me/work-claude' }, home)).toBe('Claude Code-credentials-9b768060')
  expect(await liveServiceName({ configDir: '/home/me/work-claude', secureStorageDir: '' }, home)).toBe(LIVE_SERVICE)
  // A macOS-style folder hashes its exact text as given.
  expect(await liveServiceName({ configDir: '/Users/me/.claude' }, home)).toBe('Claude Code-credentials-0bd83d07')
})

test('addLine carries the secret as hex and refuses names that would end the line', async () => {
  const secret = '{"claudeAiOauth":{"accessToken":"sk-ant-x"}}'
  const line = addLine('rice-session-accounts', 'work', secret)
  expect(line.includes('sk-ant-x')).toBe(false)
  const hex = /-X "([0-9a-f]+)"/.exec(line)?.[1] ?? ''
  const bytes = new Uint8Array(hex.match(/../g)?.map(pair => Number.parseInt(pair, 16)) ?? [])
  expect(new TextDecoder().decode(bytes)).toBe(secret)
  expect(() => addLine('rice-session-accounts', 'w"x', '{}')).toThrow()
  expect(() => addLine('svc', 'w\nx', '{}')).toThrow()
})

test('addLine refuses a line security -i would split instead of storing a truncated login', async () => {
  const service = 'Claude Code-credentials-0bd83d07'
  const overhead = addLineLength(service, 'me', '')
  const fits = 'a'.repeat(Math.floor((SECURITY_LINE_LIMIT - overhead) / 2))
  expect(addLine(service, 'me', fits).length).toBeLessThanOrEqual(SECURITY_LINE_LIMIT)
  expect(addLine(service, 'me', fits).length).toBeGreaterThan(SECURITY_LINE_LIMIT - 2)
  expect(() => addLine(service, 'me', `${fits}a`)).toThrow(KeychainLimitError)
  let refused = ''
  try { addLine(service, 'me', `fixture-secret-${'b'.repeat(4000)}`) } catch (error) { refused = error instanceof Error ? error.message : String(error) }
  expect(refused).toContain('truncated')
  expect(refused.includes('fixture-secret')).toBe(false)
  expect(SECURITY_LINE_LIMIT).toBeLessThan(4032)
})

test('a login too long for one security -i line drops the largest optional keys first and never claudeAiOauth', async () => {
  const login: Credential = {
    claudeAiOauth: { accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token', expiresAt: 1, scopes: ['user:inference'] },
    mcpOAuth: { server: 'm'.repeat(2500) },
    organizationCache: 'o'.repeat(900),
    smallFlag: true,
  }
  const fitted = fitCredential(login, 'Claude Code-credentials', 'me')
  expect(fitted.dropped).toEqual(['mcpOAuth'])
  const stored = JSON.parse(fitted.text) as Credential
  expect(stored.claudeAiOauth).toEqual(login.claudeAiOauth)
  expect(stored.smallFlag).toBe(true)
  expect(stored.organizationCache).toBe(login.organizationCache)
  expect(addLine('Claude Code-credentials', 'me', fitted.text).length).toBeLessThanOrEqual(SECURITY_LINE_LIMIT)
  expect(fitCredential({ claudeAiOauth: login.claudeAiOauth, small: 1 }, 'Claude Code-credentials', 'me').dropped).toEqual([])
  const huge: Credential = { claudeAiOauth: { ...login.claudeAiOauth, accessToken: 'x'.repeat(2100) }, other: 'kept?' }
  expect(() => fitCredential(huge, 'Claude Code-credentials', 'me')).toThrow(KeychainLimitError)
})

test('an item printed as hex is decoded back to its JSON; a plain token stays as it is', async () => {
  const json = '{"claudeAiOauth":{}}'
  const hex = Array.from(new TextEncoder().encode(json), byte => byte.toString(16).padStart(2, '0')).join('')
  expect(itemText(`${hex}\n`)).toBe(json)
  expect(itemText('sk-ant-oat01-abc\n')).toBe('sk-ant-oat01-abc')
  expect(itemText('deadbeef')).toBe('deadbeef')
})

test('the keychain account is the user name, or claude-code-user', async () => {
  expect(keychainAccountName('me')).toBe('me')
  expect(keychainAccountName('a b')).toBe('claude-code-user')
  expect(keychainAccountName(undefined)).toBe('claude-code-user')
})

function result(stdout = '', exitCode = 0, stderr = '') {
  return { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false }
}

function keychainIo(run: Io['run']): Io {
  return {
    run,
    read: async () => { throw new Error('unexpected read') },
    write: async () => { throw new Error('unexpected write') },
    exists: async () => false,
    stat: async () => { throw new Error('unexpected stat') },
    env: async () => undefined,
    now: async () => 0,
    sleep: async () => {},
    fetch: async () => { throw new Error('unexpected network request') },
    log: () => {},
  }
}

test('an unset USER resolves the account as Claude Code does: the login name, else no -a on reads', async () => {
  const commands: (readonly string[])[] = []
  const known = keychainIo(async (argv, init) => {
    commands.push(argv)
    expect(init?.cwd).toBe('/')
    expect(init?.env).toEqual({ NoDefaultCurrentDirectoryInExePath: '1', NODE_OPTIONS: '' })
    return result('fixture.user\n')
  })
  expect(await resolveKeychainAccount(known, 'me')).toBe('me')
  expect(commands).toEqual([])
  expect(await resolveKeychainAccount(known, undefined)).toBe('fixture.user')
  expect(await resolveKeychainAccount(known, '')).toBe('fixture.user')
  expect(commands).toEqual([['/usr/bin/id', '-un'], ['/usr/bin/id', '-un']])
  expect(await resolveKeychainAccount(keychainIo(async () => result('name with space\n')), undefined)).toBe('claude-code-user')
  expect(await resolveKeychainAccount(keychainIo(async () => { throw new Error('ENOENT') }), undefined)).toBe(undefined)
  const reads: (readonly string[])[] = []
  await readItem(keychainIo(async argv => { reads.push(argv); return result('{}') }), 'svc', undefined)
  expect(reads[0]).toEqual(['/usr/bin/security', 'find-generic-password', '-s', 'svc', '-w'])
})

test('security -i error text fails a write even with exit 0, and a timeout is not reported as a missing program', async () => {
  const unknown = keychainIo(async () => result('', 0, 'Unknown command "3f"\n'))
  let failed = ''
  try { await writeItem(unknown, 'svc', 'me', '{"claudeAiOauth":{}}') } catch (error) { failed = error instanceof Error ? error.message : String(error) }
  expect(failed).toContain('security reported an error')
  const quiet = keychainIo(async (argv, init) => {
    expect(argv).toEqual(['/usr/bin/security', '-i'])
    expect(init?.stdin?.startsWith('add-generic-password -U -a "me" -s "svc" -X "')).toBe(true)
    return result('', 0, '')
  })
  await writeItem(quiet, 'svc', 'me', '{}')
  const slow = keychainIo(async () => { throw new Error('$.process.run: aborted: still running after 15000ms') })
  let timeout = ''
  try { await readItem(slow, 'svc', 'me') } catch (error) { timeout = error instanceof Error ? error.message : String(error) }
  expect(timeout).toContain('did not answer within 15 seconds')
  const locked = keychainIo(async () => result('', 36))
  let lockedText = ''
  try { await readItem(locked, 'svc', 'me') } catch (error) { lockedText = error instanceof Error ? error.message : String(error) }
  expect(lockedText).toContain('locked')
})

test('process rejections are classified as timeout, missing program, denied or other', async () => {
  expect(runFailure(new Error('$.process.run (fixture): node aborted: still running after 15000ms'))).toBe('timeout')
  expect(runFailure(Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }))).toBe('missing')
  expect(runFailure(new Error('spawn /usr/bin/node EACCES'))).toBe('denied')
  expect(runFailure(new Error('something else'))).toBe('failed')
  expect(trustedRun('/trusted', { stdin: 'x', timeoutMs: 5 })).toEqual({ stdin: 'x', timeoutMs: 5, cwd: '/trusted', env: { NoDefaultCurrentDirectoryInExePath: '1', NODE_OPTIONS: '' } })
})

test('a login is renewed five minutes before it expires, and the rotated refresh token is kept', async () => {
  const login = parseCredential('{"claudeAiOauth":{"accessToken":"a1","refreshToken":"r1","expiresAt":1000000,"scopes":["user:inference"]}}')
  expect(needsRefresh(login, 1_000_000 - 6 * 60_000)).toBe(false)
  expect(needsRefresh(login, 1_000_000 - 4 * 60_000)).toBe(true)
  expect(needsRefresh({ claudeAiOauth: { ...login.claudeAiOauth, expiresAt: Number.NaN } }, 0)).toBe(true)
  const renewed = applyRefresh(login, '{"access_token":"a2","refresh_token":"r2","expires_in":3600}', 5_000)
  expect(renewed.claudeAiOauth.accessToken).toBe('a2')
  expect(renewed.claudeAiOauth.refreshToken).toBe('r2')
  expect(renewed.claudeAiOauth.expiresAt).toBe(5_000 + 3_600_000)
  expect(renewed.claudeAiOauth.scopes).toEqual(['user:inference'])
})

test('refresh responses are validated: no rotation, missing, negative, huge or text lifetimes', async () => {
  const login = parseCredential('{"claudeAiOauth":{"accessToken":"a1","refreshToken":"r1","expiresAt":1}}')
  expect(applyRefresh(login, '{"access_token":"a2","expires_in":60}', 0).claudeAiOauth.refreshToken).toBe('r1')
  expect(applyRefresh(login, '{"access_token":"a2","refresh_token":null,"expires_in":60}', 0).claudeAiOauth.refreshToken).toBe('r1')
  expect(applyRefresh(login, '{"access_token":"a2"}', 0).claudeAiOauth.expiresAt).toBe(UNKNOWN_TOKEN_LIFETIME_S * 1000)
  expect(applyRefresh(login, '{"access_token":"a2","expires_in":-5}', 0).claudeAiOauth.expiresAt).toBe(UNKNOWN_TOKEN_LIFETIME_S * 1000)
  expect(applyRefresh(login, '{"access_token":"a2","expires_in":1e12}', 0).claudeAiOauth.expiresAt).toBe(MAX_TOKEN_LIFETIME_S * 1000)
  expect(applyRefresh(login, '{"access_token":"a2","expires_in":"3600"}', 0).claudeAiOauth.expiresAt).toBe(3_600_000)
  for (const body of ['[]', 'null', '{"access_token":""}', '{"access_token":"bad token"}', '{"access_token":42}', `{"access_token":"${'z'.repeat(70_000)}"}`]) {
    expect(() => applyRefresh(login, body, 0)).toThrow(RefreshResponseError)
  }
})

test('a rotated refresh token without a usable access token is salvaged, not dropped', async () => {
  const login = parseCredential('{"claudeAiOauth":{"accessToken":"a1","refreshToken":"r1","expiresAt":1},"keep":"yes"}')
  let salvage: Credential | undefined
  let text = ''
  try { applyRefresh(login, '{"refresh_token":"fixture-rotated-grant","expires_in":3600}', 0) } catch (error) {
    if (error instanceof RefreshResponseError) { salvage = error.salvage; text = error.message }
  }
  expect(text).toContain('no access token')
  expect(text.includes('fixture-rotated-grant')).toBe(false)
  expect(salvage?.claudeAiOauth.refreshToken).toBe('fixture-rotated-grant')
  expect(salvage?.claudeAiOauth.expiresAt).toBe(0)
  expect(salvage?.keep).toBe('yes')
  let unrotated: RefreshResponseError | undefined
  try { applyRefresh(login, '{"refresh_token":"r1"}', 0) } catch (error) { if (error instanceof RefreshResponseError) unrotated = error }
  expect(unrotated?.salvage).toBe(undefined)
})

test('an unreadable refresh response fails without quoting the grant text it held', async () => {
  const login = parseCredential('{"claudeAiOauth":{"accessToken":"a1","refreshToken":"r1","expiresAt":1000000}}')
  let message = ''
  try { applyRefresh(login, '{"refresh_token":"fixture-rotated-grant-wxyz","access_token":"fixture-access-wxyz","x":@}', 5_000) }
  catch (error) { message = error instanceof Error ? error.message : String(error) }
  expect(message).toContain('unreadable response')
  expect(message.includes('wxyz')).toBe(false)
})

test('the refresh request carries the client id and scopes, and omits an empty scope', async () => {
  const scoped = JSON.parse(String(refreshInit(parseCredential('{"claudeAiOauth":{"accessToken":"a","refreshToken":"r","expiresAt":1,"scopes":["user:inference","user:profile"]}}')).body)) as Record<string, string>
  expect(scoped).toEqual({ grant_type: 'refresh_token', refresh_token: 'r', client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', scope: 'user:inference user:profile' })
  const bare = JSON.parse(String(refreshInit(parseCredential('{"claudeAiOauth":{"accessToken":"a","refreshToken":"r","expiresAt":1}}')).body)) as Record<string, string>
  expect('scope' in bare).toBe(false)
})

test('token endpoint failures say whether to sign in again and never echo the body', async () => {
  const body = (error: string) => JSON.stringify({ error, error_description: 'fixture-echo-secret' })
  const revoked = refreshFailure('work', { status: 400, text: body('invalid_grant'), headers: {} })
  expect(revoked.message).toContain('sign it in again: /rice-account setup work')
  expect(revoked.status).toBe(400)
  const scope = refreshFailure('work', { status: 400, text: body('invalid_scope'), headers: {} })
  expect(scope.message).toContain('invalid_scope')
  expect(scope.message.includes('sign it in again')).toBe(false)
  const limited = refreshFailure('work', { status: 429, text: 'fixture-echo-secret', headers: { 'retry-after': '120' } })
  expect(limited.message).toContain('rate limiting')
  expect(limited.message).toContain('120 seconds')
  expect(limited.message).toContain('kept')
  const down = refreshFailure('work', { status: 503, text: '<html>fixture-echo-secret</html>', headers: {} })
  expect(down.message).toContain('HTTP 503')
  for (const failure of [revoked, scope, limited, down]) expect(failure.message.includes('fixture-echo-secret')).toBe(false)
  expect(tokenErrorCode(body('made-up-code'))).toBe(undefined)
  expect(tokenErrorCode(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'x' } }))).toBe('rate_limit_error')
  expect(tokenErrorCode(`{"error":"invalid_grant","pad":"${'p'.repeat(70_000)}"}`)).toBe(undefined)
})

test('usage windows read both response shapes', async () => {
  expect(parseUsage({ limits: [{ kind: 'session', percent: 12 }, { kind: 'weekly_all', percent: 40 }] }).map(limit => limit.label)).toEqual(['5h', 'wk'])
  expect(parseUsage({ five_hour: { utilization: 3 }, seven_day: { utilization: 9 } }).map(limit => limit.percent)).toEqual([3, 9])
})
