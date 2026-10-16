import type { HttpInit } from 'claude-code'

const PREFIX = 'rice_accounts_auth_'
const INVALID = 'This account authorization does not belong to the calling plugin session.'

/** Opaque selected-account references. Credentials stay outside this table. */
export class SessionAuthorizations {
  private readonly handles = new Map<string, string>()
  private readonly pluginHandles = new Map<string, string>()

  clear(): void { this.handles.clear(); this.pluginHandles.clear() }

  owns(handle: string | undefined): boolean { return handle?.startsWith(PREFIX) ?? false }

  recognizes(handle: string | undefined): boolean { return this.owns(handle) || handle !== undefined && this.handles.has(handle) }

  trackNative(plugin: string, handle: string): void { this.handles.set(handle, plugin) }

  issue(plugin: string): { handle: string; kind: 'bearer' } {
    const handle = this.pluginHandles.get(plugin) ?? PREFIX + crypto.randomUUID()
    this.pluginHandles.set(plugin, handle)
    this.handles.set(handle, plugin)
    return { handle, kind: 'bearer' }
  }

  /** Prepare own references and observed native references; unknown handles stay native. */
  prepare(urlText: string, init: HttpInit | undefined, plugin: string, token: string | undefined, networkDisabled: boolean): HttpInit | undefined {
    if (!this.recognizes(init?.auth)) return undefined
    const issued = init?.auth ? this.handles.get(init.auth) : undefined
    if (issued !== plugin) throw new Error(INVALID)
    if (networkDisabled) throw new Error('The session credential is withheld while nonessential network traffic is disabled.')
    let url: URL
    try { url = new URL(urlText) } catch { throw new Error('Account authorization requires an absolute first-party HTTPS URL.') }
    if (url.protocol !== 'https:' || url.host !== 'api.anthropic.com' || url.username || url.password || init?.socketPath !== undefined) throw new Error('Account authorization is restricted to https://api.anthropic.com without URL credentials or a socket override.')
    if (!token) throw new Error('The selected session account has no OAuth credential. Select the account again.')
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
