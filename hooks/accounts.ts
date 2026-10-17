import type { AccountConfig, Paths } from './config'
import { checkRenewable, inspectLogin, promoteLogin, readLogin, readSecret, saveRenewal } from './credentials'
import type { LoginLocation } from './credentials'
import type { Io } from './io'
import { message } from './io'
import { isSameGrant } from './keychain'
import type { Credential, StorageVariables } from './keychain'
import { LockBusyError, LockLostError, withLock } from './lock'
import type { Lock, LockOptions } from './lock'
import { AnthropicError, applyRefresh, needsRefresh, networkProblem, RefreshResponseError, refreshFailure, refreshInit, TOKEN_URL } from './oauth'

/** Where Claude Code keeps this machine's own login. */
export type Machine = { claudeDir: string; user: string | undefined; storage: StorageVariables }

/** What a switch needs from an account's credential store; the secret stays in memory only. */
export type Material = { secret?: string; expiresAt?: number }

/**
 * The renewal lock. Its critical section can last two 15 s store reads, the
 * token request, a keychain re-read, a 15 s write and a read-back, so a lock
 * is taken as abandoned only after 150 s. The holder renews its time
 * (heartbeat) before the token request, every `LOCK_HEARTBEAT_MS` while the
 * request is pending (for at most `LOCK_HEARTBEAT_LIMIT_MS`), and after the
 * renewal is written ahead, before the store write.
 */
export const RENEWAL_LOCK = { staleMs: 150_000, tries: 20 } as const

/** How often the renewal lock is renewed while the token request is pending: well inside its stale time. */
export const LOCK_HEARTBEAT_MS = 45_000

/**
 * How long a pending token request keeps the lock. A connection that went
 * silent (half-open after a network change) never answers; past this the lock
 * is left to go stale so other sessions are not locked out for hours. The
 * request is still awaited, and its answer saved: the compare-and-swap and the
 * rotation make a takeover in the meantime safe.
 */
export const LOCK_HEARTBEAT_LIMIT_MS = 10 * 60_000

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
 * Refuse to renew the machine's own grant: it is not this mod's to spend. When
 * the machine store cannot be read (a locked keychain, for example) the
 * renewal fails closed, and says why.
 */
async function refuseMachineGrant(io: Io, name: string, current: Credential, machine: Machine): Promise<void> {
  let own: Credential | null
  try {
    own = await machineLogin(io, machine)
  } catch (error) {
    throw new Error(`Cannot renew ${name}: this machine's own login could not be read to check that ${name} is a different sign-in (${message(error).replace(/\.$/, '')}). No token request was made; unlock or repair the machine's credential store, then retry.`)
  }
  if (isSameGrant(current, own)) throw new Error(`${name} holds this machine's own /login; switch to "login" instead`)
}

type TokenResponse = Awaited<ReturnType<Io['fetch']>>

/**
 * The token request, renewing the lock every `LOCK_HEARTBEAT_MS` while it is
 * pending. The request itself is never timed out: the server may already have
 * rotated the refresh token, and that answer must be saved. After it settles,
 * heartbeat failures are ignored; a lock taken over meanwhile, or no longer
 * renewed because the request outlasted `LOCK_HEARTBEAT_LIMIT_MS`, is reported
 * in `lockLost`, and the answer is still returned for saving.
 */
async function requestKeepingLock(io: Io, lock: Lock, name: string, current: Credential): Promise<{ response: TokenResponse; lockLost: boolean }> {
  let request: Promise<TokenResponse>
  try {
    request = io.fetch(TOKEN_URL, refreshInit(current))
  } catch (error) {
    request = Promise.reject(error)
  }
  // Attached first, so a request that is already answered stops the loop before any heartbeat.
  let settled = false
  const done = request.then(() => { settled = true }, () => { settled = true })
  let lockLost = false
  const keeping = (async () => {
    for (let beat = 0; ; beat += 1) {
      try {
        await Promise.race([io.sleep(LOCK_HEARTBEAT_MS), done])
      } catch {
        return
      }
      if (settled) return
      if ((beat + 1) * LOCK_HEARTBEAT_MS > LOCK_HEARTBEAT_LIMIT_MS) {
        lockLost = true
        io.log(`the ${name} token request has been pending for ${Math.round(LOCK_HEARTBEAT_LIMIT_MS / 60_000)} minutes; its renewal lock is no longer renewed, and the answer is still saved if one arrives`)
        return
      }
      try {
        await lock.heartbeat()
      } catch (error) {
        if (settled) return
        if (error instanceof LockLostError) {
          lockLost = true
          io.log(`another session took over the ${name} renewal lock while its token request was pending; this session still saves what the server returns`)
          return
        }
        io.log(`could not renew the ${name} renewal lock while its token request was pending: ${message(error)}`)
      }
    }
  })()
  let response: TokenResponse | undefined
  let failure: unknown
  try {
    response = await request
  } catch (error) {
    failure = error
  }
  await keeping
  if (response === undefined) throw new AnthropicError(`the ${name} login could not be renewed: ${networkProblem(failure)}; the saved login was kept, retry`)

  return { response, lockLost }
}

