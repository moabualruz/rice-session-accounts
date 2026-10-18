// Adapted from simplecore-inc/claude-mods mods/accounts/hooks/anthropic.ts at 722763c
// (MIT, Copyright (c) 2026 SimpleCORE Inc., see LICENSES/simplecore-claude-mods.MIT.txt).
// Modified: kept the endpoint constants, refresh, usage and profile parsing; pane-specific
// readings, spend and healing removed; LimitView declared here; refresh responses and
// token-endpoint failures validated and classified without echoing bodies.
import type { HttpInit, HttpResponse, SessionRateLimit } from 'claude-code'

import type { Credential } from './keychain'

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
/** Claude Code 2.1.302's TOKEN_URL and CLIENT_ID constants, verified read-only in its binary. */
export const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
export const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const OAUTH_BETA = 'oauth-2025-04-20'
/** Refresh this long before the access token expires, by the local clock; it also absorbs a few minutes of clock skew. */
export const EXPIRY_MARGIN_MS = 5 * 60 * 1000
/** The largest token-endpoint body parsed; a larger one is refused without being read or quoted. */
export const MAX_TOKEN_BODY = 64 * 1024
/** A longer `expires_in` is treated as this, so a login is still renewed in time if the value is wrong. */
export const MAX_TOKEN_LIFETIME_S = 7 * 24 * 60 * 60
/** The lifetime assumed when `expires_in` is missing or not a positive number: short, so the login is renewed again soon. */
export const UNKNOWN_TOKEN_LIFETIME_S = 10 * 60
const MAX_TOKEN_LENGTH = 16 * 1024
/** OAuth and API error codes that may be shown; any other text of an error body is never echoed. */
const KNOWN_ERRORS = new Set([
  'invalid_grant', 'invalid_request', 'invalid_client', 'invalid_scope', 'unauthorized_client', 'unsupported_grant_type',
  'invalid_request_error', 'authentication_error', 'permission_error', 'rate_limit_error', 'api_error', 'overloaded_error',
])

export class AnthropicError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

/**
 * A successful refresh whose body cannot be used. When it still rotated the
 * refresh token, `salvage` is the login holding that new refresh token (its
 * access token expired), which must be saved: the old refresh token is spent.
 */
export class RefreshResponseError extends AnthropicError {
  readonly salvage?: Credential

