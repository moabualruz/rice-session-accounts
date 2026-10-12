import { expect, test } from 'claude-code/testing'

import type { AccountConfig } from '../hooks/config'
import { MANAGED, planEnv } from '../hooks/env'
import type { Originals } from '../hooks/env'

const none = Object.fromEntries(MANAGED.map(name => [name, null])) as Originals
const launched: Originals = { ...none, AWS_PROFILE: 'personal', AWS_REGION: 'eu-central-1', ANTHROPIC_API_KEY: 'sk-launch', CLAUDE_CODE_USE_BEDROCK: '1' }

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

test('an API key account sets the key and clears the OAuth token and providers', async () => {
  const plan = planEnv({ kind: 'api-key', secret: { service: 's', account: 'a' } }, 'sk-work', { ...launched, CLAUDE_CODE_OAUTH_TOKEN: 'oat-launch' })
  expect(plan.ANTHROPIC_API_KEY).toBe('sk-work')
  expect(plan.CLAUDE_CODE_OAUTH_TOKEN).toBe(undefined)
  expect(plan.CLAUDE_CODE_USE_BEDROCK).toBe(undefined)
})

test('a gateway account sets its base URL and bearer token', async () => {
  const account: AccountConfig = { kind: 'gateway', baseUrl: 'https://gw.example', secret: { service: 's', account: 'gw' } }
  const plan = planEnv(account, 'gw-token', none)
  expect(plan.ANTHROPIC_BASE_URL).toBe('https://gw.example')
  expect(plan.ANTHROPIC_AUTH_TOKEN).toBe('gw-token')
})

test('cloud accounts switch the provider and keep launch values they do not name', async () => {
  const bedrock = planEnv({ kind: 'bedrock', awsProfile: 'work' }, undefined, launched)
  expect(bedrock.CLAUDE_CODE_USE_BEDROCK).toBe('1')
  expect(bedrock.AWS_PROFILE).toBe('work')
  expect(bedrock.AWS_REGION).toBe('eu-central-1')
  expect(bedrock.ANTHROPIC_API_KEY).toBe(undefined)
  const vertex = planEnv({ kind: 'vertex', projectId: 'p1', region: 'us-east5' }, undefined, launched)
  expect(vertex.CLAUDE_CODE_USE_VERTEX).toBe('1')
  expect(vertex.CLAUDE_CODE_USE_BEDROCK).toBe(undefined)
  expect(vertex.ANTHROPIC_VERTEX_PROJECT_ID).toBe('p1')
  expect(vertex.CLOUD_ML_REGION).toBe('us-east5')
  const foundry = planEnv({ kind: 'foundry', resource: 'r1', secret: { service: 's', account: 'f' } }, 'fk', none)
  expect(foundry.CLAUDE_CODE_USE_FOUNDRY).toBe('1')
  expect(foundry.ANTHROPIC_FOUNDRY_RESOURCE).toBe('r1')
  expect(foundry.ANTHROPIC_FOUNDRY_API_KEY).toBe('fk')
})
