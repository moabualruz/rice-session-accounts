import { expect, test } from 'claude-code/testing'

import { ISSUED_HANDLE_LIMIT, NATIVE_HANDLE_LIMIT, refusalText, SessionAuthorizations, UNKNOWN_HANDLE } from '../hooks/session-auth'

test('selected authorization references preserve native handles and bind their own handles to the caller', async () => {
  const auth = new SessionAuthorizations()
  expect(auth.prepare('https://example.test', { auth: 'native-handle' }, 'caller', 'synthetic-b', false)).toBe(undefined)
  const reference = auth.issue('caller').authorization
  expect(reference.kind).toBe('bearer')
  expect(reference.handle).not.toContain('synthetic-b')
  expect(() => auth.prepare('https://api.anthropic.com/api/oauth/profile', { auth: reference.handle }, 'other-plugin', 'synthetic-b', false)).toThrow('calling plugin')
})

test('selected first-party authorization replaces competing credentials while retaining the HTTP request', async () => {
  const auth = new SessionAuthorizations(), reference = auth.issue('caller').authorization
  const prepared = auth.prepare('https://api.anthropic.com:443/api/oauth/profile', {
    auth: reference.handle, method: 'POST', body: 'owned body',
    headers: { authorization: 'stale-a', 'X-API-Key': 'stale-key', Host: 'other.test', Accept: 'application/json', 'Anthropic-Beta': 'existing-beta,oauth-2025-04-20' },
  }, 'caller', 'synthetic-b', false)
  expect(prepared?.auth).toBe(undefined)
  expect(prepared?.method).toBe('POST')
  expect(prepared?.body).toBe('owned body')
  expect(prepared?.headers).toEqual({ Accept: 'application/json', Authorization: 'Bearer synthetic-b', 'anthropic-beta': 'existing-beta,oauth-2025-04-20' })
})

test('cached session references use B on the next dispatch while an already prepared A request keeps A', async () => {
  const auth = new SessionAuthorizations(), reference = auth.issue('caller').authorization
  const heldA = auth.prepare('https://api.anthropic.com/api/oauth/profile', { auth: reference.handle }, 'caller', 'synthetic-a', false)
  expect(auth.issue('caller')).toEqual({ authorization: reference, isNew: false })
  expect(auth.prepare('https://api.anthropic.com/api/oauth/profile', { auth: reference.handle }, 'caller', 'synthetic-b', false)?.headers?.Authorization).toBe('Bearer synthetic-b')
  expect(heldA?.headers?.Authorization).toBe('Bearer synthetic-a')
  expect(auth.prepare('https://api.anthropic.com/api/oauth/profile', { auth: reference.handle }, 'caller', 'synthetic-b-renewed', false)?.headers?.Authorization).toBe('Bearer synthetic-b-renewed')
  expect(auth.trackNative('caller', 'observed-startup-handle')).toBe(true)
  expect(auth.trackNative('caller', 'observed-startup-handle')).toBe(false)
  expect(auth.prepare('https://api.anthropic.com/api/oauth/profile', { auth: 'observed-startup-handle' }, 'caller', 'synthetic-b', false)?.headers?.Authorization).toBe('Bearer synthetic-b')
  expect(() => auth.prepare('https://api.anthropic.com/', { auth: 'observed-startup-handle' }, 'another', 'synthetic-b', false)).toThrow('calling plugin')
  const separateSession = new SessionAuthorizations()
  expect(() => separateSession.prepare('https://api.anthropic.com/', { auth: reference.handle }, 'caller', 'synthetic-c', false)).toThrow('authorize() again')
  expect(separateSession.recognizes('observed-startup-handle')).toBe(false)
})

