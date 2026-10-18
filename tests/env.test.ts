import { expect, test } from 'claude-code/testing'

import type { AccountConfig } from '../hooks/config'
import { BLOCKING_VARIABLES, headerToken, MANAGED, oauthHeaders, planEnv, SWITCH_BLOCKERS, switchBlocker } from '../hooks/env'
import type { Originals, SwitchContext } from '../hooks/env'

const none = Object.fromEntries(MANAGED.map(name => [name, null])) as Originals
const launched: Originals = { ...none, AWS_PROFILE: 'personal', AWS_REGION: 'eu-central-1', ANTHROPIC_API_KEY: 'sk-launch', CLAUDE_CODE_USE_BEDROCK: '1' }
const providerSelectors = {
  CLAUDE_CODE_USE_ANTHROPIC_AWS: '1',
  CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: '1',
  CLAUDE_CODE_USE_MANTLE: '1',
  CLAUDE_CODE_USE_GATEWAY: '1',
  CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '17',
  CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR: '19',
  CLAUDE_BG_AUTH_SNAPSHOT_PATH: '/fixture/background-auth',
  CLAUDE_CODE_HOST_CREDS_FILE: '/fixture/host-credentials',
  CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
  CLAUDE_CODE_HOST_AUTH_ENV_VAR: 'FIXTURE_HOST_AUTH',
}

test('the machine login restores every managed variable as the process started', async () => {
  const plan = planEnv({ kind: 'login' }, undefined, launched)
  expect(plan.ANTHROPIC_API_KEY).toBe('sk-launch')
  expect(plan.CLAUDE_CODE_USE_BEDROCK).toBe('1')
  expect(plan.AWS_PROFILE).toBe('personal')
  expect(plan.CLAUDE_CODE_OAUTH_TOKEN).toBe(undefined)
})

