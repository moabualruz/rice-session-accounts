// Adapted from simplecore-inc/claude-mods mods/accounts/hooks/keychain.ts at 722763c
// (MIT, Copyright (c) 2026 SimpleCORE Inc., see LICENSES/simplecore-claude-mods.MIT.txt).
// Modified: macOS keychain only; Orca and file-vault helpers removed; read and write
// helpers over Io added; `security` called by absolute path.
import type { Io } from './io'

/** The keychain item Claude Code reads its login from, with its default config directory. */
export const LIVE_SERVICE = 'Claude Code-credentials'
/** `security`'s exit code for an item that is not there. */
export const ITEM_NOT_FOUND = 44
const SECURITY = '/usr/bin/security'

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

/** The keychain account Claude Code reads its login with: the user's name, or `claude-code-user` when that holds other characters. */
export function keychainAccountName(user: string | undefined): string {
  return user && /^[a-zA-Z0-9._-]+$/.test(user) ? user : 'claude-code-user'
}

/** The OAuth credential document Claude Code stores, kept whole. */
export type Credential = {
  claudeAiOauth: {
    accessToken: string
    refreshToken: string
    expiresAt: number
    scopes?: string[]
    subscriptionType?: string
    rateLimitTier?: string
    [field: string]: unknown
  }
  [field: string]: unknown
}

export class KeychainError extends Error {}

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

/**
 * The `security -i` line that creates or replaces an item. The secret travels
 * on stdin as hex, never in argv, the way Claude Code writes its own item.
 */
export function addLine(service: string, account: string, text: string): string {
  // `security -i` reads the line as a command line of its own: a quote, a backslash or a line break would end it.
  for (const value of [service, account]) {
    if (/["\\\n\r]/.test(value)) throw new KeychainError(`refused a keychain name with a quote, backslash or line break: ${JSON.stringify(value)}`)
  }

  return `add-generic-password -U -a "${account}" -s "${service}" -X "${toHex(text)}"\n`
}

/** An item's secret, or null when there is no such item. */
export async function readItem(io: Io, service: string, account: string): Promise<string | null> {
  const ran = await io.run([SECURITY, 'find-generic-password', '-s', service, '-a', account, '-w'], { timeoutMs: 15_000 })
  if (ran.exitCode === ITEM_NOT_FOUND) return null
  if (ran.exitCode !== 0) throw new KeychainError(`cannot read the keychain item "${service}" (security exit ${ran.exitCode})`)

  return itemText(ran.stdout)
}

/** Creates or replaces an item; the secret goes over stdin. */
export async function writeItem(io: Io, service: string, account: string, text: string): Promise<void> {
  const ran = await io.run([SECURITY, '-i'], { stdin: addLine(service, account, text), timeoutMs: 15_000 })
  if (ran.exitCode !== 0) throw new KeychainError(`cannot write the keychain item "${service}" (security exit ${ran.exitCode})`)
}

/** Whether two logins are one grant: the same refresh token, whatever access token each holds now. */
export function isSameGrant(a: Credential | null, b: Credential | null): boolean {
  return a !== null && b !== null && a.claudeAiOauth.refreshToken === b.claudeAiOauth.refreshToken
}
