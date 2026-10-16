import type { AccountConfig } from './config'

/**
 * The environment variables a switch owns. Native OAuth credentials are
 * memoized, while the supported custom request headers are read when a client
 * is created. Keep the original native credential source available for its
 * own refresh lifecycle and select another account through request headers.
 */
export const MANAGED = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
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

/** Keep unrelated custom headers, replacing only competing authentication. */
export function withoutAuthHeaders(headers: string | undefined): string | undefined {
  const kept = headers?.split(/\r?\n/).filter(line => !/^\s*(?:authorization|x-api-key)\s*:/i.test(line)).join('\n')
  return kept || undefined
}

/** A session-local native SDK override. Credential bytes stay in process memory. */
export function oauthHeaders(headers: string | undefined, token: string): string {
  if (!token || /[\r\n\0]/.test(token)) throw new Error('The OAuth access token cannot be used as an HTTP header.')
  const lines = (withoutAuthHeaders(headers) ?? '').split('\n').filter(Boolean)
  const betas: string[] = []
  const kept = lines.filter(line => {
    const beta = /^\s*anthropic-beta\s*:(.*)$/i.exec(line)
    if (!beta) return true
    betas.push(...beta[1]!.split(',').map(value => value.trim()).filter(Boolean))
    return false
  })
  kept.push(`anthropic-beta: ${[...new Set([...betas, 'oauth-2025-04-20'])].join(',')}`, `Authorization: Bearer ${token}`)
  return kept.join('\n')
}

/** Reads only the generated bearer line, never arbitrary prose or another scheme. */
export function headerToken(headers: string | undefined): string | undefined {
  const values = headers?.split(/\r?\n/).flatMap(line => /^\s*authorization\s*:\s*Bearer ([^\r\n\0]+)\s*$/i.exec(line)?.[1]?.trim() ?? []) ?? []
  return values.length === 1 ? values[0] : undefined
}

/**
 * The environment for an OAuth account. `secret` is its access token.
 * The machine login restores the
 * process's own values; any other kind starts from them with every
 * credential and provider switch cleared, then sets its own.
 */
export function planEnv(account: AccountConfig, secret: string | undefined, originals: Originals): EnvPlan {
  const plan = Object.fromEntries(MANAGED.map(name => [name, originals[name] ?? undefined])) as EnvPlan
  if (account.kind === 'login') return plan
  for (const name of AUTH) plan[name] = undefined
  switch (account.kind) {
    case 'claudeai':
      if (!account.loginDir) throw new Error('The browser account has no native login directory.')
      if (!secret) throw new Error('The browser account has no OAuth access token.')
      plan.ANTHROPIC_CUSTOM_HEADERS = oauthHeaders(originals.ANTHROPIC_CUSTOM_HEADERS ?? undefined, secret)
      break
    case 'claudeai-token':
      if (!secret) throw new Error('The setup-token account has no OAuth access token.')
      plan.ANTHROPIC_CUSTOM_HEADERS = oauthHeaders(originals.ANTHROPIC_CUSTOM_HEADERS ?? undefined, secret)
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
