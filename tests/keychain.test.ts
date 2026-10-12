// Partly adapted from simplecore-inc/claude-mods mods/accounts/tests/keychain.test.ts at 722763c
// (MIT, Copyright (c) 2026 SimpleCORE Inc., see LICENSES/simplecore-claude-mods.MIT.txt).
import { expect, test } from 'claude-code/testing'

import { addLine, itemText, keychainAccountName, LIVE_SERVICE, liveServiceName, parseCredential } from '../hooks/keychain'
import { applyRefresh, needsRefresh, parseUsage } from '../hooks/oauth'

test('the keychain service is named as Claude Code names it for its config directory', async () => {
  const home = '/home/me/.claude'
  expect(await liveServiceName({}, home)).toBe(LIVE_SERVICE)
  expect(await liveServiceName({ configDir: '/home/me/.claude' }, home)).toBe('Claude Code-credentials-cb67f5c9')
  expect(await liveServiceName({ configDir: '/home/me/work-claude' }, home)).toBe('Claude Code-credentials-9b768060')
  expect(await liveServiceName({ configDir: '/home/me/work-claude', secureStorageDir: '' }, home)).toBe(LIVE_SERVICE)
  // Checked on this machine against an item Claude Code itself wrote for CLAUDE_CONFIG_DIR=/Users/mkh/.claude.
  expect(await liveServiceName({ configDir: '/Users/mkh/.claude' }, home)).toBe('Claude Code-credentials-3617b2f2')
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

test('an item printed as hex is decoded back to its JSON; a plain token stays as it is', async () => {
  const json = '{"claudeAiOauth":{}}'
  const hex = Array.from(new TextEncoder().encode(json), byte => byte.toString(16).padStart(2, '0')).join('')
  expect(itemText(`${hex}\n`)).toBe(json)
  expect(itemText('sk-ant-oat01-abc\n')).toBe('sk-ant-oat01-abc')
  expect(itemText('deadbeef')).toBe('deadbeef')
})

test('the keychain account is the user name, or claude-code-user', async () => {
  expect(keychainAccountName('mkh')).toBe('mkh')
  expect(keychainAccountName('a b')).toBe('claude-code-user')
  expect(keychainAccountName(undefined)).toBe('claude-code-user')
})

test('a login is renewed five minutes before it expires, and the rotated refresh token is kept', async () => {
  const login = parseCredential('{"claudeAiOauth":{"accessToken":"a1","refreshToken":"r1","expiresAt":1000000,"scopes":["user:inference"]}}')
  expect(needsRefresh(login, 1_000_000 - 6 * 60_000)).toBe(false)
  expect(needsRefresh(login, 1_000_000 - 4 * 60_000)).toBe(true)
  const renewed = applyRefresh(login, '{"access_token":"a2","refresh_token":"r2","expires_in":3600}', 5_000)
  expect(renewed.claudeAiOauth.accessToken).toBe('a2')
  expect(renewed.claudeAiOauth.refreshToken).toBe('r2')
  expect(renewed.claudeAiOauth.expiresAt).toBe(5_000 + 3_600_000)
  expect(renewed.claudeAiOauth.scopes).toEqual(['user:inference'])
})

test('usage windows read both response shapes', async () => {
  expect(parseUsage({ limits: [{ kind: 'session', percent: 12 }, { kind: 'weekly_all', percent: 40 }] }).map(limit => limit.label)).toEqual(['5h', 'wk'])
  expect(parseUsage({ five_hour: { utilization: 3 }, seven_day: { utilization: 9 } }).map(limit => limit.percent)).toEqual([3, 9])
})
