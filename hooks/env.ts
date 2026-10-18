import type { AccountConfig } from './config'
import type { EnvName } from './io'

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

/**
 * What a switch is checked against before anything changes: the settings
 * merged over every source, the variables the blockers name, and whether
 * Claude Code itself signs in with a Claude subscription. A read that failed
 * leaves `settings` or `isOAuthLogin` undefined.
 */
export type SwitchContext = {
  settings: Readonly<Record<string, unknown>> | undefined
  variables: Readonly<Partial<Record<EnvName, string>>>
  isOAuthLogin: boolean | undefined
}

/** A credential source, how it is detected, and what to change; `message` names the cause and the fix. */
export type SwitchBlocker =
  | { setting: string; message: string }
  | { variables: readonly EnvName[]; message: string }
  | { login: 'not-oauth'; message: string }

/**
 * The sources that beat or break the selected account's bearer on the wire,
 * as measured against Claude Code 2.1.302: Claude Code's own credential wins
 * over the request header, or its requests drop the OAuth beta header the
 * bearer needs. An API key, an auth token or a provider selector does
 * neither: the switch clears them. The first that applies is reported.
 */
export const SWITCH_BLOCKERS: readonly SwitchBlocker[] = [
  { setting: 'apiKeyHelper', message: "Claude Code sends the key from the apiKeyHelper setting in place of the selected account's token. Remove apiKeyHelper from your settings, then restart Claude Code." },
  { variables: ['CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR'], message: "Claude Code sends the API key it read through CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR along with the selected account's token. Start Claude Code without CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR." },
  { variables: ['ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID'], message: "Claude Code signs in through workload identity federation (ANTHROPIC_FEDERATION_RULE_ID and ANTHROPIC_ORGANIZATION_ID) and sends that token in place of the selected account's. Start Claude Code without them." },
  { login: 'not-oauth', message: "Claude Code was not started signed in with a Claude subscription, so its requests drop the OAuth beta header the selected account's token needs. Start Claude Code signed in with your Claude subscription (claude auth login, or CLAUDE_CODE_OAUTH_TOKEN)." },
]

/** The variables the blockers name, for the switch to read by their literal names. */
export const BLOCKING_VARIABLES: readonly EnvName[] = [...new Set(SWITCH_BLOCKERS.flatMap(blocker => 'variables' in blocker ? blocker.variables : []))]

/** Why a switch to an account other than the login cannot work in this session, or undefined. Unknown inputs refuse nothing. */
export function switchBlocker(context: SwitchContext): string | undefined {
  const found = SWITCH_BLOCKERS.find(blocker => {
    if ('setting' in blocker) {
      const value = context.settings?.[blocker.setting]
      return typeof value === 'string' && value.trim() !== ''
    }
    if ('variables' in blocker) return blocker.variables.every(name => Boolean(context.variables[name]))
    return context.isOAuthLogin === false
  })
  return found && `This session cannot switch accounts: ${found.message}`
}

/** The names a plan changes from what the process holds now, for the switch to set. */
export function changedNames(plan: EnvPlan, current: Record<Managed, string | undefined>): Managed[] {
  return MANAGED.filter(name => plan[name] !== current[name])
}
