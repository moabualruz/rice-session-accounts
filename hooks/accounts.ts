import type { AccountConfig, Paths } from './config'
import type { Io } from './io'
import { isSameGrant, keychainAccountName, liveServiceName, parseCredential, readItem, writeItem } from './keychain'
import type { Credential, StorageVariables } from './keychain'
import { withLock } from './lock'
import { AnthropicError, applyRefresh, needsRefresh, refreshInit, TOKEN_URL } from './oauth'

/** Where Claude Code keeps this machine's own login. */
export type Machine = { claudeDir: string; user: string | undefined; storage: StorageVariables }

/** What a switch needs from an account's credential store; the secret stays in memory only. */
export type Material = { secret?: string; expiresAt?: number }

export function loginCommand(account: AccountConfig): string {
  return `CLAUDE_CONFIG_DIR="${account.loginDir}" claude auth login --claudeai`
}

/** The secret, and when it expires for a login that does, read from the keychain. */
export async function materialFor(io: Io, name: string, account: AccountConfig, paths: Paths, machine: Machine): Promise<Material> {
  if (account.kind === 'claudeai') {
    const credential = await freshLogin(io, name, account, paths, machine)

    return { secret: credential.claudeAiOauth.accessToken, expiresAt: credential.claudeAiOauth.expiresAt }
  }
  if (!account.secret) return {}
  const text = await readItem(io, account.secret.service, account.secret.account)
  if (text === null || text.trim() === '') {
    throw new Error(
      `no keychain item for ${name}: security add-generic-password -U -s ${account.secret.service} -a ${account.secret.account} -w`,
    )
  }

  return { secret: text.trim() }
}

async function machineLogin(io: Io, machine: Machine): Promise<Credential | null> {
  const service = await liveServiceName(machine.storage, machine.claudeDir)
  const text = await readItem(io, service, keychainAccountName(machine.user))

  return text === null ? null : parseCredential(text)
}

/**
 * The isolated login of a claudeai account, renewed when it expires within
 * five minutes. Its folder is signed in only for this mod, so renewing it
 * (the server rotates the refresh token) spends nobody else's grant; the lock
 * and the read inside it keep two sessions from renewing it at once.
 */
export async function freshLogin(io: Io, name: string, account: AccountConfig, paths: Paths, machine: Machine): Promise<Credential> {
  if (!account.loginDir) throw new Error(`${name} has no loginDir`)
  const service = await liveServiceName({ configDir: account.loginDir }, machine.claudeDir)
  const keychainAccount = keychainAccountName(machine.user)
  const load = async (): Promise<Credential> => {
    const text = await readItem(io, service, keychainAccount)
    if (text === null) throw new Error(`${name} is not signed in yet: ${loginCommand(account)}`)

    return parseCredential(text)
  }
  const first = await load()
  if (!needsRefresh(first, await io.now())) return first
  const own = await machineLogin(io, machine).catch(() => null)
  if (isSameGrant(first, own)) throw new Error(`${name} holds this machine's own /login; switch to "login" instead`)

  return withLock(io, paths.lock(name), { staleMs: 60_000, tries: 20 }, async () => {
    const current = await load()
    if (!needsRefresh(current, await io.now())) return current
    const response = await io.fetch(TOKEN_URL, refreshInit(current))
    if (!response.ok) {
      throw new AnthropicError(`the ${name} login could not be renewed (HTTP ${response.status}); sign it in again: ${loginCommand(account)}`, response.status)
    }
    const fresh = applyRefresh(current, response.text, await io.now())
    await writeItem(io, service, keychainAccount, JSON.stringify(fresh))
    io.log(`renewed the ${name} login`)

    return fresh
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