test('a browser account selects SDK request headers and keeps native baseline credential ownership', async () => {
  const plan = planEnv({ kind: 'claudeai', loginDir: '/x' }, 'oat-1', launched)
  expect(headerToken(plan.ANTHROPIC_CUSTOM_HEADERS)).toBe('oat-1')
  expect(plan.CLAUDE_CODE_OAUTH_TOKEN).toBe(undefined)
  expect(plan.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(undefined)
  expect(plan.ANTHROPIC_API_KEY).toBe(undefined)
  expect(plan.ANTHROPIC_AUTH_TOKEN).toBe(undefined)
  expect(plan.CLAUDE_CODE_USE_BEDROCK).toBe(undefined)
  // Provider settings that pick no credential are left as the process had them.
  expect(plan.AWS_PROFILE).toBe('personal')
})

test('an OAuth setup-token account overrides SDK authorization without replacing the launch token', async () => {
  const plan = planEnv({ kind: 'claudeai-token', secret: { service: 's', account: 'a' } }, 'fixture-setup-token', { ...launched, CLAUDE_CODE_OAUTH_TOKEN: 'oat-launch' })
  expect(plan.ANTHROPIC_API_KEY).toBe(undefined)
  expect(plan.CLAUDE_CODE_OAUTH_TOKEN).toBe('oat-launch')
  expect(headerToken(plan.ANTHROPIC_CUSTOM_HEADERS)).toBe('fixture-setup-token')
  expect(plan.CLAUDE_CODE_USE_BEDROCK).toBe(undefined)
})

test('OAuth request headers preserve other headers and restore exact original authentication on login', async () => {
  const original = 'X-Trace: kept\naUtHoRiZaTiOn: Bearer old\nx-api-key: old-key\nAnthropic-Beta: fixture-beta,oauth-2025-04-20'
  const baseline = { ...launched, ANTHROPIC_CUSTOM_HEADERS: original, CLAUDE_SECURESTORAGE_CONFIG_DIR: '/machine/original-store' }
  const selected = planEnv({ kind: 'claudeai', loginDir: '/isolated/b' }, 'selected-b', baseline)
  expect(selected.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Trace: kept\nanthropic-beta: fixture-beta,oauth-2025-04-20\nAuthorization: Bearer selected-b')
  expect(selected.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('/machine/original-store')
  expect(planEnv({ kind: 'login' }, undefined, baseline).ANTHROPIC_CUSTOM_HEADERS).toBe(original)
  expect(() => oauthHeaders(original, 'token\nX-Injected: bad')).toThrow('HTTP header')
  expect(headerToken('Authorization: Bearer one\nauthorization: Bearer two')).toBe(undefined)
})

test('legacy provider records cannot create an account switch environment', async () => {
  const accounts: AccountConfig[] = [
    { kind: 'api-key', secret: { service: 's', account: 'key' } },
    { kind: 'gateway', baseUrl: 'https://gateway.example', secret: { service: 's', account: 'gateway' } },
    { kind: 'bedrock', awsProfile: 'work' },
    { kind: 'vertex', projectId: 'project' },
    { kind: 'foundry', resource: 'resource' },
  ]
  for (const account of accounts) expect(() => planEnv(account, 'fixture-value', launched)).toThrow('OAuth accounts only')
})

test('new native provider selectors are managed and restored for the machine login', async () => {
  const plan: Record<string, string | undefined> = planEnv({ kind: 'login' }, undefined, { ...launched, ...providerSelectors })
  for (const [name, value] of Object.entries(providerSelectors)) {
    expect(MANAGED).toContain(name)
    expect(plan[name]).toBe(value)
  }
})

test('every supported OAuth account clears inherited native provider selectors and host authentication', async () => {
  const accounts: AccountConfig[] = [
    { kind: 'claudeai', loginDir: '/fixture/login' },
    { kind: 'claudeai-token', secret: { service: 'fixture', account: 'token' } },
  ]
  for (const account of accounts) {
    const plan: Record<string, string | undefined> = planEnv(account, 'fixture-secret', { ...launched, ...providerSelectors })
    for (const name of Object.keys(providerSelectors)) {
      expect(MANAGED).toContain(name)
      expect(plan[name]).toBe(undefined)
    }
  }
})

const clean: SwitchContext = { settings: {}, variables: {}, isOAuthLogin: true }

test('a session signed in with a Claude subscription and no competing credential may switch', async () => {
  expect(switchBlocker(clean)).toBe(undefined)
  // The switch clears these itself, and the subscription login then carries the selected bearer.
  expect(switchBlocker({ ...clean, settings: { env: { ANTHROPIC_API_KEY: 'fixture' }, apiKeyHelper: '' } })).toBe(undefined)
})

test('each measured credential source refuses the switch with its cause and its fix on one line', async () => {
  const cases: [SwitchContext, string, string][] = [
    [{ ...clean, settings: { apiKeyHelper: '/fixture/helper' } }, 'apiKeyHelper setting', 'Remove apiKeyHelper'],
    [{ ...clean, variables: { CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '3' } }, 'through CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'Start Claude Code without CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR'],
    [{ ...clean, variables: { ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_fixture', ANTHROPIC_ORGANIZATION_ID: 'fixture-org' } }, 'workload identity federation', 'Start Claude Code without them'],
    [{ ...clean, isOAuthLogin: false }, 'not started signed in with a Claude subscription', 'claude auth login, or CLAUDE_CODE_OAUTH_TOKEN'],
  ]
  for (const [context, cause, fix] of cases) {
    const refusal = switchBlocker(context) ?? ''
    expect(refusal.startsWith('This session cannot switch accounts: ')).toBe(true)
    expect(refusal).toContain(cause)
    expect(refusal).toContain(fix)
    expect(refusal).not.toContain('\n')
  }
  expect(cases.length).toBe(SWITCH_BLOCKERS.length)
})

test('the first source in the table is reported, and an unknown input refuses nothing', async () => {
  expect(switchBlocker({ settings: { apiKeyHelper: 'helper' }, variables: { CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '3' }, isOAuthLogin: false }) ?? '').toContain('apiKeyHelper')
  expect(switchBlocker({ ...clean, settings: undefined })).toBe(undefined)
  expect(switchBlocker({ ...clean, isOAuthLogin: undefined })).toBe(undefined)
  // Federation is in effect only with both variables.
  expect(switchBlocker({ ...clean, variables: { ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_fixture' } })).toBe(undefined)
})

test('the variables the switch reads are exactly those the table names', async () => {
  expect([...BLOCKING_VARIABLES].sort()).toEqual(['ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR'])
})
