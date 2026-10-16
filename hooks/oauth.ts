// Adapted from simplecore-inc/claude-mods mods/accounts/hooks/anthropic.ts at 722763c
// (MIT, Copyright (c) 2026 SimpleCORE Inc., see LICENSES/simplecore-claude-mods.MIT.txt).
// Modified: kept the endpoint constants, refresh, usage and profile parsing; pane-specific
// readings, spend and healing removed; LimitView declared here.
import type { HttpInit } from 'claude-code'

import type { Credential } from './keychain'

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
export const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
export const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const OAUTH_BETA = 'oauth-2025-04-20'
/** Refresh this long before the access token expires. */
export const EXPIRY_MARGIN_MS = 5 * 60 * 1000

export class AnthropicError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

/** One usage window: `5h`, `wk`, or a model's own weekly limit. */
export type LimitView = { label: string; percent: number; resetsAt?: string }

type RawLimit = {
  kind?: string
  percent?: number
  resets_at?: string | null
  scope?: { model?: { display_name?: string | null } | null } | null
}

type RawWindow = { utilization?: number | null; resets_at?: string | null } | null

type RawUsage = { limits?: RawLimit[]; five_hour?: RawWindow; seven_day?: RawWindow }

function labelOf(limit: RawLimit): string {
  if (limit.kind === 'session') return '5h'
  if (limit.kind === 'weekly_all') return 'wk'

  return limit.scope?.model?.display_name ?? limit.kind ?? '?'
}

/** The usage endpoint's body as windows. */
export function parseUsage(body: unknown): LimitView[] {
  const raw = (body ?? {}) as RawUsage
  if (Array.isArray(raw.limits) && raw.limits.length > 0) {
    return raw.limits
      .filter(limit => typeof limit.percent === 'number')
      .map(limit => ({ label: labelOf(limit), percent: limit.percent as number, resetsAt: limit.resets_at ?? undefined }))
  }
  const windows: [string, RawWindow | undefined][] = [
    ['5h', raw.five_hour],
    ['wk', raw.seven_day],
  ]

  return windows.flatMap(([label, window]) =>
    typeof window?.utilization === 'number' ? [{ label, percent: window.utilization, resetsAt: window.resets_at ?? undefined }] : [],
  )
}

/** A usage or profile request: with a bearer token, or with the session's own credential handle. */
export function oauthInit(auth: { token: string } | { handle: string }): HttpInit {
  if ('handle' in auth) return { headers: { 'anthropic-beta': OAUTH_BETA }, auth: auth.handle }

  return { headers: { 'anthropic-beta': OAUTH_BETA, Authorization: `Bearer ${auth.token}` } }
}

/** Whether a token expires within `marginMs`: refreshed before it is used. */
export function needsRefresh(credential: Credential, now: number, marginMs = EXPIRY_MARGIN_MS): boolean {
  return credential.claudeAiOauth.expiresAt - marginMs <= now
}

export function refreshInit(credential: Credential): HttpInit {
  const oauth = credential.claudeAiOauth

  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: oauth.refreshToken,
      client_id: CLIENT_ID,
      scope: (oauth.scopes ?? []).join(' '),
    }),
  }
}

/** The credential after a refresh; the server rotates the refresh token, so it must be saved. */
export function applyRefresh(credential: Credential, responseText: string, now: number): Credential {
  let body: { access_token?: string; refresh_token?: string; expires_in?: number } | null
  // A JSON syntax error quotes the text it read, and this response carries grants.
  try { body = JSON.parse(responseText) as typeof body } catch { throw new AnthropicError('the token refresh returned an unreadable response') }
  if (typeof body?.access_token !== 'string' || typeof body.expires_in !== 'number') {
    throw new AnthropicError('the token refresh returned no access token')
  }
  const oauth = credential.claudeAiOauth

  return {
    ...credential,
    claudeAiOauth: {
      ...oauth,
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? oauth.refreshToken,
      expiresAt: now + body.expires_in * 1000,
    },
  }
}

/** Whose a token is, as the profile endpoint answers. */
export type TokenOwner = { email: string; organizationName?: string }

export function parseProfile(text: string): TokenOwner {
  const body = JSON.parse(text) as { account?: { email?: string }; organization?: { name?: string } }
  if (typeof body.account?.email !== 'string') throw new AnthropicError('the profile endpoint named no account')

  return { email: body.account.email, organizationName: body.organization?.name }
}
