import type { AccountConfig } from './config'

/**
 * The environment variables a switch owns. Claude Code reads them on every
 * request, so setting them in this process changes this session's account
 * from its next request, its subagents' included, and every child it starts
 * after (a `claude -p` too); other sessions are other processes.
 */
export const MANAGED = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_API_KEY',
] as const

export type Managed = (typeof MANAGED)[number]

/** Each managed variable as the process started: a value, or null for unset. */
export type Originals = Record<Managed, string | null>

/** What a switch sets: a value, or undefined to unset. */
export type EnvPlan = Record<Managed, string | undefined>

/** The variables that pick a credential or a provider; a switch to any other account clears them first. */
const AUTH: readonly Managed[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_FOUNDRY_API_KEY',
]

/**
 * The environment for an account. `secret` is the account's token or key
 * (a claude.ai access token, an API key, a gateway token), absent for kinds
 * that use another tool's credentials. The machine login restores the
 * process's own values; any other kind starts from them with every
 * credential and provider switch cleared, then sets its own.
 */
export function planEnv(account: AccountConfig, secret: string | undefined, originals: Originals): EnvPlan {
  const plan = Object.fromEntries(MANAGED.map(name => [name, originals[name] ?? undefined])) as EnvPlan
  if (account.kind === 'login') return plan
  for (const name of AUTH) plan[name] = undefined
  const keep = (value: string | undefined, name: Managed) => value ?? originals[name] ?? undefined
  switch (account.kind) {
    case 'claudeai':
    case 'claudeai-token':
      plan.CLAUDE_CODE_OAUTH_TOKEN = secret
      break
    case 'api-key':
      plan.ANTHROPIC_API_KEY = secret
      break
    case 'gateway':
      plan.ANTHROPIC_BASE_URL = account.baseUrl
      plan.ANTHROPIC_AUTH_TOKEN = secret
      break
    case 'bedrock':
      plan.CLAUDE_CODE_USE_BEDROCK = '1'
      plan.AWS_PROFILE = keep(account.awsProfile, 'AWS_PROFILE')
      plan.AWS_REGION = keep(account.region, 'AWS_REGION')
      plan.ANTHROPIC_BEDROCK_BASE_URL = keep(account.baseUrl, 'ANTHROPIC_BEDROCK_BASE_URL')
      plan.AWS_BEARER_TOKEN_BEDROCK = secret
      break
    case 'vertex':
      plan.CLAUDE_CODE_USE_VERTEX = '1'
      plan.ANTHROPIC_VERTEX_PROJECT_ID = account.projectId
      plan.CLOUD_ML_REGION = keep(account.region, 'CLOUD_ML_REGION')
      plan.ANTHROPIC_VERTEX_BASE_URL = keep(account.baseUrl, 'ANTHROPIC_VERTEX_BASE_URL')
      break
    case 'foundry':
      plan.CLAUDE_CODE_USE_FOUNDRY = '1'
      plan.ANTHROPIC_FOUNDRY_RESOURCE = keep(account.resource, 'ANTHROPIC_FOUNDRY_RESOURCE')
      plan.ANTHROPIC_FOUNDRY_BASE_URL = keep(account.baseUrl, 'ANTHROPIC_FOUNDRY_BASE_URL')
      plan.ANTHROPIC_FOUNDRY_API_KEY = secret
      break
  }

  return plan
}

/** The names a plan changes from what the process holds now, for the switch to set. */
export function changedNames(plan: EnvPlan, current: Record<Managed, string | undefined>): Managed[] {
  return MANAGED.filter(name => plan[name] !== current[name])
}
