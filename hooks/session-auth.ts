import type { HttpInit } from 'claude-code'

import type { AuthorizationTable } from '../types'

const PREFIX = 'rice_accounts_auth_'
/** Bounds on the reference tables; the oldest unused entry goes first. */
export const NATIVE_HANDLE_LIMIT = 512
export const ISSUED_HANDLE_LIMIT = 64

/** Permanent refusals: the same request cannot succeed when retried. */
export const FOREIGN_HANDLE = 'This account authorization does not belong to the calling plugin session.'
export const NETWORK_DISABLED = 'The session credential is withheld while nonessential network traffic is disabled (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).'
export const NOT_ABSOLUTE = 'Account authorization requires an absolute first-party HTTPS URL.'
export const WRONG_HOST = 'Account authorization is restricted to https://api.anthropic.com without URL credentials or a socket override.'
export const UNKNOWN_HANDLE = 'This authorization is not one Rice Accounts can serve for the selected session account. Call $.session.authorize() again.'
/** Retryable: the selection is not ready yet. */
export const NO_CREDENTIAL = 'The selected session account has no OAuth credential. Select the account again.'

const PERMANENT = [FOREIGN_HANDLE, NETWORK_DISABLED, NOT_ABSOLUTE, WRONG_HOST, UNKNOWN_HANDLE]

/** Whether a refusal's cause is one retrying the same request cannot change. */
export function isPermanentRefusal(cause: string | undefined): boolean {
  return PERMANENT.some(text => cause?.startsWith(text) ?? false)
}

/** The refusal text for a failed authorization: its specific cause, and whether retrying can help. */
export function refusalText(cause: string | undefined): string {
  const reason = cause?.trim()
  if (isPermanentRefusal(reason)) return `Rice Accounts refused this request: ${reason} Retrying the same request will not help.`
  return `Rice Accounts could not prepare the session account for this request${reason ? `: ${reason.replace(/\.$/, '')}` : ''}. Retry after the account selection completes, or run /rice-account login to recover.`
}

function pairs(value: unknown, limit: number): [string, string][] {
  if (!Array.isArray(value)) return []
  return value
    .filter((pair): pair is [string, string] => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string')
    .slice(-limit)
}

function remember(map: Map<string, string>, key: string, value: string, limit: number): boolean {
  const changed = map.get(key) !== value
  map.delete(key)
  map.set(key, value)
  while (map.size > limit) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
  return changed
}

/**
 * Opaque selected-account references. Credentials stay outside this table;
 * it holds handle ids and plugin names only, so it can be kept in `$.state`
 * and survive a reload of this module.
 */
export class SessionAuthorizations {
  /** Native handles observed before a selection: handle to the plugin it was answered to. */
  private readonly native = new Map<string, string>()
  /** This module's own references: plugin to its handle. */
  private readonly issued = new Map<string, string>()

  owns(handle: string | undefined): boolean { return handle?.startsWith(PREFIX) ?? false }

  recognizes(handle: string | undefined): boolean { return this.owns(handle) || handle !== undefined && this.native.has(handle) }

  /** Records a native answer; true when the table changed and should be kept. */
  trackNative(plugin: string, handle: string): boolean { return remember(this.native, handle, plugin, NATIVE_HANDLE_LIMIT) }

  /** This plugin's stable reference, made on first use; `isNew` when the table changed. */
  issue(plugin: string): { authorization: { handle: string; kind: 'bearer' }; isNew: boolean } {
    const handle = this.issued.get(plugin) ?? PREFIX + crypto.randomUUID()
    const isNew = remember(this.issued, plugin, handle, ISSUED_HANDLE_LIMIT)
    return { authorization: { handle, kind: 'bearer' }, isNew }
  }

  /** Plain data for `$.state`: handle ids and plugin names, oldest first. */
  snapshot(): AuthorizationTable {
    return { native: [...this.native.entries()], issued: [...this.issued.entries()] }
  }

  /**
   * Puts back a kept table beneath what this instance already holds, which
   * is newer (a handle seen while a reload was starting); anything malformed
   * is left out.
   */
  restore(table: unknown): void {
    const native = [...this.native], issued = [...this.issued]
    this.native.clear()
    this.issued.clear()
    if (typeof table === 'object' && table !== null) {
      const kept = table as { native?: unknown; issued?: unknown }
      for (const [handle, plugin] of pairs(kept.native, NATIVE_HANDLE_LIMIT)) if (!this.owns(handle)) this.native.set(handle, plugin)
      for (const [plugin, handle] of pairs(kept.issued, ISSUED_HANDLE_LIMIT)) if (this.owns(handle)) this.issued.set(plugin, handle)
    }
    for (const [handle, plugin] of native) remember(this.native, handle, plugin, NATIVE_HANDLE_LIMIT)
    for (const [plugin, handle] of issued) remember(this.issued, plugin, handle, ISSUED_HANDLE_LIMIT)
  }

  private ownerOf(handle: string | undefined): string | undefined {
    if (handle === undefined) return undefined
    const native = this.native.get(handle)
    if (native !== undefined) return native
    for (const [plugin, issued] of this.issued) if (issued === handle) return plugin
    return undefined
  }

  /** Prepare own references and observed native references; unknown handles stay native. */
  prepare(urlText: string, init: HttpInit | undefined, plugin: string, token: string | undefined, networkDisabled: boolean): HttpInit | undefined {
    if (!this.recognizes(init?.auth)) return undefined
    if (this.ownerOf(init?.auth) !== plugin) throw new Error(FOREIGN_HANDLE)
    if (networkDisabled) throw new Error(NETWORK_DISABLED)
    let url: URL
    try { url = new URL(urlText) } catch { throw new Error(NOT_ABSOLUTE) }
    if (url.protocol !== 'https:' || url.host !== 'api.anthropic.com' || url.username || url.password || init?.socketPath !== undefined) throw new Error(WRONG_HOST)
    if (!token) throw new Error(NO_CREDENTIAL)
    const headers: Record<string, string> = {}
    let beta = ''
    for (const [key, value] of Object.entries(init?.headers ?? {})) {
      const lower = key.toLowerCase()
      if (lower === 'authorization' || lower === 'x-api-key' || lower === 'host') continue
      if (lower === 'anthropic-beta') beta = value
      else headers[key] = value
    }
    headers.Authorization = `Bearer ${token}`
    headers['anthropic-beta'] = [...new Set([...beta.split(',').map(value => value.trim()).filter(Boolean), 'oauth-2025-04-20'])].join(',')
    // Native fetch beneath this hook retains redirect/body/network policy and
    // strips Authorization when a redirect changes origin. No socket override
    // is accepted, so it cannot lose native credentialed-socket TLS checks.
    return { ...init, auth: undefined, headers }
  }
}
