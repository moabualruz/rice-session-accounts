import { expect, test } from 'claude-code/testing'

import { SessionAuthorizations } from '../hooks/session-auth'

test('selected authorization references preserve native handles and bind their own handles to the caller', async () => {
  const auth = new SessionAuthorizations()
  expect(auth.prepare('https://example.test', { auth: 'native-handle' }, 'caller', 'synthetic-b', false)).toBe(undefined)
  const reference = auth.issue('caller')
  expect(reference.kind).toBe('bearer')
  expect(reference.handle).not.toContain('synthetic-b')
  expect(() => auth.prepare('https://api.anthropic.com/api/oauth/profile', { auth: reference.handle }, 'other-plugin', 'synthetic-b', false)).toThrow('calling plugin')
})

test('selected first-party authorization replaces competing credentials while retaining the HTTP request', async () => {
  const auth = new SessionAuthorizations(), reference = auth.issue('caller')
  const prepared = auth.prepare('https://api.anthropic.com:443/api/oauth/profile', {
    auth: reference.handle, method: 'POST', body: 'owned body', timeoutMs: 1234,
    headers: { authorization: 'stale-a', 'X-API-Key': 'stale-key', Host: 'other.test', Accept: 'application/json', 'Anthropic-Beta': 'existing-beta,oauth-2025-04-20' },
  }, 'caller', 'synthetic-b', false)
  expect(prepared?.auth).toBe(undefined)
  expect(prepared?.method).toBe('POST')
  expect(prepared?.body).toBe('owned body')
  expect(prepared?.timeoutMs).toBe(1234)
  expect(prepared?.headers).toEqual({ Accept: 'application/json', Authorization: 'Bearer synthetic-b', 'anthropic-beta': 'existing-beta,oauth-2025-04-20' })
})

test('cached session references use B on the next dispatch while an already prepared A request keeps A', async () => {
  const auth = new SessionAuthorizations(), reference = auth.issue('caller')
  const heldA = auth.prepare('https://api.anthropic.com/api/oauth/profile', { auth: reference.handle }, 'caller', 'synthetic-a', false)
  expect(auth.issue('caller').handle).toBe(reference.handle)
  expect(auth.prepare('https://api.anthropic.com/api/oauth/profile', { auth: reference.handle }, 'caller', 'synthetic-b', false)?.headers?.Authorization).toBe('Bearer synthetic-b')
  expect(heldA?.headers?.Authorization).toBe('Bearer synthetic-a')
  expect(auth.prepare('https://api.anthropic.com/api/oauth/profile', { auth: reference.handle }, 'caller', 'synthetic-b-renewed', false)?.headers?.Authorization).toBe('Bearer synthetic-b-renewed')
  auth.trackNative('caller', 'observed-startup-handle')
  expect(auth.prepare('https://api.anthropic.com/api/oauth/profile', { auth: 'observed-startup-handle' }, 'caller', 'synthetic-b', false)?.headers?.Authorization).toBe('Bearer synthetic-b')
  expect(() => auth.prepare('https://api.anthropic.com/', { auth: 'observed-startup-handle' }, 'another', 'synthetic-b', false)).toThrow('calling plugin')
  const separateSession = new SessionAuthorizations()
  expect(() => separateSession.prepare('https://api.anthropic.com/', { auth: reference.handle }, 'caller', 'synthetic-c', false)).toThrow('calling plugin session')
  expect(separateSession.recognizes('observed-startup-handle')).toBe(false)
})

test('selected authorization retains the native first-party HTTPS and nonessential-traffic boundary', async () => {
  const auth = new SessionAuthorizations(), reference = auth.issue('caller')
  const prepare = (url: string) => auth.prepare(url, { auth: reference.handle }, 'caller', 'synthetic-b', false)
  for (const url of ['http://api.anthropic.com/api/oauth/profile', 'https://api.anthropic.com.evil.test/', 'https://api.anthropic.com:444/', 'https://user:password@api.anthropic.com/', '/relative']) expect(() => prepare(url)).toThrow()
  expect(() => auth.prepare('https://api.anthropic.com/', { auth: reference.handle, socketPath: '/owned-socket' }, 'caller', 'synthetic-b', false)).toThrow('socket override')
  expect(() => auth.prepare('https://api.anthropic.com/', { auth: reference.handle }, 'caller', 'synthetic-b', true)).toThrow('nonessential')
  expect(() => auth.prepare('https://api.anthropic.com/', { auth: reference.handle }, 'caller', undefined, false)).toThrow('no OAuth credential')
})
