import { expect, test } from 'claude-code/testing'

import type { AccountConfig } from '../hooks/config'
import { MANAGED, planEnv } from '../hooks/env'
import type { Originals } from '../hooks/env'

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

test('a claude.ai account sets only the OAuth token and clears every credential that would outrank it', async () => {
  const plan = planEnv({ kind: 'claudeai', loginDir: '/x' }, 'oat-1', launched)
  expect(plan.CLAUDE_CODE_OAUTH_TOKEN).toBe('oat-1')
  expect(plan.ANTHROPIC_API_KEY).toBe(undefined)
  expect(plan.ANTHROPIC_AUTH_TOKEN).toBe(undefined)
  expect(plan.CLAUDE_CODE_USE_BEDROCK).toBe(undefined)
  // Provider settings that pick no credential are left as the process had them.
  expect(plan.AWS_PROFILE).toBe('personal')
})

test('an OAuth setup-token account replaces the launch OAuth token and clears competing credentials', async () => {
  const plan = planEnv({ kind: 'claudeai-token', secret: { service: 's', account: 'a' } }, 'fixture-setup-token', { ...launched, CLAUDE_CODE_OAUTH_TOKEN: 'oat-launch' })
  expect(plan.ANTHROPIC_API_KEY).toBe(undefined)
  expect(plan.CLAUDE_CODE_OAUTH_TOKEN).toBe('fixture-setup-token')
  expect(plan.CLAUDE_CODE_USE_BEDROCK).toBe(undefined)
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
