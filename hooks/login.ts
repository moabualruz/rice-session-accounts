import type { Originals } from './env'

/**
 * How this session's machine login authenticates, decided from the launch
 * environment in native precedence: a provider selector, an API key or an
 * auth token comes before CLAUDE_CODE_OAUTH_TOKEN, which comes before the
 * stored /login. Only the last two carry subscription usage.
 */
export type LoginSource =
  | { kind: 'not-oauth' }
  | { kind: 'launch-token'; token: string }
  | { kind: 'stored' }

const NOT_OAUTH: readonly (keyof Originals)[] = [
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_GATEWAY',
]

export const NOT_OAUTH_LOGIN = "This session's machine login uses an API key or a cloud provider, which have no Claude subscription usage. Check limits on that provider's console."

export function loginSourceOf(originals: Originals): LoginSource {
  if (NOT_OAUTH.some(name => Boolean(originals[name]))) return { kind: 'not-oauth' }
  const token = originals.CLAUDE_CODE_OAUTH_TOKEN
  if (token) return { kind: 'launch-token', token }
  return { kind: 'stored' }
}
