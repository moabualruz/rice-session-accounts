// Adapted from simplecore-inc/claude-mods mods/accounts/hooks/keychain.ts at 722763c
// (MIT, Copyright (c) 2026 SimpleCORE Inc., see LICENSES/simplecore-claude-mods.MIT.txt).
// Modified: macOS keychain only; Orca and file-vault helpers removed; read and write
// helpers over Io added; `security` called by absolute path; the `security -i` line
// limit, error text and account-name fallback handled.
import type { Io } from './io'
import { runFailure, trustedRun } from './io'

/** The keychain item Claude Code reads its login from, with its default config directory. */
export const LIVE_SERVICE = 'Claude Code-credentials'
/** `security`'s exit code for an item that is not there. */
export const ITEM_NOT_FOUND = 44
/** `security`'s exit code when the keychain is locked and may not ask to unlock (Claude Code 2.1.302 reads 36 the same way). */
export const KEYCHAIN_LOCKED = 36
/**
 * The longest `security -i` line this module writes. `security -i` splits a
 * line over 4095 characters into separate commands and runs the first part,
 * so a longer `add-generic-password -U` line would replace the item with a
 * truncated login. Claude Code 2.1.302 itself switches away from `-i` above
 * 4032 characters; this stays below both.
 */
export const SECURITY_LINE_LIMIT = 4000
const SECURITY = '/usr/bin/security'
/** `security` is called by absolute path; a root-owned working folder keeps the project folder out of it. */
const SECURITY_CWD = '/'
/** Text `security` prints for a failed command; with `-i` the exit status is only the last command's. */
const SECURITY_ERROR = /unknown command|error|fail|invalid|cannot|could not|couldn't|not allowed|denied|usage:|SecKeychain|errSec/i

/** The environment variables that decide where Claude Code keeps its login. */
export type StorageVariables = { configDir?: string; secureStorageDir?: string }

/**
 * The keychain service Claude Code keeps a login under: `Claude Code-credentials`,
 * then `-` and the first eight hex digits of the SHA-256 of a folder when
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` names one, or else when `CLAUDE_CONFIG_DIR`
 * is set (that folder, as given, NFC). An empty `CLAUDE_SECURESTORAGE_CONFIG_DIR`
 * keeps the plain name.
 */
export async function liveServiceName(variables: StorageVariables, defaultConfigDir: string): Promise<string> {
  const { secureStorageDir, configDir } = variables
  const isPlain = secureStorageDir !== undefined ? secureStorageDir === '' : !configDir
  if (isPlain) return LIVE_SERVICE
  const folder = (secureStorageDir ?? configDir ?? defaultConfigDir).normalize('NFC')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(folder))
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')

  return `${LIVE_SERVICE}-${hex.slice(0, 8)}`
}

const ACCOUNT_NAME = /^[a-zA-Z0-9._-]+$/
const FALLBACK_ACCOUNT = 'claude-code-user'

/**
 * The keychain account Claude Code reads and writes its login with, for a
 * known user name. Verified read-only against the Claude Code 2.1.302 binary
 * (`rg -a claude-code-user` on ~/.local/share/claude/versions/2.1.302):
 *
 *   let e; try { e = process.env.USER || os.userInfo().username } catch { e = "claude-code-user" }
 *   if (!/^[a-zA-Z0-9._-]+$/.test(e)) return "claude-code-user"; return e
 *
 * and it reads with `security find-generic-password -a <account> -w -s <service>`.
 * So a non-empty USER is used as it is, or `claude-code-user` when it holds
 * other characters; an unset or empty USER is NOT `claude-code-user` there but
 * the process's login name, which `resolveKeychainAccount` looks up. Called
 * without a name this keeps the 0.4.1 answer for compatibility.
 */
export function keychainAccountName(user: string | undefined): string {
  return user && ACCOUNT_NAME.test(user) ? user : FALLBACK_ACCOUNT
}

