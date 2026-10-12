/** The account this session switched to, or null while it runs on the default. */
export type ActiveAccount = { name: string; switchedAt: number }

/** The managed environment variables as the process started, null for unset. */
export type EnvSnapshot = Record<string, string | null>

declare module 'claude-code' {
  interface PluginState {
    'rice-session-accounts': {
      active: ActiveAccount | null
      originals: EnvSnapshot | null
    }
  }
}
