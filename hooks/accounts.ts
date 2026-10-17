import type { AccountConfig, Paths } from './config'
import { checkRenewable, hasUnsavedLogin, readLogin, readSecret, saveUnsavedLogin, writeLogin } from './credentials'
import type { LoginLocation } from './credentials'
import type { Io } from './io'
import { message } from './io'
import { isSameGrant } from './keychain'
import type { Credential, StorageVariables } from './keychain'
import { LockLostError, withLock } from './lock'
import { AnthropicError, applyRefresh, needsRefresh, networkProblem, RefreshResponseError, refreshFailure, refreshInit, TOKEN_URL } from './oauth'

/** Where Claude Code keeps this machine's own login. */
export type Machine = { claudeDir: string; user: string | undefined; storage: StorageVariables }

/** What a switch needs from an account's credential store; the secret stays in memory only. */
export type Material = { secret?: string; expiresAt?: number }

/**
 * The renewal lock. Its critical section can last two 15 s store reads, the
 * token request, a keychain re-read, a 15 s write and a read-back, so a lock
 * is taken as abandoned only after 150 s, and the holder renews its time
 * (heartbeat) before the token request and before the write.
 */
export const RENEWAL_LOCK = { staleMs: 150_000, tries: 20 } as const

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
 *
 * Once the server answers, the old refresh token is spent: the renewed login
 * is written ahead to a pending file and kept in memory before the store
 * write (`writeLogin`), and one that could not be saved is saved on the next
 * use. Nothing that could make the store write impossible is discovered only
 * after the token request: the size check runs before it.
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
  if (!needsRefresh(first, await io.now()) && !(await hasUnsavedLogin(io, location))) return first

  return withLock(io, paths.lock(name), { ...RENEWAL_LOCK, cwd: machine.claudeDir }, async lock => {
    if (await hasUnsavedLogin(io, location)) await saveUnsavedLogin(io, location)
    const current = await load()
    if (!needsRefresh(current, await io.now())) return current
    const own = await machineLogin(io, machine)
    if (isSameGrant(current, own)) throw new Error(`${name} holds this machine's own /login; switch to "login" instead`)
    await checkRenewable(io, location, current)
    try {
      await lock.heartbeat()
    } catch (error) {
      if (error instanceof LockLostError) throw new Error(`Another session took over renewing ${name}; this session made no token request. Retry the account switch.`)
      throw new Error(`Cannot keep the ${name} renewal lock (${message(error)}); this session made no token request. Retry the account switch.`)
    }
    const response = await io.fetch(TOKEN_URL, refreshInit(current)).catch((error: unknown) => {
      throw new AnthropicError(`the ${name} login could not be renewed: ${networkProblem(error)}; the saved login was kept, retry`)
    })
    if (!response.ok) throw refreshFailure(name, response)
    let fresh: Credential
    try {
      fresh = applyRefresh(current, response.text, await io.now())
    } catch (error) {
      // The response may still have rotated the refresh token: save that before reporting.
      if (error instanceof RefreshResponseError && error.salvage) {
        try {
          await writeLogin(io, location, error.salvage, current)
        } catch (saving) {
          throw new AnthropicError(`the ${name} renewal returned no usable access token. ${message(saving)}`)
        }
        throw new AnthropicError(`the ${name} renewal returned no usable access token; its rotated refresh token was saved, retry the account switch`)
      }
      throw new AnthropicError(`the ${name} login could not be renewed: ${message(error)}; retry, and if this repeats sign it in again: /rice-account setup ${name}`)
    }
    // The refresh token is spent now: write even when the heartbeat fails (the store write checks the grant).
    await lock.heartbeat().catch((error: unknown) => io.log(`the ${name} renewal lock heartbeat failed before saving: ${message(error)}`))
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