/**
 * The keychain account as Claude Code computes it: USER when set, else the
 * login name (`id -un`, what `os.userInfo().username` reads), each passed
 * through `keychainAccountName`. Undefined when the login name cannot be
 * found; every read of the item (a plain read, the compare before a write and
 * the read-back after it) then omits `-a`, so they all address one item, and
 * writes use `claude-code-user`, Claude Code's own fallback when
 * `os.userInfo()` throws. A write that lands on another item fails its
 * read-back instead of being taken as saved.
 */
export async function resolveKeychainAccount(io: Io, user: string | undefined): Promise<string | undefined> {
  if (user) return keychainAccountName(user)
  try {
    const ran = await io.run(['/usr/bin/id', '-un'], trustedRun(SECURITY_CWD, { timeoutMs: 10_000 }))
    const name = ran.exitCode === 0 ? ran.stdout.trim() : ''
    if (name) return keychainAccountName(name)
  } catch {
    // Unknown: the caller reads without an account.
  }

  return undefined
}

/** The OAuth credential document Claude Code stores, kept whole. */
export type Credential = {
  claudeAiOauth: {
    accessToken: string
    refreshToken: string
    expiresAt: number
    /** When the refresh token expires; Claude Code's signed-in check reads it. */
    refreshTokenExpiresAt?: number
    /** The OAuth client the login was signed in with, when not Claude Code's own. */
    clientId?: string
    scopes?: string[]
    subscriptionType?: string
    rateLimitTier?: string
    [field: string]: unknown
  }
  [field: string]: unknown
}

export class KeychainError extends Error {}

/** A write refused because its `security -i` line would be cut and a truncated login stored. */
export class KeychainLimitError extends KeychainError {}

