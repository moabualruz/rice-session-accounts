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
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_BG_AUTH_SNAPSHOT_PATH',
  'CLAUDE_CODE_HOST_CREDS_FILE',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
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
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_BG_AUTH_SNAPSHOT_PATH',
  'CLAUDE_CODE_HOST_CREDS_FILE',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
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
  switch (account.kind) {
    case 'claudeai':
    case 'claudeai-token':
      plan.CLAUDE_CODE_OAUTH_TOKEN = secret
      break
    default:
      throw new Error('Rice Accounts supports Anthropic OAuth accounts only.')
  }

  return plan
}

/** The names a plan changes from what the process holds now, for the switch to set. */
export function changedNames(plan: EnvPlan, current: Record<Managed, string | undefined>): Managed[] {
  return MANAGED.filter(name => plan[name] !== current[name])
}
