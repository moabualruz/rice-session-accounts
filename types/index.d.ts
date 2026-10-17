/**
 * What a session keeps of the account it switched to, taken at the switch:
 * the kind and where its credential lives, never the credential. Renewal reads
 * this copy, so a later edit of accounts.json (another session removing the
 * account, say) does not change a running session.
 */
export type AccountSnapshot = {
  kind: 'claudeai' | 'claudeai-token'
  loginDir?: string
  secret?: { service: string; account: string }
  label?: string
}

/** The account this session switched to, or null while it runs on the default. */
export type ActiveAccount = { name: string; switchedAt: number; account?: AccountSnapshot }

/** The managed environment variables as the process started, null for unset. */
export type EnvSnapshot = Record<string, string | null>

/**
 * Opaque authorization references, oldest first: native handles observed
 * before a selection (handle, plugin) and this plugin's own (plugin, handle).
 * Handle ids and plugin names only; no credential.
 */
export type AuthorizationTable = { native: [string, string][]; issued: [string, string][] }

declare module 'claude-code' {
  interface PluginState {
    'rice-session-accounts': {
      active: ActiveAccount | null
      originals: EnvSnapshot | null
      /** Why the session account is unconfirmed; requests stay refused until a verified selection. */
      problem: string | null
      authorizations: AuthorizationTable | null
    }
  }
}