function toHex(text: string): string {
  return Array.from(new TextEncoder().encode(text), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** An item's text as `security -w` prints it: plain when printable, else hex of the bytes. */
export function itemText(printed: string): string {
  const text = printed.replace(/\n$/, '')
  if (!/^[0-9a-f]+$/.test(text) || text.length % 2 !== 0) return text
  const bytes = new Uint8Array(text.length / 2)
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16)
  const decoded = new TextDecoder().decode(bytes)

  return decoded.trimStart().startsWith('{') ? decoded : text
}

export function parseCredential(text: string): Credential {
  const parsed: unknown = JSON.parse(text.trim())
  const oauth = (parsed as Credential | null)?.claudeAiOauth
  if (typeof oauth?.accessToken !== 'string' || typeof oauth.refreshToken !== 'string') {
    throw new KeychainError('the keychain item holds no Claude OAuth login')
  }

  return parsed as Credential
}

function commandLine(service: string, account: string, text: string): string {
  // `security -i` reads the line as a command line of its own: a quote, a backslash or a line break would end it.
  for (const value of [service, account]) {
    if (/["\\\n\r]/.test(value)) throw new KeychainError(`refused a keychain name with a quote, backslash or line break: ${JSON.stringify(value)}`)
  }

  return `add-generic-password -U -a "${account}" -s "${service}" -X "${toHex(text)}"\n`
}

/** How long the `security -i` line for this item would be, newline included. */
export function addLineLength(service: string, account: string, text: string): number {
  return commandLine(service, account, text).length
}

/**
 * The `security -i` line that creates or replaces an item. The secret travels
 * on stdin as hex, never in argv, the way Claude Code writes its own item. A
 * line over `SECURITY_LINE_LIMIT` is refused rather than cut.
 */
export function addLine(service: string, account: string, text: string): string {
  const line = commandLine(service, account, text)
  if (line.length > SECURITY_LINE_LIMIT) {
    throw new KeychainLimitError(`refused a ${line.length}-character keychain write: security -i accepts ${SECURITY_LINE_LIMIT} here and would store a truncated login`)
  }

  return line
}

function sizeOf(value: unknown): number {
  try { return JSON.stringify(value)?.length ?? 0 } catch { return 0 }
}

/**
 * The text to store for a login within the `security -i` line limit. When the
 * whole document is too long, top-level keys other than `claudeAiOauth` (for
 * example `mcpOAuth`) are left out, largest first, until it fits; `dropped`
 * names them. `claudeAiOauth` is never left out: a login that does not fit
 * with it alone is refused with `KeychainLimitError`.
 */
export function fitCredential(credential: Credential, service: string, account: string): { text: string; dropped: string[] } {
  const document: Record<string, unknown> = { ...credential }
  const others = Object.keys(document).filter(key => key !== 'claudeAiOauth').sort((a, b) => sizeOf(document[b]) - sizeOf(document[a]))
  const dropped: string[] = []
  for (;;) {
    const text = JSON.stringify(document)
    const length = addLineLength(service, account, text)
    if (length <= SECURITY_LINE_LIMIT) return { text, dropped }
    const next = others.shift()
    if (next === undefined) {
      throw new KeychainLimitError(`the login needs a ${length}-character keychain line even without its optional fields, over the ${SECURITY_LINE_LIMIT}-character security -i limit`)
    }
    delete document[next]
    dropped.push(next)
  }
}

function securityProblem(error: unknown, action: string): KeychainError {
  switch (runFailure(error)) {
    case 'timeout':
      return new KeychainError(`the macOS keychain did not answer within 15 seconds while trying to ${action}: a keychain prompt may be waiting, or the keychain is locked. Answer or unlock it, then retry.`)
    case 'missing':
    case 'denied':
      return new KeychainError(`${SECURITY} could not be started to ${action}.`)
    default:
      return new KeychainError(`${SECURITY} failed to ${action}.`)
  }
}

function lockedProblem(action: string): KeychainError {
  return new KeychainError(`cannot ${action}: the macOS keychain is locked and cannot ask to unlock here. Unlock it (security unlock-keychain), then retry.`)
}

/** An item's secret, or null when there is no such item. Without an account, the first item of the service is read. */
export async function readItem(io: Io, service: string, account: string | undefined): Promise<string | null> {
  const argv = account === undefined
    ? [SECURITY, 'find-generic-password', '-s', service, '-w']
    : [SECURITY, 'find-generic-password', '-s', service, '-a', account, '-w']
  const action = `read the keychain item "${service}"`
  const ran = await io.run(argv, trustedRun(SECURITY_CWD, { timeoutMs: 15_000 }))
    .catch((error: unknown) => { throw securityProblem(error, action) })
  if (ran.exitCode === ITEM_NOT_FOUND) return null
  if (ran.exitCode === KEYCHAIN_LOCKED) throw lockedProblem(action)
  if (ran.exitCode !== 0 || ran.isStdoutTruncated) throw new KeychainError(`cannot ${action} (security exit ${ran.exitCode})`)

  return itemText(ran.stdout)
}

/**
 * Creates or replaces an item; the secret goes over stdin. `security -i`
 * exits with its last command's status only, so error text on stderr is a
 * failure too. stderr is never quoted: it may repeat the line.
 */
export async function writeItem(io: Io, service: string, account: string, text: string): Promise<void> {
  const input = addLine(service, account, text)
  const action = `write the keychain item "${service}"`
  const ran = await io.run([SECURITY, '-i'], trustedRun(SECURITY_CWD, { stdin: input, timeoutMs: 15_000 }))
    .catch((error: unknown) => { throw securityProblem(error, action) })
  if (ran.exitCode === KEYCHAIN_LOCKED) throw lockedProblem(action)
  if (ran.exitCode !== 0) throw new KeychainError(`cannot ${action} (security exit ${ran.exitCode})`)
  if (SECURITY_ERROR.test(ran.stderr)) throw new KeychainError(`cannot ${action}: security reported an error`)
}

/** Whether two logins are one grant: the same refresh token, whatever access token each holds now. */
export function isSameGrant(a: Credential | null, b: Credential | null): boolean {
  return a !== null && b !== null && a.claudeAiOauth.refreshToken === b.claudeAiOauth.refreshToken
}