  constructor(message: string, salvage?: Credential) {
    super(message)
    this.salvage = salvage
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

/** The window kinds the engine's `SessionRateLimit` declares. */
const ENGINE_LIMIT_KINDS = new Set(['five_hour', 'seven_day', 'spend_limit'])
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/

/**
 * Usage windows as the engine's `SessionRateLimit` declares them (2.1.302):
 * kind `five_hour`, `seven_day` or `spend_limit`; `percentUsed` 0 to 100 with
 * at most one decimal, past 100 only on an exceeded spend limit; `resetsAt` an
 * ISO 8601 timestamp. A model's own weekly window has no engine kind and is
 * left out here; this module's own text still shows it.
 */
export function sessionRateLimits(limits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]): SessionRateLimit[] {
  return limits.flatMap(limit => {
    if (!ENGINE_LIMIT_KINDS.has(limit.kind) || !Number.isFinite(limit.percentUsed)) return []
    const percent = Math.max(0, limit.kind === 'spend_limit' ? limit.percentUsed : Math.min(100, limit.percentUsed))
    return [{ kind: limit.kind, percentUsed: Math.round(percent * 10) / 10, ...(limit.resetsAt !== undefined && ISO_TIME.test(limit.resetsAt) ? { resetsAt: limit.resetsAt } : {}) }]
  })
}

/**
 * The User-Agent Claude Code 2.1.302 sends from its API client, which makes its
 * GET /api/oauth/usage request: `claude-cli/<version> (external, cli)`, `cli`
 * being its entry point in a terminal session. A version that is not one
 * header token is sent as `unknown`.
 */
export function userAgent(version: string | undefined): string {
  return `claude-cli/${version !== undefined && /^[\x21-\x7e]{1,128}$/.test(version) ? version : 'unknown'} (external, cli)`
}

/** `init` with that User-Agent, so usage, profile and token requests identify as Claude Code. */
export function withUserAgent(init: HttpInit | undefined, version: string | undefined): HttpInit {
  return { ...init, headers: { ...init?.headers, 'User-Agent': userAgent(version) } }
}

/** A usage or profile request: with a bearer token, or with the session's own credential handle. */
export function oauthInit(auth: { token: string } | { handle: string }): HttpInit {
  if ('handle' in auth) return { headers: { 'anthropic-beta': OAUTH_BETA }, auth: auth.handle }

  return { headers: { 'anthropic-beta': OAUTH_BETA, Authorization: `Bearer ${auth.token}` } }
}

/** Whether a token expires within `marginMs` of the local clock: refreshed before it is used. A login without a usable expiry is renewed. */
export function needsRefresh(credential: Credential, now: number, marginMs = EXPIRY_MARGIN_MS): boolean {
  const expiresAt = credential.claudeAiOauth.expiresAt
  return !Number.isFinite(expiresAt) || expiresAt - marginMs <= now
}

/**
 * The refresh request Claude Code sends: grant type, refresh token, client id
 * (the login's own `clientId` when it was signed in with another client, as
 * Claude Code 2.1.302 sends it) and the login's scopes. A login without scopes
 * omits `scope`, which keeps the scopes originally granted (RFC 6749 section
 * 6); an empty `scope` would ask for none.
 */
export function refreshInit(credential: Credential): HttpInit {
  const oauth = credential.claudeAiOauth
  const scopes = Array.isArray(oauth.scopes) ? oauth.scopes.filter(scope => typeof scope === 'string' && scope !== '') : []
  const clientId = typeof oauth.clientId === 'string' && /^[\x21-\x7e]{1,256}$/.test(oauth.clientId) ? oauth.clientId : CLIENT_ID

  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: oauth.refreshToken,
      client_id: clientId,
      ...(scopes.length > 0 ? { scope: scopes.join(' ') } : {}),
    }),
  }
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_LENGTH && !/[\s\u0000-\u001f\u007f]/.test(value)
}

function lifetimeOf(value: unknown): number {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,10}$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isFinite(seconds) || seconds <= 0) return UNKNOWN_TOKEN_LIFETIME_S

  return Math.min(seconds, MAX_TOKEN_LIFETIME_S)
}

/**
 * When the refresh token of a response expires, as Claude Code 2.1.302 records
 * it (`refreshTokenExpiresAt`, which its signed-in check reads): from a
 * numeric `refresh_token_expires_in`, else not given, and the stored one stays.
 */
function refreshExpiryOf(fields: Record<string, unknown>, now: number): { refreshTokenExpiresAt?: number } {
  const seconds = fields.refresh_token_expires_in
  return typeof seconds === 'number' && Number.isFinite(seconds) ? { refreshTokenExpiresAt: now + seconds * 1000 } : {}
}

/**
 * The credential after a refresh; the server rotates the refresh token, so it
 * must be saved. An absent `refresh_token` means the server did not rotate it
 * and the current one stays. A missing, negative or non-numeric `expires_in`
 * counts as ten minutes, and one over seven days as seven days. Errors never
 * quote the body: it carries grants.
 */