test('selected authorization retains the native first-party HTTPS and nonessential-traffic boundary', async () => {
  const auth = new SessionAuthorizations(), reference = auth.issue('caller').authorization
  const prepare = (url: string) => auth.prepare(url, { auth: reference.handle }, 'caller', 'synthetic-b', false)
  for (const url of ['http://api.anthropic.com/api/oauth/profile', 'https://api.anthropic.com.evil.test/', 'https://api.anthropic.com:444/', 'https://user:password@api.anthropic.com/', '/relative']) expect(() => prepare(url)).toThrow()
  expect(() => auth.prepare('https://api.anthropic.com/', { auth: reference.handle, socketPath: '/owned-socket' }, 'caller', 'synthetic-b', false)).toThrow('socket override')
  expect(() => auth.prepare('https://api.anthropic.com/', { auth: reference.handle }, 'caller', 'synthetic-b', true)).toThrow('nonessential')
  expect(() => auth.prepare('https://api.anthropic.com/', { auth: reference.handle }, 'caller', undefined, false)).toThrow('no OAuth credential')
})

test('the reference table survives a reload as plain data, without credentials, and serves the same handles', async () => {
  const auth = new SessionAuthorizations()
  const reference = auth.issue('caller').authorization
  auth.trackNative('consumer', 'observed-native-handle')
  const kept = JSON.parse(JSON.stringify(auth.snapshot()))
  expect(JSON.stringify(kept).includes('synthetic')).toBe(false)
  const reloaded = new SessionAuthorizations()
  reloaded.restore(kept)
  expect(reloaded.issue('caller')).toEqual({ authorization: reference, isNew: false })
  expect(reloaded.prepare('https://api.anthropic.com/', { auth: 'observed-native-handle' }, 'consumer', 'synthetic-b', false)?.headers?.Authorization).toBe('Bearer synthetic-b')
  for (const malformed of [null, 'text', { native: 'x' }, { native: [['only-one']], issued: [[1, 2]] }]) {
    const empty = new SessionAuthorizations()
    empty.restore(malformed)
    expect(empty.snapshot()).toEqual({ native: [], issued: [] })
  }
})

test('the reference tables stay bounded, dropping the least recently used entry first', async () => {
  const auth = new SessionAuthorizations()
  auth.trackNative('consumer', 'native-first')
  for (let index = 0; index < NATIVE_HANDLE_LIMIT; index += 1) {
    auth.trackNative('consumer', `native-${index}`)
    if (index === 10) auth.trackNative('consumer', 'native-first')
  }
  const table = auth.snapshot()
  expect(table.native.length).toBe(NATIVE_HANDLE_LIMIT)
  expect(auth.recognizes('native-first')).toBe(true)
  expect(auth.recognizes('native-0')).toBe(false)
  for (let index = 0; index < ISSUED_HANDLE_LIMIT + 5; index += 1) auth.issue(`plugin-${index}`)
  expect(auth.snapshot().issued.length).toBe(ISSUED_HANDLE_LIMIT)
})

test('refusals name their cause and say whether a retry can help', async () => {
  const auth = new SessionAuthorizations(), reference = auth.issue('caller').authorization
  const causeOf = (run: () => unknown) => { try { run(); return '' } catch (error) { return error instanceof Error ? error.message : String(error) } }
  const permanent = [
    causeOf(() => auth.prepare('https://api.anthropic.com/', { auth: reference.handle }, 'another', 'synthetic-b', false)),
    causeOf(() => auth.prepare('https://api.anthropic.com/', { auth: reference.handle }, 'caller', 'synthetic-b', true)),
    causeOf(() => auth.prepare('https://other.test/', { auth: reference.handle }, 'caller', 'synthetic-b', false)),
    UNKNOWN_HANDLE,
  ]
  for (const cause of permanent) {
    const text = refusalText(cause)
    expect(text).toContain(cause)
    expect(text).toContain('will not help')
  }
  const retryable = refusalText(causeOf(() => auth.prepare('https://api.anthropic.com/', { auth: reference.handle }, 'caller', undefined, false)))
  expect(retryable).toContain('no OAuth credential')
  expect(retryable).toContain('Retry after the account selection completes')
  expect(refusalText(undefined)).toContain('Retry after the account selection completes')
  expect(refusalText('The session account is changing. Retry when the selection completes.')).toContain('changing')
})