/**
 * The isolated login of a claudeai account, renewed when it expires within
 * five minutes. Its folder is signed in only for this mod, so renewing it
 * (the server rotates the refresh token) spends nobody else's grant; the lock
 * and the inspection inside it keep two sessions from renewing it at once.
 *
 * Under the lock the store and its pending renewal are inspected, and the
 * login to renew is chosen by lineage (rule B in credentials.ts), never by
 * expiry. Once the server answers, the old refresh token is spent: the renewal
 * is written ahead to the pending file with the refresh token the store holds
 * as its base, then saved to the store only if the store still holds that
 * token (`saveRenewal`). A renewal that could not be saved stays usable and is
 * saved on a later use. Nothing that could make the store write impossible is
 * discovered only after the token request: the size check runs before it.
 */
export async function freshLogin(io: Io, name: string, account: AccountConfig, paths: Paths, machine: Machine): Promise<Credential> {
  if (!account.loginDir) throw new Error(`${name} has no loginDir`)
  const location: LoginLocation = {
    storage: { configDir: account.loginDir, secureStorageDir: account.loginDir },
    defaultConfigDir: machine.claudeDir,
    user: machine.user,
  }
  const signedOut = () => new Error(`${name} is not signed in yet: /rice-account setup ${name}`)
  // Read only. A saved login that does not expire soon is answered without the lock.
  const first = await inspectLogin(io, location)
  if (first.login === null) throw signedOut()
  const usable = !needsRefresh(first.login, await io.now())
  if (usable && first.source === 'store') return first.login
  // A renewal kept unsaved (a failed store write, or before a plugin reload) works as it is, and is saved when the lock is free.
  const options = { ...RENEWAL_LOCK, cwd: machine.claudeDir, ...(usable ? { tries: 1 } : {}) }
  try {
    return await renewing(io, name, location, paths, machine, options)
  } catch (error) {
    if (usable && error instanceof LockBusyError) return first.login
    throw error
  }
}

async function renewing(io: Io, name: string, location: LoginLocation, paths: Paths, machine: Machine, options: LockOptions): Promise<Credential> {
  const signedOut = () => new Error(`${name} is not signed in yet: /rice-account setup ${name}`)

  return withLock(io, paths.lock(name), options, async lock => {
    const state = await inspectLogin(io, location)
    const current = state.login
    if (current === null) throw signedOut()
    // A usable renewal that does not need renewing is saved now if it can be; a failure is only logged.
    if (!needsRefresh(current, await io.now())) return (await promoteLogin(io, location, state)) ?? current
    await refuseMachineGrant(io, name, current, machine)
    await checkRenewable(io, location, current)
    try {
      await lock.heartbeat()
    } catch (error) {
      if (error instanceof LockLostError) throw new Error(`Another session took over renewing ${name}; this session made no token request. Retry the account switch.`)
      throw new Error(`Cannot keep the ${name} renewal lock (${message(error)}); this session made no token request. Retry the account switch.`)
    }
    const { response, lockLost } = await requestKeepingLock(io, lock, name, current)
    // The refresh token is spent once the answer arrives: the lock is extended after the renewal is written ahead (a failure only logged; the store write checks the grant).
    const extend = async (): Promise<void> => {
      if (!lockLost) await lock.heartbeat().catch((error: unknown) => io.log(`the ${name} renewal lock heartbeat failed before saving: ${message(error)}`))
    }
    if (!response.ok) throw refreshFailure(name, response)
    let fresh: Credential
    try {
      fresh = applyRefresh(current, response.text, await io.now())
    } catch (error) {
      // The response may still have rotated the refresh token: save that before reporting.
      if (error instanceof RefreshResponseError && error.salvage) {
        try {
          await saveRenewal(io, location, error.salvage, state, extend)
        } catch (saving) {
          throw new AnthropicError(`the ${name} renewal returned no usable access token. ${message(saving)}`)
        }
        throw new AnthropicError(`the ${name} renewal returned no usable access token; its rotated refresh token was saved, retry the account switch`)
      }
      throw new AnthropicError(`the ${name} login could not be renewed: ${message(error)}; retry, and if this repeats sign it in again: /rice-account setup ${name}`)
    }
    const saved = await saveRenewal(io, location, fresh, state, extend)
    io.log(lockLost ? `renewed the ${name} login; its renewal lock was no longer held meanwhile, so this session starts no other renewal` : `renewed the ${name} login`)

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