export function applyRefresh(credential: Credential, responseText: string, now: number): Credential {
  if (responseText.length > MAX_TOKEN_BODY) throw new RefreshResponseError('the token refresh returned an oversized response')
  let body: unknown
  // A JSON syntax error quotes the text it read, and this response carries grants.
  try { body = JSON.parse(responseText) } catch { throw new RefreshResponseError('the token refresh returned an unreadable response') }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new RefreshResponseError('the token refresh returned an unreadable response')
  const fields = body as Record<string, unknown>
  const oauth = credential.claudeAiOauth
  const refreshToken = fields.refresh_token
  const rotated = isToken(refreshToken) ? refreshToken : undefined
  const accessToken = fields.access_token
  if (!isToken(accessToken)) {
    const salvage = rotated !== undefined && rotated !== oauth.refreshToken
      ? { ...credential, claudeAiOauth: { ...oauth, refreshToken: rotated, expiresAt: 0, ...refreshExpiryOf(fields, now) } }
      : undefined
    throw new RefreshResponseError('the token refresh returned no access token', salvage)
  }

  return {
    ...credential,
    claudeAiOauth: {
      ...oauth,
      accessToken,
      refreshToken: rotated ?? oauth.refreshToken,
      expiresAt: now + lifetimeOf(fields.expires_in) * 1000,
      ...refreshExpiryOf(fields, now),
    },
  }
}

/** The error code of a token-endpoint error body, only when it is a known code; the body itself is never returned. */
export function tokenErrorCode(text: string): string | undefined {
  if (text.length > MAX_TOKEN_BODY) return undefined
  try {
    const body: unknown = JSON.parse(text)
    const error = (body as { error?: unknown } | null)?.error
    const code = typeof error === 'string' ? error : (error as { type?: unknown } | null | undefined)?.type
    return typeof code === 'string' && KNOWN_ERRORS.has(code) ? code : undefined
  } catch {
    return undefined
  }
}

function retryAfterSeconds(headers: Record<string, string> | undefined): number | undefined {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() === 'retry-after' && /^\d{1,6}$/.test(value.trim())) return Number(value.trim())
  }

  return undefined
}

/**
 * Why the token endpoint refused a renewal, for the account `name`. Only
 * `invalid_grant` means the login itself is gone and must be signed in again;
 * rate limits and server failures keep the saved login for a retry. The body
 * is never echoed, only a known error code.
 */
export function refreshFailure(name: string, response: Pick<HttpResponse, 'status' | 'text'> & { headers?: Record<string, string> }): AnthropicError {
  const { status } = response
  const code = tokenErrorCode(response.text)
  if (code === 'invalid_grant') {
    return new AnthropicError(`the ${name} login was revoked or has expired (HTTP ${status}, invalid_grant); sign it in again: /rice-account setup ${name}`, status)
  }
  if (status === 429) {
    const wait = retryAfterSeconds(response.headers)
    return new AnthropicError(`the Anthropic sign-in service is rate limiting renewals (HTTP 429); the saved ${name} login was kept, retry ${wait === undefined ? 'in a few minutes' : `in ${wait} seconds`}`, status)
  }
  if (status >= 500) {
    return new AnthropicError(`the Anthropic sign-in service failed (HTTP ${status}); the saved ${name} login was kept, retry later`, status)
  }

  return new AnthropicError(`the token endpoint refused to renew the ${name} login (HTTP ${status}${code ? `, ${code}` : ''}); the saved login was kept. Retry, and update Rice Accounts if this persists`, status)
}

/** A short, secret-free reason a token request could not be sent: its error code or kind, never its text. */
export function networkProblem(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  if (/timed? ?out|ETIMEDOUT|still running after/i.test(text)) return 'the request timed out'
  const code = /\b(E[A-Z]{3,}|UND_ERR_[A-Z_]+|CERT_[A-Z_]+)\b/.exec(text)?.[1]
  return code ? `the network request failed (${code})` : 'the network request failed'
}

/** Whose a token is, as the profile endpoint answers. */
export type TokenOwner = { email: string; organizationName?: string }

export function parseProfile(text: string): TokenOwner {
  const body = JSON.parse(text) as { account?: { email?: string }; organization?: { name?: string } }
  if (typeof body.account?.email !== 'string') throw new AnthropicError('the profile endpoint named no account')

  return { email: body.account.email, organizationName: body.organization?.name }
}
