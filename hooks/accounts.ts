import type { AccountConfig, Paths } from './config'
import { readLogin, readSecret, writeLogin } from './credentials'
import type { LoginLocation } from './credentials'
import type { Io } from './io'
import { isSameGrant } from './keychain'
import type { Credential, StorageVariables } from './keychain'
import { withLock } from './lock'
import { AnthropicError, applyRefresh, needsRefresh, refreshInit, TOKEN_URL } from './oauth'

/** Where Claude Code keeps this machine's own login. */
export type Machine = { claudeDir: string; user: string | undefined; storage: StorageVariables }

/** What a switch needs from an account's credential store; the secret stays in memory only. */
export type Material = { secret?: string; expiresAt?: number }

/** The secret, and when it expires for a login that does, read from its platform store. */
export async function materialFor(io: Io, name: string, account: AccountConfig, paths: Paths, machine: Machine): Promise<Material> {
  if (account.kind === 'claudeai') {
    const credential = await freshLogin(io, name, account, paths, machine)

    return { secret: credential.claudeAiOauth.accessToken, expiresAt: credential.claudeAiOauth.expiresAt }
  }
  if (!account.secret) return {}
  const text = await readSecret(io, account.secret)
  if (text === null || text.trim() === '') {
    throw new Error(
      `${name} has no stored secret yet: /rice-account setup ${name}`,
    )
  }

  return { secret: text.trim() }
}

async function machineLogin(io: Io, machine: Machine): Promise<Credential | null> {
  return readLogin(io, { storage: machine.storage, defaultConfigDir: machine.claudeDir, user: machine.user })
}

/**
 * The isolated login of a claudeai account, renewed when it expires within
 * five minutes. Its folder is signed in only for this mod, so renewing it
 * (the server rotates the refresh token) spends nobody else's grant; the lock
 * and the read inside it keep two sessions from renewing it at once.
 */
export async function freshLogin(io: Io, name: string, account: AccountConfig, paths: Paths, machine: Machine): Promise<Credential> {
  if (!account.loginDir) throw new Error(`${name} has no loginDir`)
  const location: LoginLocation = {
    storage: { configDir: account.loginDir, secureStorageDir: account.loginDir },
    defaultConfigDir: machine.claudeDir,
    user: machine.user,
  }
  const load = async (): Promise<Credential> => {
    const value = await readLogin(io, location)
    if (value === null) throw new Error(`${name} is not signed in yet: /rice-account setup ${name}`)

    return value
  }
  const first = await load()
  if (!needsRefresh(first, await io.now())) return first

  return withLock(io, paths.lock(name), { staleMs: 60_000, tries: 20 }, async () => {
    const current = await load()
    if (!needsRefresh(current, await io.now())) return current
    const own = await machineLogin(io, machine)
    if (isSameGrant(current, own)) throw new Error(`${name} holds this machine's own /login; switch to "login" instead`)
    const response = await io.fetch(TOKEN_URL, refreshInit(current))
    if (!response.ok) {
      throw new AnthropicError(`the ${name} login could not be renewed (HTTP ${response.status}); sign it in again: /rice-account setup ${name}`, response.status)
    }
    const fresh = applyRefresh(current, response.text, await io.now())
    const saved = await writeLogin(io, location, fresh, current)
    io.log(`renewed the ${name} login`)

    return saved
  })
}

/** The email an isolated login folder records (not secret), for the listing. */
export async function loginEmail(io: Io, loginDir: string | undefined): Promise<string | undefined> {
  if (!loginDir) return undefined
  try {
    const raw = JSON.parse(await io.read(`${loginDir}/.claude.json`)) as { oauthAccount?: { emailAddress?: unknown } }

    return typeof raw.oauthAccount?.emailAddress === 'string' ? raw.oauthAccount.emailAddress : undefined
  } catch {
    return undefined
  }
}
