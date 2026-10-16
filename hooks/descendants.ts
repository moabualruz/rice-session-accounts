import type { EngineInterface, On } from 'claude-code'

/** Native child-environment filtering removes CLAUDE_CODE_OAUTH_TOKEN. */
const BASH_AUTH = 'export CLAUDE_CODE_OAUTH_TOKEN="${RICE_SESSION_ACCOUNTS_OAUTH_RELAY-}"; unset RICE_SESSION_ACCOUNTS_OAUTH_RELAY;\n'

/** Derived process state only. No credential bytes enter commands or files. */
export async function syncDescendantAuth($: EngineInterface): Promise<void> {
  const token = await $.env.get('CLAUDE_CODE_OAUTH_TOKEN')
  const current = await $.env.get('RICE_SESSION_ACCOUNTS_OAUTH_RELAY')
  if (current !== (token || undefined)) await $.env.set('RICE_SESSION_ACCOUNTS_OAUTH_RELAY', token || undefined)
}

/** The caller's explicit environment has precedence over the inherited token. */
async function childEnvironment($: EngineInterface, explicit: Record<string, string> | undefined): Promise<Record<string, string> | undefined> {
  const token = await $.env.get('CLAUDE_CODE_OAUTH_TOKEN')
  return token ? { CLAUDE_CODE_OAUTH_TOKEN: token, ...explicit } : explicit
}

/**
 * Keep native child filtering intact, then restore the selected session token
 * through each supported child surface. No listener or transport is involved.
 */
export function registerDescendantAuth(on: On): void {
  on('process.run', async ($, e, next) => {
    const env = await childEnvironment($, e.init?.env)
    return next(env === e.init?.env ? e : { ...e, init: { ...e.init, env } })
  }).catch((_host, e, next) => next.called ? next(e) : { deny: 'Account authentication could not be prepared for the child process. Retry the account switch.' })

  on('process.spawn', async function* ($, e, next) {
    const env = await childEnvironment($, e.env)
    return yield* next(env === e.env ? e : { ...e, env })
  }).catch(async function* (_host, e, next) {
    if (next.called) return yield* next(e)
    return { deny: 'Account authentication could not be prepared for the streamed child process. Retry the account switch.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const token = await $.env.get('CLAUDE_CODE_OAUTH_TOKEN')
    if (!token) return next(e)
    await syncDescendantAuth($)
    return next({ ...e, command: BASH_AUTH + e.command })
  }).catch((_host, e, next) => next.called ? next(e) : { deny: 'Account authentication could not be prepared for Bash. Retry the account switch.' })
}
