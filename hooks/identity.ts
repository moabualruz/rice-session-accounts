import type { Machine } from './accounts'
import type { AccountConfig } from './config'
import { readLogin } from './credentials'
import type { LoginLocation } from './credentials'
import type { Io } from './io'
import type { Credential } from './keychain'
import type { LoginSource } from './login'

export type AccountIdentity = { email: string; tier: string }

const UNKNOWN: AccountIdentity = { email: 'Unknown', tier: 'Unknown' }
const UNSIGNED: AccountIdentity = { email: 'Not signed in', tier: 'Unknown' }
const PLANS: Record<string, string> = {
  free: 'Free', pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise',
}

function plan(credential: Credential): string {
  const { subscriptionType, rateLimitTier } = credential.claudeAiOauth
  if (typeof subscriptionType !== 'string') return 'Unknown'
  const subscription = subscriptionType.trim().toLowerCase()
  if (subscription === 'max') {
    if (rateLimitTier === 'default_claude_max_5x') return 'Max (5x)'
    if (rateLimitTier === 'default_claude_max_20x') return 'Max (20x)'
  }

  return Object.hasOwn(PLANS, subscription) ? PLANS[subscription] ?? 'Unknown' : 'Unknown'
}

/** Native account metadata only. Never infer an identity from a saved label. */
async function emailAt(io: Io, path: string): Promise<string | undefined> {
  try {
    const raw: unknown = JSON.parse(await io.read(path))
    const email = (raw as { oauthAccount?: { emailAddress?: unknown } } | null)?.oauthAccount?.emailAddress
    if (typeof email !== 'string') return undefined
    const value = email.trim()

    return value.length > 0 && value.length <= 320 && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined
  } catch {
    return undefined
  }
}

function metadataPath(folder: string): string {
  return `${folder.replace(/\/+$/, '')}/.claude.json`
}

/**
 * Read cached email and plan for account rows without refreshing the login or
 * making provider requests. Credential bytes are never returned or logged.
 * The machine login's `source` says what the session launched with: a launch
 * token or an API key is not the stored /login, so that login is not read.
 */
export async function accountIdentity(io: Io, account: AccountConfig, machine: Machine, source: LoginSource = { kind: 'stored' }): Promise<AccountIdentity> {
  if (account.kind === 'login' && source.kind === 'launch-token') return { email: 'Set by CLAUDE_CODE_OAUTH_TOKEN', tier: 'Unknown' }
  if (account.kind === 'login' && source.kind === 'not-oauth') return { email: 'Not available', tier: 'API or provider' }
  if (account.kind !== 'login' && account.kind !== 'claudeai') {
    const provider = {
      'claudeai-token': 'Unknown', 'api-key': 'API', gateway: 'Gateway',
      bedrock: 'AWS Bedrock', vertex: 'Google Vertex', foundry: 'Azure Foundry',
    }

    return { email: 'Not available', tier: provider[account.kind] }
  }
  if (account.kind === 'claudeai' && !account.loginDir) return { ...UNSIGNED }
  const location: LoginLocation = {
    storage: account.kind === 'claudeai'
      ? { configDir: account.loginDir, secureStorageDir: account.loginDir }
      : machine.storage,
    defaultConfigDir: machine.claudeDir,
    user: machine.user,
  }
  let credential: Credential | null
  try {
    credential = await readLogin(io, location)
  } catch {
    return { ...UNKNOWN }
  }
  if (credential === null) return { ...UNSIGNED }

  const paths: string[] = []
  if (account.kind === 'claudeai') {
    paths.push(metadataPath(account.loginDir!))
  } else if (machine.storage.configDir) {
    paths.push(metadataPath(machine.storage.configDir))
  } else {
    // Native Windows keeps ~/.claude.json under USERPROFILE, which HOME rarely names.
    const windows = await io.env('OS').catch(() => undefined) === 'Windows_NT'
    const home = (windows ? await io.env('USERPROFILE').catch(() => undefined) : undefined) ?? await io.env('HOME').catch(() => undefined)
    if (home) paths.push(metadataPath(home))
    const fallback = metadataPath(machine.claudeDir)
    if (!paths.includes(fallback)) paths.push(fallback)
  }
  for (const path of paths) {
    const email = await emailAt(io, path)
    if (email) return { email, tier: plan(credential) }
  }

  return { email: 'Unknown', tier: plan(credential) }
}
