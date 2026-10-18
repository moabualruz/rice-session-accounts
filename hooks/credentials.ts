import type { SecretRef } from './config'
import type { Io, RunFailure } from './io'
import { message, runFailure, trustedRun } from './io'
import { fitCredential, KeychainError, keychainAccountName, liveServiceName, readItem, resolveKeychainAccount, writeItem } from './keychain'
import type { Credential, StorageVariables } from './keychain'
import { WINDOWS_CREDENTIAL_STORE } from '../scripts/windows-store-payloads.mjs'

export type HostPlatform = 'darwin' | 'linux' | 'win32'
export type LoginLocation = { storage: StorageVariables; defaultConfigDir: string; user?: string }

/** Appended to the native credential path: the renewed login written ahead of the store. */
export const PENDING_SUFFIX = '.rice-pending'
/** The pending file format this version writes and reads; a file of any other format is ignored. */
export const PENDING_VERSION = 2
/** A leftover temporary copy, or a pending file of another format, is removed only once it is older than this. */
export const STALE_COPY_MS = 5 * 60 * 1000
/** The largest pending or credentials file read on macOS; the Node program applies the same cap. */
const PENDING_LIMIT = 1024 * 1024
/** Set to exactly 1, it makes Claude Code on Windows keep logins in Credential Manager. */
const CREDMAN_VARIABLE = 'CLAUDE_CODE_FORCE_WINDOWS_CREDMAN'
/** The cached GrowthBook flag that does the same when it is true. */
const CREDMAN_FLAG = 'tengu_windows_credman'
/** How many spent refresh tokens a renewal kept in memory remembers it descends from. */
const SPENT_KEPT = 32

let platformCache: { key: string; platform: Promise<HostPlatform> } | undefined

/**
 * Detect the execution host, including Linux inside WSL. Native Windows is
 * known from its environment without a process; otherwise `uname -s` runs
 * once per process rather than once per Io (register.ts builds a new Io for
 * every call), since the platform does not change. The cache is keyed by
 * HOME only so tests that fake several hosts in one process still detect each
 * one; HOME does not change within a session. A failed detection is retried.
 */
export async function hostPlatform(io: Io): Promise<HostPlatform> {
  if (await io.env('OS') === 'Windows_NT') return 'win32'
  const key = await io.env('HOME') ?? ''
  if (platformCache?.key === key) return platformCache.platform
  const platform = detectPosix(io)
  platformCache = { key, platform }
  platform.catch(() => { if (platformCache?.platform === platform) platformCache = undefined })

  return platform
}

async function detectPosix(io: Io): Promise<HostPlatform> {
  // Alpine and unmerged-/usr systems ship /bin/uname only; NixOS has neither path.
  let system: string | undefined
  for (const command of ['/usr/bin/uname', '/bin/uname', 'uname']) {
    const result = await io.run([command, '-s'], trustedRun('/', { timeoutMs: 10_000 })).catch(() => undefined)
    if (result?.exitCode === 0) { system = result.stdout.trim(); break }
  }
  if (system === undefined) throw new Error('Cannot detect the host OS: uname -s must be available.')
  if (system === 'Darwin') return 'darwin'
  if (system === 'Linux') return 'linux'
  throw new Error('Account storage supports macOS, Linux (including WSL) and native Windows.')
}

/** Forget the detected platform; for tests that fake several hosts. */
export function forgetHostPlatform(): void {
  platformCache = undefined
}

/** Native file storage is independent of CLAUDE_CONFIG_DIR when overridden. */
export function nativeCredentialPath(location: LoginLocation, home: string | undefined, platform: HostPlatform = 'linux'): string {
  const { secureStorageDir, configDir } = location.storage
  const folder = secureStorageDir === ''
    ? home ? `${home}/.claude` : undefined
    : secureStorageDir ?? configDir ?? location.defaultConfigDir
  const absolute = folder && (platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(folder) : folder.startsWith('/'))
  if (!absolute || /[\0\r\n]/.test(folder)) throw new Error('The native credential directory must be an absolute path; the machine home is required for an empty secure-storage override.')

  return `${folder.normalize('NFC').replace(/[\\/]+$/, '')}/.credentials.json`
}

/**
 * The static program Node runs for native file storage. Paths and the program
 * are argv; secrets use stdin/stdout only. It is ES5 (var, function, no
 * optional chaining, nullish coalescing, arrow functions or `node:`
 * specifiers) so that an old Node, such as Ubuntu 22.04's Node 12, parses it
 * and reaches the version guard instead of failing with a syntax error.
 *
 * The `.rice-pending` file beside the store holds
 * `{"version":2,"base":B,"credential":{"claudeAiOauth":G}}`: G is the newest
 * renewed grant not saved to the store yet, and B the refresh token the store
 * held when the first unsaved renewal began. A pending renewal is usable only
 * while the store still holds B (rule B in `pendingState`); expiry times never
 * decide which login is newer.
 *
 * Operations: `read` prints the store, or the store with a usable pending
 * grant, and never writes or removes anything; `examine` prints
 * `{"stored":document or null,"pending":{"base":B,"credential":...} or null}`
 * (null for a missing store; otherwise its exit codes are `read`'s), also
 * without writing; `write` replaces only the OAuth grant (the two tokens,
 * `expiresAt`, and `refreshTokenExpiresAt` when the renewal has one; a stored
 * one stays otherwise) when the stored refresh token is still the expected
 * one, and leaves the pending file alone;
 * `pending` writes `{base, credential}` from stdin as the pending file;
 * `readpending` prints `{"pending":...}` alone, for a store that cannot be
 * read; `clearpending` takes `{base, tokens}` and removes the pending file only
 * when its base is that one and its refresh token is one of `tokens` (the
 * caller's own renewals: another session's later renewal is left), or when it
 * is not version 2 and older than five minutes. `write` and
 * `pending` also remove temporary copies older than five minutes left by a
 * killed write. Writes create an exclusive 0600 temporary file, fsync it,
 * rename it over the target and fsync the folder on POSIX; a rename refused
 * as busy is retried for about 3 seconds, and on Windows also one refused
 * with EPERM or EACCES while Defender or an indexer holds the file. stdin is
 * read in a loop that waits out EAGAIN from a non-blocking pipe.
 *
 * Exit codes: 43 a valid document without OAuth; 44 only ENOENT, never an
 * unreadable store; 45 a symbolic link; 46 unreadable, malformed or not
 * permitted; 47 the stored grant changed (another writer); 48 the file stayed
 * held by another program; 49 no space or a read-only file system; 50 Node is
 * older than 22; 51 a Windows node.exe reached from WSL (a POSIX path on win32).
 */
const NATIVE_FILE = String.raw`
var fs = require('fs');
var crypto = require('crypto');
var paths = require('path');
var operation = process.argv[1];
var path = process.argv[2];
var flags = fs.constants || {};
var limit = 1024 * 1024;
var staleMs = 5 * 60 * 1000;
var retryDelays = [50, 100, 200, 400, 800, 1450];
var pendingPath = path + '.rice-pending';
var temporary;
function Refusal(code) { this.exitCode = code; }
function fail(code) { throw new Refusal(code); }
function sleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (ignored) { var until = Date.now() + ms; while (Date.now() < until) {} }
}
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isOAuth(value) { return isObject(value) && typeof value.accessToken === 'string' && typeof value.refreshToken === 'string' && typeof value.expiresAt === 'number' && isFinite(value.expiresAt); }
function grantOf(document) { return isObject(document) && isOAuth(document.claudeAiOauth) ? document.claudeAiOauth : null; }
function copy(source) {
  var target = {};
  for (var key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) Object.defineProperty(target, key, { value: source[key], enumerable: true, writable: true, configurable: true });
  }
  return target;
}
function grantOnly(oauth) {
  var grant = { accessToken: oauth.accessToken, refreshToken: oauth.refreshToken, expiresAt: oauth.expiresAt };
  if (typeof oauth.refreshTokenExpiresAt === 'number' && isFinite(oauth.refreshTokenExpiresAt)) grant.refreshTokenExpiresAt = oauth.refreshTokenExpiresAt;
  return grant;
}
function merged(document, oauth) {
  var next = copy(document);
  var inner = copy(document.claudeAiOauth);
  var grant = grantOnly(oauth);
  inner.accessToken = grant.accessToken;
  inner.refreshToken = grant.refreshToken;
  inner.expiresAt = grant.expiresAt;
  if (grant.refreshTokenExpiresAt !== undefined) inner.refreshTokenExpiresAt = grant.refreshTokenExpiresAt;
  next.claudeAiOauth = inner;
  return next;
}
function remove(file) { try { fs.unlinkSync(file); } catch (ignored) {} }
function readJson(file, strict) {
  var fd;
  try {
    var link = fs.lstatSync(file, { bigint: true });
    if (link.isSymbolicLink()) fail(45);
    if (!link.isFile() || link.size > limit) fail(46);
    fd = fs.openSync(file, flags.O_RDONLY | (flags.O_NOFOLLOW || 0) | (flags.O_NONBLOCK || 0));
    var identity = fs.fstatSync(fd, { bigint: true });
    if (!identity.isFile() || identity.size > limit) fail(46);
    if (identity.ino !== link.ino || identity.dev !== link.dev) fail(45);
    var bytes = Buffer.alloc(limit + 1);
    var size = 0;
    while (size < bytes.length) {
      var count = fs.readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > limit) fail(46);
    return JSON.parse(bytes.toString('utf8', 0, size));
  } catch (error) {
    if (strict) throw error;
    return undefined;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (ignored) {} }
  }
}
function readStored() {
  var document = readJson(path, true);
  if (!isObject(document)) fail(46);
  if (document.claudeAiOauth === undefined || document.claudeAiOauth === null) fail(43);
  if (!isOAuth(document.claudeAiOauth)) fail(46);
  return document;
}
function readStoredOrNull() {
  try { return readStored(); } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}
function pendingOf(document) {
  if (!isObject(document) || document.version !== 2 || typeof document.base !== 'string' || document.base === '') return null;
  var grant = grantOf(document.credential);
  return grant === null ? null : { base: document.base, credential: { claudeAiOauth: grantOnly(grant) } };
}
function readPending() { return pendingOf(readJson(pendingPath, false)); }
function bestOf(stored, pending) {
  return pending !== null && stored.claudeAiOauth.refreshToken === pending.base ? merged(stored, pending.credential.claudeAiOauth) : stored;
}
function isStale(file) {
  var stat = null;
  try { stat = fs.lstatSync(file); } catch (ignored) {}
  return stat !== null && stat.isFile() && Date.now() - stat.mtimeMs >= staleMs;
}
function removeStaleCopies() {
  var folder = paths.dirname(path);
  var prefix = paths.basename(path) + '.rice-';
  var names = [];
  try { names = fs.readdirSync(folder); } catch (ignored) {}
  for (var index = 0; index < names.length; index += 1) {
    var name = names[index];
    if (name.indexOf(prefix) !== 0 || !/^[0-9]+-[0-9a-f-]{16,64}$/.test(name.slice(prefix.length))) continue;
    var file = paths.join(folder, name);
    if (file !== temporary && isStale(file)) remove(file);
  }
}
function isRetryable(code) {
  if (code === 'EBUSY') return true;
  return process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES');
}
function renameWithRetry(from, to) {
  for (var attempt = 0; ; attempt += 1) {
    try { fs.renameSync(from, to); return; } catch (error) {
      if (!isRetryable(error && error.code)) throw error;
      if (attempt >= retryDelays.length) fail(48);
      sleep(retryDelays[attempt]);
    }
  }
}
function syncFolder(folder) {
  if (process.platform === 'win32') return;
  var fd;
  try { fd = fs.openSync(folder, 'r'); fs.fsyncSync(fd); } catch (ignored) {} finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (ignored) {} }
  }
}
function writeAtomic(target, document) {
  var encoded = JSON.stringify(document);
  if (Buffer.byteLength(encoded) > limit) fail(46);
  temporary = path + '.rice-' + process.pid + '-' + crypto.randomBytes(16).toString('hex');
  var fd = fs.openSync(temporary, flags.O_WRONLY | flags.O_CREAT | flags.O_EXCL | (flags.O_NOFOLLOW || 0), 384);
  try { fs.writeFileSync(fd, encoded, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  renameWithRetry(temporary, target);
  temporary = undefined;
  syncFolder(paths.dirname(target));
}
function readInput() {
  var chunk = Buffer.alloc(65536);
  var chunks = [];
  var size = 0;
  var deadline = Date.now() + 10000;
  for (;;) {
    var count;
    try { count = fs.readSync(0, chunk, 0, chunk.length, null); } catch (error) {
      var code = error && error.code;
      if (code === 'EAGAIN' && Date.now() < deadline) { sleep(5); continue; }
      if (code === 'EOF') break;
      throw error;
    }
    if (count === 0) break;
    size += count;
    if (size > limit) fail(46);
    chunks.push(Buffer.from(chunk.subarray(0, count)));
  }
  return Buffer.concat(chunks, size).toString('utf8');
}
function input() {
  var value = JSON.parse(readInput());
  if (!isObject(value)) fail(46);
  return value;
}
try {
  if (process.platform === 'win32' && typeof path === 'string' && /^\/(?!\/)/.test(path)) fail(51);
  if (Number(String(process.versions.node).split('.')[0]) < 22) fail(50);
  if (!path || !paths.isAbsolute(path) || /[\0\r\n]/.test(path) || process.platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(path)) fail(46);
  var output = null;
  if (operation === 'read') {
    output = bestOf(readStored(), readPending());
  } else if (operation === 'examine') {
    output = { stored: readStoredOrNull(), pending: readPending() };
  } else if (operation === 'write') {
    var request = input();
    var oauth = request.oauth;
    if (!isOAuth(oauth) || typeof request.expectedRefreshToken !== 'string') fail(46);
    var current = readStored();
    if (current.claudeAiOauth.refreshToken !== request.expectedRefreshToken) fail(47);
    output = merged(current, oauth);
    writeAtomic(path, output);
    removeStaleCopies();
  } else if (operation === 'pending') {
    var renewal = input();
    var grant = grantOf(renewal.credential);
    if (typeof renewal.base !== 'string' || renewal.base === '' || grant === null) fail(46);
    removeStaleCopies();
    writeAtomic(pendingPath, { version: 2, base: renewal.base, credential: { claudeAiOauth: grantOnly(grant) } });
  } else if (operation === 'readpending') {
    output = { pending: readPending() };
  } else if (operation === 'clearpending') {
    var request = input();
    var expected = request.base;
    var owned = request.tokens;
    if (typeof expected !== 'string' || expected === '' || !Array.isArray(owned)) fail(46);
    var held = readPending();
    var mine = held !== null && held.base === expected && owned.indexOf(held.credential.claudeAiOauth.refreshToken) >= 0;
    if (held !== null ? mine : isStale(pendingPath)) remove(pendingPath);
  } else fail(46);
  if (output !== null) process.stdout.write(JSON.stringify(output));
} catch (error) {
  var code = error && error.code;
  process.exitCode = error instanceof Refusal ? error.exitCode
    : code === 'ENOENT' ? 44
    : code === 'ELOOP' ? 45
    : code === 'ENOSPC' || code === 'EDQUOT' || code === 'EROFS' ? 49
    : 46;
} finally {
  if (temporary) remove(temporary);
}
`

/** The native file program's documented exit codes. */
export const FILE_EXIT = { noOAuth: 43, missing: 44, link: 45, invalid: 46, changed: 47, busy: 48, full: 49, oldNode: 50, windowsNode: 51 } as const

/**
 * The darwin pending writer: no Node there, so a POSIX shell writes the
 * owner-only (umask 077) copy. It first removes its own temporary copies
 * older than five minutes (`<pending>.tmp.<pid>.<random>`, and the fixed
 * `<pending>.tmp` of earlier versions), then creates a temporary file named
 * with its process id and a random suffix exclusively (noclobber), so
 * concurrent writers never share or delete one another's copy, flushes it
 * (`sync`), renames it into place and flushes again. stdin is the document.
 */
const PENDING_SH = String.raw`umask 077
d=$(/usr/bin/dirname "$0") && b=$(/usr/bin/basename "$0") || exit 1
/usr/bin/find "$d" -maxdepth 1 -type f \( -name "$b.tmp" -o -name "$b.tmp.[0-9]*" \) -mmin +5 -exec /bin/rm -f {} + 2>/dev/null
r=$(/usr/bin/od -An -N8 -tx1 /dev/urandom 2>/dev/null | /usr/bin/tr -d ' \n')
t="$0.tmp.$$.$r"
set -C
: > "$t" || exit 1
if /bin/cat >> "$t" && /bin/sync && /bin/mv -f "$t" "$0"; then /bin/sync; exit 0; fi
/bin/rm -f "$t"
exit 1
`

/** What a renewal changes in a stored login; `refreshTokenExpiresAt` only when the server gave one. */
type OAuthGrant = Pick<Credential['claudeAiOauth'], 'accessToken' | 'refreshToken' | 'expiresAt' | 'refreshTokenExpiresAt'>
/** `filePath` is the credentials file Claude Code falls back to when the keychain cannot store a login. */
type KeychainStore = { kind: 'keychain'; key: string; service: string; account: string | undefined; writeAccount: string; filePath: string | undefined; pendingPath: string | undefined; cwd: string }
type FileStore = { kind: 'file'; key: string; path: string; pendingPath: string; cwd: string; platform: HostPlatform }
type Store = KeychainStore | FileStore
// Never name an operation `inspect` (or `debug`): Node runs a first program argument with that name as its debugger client, even after -e.
type FileOperation = 'read' | 'examine' | 'readpending' | 'write' | 'pending' | 'clearpending'
type RunResult = Awaited<ReturnType<Io['run']>>

/**
 * A renewal not saved to the store yet. `base` is the refresh token the store
 * held when the first unsaved renewal began; that renewal spent it, so it no
 * longer works. It stays the same across further unsaved renewals while
 * `credential` advances to the newest renewed login.
 */
export type PendingLogin = { base: string; credential: Credential }

/**
 * How a pending renewal relates to the stored login: `usable` while the store
 * still holds its base, `redundant` once the store holds its refresh token
 * (saved), `obsolete` when the store holds neither (it moved past the
 * renewal, or was signed in again: the store is authoritative), `orphaned`
 * when there is no stored login to compare with.
 */
export type PendingState = 'usable' | 'redundant' | 'obsolete' | 'orphaned'

/** Where the login to use came from. */
export type CandidateSource = 'store' | 'pending' | 'memory'

/** The store, its pending renewal and the login to use by rule B, as read at one moment. */
export type LoginState = {
  /** The stored login; null when there is none, or it could not be read and memory answered. */
  stored: Credential | null
  pending: PendingLogin | null
  /** The login to use: the stored one, or it with a usable renewal's grant. */
  login: Credential | null
  source: CandidateSource
  /** The usable renewal `login` came from, when it did not come from the store. */
  candidate: PendingLogin | null
  /** The refresh token the store holds: what a store write must find (compare-and-swap). */
  onDisk: string | undefined
  /** Spent refresh tokens `login` is known to descend from (from this process's memory). */
  spent: readonly string[]
}

/** The store's login changed while it was renewed: another sign-in or another writer. */
class LoginChangedError extends Error {}

/** The store holds no login any more: a renewal cannot be saved there, nor used without one. */
class StoreGoneError extends Error {}

/** A renewal the server granted that could not be saved; the message says where it was kept. */
export class LoginNotSavedError extends Error {}

function invalidStore(): Error {
  return new Error('The credential store contains no valid Claude OAuth login. Run account setup again.')
}

function grantOf(value: unknown): OAuthGrant | null {
  const oauth = (value as { claudeAiOauth?: Partial<OAuthGrant> } | null)?.claudeAiOauth
  return typeof oauth?.accessToken === 'string' && typeof oauth.refreshToken === 'string' && typeof oauth.expiresAt === 'number' && Number.isFinite(oauth.expiresAt)
    ? grantOnly(oauth as OAuthGrant)
    : null
}

/** A stored credential document: null when it is valid but holds no OAuth login. */
function documentOf(value: unknown): Credential | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidStore()
  const oauth = (value as { claudeAiOauth?: unknown }).claudeAiOauth
  if (oauth === undefined || oauth === null) return null
  if (grantOf(value) === null) throw invalidStore()

  return value as Credential
}

function credential(text: string): Credential | null {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw invalidStore() }

  return documentOf(value)
}

function pendingOf(value: unknown): PendingLogin | null {
  const fields = value as { base?: unknown; credential?: unknown } | null
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields) || typeof fields.base !== 'string' || fields.base === '') return null
  const oauth = grantOf(fields.credential)

  return oauth === null ? null : { base: fields.base, credential: { claudeAiOauth: oauth } }
}

/** A pending file's text as a renewal; null for any other version, a malformed file or one without a grant. */
export function parsePendingLogin(text: string): PendingLogin | null {
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  if ((value as { version?: unknown } | null)?.version !== PENDING_VERSION) return null

  return pendingOf(value)
}

/**
 * Rule B, shared by the file and keychain stores: lineage is decided by the
 * refresh tokens, never by expiry times (a salvaged login has `expiresAt` 0
 * and is still the newest one).
 */
export function pendingState(stored: Credential | null, pending: PendingLogin): PendingState {
  if (stored === null) return 'orphaned'
  const held = stored.claudeAiOauth.refreshToken
  if (held === pending.base) return 'usable'
  if (held === pending.credential.claudeAiOauth.refreshToken) return 'redundant'

  return 'obsolete'
}

/** The stored document with a renewal's grant; a stored `refreshTokenExpiresAt` stays when the renewal gave none, as in Claude Code. */
function merged(document: Credential, oauth: OAuthGrant): Credential {
  return { ...document, claudeAiOauth: { ...document.claudeAiOauth, ...grantOnly(oauth) } }
}

function grantOnly(oauth: OAuthGrant): OAuthGrant {
  const expiry = oauth.refreshTokenExpiresAt
  return { accessToken: oauth.accessToken, refreshToken: oauth.refreshToken, expiresAt: oauth.expiresAt, ...(typeof expiry === 'number' && Number.isFinite(expiry) ? { refreshTokenExpiresAt: expiry } : {}) }
}

/** Whether a usable pending renewal is later than a usable memory one: memory does not descend from it. */
function pendingIsLater(memory: PendingLogin & { spent?: readonly string[] }, pending: PendingLogin): boolean {
  const held = pending.credential.claudeAiOauth.refreshToken
  return held !== memory.credential.claudeAiOauth.refreshToken && !(memory.spent ?? []).includes(held)
}

/**
 * The login to use (rule B): the best usable candidate, the in-memory renewal
 * `memory` before the pending file, else the store. Usable candidates share
 * the store's refresh token as their base, so they lie on one chain of
 * renewals; the later one is the one whose credential is not an ancestor of
 * the other. Memory knows the spent tokens it descends from, so the pending
 * renewal wins only when memory does not descend from it (another session
 * renewed further). The login keeps the stored document's other fields.
 */
export function bestLogin(stored: Credential | null, pending: PendingLogin | null, memory?: (PendingLogin & { spent?: readonly string[] }) | null): { login: Credential | null; source: CandidateSource; candidate: PendingLogin | null } {
  const fromMemory = memory && pendingState(stored, memory) === 'usable' ? memory : null
  const fromPending = pending && pendingState(stored, pending) === 'usable' ? pending : null
  const candidate = fromMemory && fromPending ? (pendingIsLater(fromMemory, fromPending) ? fromPending : fromMemory) : fromMemory ?? fromPending
  if (candidate === null || stored === null) return { login: stored, source: 'store', candidate: null }

  return { login: merged(stored, candidate.credential.claudeAiOauth), source: candidate === fromMemory ? 'memory' : 'pending', candidate }
}

/** A config file's text: '' when there is none (or a folder stands there), undefined when it cannot be read. */
async function configText(io: Io, path: string): Promise<string | undefined> {
  const stat = await io.stat(path).catch(() => null)
  if (stat === null || stat.kind === 'dir') return ''
  if (stat.kind !== 'file') return undefined
  return io.read(path).catch(() => undefined)
}

/**
 * Why Claude Code on Windows keeps the login at `location` in Credential
 * Manager (read before the credentials file), or undefined when it uses the
 * file alone. Its rule, read in the 2.1.302 binary: CLAUDE_CODE_FORCE_WINDOWS_CREDMAN
 * is exactly 1, or the cached GrowthBook flag tengu_windows_credman is true in
 * `<config folder>/.config.json` when that file is present and not empty, else
 * in `<CLAUDE_CONFIG_DIR or home>/.claude.json`. A config that cannot be read
 * or parsed counts as off, as it does there.
 */
async function credentialManagerCause(io: Io, location: LoginLocation, home: string | undefined): Promise<string | undefined> {
  if (await io.env(CREDMAN_VARIABLE) === '1') return `${CREDMAN_VARIABLE} is 1`
  const { configDir } = location.storage
  const folder = (path: string) => path.replace(/[\\/]+$/, '')
  let file: string | undefined = `${folder(configDir ?? location.defaultConfigDir)}/.config.json`
  let text = await configText(io, file)
  if (text === '') {
    file = configDir ? `${folder(configDir)}/.claude.json` : home ? `${folder(home)}/.claude.json` : undefined
    text = file === undefined ? undefined : await configText(io, file)
  }
  if (!text) return undefined
  let flag: unknown
  try { flag = (JSON.parse(text) as { cachedGrowthBookFeatures?: Record<string, unknown> }).cachedGrowthBookFeatures?.[CREDMAN_FLAG] } catch { return undefined }

  return flag === true ? `its cached setting ${CREDMAN_FLAG} is on in ${file}` : undefined
}

/** Refuse a Windows login Claude Code keeps in Credential Manager: this module reads browser logins from the credentials file only. */
async function refuseCredentialManager(io: Io, location: LoginLocation, home: string | undefined, path: string): Promise<void> {
  const cause = await credentialManagerCause(io, location, home)
  if (cause === undefined) return
  const variable = cause.startsWith(CREDMAN_VARIABLE) ? `, or start this session and account setup without ${CREDMAN_VARIABLE}` : ''
  throw new Error(`Claude Code keeps the login for ${path.replace(/[\\/]\.credentials\.json$/, '')} in Windows Credential Manager (${cause}), and Rice Accounts reads browser logins only from the credentials file ${path}. Use a claudeai-token account instead (/rice-account add <name> claudeai-token), whose token Rice Accounts keeps in Windows Credential Manager itself${variable}.`)
}

/**
 * Claude Code on macOS keeps a login in its plaintext credentials file only
 * when the keychain could not store it, and reads that file when the keychain
 * holds no item. Whether `path` holds such a login; the grant is not kept.
 */
async function fileHoldsLogin(io: Io, path: string): Promise<boolean> {
  const stat = await io.stat(path).catch(() => null)
  if (stat === null || stat.kind !== 'file' || stat.size > PENDING_LIMIT) return false
  const text = await io.read(path).catch(() => null)
  if (text === null) return false
  try { return grantOf(JSON.parse(text)) !== null } catch { return false }
}

/** Windows paths name one file whatever their case or separators. */
function fileKey(path: string, platform: HostPlatform): string {
  return `file\0${platform === 'win32' ? path.replace(/\\/g, '/').toLowerCase() : path}`
}

async function storeOf(io: Io, location: LoginLocation): Promise<Store> {
  const platform = await hostPlatform(io)
  if (platform === 'darwin') {
    const service = await liveServiceName(location.storage, location.defaultConfigDir)
    const account = await resolveKeychainAccount(io, location.user)
    let filePath: string | undefined
    try { filePath = nativeCredentialPath(location, await io.env('HOME'), platform) } catch { filePath = undefined }
    const pendingPath = filePath === undefined ? undefined : `${filePath}${PENDING_SUFFIX}`

    return { kind: 'keychain', key: `keychain\0${service}\0${account ?? ''}`, service, account, writeAccount: account ?? keychainAccountName(undefined), filePath, pendingPath, cwd: '/' }
  }
  const home = platform === 'win32' ? await io.env('USERPROFILE') ?? await io.env('HOME') : await io.env('HOME')
  const path = nativeCredentialPath(location, home, platform)
  if (platform === 'win32') await refuseCredentialManager(io, location, home, path)
  // POSIX never searches the working folder for a program; Windows does, so
  // there it is the Claude config folder, which only this user writes.
  const cwd = platform === 'win32' ? location.defaultConfigDir : '/'

  return { kind: 'file', key: fileKey(path, platform), path, pendingPath: `${path}${PENDING_SUFFIX}`, cwd, platform }
}

async function isFolder(io: Io, path: string): Promise<boolean> {
  const stat = await io.stat(path).catch(() => null)
  return stat !== null && stat.kind === 'dir'
}

async function nodeStartProblem(io: Io, failure: RunFailure, store: FileStore, operation: FileOperation): Promise<string> {
  const doing = operation === 'read' || operation === 'examine' || operation === 'readpending' ? 'reading' : 'writing'
  switch (failure) {
    case 'timeout':
      return `Node.js did not finish ${doing} the native Claude credential file at ${store.path} within 15 seconds; another program (for example antivirus or a search indexer) may be holding it. Retry in a moment.`
    case 'missing':
      // Windows starts Node in the Claude config folder: a missing folder fails the start with ENOENT too.
      if (store.platform === 'win32' && !(await isFolder(io, store.cwd))) {
        return `The Claude configuration folder ${store.cwd} does not exist, so Node.js could not be started there for native file account storage. Start Claude Code once so it creates that folder (or check CLAUDE_CONFIG_DIR), then retry.`
      }
      return `Native file account storage needs Node.js 22 or later, and no node program could be started from PATH${store.platform === 'win32' ? ` (working folder ${store.cwd})` : ''}. Install Node.js 22 or later, then run account setup again.`
    case 'denied':
      return 'The node program on PATH could not be executed for native file account storage. Check that Node.js 22 or later is installed and executable, then run account setup again.'
    default:
      return 'Node.js could not be started for native file account storage. Check that Node.js 22 or later is on PATH, then run account setup again.'
  }
}

function nodeExitProblem(code: number, store: FileStore, operation: FileOperation): string {
  const reading = operation === 'read' || operation === 'examine' || operation === 'readpending'
  const target = operation === 'pending' || operation === 'clearpending' || operation === 'readpending' ? `the pending copy ${store.pendingPath}` : `the native Claude credential file at ${store.path}`
  const verb = reading ? 'read' : operation === 'clearpending' ? 'remove' : 'write'
  switch (code) {
    case FILE_EXIT.noOAuth:
      return `The native Claude credential file at ${store.path} no longer holds a Claude OAuth login: it was signed out or replaced while the login was renewed.`
    case FILE_EXIT.missing:
      return operation === 'pending'
        ? `Cannot keep the renewed login in ${store.pendingPath}: the login folder does not exist.`
        : `The native Claude credential file at ${store.path} disappeared while the login was renewed.`
    case FILE_EXIT.link:
      return 'Refused a symbolic link at the native credential file. Run account setup with its own login directory.'
    case FILE_EXIT.invalid:
      return reading
        ? `Cannot read the native Claude credential file at ${store.path}: it is unreadable, malformed or not permitted. Check its permissions and run account setup again.`
        : `Cannot ${verb} ${target}: permission was denied, or the file is unreadable or malformed. Check the permissions of the file and its folder.`
    case FILE_EXIT.busy:
      return `Another program (for example antivirus or a search indexer) kept ${target} open, so it could not be replaced after retrying for 3 seconds.`
    case FILE_EXIT.full:
      return `Cannot write ${target}: no space is left on its disk, or the file system is read-only.`
    case FILE_EXIT.oldNode:
      return 'Native file account storage requires Node.js 22 or later on PATH; the node program found there is older. Install Node.js 22 or later, then run account setup again.'
    case FILE_EXIT.windowsNode:
      return 'This WSL session found a Windows node.exe through Windows interop. Install Linux Node.js 22 or later inside WSL so node on PATH is the Linux build, then run account setup again.'
    default:
      return `Cannot ${verb} ${target}: Node.js exited with code ${code}.${reading ? ' Check its permissions and run account setup again.' : ''}`
  }
}

async function runFile(io: Io, store: FileStore, operation: FileOperation, stdin?: string): Promise<RunResult> {
  const init = trustedRun(store.cwd, stdin === undefined ? { timeoutMs: 15_000 } : { stdin, timeoutMs: 15_000 })
  try {
    return await io.run(['node', '-e', NATIVE_FILE, operation, store.path], init)
  } catch (error) {
    throw new Error(await nodeStartProblem(io, runFailure(error), store, operation))
  }
}

/** The program's `read`: the store, or the store with a usable pending grant. Nothing is written. */
async function fileRead(io: Io, store: FileStore): Promise<Credential | null> {
  const result = await runFile(io, store, 'read')
  if (result.exitCode === FILE_EXIT.noOAuth || result.exitCode === FILE_EXIT.missing) return null
  if (result.exitCode !== 0) throw new Error(nodeExitProblem(result.exitCode, store, 'read'))
  if (result.isStdoutTruncated) throw new Error(nodeExitProblem(FILE_EXIT.invalid, store, 'read'))

  return credential(result.stdout)
}

type StoreView = { stored: Credential | null; pending: PendingLogin | null }

/**
 * The program's `examine`: the store and its pending renewal as they are.
 * Nothing is written. `examine` reports a missing store as null, so its exit
 * 44 is not an answer: the login is not renewed on a guess (reading the store
 * alone would also mix in a usable pending renewal and hide which token the
 * store holds).
 */
async function fileInspect(io: Io, store: FileStore): Promise<StoreView> {
  const result = await runFile(io, store, 'examine')
  if (result.exitCode === FILE_EXIT.noOAuth) return { stored: null, pending: null }
  if (result.exitCode !== 0) throw new Error(nodeExitProblem(result.exitCode, store, 'examine'))
  if (result.isStdoutTruncated) throw new Error(nodeExitProblem(FILE_EXIT.invalid, store, 'examine'))
  let value: { stored?: unknown; pending?: unknown } | null
  try { value = JSON.parse(result.stdout) as { stored?: unknown; pending?: unknown } | null } catch { throw invalidStore() }
  if (value === null || typeof value !== 'object') throw invalidStore()
  const stored = value.stored === null || value.stored === undefined ? null : documentOf(value.stored)

  return { stored, pending: pendingOf(value.pending) }
}

/** The program's `readpending`: the pending renewal alone, for a store that cannot be read. */
async function filePendingOnly(io: Io, store: FileStore): Promise<PendingLogin | null> {
  const result = await runFile(io, store, 'readpending')
  if (result.exitCode !== 0 || result.isStdoutTruncated) return null
  try { return pendingOf((JSON.parse(result.stdout) as { pending?: unknown } | null)?.pending) } catch { return null }
}

async function fileWrite(io: Io, store: FileStore, fresh: Credential, expected: string): Promise<Credential> {
  const result = await runFile(io, store, 'write', JSON.stringify({ expectedRefreshToken: expected, oauth: grantOnly(fresh.claudeAiOauth) }))
  if (result.exitCode === FILE_EXIT.changed) throw new LoginChangedError('The login changed while it was renewed.')
  if (result.exitCode === FILE_EXIT.noOAuth || result.exitCode === FILE_EXIT.missing) throw new StoreGoneError(nodeExitProblem(result.exitCode, store, 'write'))
  if (result.exitCode !== 0) throw new Error(nodeExitProblem(result.exitCode, store, 'write'))
  if (result.isStdoutTruncated) throw new Error(nodeExitProblem(FILE_EXIT.invalid, store, 'write'))
  const saved = credential(result.stdout)
  if (saved === null) throw new StoreGoneError(nodeExitProblem(FILE_EXIT.noOAuth, store, 'write'))

  return saved
}

async function fileChange(io: Io, store: FileStore, operation: 'pending' | 'clearpending', stdin: string): Promise<void> {
  const result = await runFile(io, store, operation, stdin)
  if (result.exitCode !== 0) throw new Error(nodeExitProblem(result.exitCode, store, operation))
}

/** Remove files by absolute path; only POSIX (darwin) needs this, the Node program removes its own. */
async function removeFiles(io: Io, cwd: string, files: string[]): Promise<void> {
  if (files.length === 0) return
  await io.run(['/bin/rm', '-f', '--', ...files], trustedRun(cwd, { timeoutMs: 10_000 }))
    .then(ran => { if (ran.exitCode !== 0) io.log(`could not remove ${files.join(', ')} (rm exit ${ran.exitCode})`) })
    .catch((error: unknown) => io.log(`could not remove ${files.join(', ')}: ${message(error)}`))
}

type PendingFile = { pending: PendingLogin | null; regular: boolean; mtimeMs: number }

/** The darwin pending file through Io, never following a symbolic link; null when there is none. */
async function readPendingFile(io: Io, path: string): Promise<PendingFile | null> {
  const stat = await io.stat(path).catch(() => null)
  if (stat === null) return null
  const regular = stat.kind === 'file' && !stat.isLink
  if (!regular || stat.size > PENDING_LIMIT) return { pending: null, regular, mtimeMs: stat.mtimeMs }
  const text = await io.read(path).catch(() => null)

  return { pending: text === null ? null : parsePendingLogin(text), regular, mtimeMs: stat.mtimeMs }
}

/**
 * The keychain item and the pending file. Reads, the compare before a write
 * and the read-back after it all address the same item: the account when it
 * is known, else none. Without an item, a login Claude Code kept in its
 * plaintext credentials file instead is reported, never used.
 */
async function keychainView(io: Io, store: KeychainStore): Promise<StoreView> {
  const text = await readItem(io, store.service, store.account)
  if (text === null && store.filePath !== undefined && await fileHoldsLogin(io, store.filePath)) {
    throw new StoreGoneError(`The Claude login for ${store.filePath.replace(/\/\.credentials\.json$/, '')} is in its plaintext credentials file ${store.filePath}, not in the macOS keychain item "${store.service}" that Rice Accounts reads: Claude Code keeps a login in that file only when the keychain could not store it, for example while the keychain was locked. Unlock the login keychain (security unlock-keychain), then sign in again in a terminal so Claude Code moves the login into the keychain: for a saved account, run the command /rice-account setup <name> prints, with --login added; for this machine's login, run claude auth login.`)
  }
  const stored = text === null ? null : credential(text)
  if (stored === null || store.pendingPath === undefined) return { stored, pending: null }

  return { stored, pending: (await readPendingFile(io, store.pendingPath))?.pending ?? null }
}

/** Store a login in the keychain within the line limit and read the same item back. */
async function writeKeychain(io: Io, store: KeychainStore, document: Credential): Promise<Credential> {
  const { text, dropped } = fitCredential(document, store.service, store.writeAccount)
  if (dropped.length > 0) io.log(`the macOS keychain line limit left ${dropped.join(', ')} out of the stored login "${store.service}"; the OAuth login was kept whole`)
  await writeItem(io, store.service, store.writeAccount, text)
  const check = await readItem(io, store.service, store.account)
  const written = check === null ? null : credential(check)
  if (written === null || written.claudeAiOauth.refreshToken !== document.claudeAiOauth.refreshToken || written.claudeAiOauth.accessToken !== document.claudeAiOauth.accessToken) {
    throw new KeychainError(`the keychain item "${store.service}" did not read back as written`)
  }

  return written
}

async function viewOf(io: Io, store: Store): Promise<StoreView> {
  return store.kind === 'file' ? fileInspect(io, store) : keychainView(io, store)
}

/**
 * Renewals the server granted that are not saved yet, by store: the store's
 * refresh token when the first of them began, the newest renewed login, and
 * the spent refresh tokens it descends from.
 */
const unsaved = new Map<string, PendingLogin & { spent: readonly string[] }>()

/** The store each inspected state was read from. */
const stores = new WeakMap<LoginState, Store>()

/** Forget unsaved renewals; for tests. */
export function forgetUnsavedLogins(): void {
  unsaved.clear()
}

/** Rule B over a view and this process's memory; memory that is no longer usable, or older than the pending renewal, is forgotten. */
function choose(key: string, view: StoreView): LoginState {
  const entry = unsaved.get(key)
  const picked = bestLogin(view.stored, view.pending, entry)
  if (entry && view.stored !== null && picked.source !== 'memory') unsaved.delete(key)

  return {
    stored: view.stored,
    pending: view.pending,
    login: picked.login,
    source: picked.source,
    candidate: picked.candidate,
    onDisk: view.stored?.claudeAiOauth.refreshToken,
    spent: picked.source === 'memory' && entry ? entry.spent : [],
  }
}

/**
 * A pending renewal that is later than the one kept in memory, read without the
 * store (which cannot be read): the same base, a login memory does not descend
 * from. Another session renewed further while this one's store was unreadable.
 */
async function laterPending(io: Io, store: Store, entry: PendingLogin & { spent: readonly string[] }): Promise<(PendingLogin & { spent: readonly string[] }) | null> {
  let pending: PendingLogin | null
  try {
    pending = store.kind === 'file' ? await filePendingOnly(io, store) : store.pendingPath === undefined ? null : (await readPendingFile(io, store.pendingPath))?.pending ?? null
  } catch {
    return null
  }
  if (pending === null || pending.base !== entry.base || !pendingIsLater(entry, pending)) return null

  return { ...pending, spent: descent(entry.spent, entry.credential.claudeAiOauth.refreshToken, pending.credential) }
}

/** The state of `store`; when it cannot be read, the newest renewal kept in memory or in the pending file answers (with its base as the store's token). */
async function stateOf(io: Io, store: Store): Promise<LoginState> {
  let view: StoreView
  try {
    view = await viewOf(io, store)
  } catch (error) {
    const entry = unsaved.get(store.key)
    if (!entry) throw error
    io.log(`the credential store is unreadable (${message(error)}); using the renewed login kept in memory`)
    const current = await laterPending(io, store, entry) ?? entry
    if (current !== entry) unsaved.set(store.key, current)
    return { stored: null, pending: null, login: current.credential, source: 'memory', candidate: current, onDisk: current.base, spent: current.spent }
  }

  return choose(store.key, view)
}

/**
 * The login at `location`: the stored one, or a renewal not saved yet that
 * is usable against it (rule B). A plain read: it never writes or removes
 * anything, whatever it finds.
 */
export async function readLogin(io: Io, location: LoginLocation): Promise<Credential | null> {
  const store = await storeOf(io, location)
  if (store.kind === 'file' && !unsaved.has(store.key)) return fileRead(io, store)

  return (await stateOf(io, store)).login
}

/**
 * The store, its pending renewal and the login to use, for a renewal under
 * the renewal lock. It reads only; `onDisk` is what the next store write must
 * find there.
 */
export async function inspectLogin(io: Io, location: LoginLocation): Promise<LoginState> {
  const store = await storeOf(io, location)
  const state = await stateOf(io, store)
  // Saving the renewal must not look the store up again (that can start a process) once the old token is spent.
  stores.set(state, store)

  return state
}

async function writePending(io: Io, store: Store, renewal: PendingLogin): Promise<string> {
  const content = { base: renewal.base, credential: { claudeAiOauth: grantOnly(renewal.credential.claudeAiOauth) } }
  if (store.kind === 'file') {
    await fileChange(io, store, 'pending', JSON.stringify(content))
    return store.pendingPath
  }
  if (store.pendingPath === undefined) throw new Error('the login has no folder to keep a pending copy in')
  const ran = await io.run(['/bin/sh', '-c', PENDING_SH, store.pendingPath], trustedRun(store.cwd, { stdin: JSON.stringify({ version: PENDING_VERSION, ...content }), timeoutMs: 15_000 }))
  if (ran.exitCode !== 0) throw new Error(`the pending copy ${store.pendingPath} could not be written (sh exit ${ran.exitCode})`)

  return store.pendingPath
}

/**
 * Remove the pending file when its base is `base` and its refresh token is one
 * of `tokens` (this renewal's own and the ones it descends from), so another
 * session's later renewal under the same base stays; or when it is not a
 * version 2 file and older than five minutes. Failures are logged: a pending
 * file left behind is redundant or obsolete by rule B and never used.
 */
async function clearPending(io: Io, store: Store, base: string, tokens: readonly string[]): Promise<void> {
  try {
    if (store.kind === 'file') {
      await fileChange(io, store, 'clearpending', JSON.stringify({ base, tokens }))
      return
    }
    if (store.pendingPath === undefined) return
    const found = await readPendingFile(io, store.pendingPath)
    if (found === null) return
    const now = await io.now().catch(() => undefined)
    const stale = found.regular && now !== undefined && now - found.mtimeMs >= STALE_COPY_MS
    const mine = found.pending !== null && found.pending.base === base && tokens.includes(found.pending.credential.claudeAiOauth.refreshToken)
    if (found.pending !== null ? mine : stale) await removeFiles(io, store.cwd, [store.pendingPath])
  } catch (error) {
    io.log(`could not remove the pending copy of a saved login: ${message(error)}`)
  }
}

/** Save `fresh` when the store still holds `expected` (compare-and-swap); `LoginChangedError` when it holds another login. */
async function saveToStore(io: Io, store: Store, fresh: Credential, expected: string): Promise<Credential> {
  if (store.kind === 'file') return fileWrite(io, store, fresh, expected)
  // The keychain has no compare-and-swap: read the same item again immediately before writing.
  const text = await readItem(io, store.service, store.account)
  const stored = text === null ? null : credential(text)
  if (stored === null) throw new StoreGoneError(`The keychain login "${store.service}" disappeared while the login was renewed.`)
  const held = stored.claudeAiOauth.refreshToken
  if (held !== expected) {
    if (held === fresh.claudeAiOauth.refreshToken) return stored
    throw new LoginChangedError('The login changed while it was renewed.')
  }

  return writeKeychain(io, store, merged(stored, fresh.claudeAiOauth))
}

function notSaved(error: unknown, kept: string | undefined): LoginNotSavedError {
  const where = kept === undefined ? 'in this session\'s memory only' : `in ${kept} (owner-only) and in this session's memory`
  const text = message(error).replace(/\.?$/, '.')
  if (error instanceof StoreGoneError) return new LoginNotSavedError(`${text} The renewed login was kept ${where}, but it cannot be used without a stored login: sign this account in again with account setup.`)

  return new LoginNotSavedError(`${text} The renewed login was kept ${where}; it is saved automatically the next time this account is used.`)
}

/**
 * The store changed under the lock (an interactive sign-in, or a session
 * without the lock). When it holds `fresh` it was saved; otherwise the store
 * is authoritative: its login (with a renewal usable against it) is used,
 * this process's renewal is forgotten, and a pending file is removed only
 * when it is obsolete against the new store.
 */
async function settleChanged(io: Io, store: Store, fresh: Credential, onDisk: string, kept: string | undefined, spent: readonly string[], hops: number): Promise<Credential> {
  let view: StoreView
  try {
    view = await viewOf(io, store)
  } catch (error) {
    throw notSaved(error, kept)
  }
  if (view.stored === null) throw notSaved(new StoreGoneError('The stored login disappeared while it was renewed.'), kept)
  const held = view.stored.claudeAiOauth.refreshToken
  // The store advanced along this renewal's own ancestry (a stalled session saved
  // its older renewal after this one began): `fresh` is the later login, and it is
  // saved over that one. Taking the store's login instead would drop the newest.
  if (held !== fresh.claudeAiOauth.refreshToken && spent.includes(held) && hops < SPENT_KEPT) {
    io.log('an older renewal of this login was saved while a newer one was being renewed; saving the newer one over it')
    return persist(io, store, fresh, held, spent, undefined, hops + 1)
  }
  unsaved.delete(store.key)
  if (held === fresh.claudeAiOauth.refreshToken) {
    await clearPending(io, store, onDisk, ownedTokens(spent, fresh))
    return view.stored
  }
  if (view.pending !== null && pendingState(view.stored, view.pending) === 'obsolete') await clearPending(io, store, view.pending.base, [view.pending.credential.claudeAiOauth.refreshToken])
  io.log('another session or sign-in saved a different login while this one renewed; kept that login')

  return bestLogin(view.stored, view.pending).login ?? view.stored
}

/**
 * Persist a renewal: kept in memory, then written ahead to the owner-only
 * pending file as `{base: onDisk, credential: fresh}`, then saved to the store
 * only if it still holds `onDisk`, and the pending file cleared. A failed
 * store write keeps both and throws `LoginNotSavedError` naming where.
 */
async function persist(io: Io, store: Store, fresh: Credential, onDisk: string, spent: readonly string[], afterKept?: () => Promise<void>, hops = 0): Promise<Credential> {
  const renewal: PendingLogin = { base: onDisk, credential: fresh }
  unsaved.set(store.key, { ...renewal, spent })
  let kept: string | undefined
  try {
    kept = await writePending(io, store, renewal)
  } catch (error) {
    io.log(`could not keep the renewed login in a pending file: ${message(error)}`)
  }
  // The only copy that could be lost is in memory until now; whatever extends the lock for the save comes after it.
  if (afterKept) await afterKept().catch((error: unknown) => io.log(`could not prepare saving the renewed login: ${message(error)}`))
  let saved: Credential
  try {
    saved = await saveToStore(io, store, fresh, onDisk)
  } catch (error) {
    if (error instanceof LoginChangedError) return settleChanged(io, store, fresh, onDisk, kept, spent, hops)
    throw notSaved(error, kept)
  }
  unsaved.delete(store.key)
  await clearPending(io, store, onDisk, ownedTokens(spent, fresh))

  return saved
}

/** The refresh tokens a renewal owns: its own and the spent ones it descends from. */
function ownedTokens(spent: readonly string[], fresh: Credential): string[] {
  return [...spent, fresh.claudeAiOauth.refreshToken]
}

/** The spent tokens a renewal of `renewed` into `fresh` descends from. */
function descent(spent: readonly string[], renewed: string, fresh: Credential): string[] {
  const all = renewed === fresh.claudeAiOauth.refreshToken || spent.includes(renewed) ? [...spent] : [...spent, renewed]
  return all.slice(-SPENT_KEPT)
}

/**
 * Persist a rotated grant renewed from `from.login` (read with
 * `inspectLogin`), comparing the store against `from.onDisk`. The server
 * already spent the previous refresh token, so the renewal is kept in memory
 * and written ahead to the pending file before the store write; a failed
 * store write throws `LoginNotSavedError`, and the renewal stays usable.
 * `afterKept` runs once the pending copy is written (or failed) and before the
 * store write.
 */
export async function saveRenewal(io: Io, location: LoginLocation, fresh: Credential, from: LoginState, afterKept?: () => Promise<void>): Promise<Credential> {
  const store = stores.get(from) ?? await storeOf(io, location)
  const renewed = from.login?.claudeAiOauth.refreshToken
  const onDisk = from.onDisk ?? renewed
  if (renewed === undefined || onDisk === undefined) throw new Error('There is no stored login to save this renewal over. Run account setup again.')

  return persist(io, store, fresh, onDisk, descent(from.spent, renewed, fresh), afterKept)
}

/**
 * Persist a rotated grant without replacing unrelated native credential
 * fields; `previous` is the login that was renewed. The store write compares
 * against the refresh token the store held when `previous`'s lineage began.
 */
export async function writeLogin(io: Io, location: LoginLocation, fresh: Credential, previous: Credential): Promise<Credential> {
  const store = await storeOf(io, location)
  const renewed = previous.claudeAiOauth.refreshToken
  const entry = unsaved.get(store.key)
  const remembered = entry?.credential.claudeAiOauth.refreshToken === renewed ? entry : undefined
  let onDisk = remembered?.base ?? renewed
  let spent: readonly string[] = remembered?.spent ?? []
  try {
    const state = await stateOf(io, store)
    if (state.stored?.claudeAiOauth.refreshToken === renewed) {
      onDisk = renewed
      spent = []
    } else if (state.candidate !== null && state.login?.claudeAiOauth.refreshToken === renewed && state.onDisk !== undefined) {
      onDisk = state.onDisk
      spent = state.spent
    }
  } catch {
    // Unreadable now: the store write below reports it, and the renewal is still kept.
  }

  return persist(io, store, fresh, onDisk, descent(spent, renewed, fresh))
}

/**
 * Save a usable renewal that `state` found unsaved (opportunistically, under
 * the renewal lock). Resolves the login to use: the saved one, the store's
 * when it changed meanwhile, or the renewal itself when the store still
 * refuses it (logged only: the renewal works).
 */
export async function promoteLogin(io: Io, location: LoginLocation, state: LoginState): Promise<Credential | null> {
  if (state.source === 'store' || state.login === null || state.stored === null) return state.login
  const store = stores.get(state) ?? await storeOf(io, location)
  const login = state.login
  const onDisk = state.stored.claudeAiOauth.refreshToken
  try {
    const saved = await saveToStore(io, store, login, onDisk)
    unsaved.delete(store.key)
    await clearPending(io, store, onDisk, ownedTokens(state.spent, login))
    io.log('saved a renewed login that had been kept unsaved')
    return saved
  } catch (error) {
    if (error instanceof LoginChangedError) {
      try { return await settleChanged(io, store, login, onDisk, undefined, state.spent, 0) } catch { return login }
    }
    io.log(`a renewed login is still unsaved and is used as it is: ${message(error)}`)
    return login
  }
}

/** Whether this process holds a renewal for `location` that is not saved yet. */
export async function hasUnsavedLogin(io: Io, location: LoginLocation): Promise<boolean> {
  if (unsaved.size === 0) return false
  return unsaved.has((await storeOf(io, location)).key)
}

/**
 * Try again to save a renewal this process holds for `location`. Resolves the
 * login to use, as `promoteLogin` does; null when there is none.
 */
export async function saveUnsavedLogin(io: Io, location: LoginLocation): Promise<Credential | null> {
  const store = await storeOf(io, location)
  if (!unsaved.has(store.key)) return null
  const state = await stateOf(io, store)

  return promoteLogin(io, location, state)
}

/** Placeholder growth for a token whose renewed length is not known yet. */
function grown(token: string): string {
  return 'x'.repeat(Math.max(token.length * 2, token.length + 512))
}

/**
 * Refuse, before the token endpoint spends the refresh token, a renewal whose
 * result could not be stored. Only the macOS keychain has a limit this small:
 * `security -i` takes about 4 KB per line. The check projects longer tokens
 * than the current ones and counts on optional fields being left out.
 */
export async function checkRenewable(io: Io, location: LoginLocation, current: Credential): Promise<void> {
  const store = await storeOf(io, location)
  if (store.kind !== 'keychain') return
  const oauth = current.claudeAiOauth
  try {
    fitCredential(merged(current, { accessToken: grown(oauth.accessToken), refreshToken: grown(oauth.refreshToken), expiresAt: Number.MAX_SAFE_INTEGER, refreshTokenExpiresAt: Number.MAX_SAFE_INTEGER }), store.service, store.writeAccount)
  } catch (error) {
    throw new Error(`This login is too large to store in the macOS keychain (${message(error)}). It was not renewed, so its refresh token was not spent; sign it in again with account setup.`)
  }
}

function secretStartProblem(failure: RunFailure, platform: 'win32' | 'linux', command: string): string {
  if (platform === 'win32') {
    if (failure === 'timeout') return 'Windows Credential Manager did not answer within 15 seconds. Sign into an interactive Windows session (a sign-in prompt may be waiting), then retry.'
    if (failure === 'missing' || failure === 'denied') return `Windows account secrets require Windows PowerShell; ${command} could not be started. Restore Windows PowerShell, then run account setup again.`
    return 'Windows account secrets require Windows PowerShell and an interactive Windows sign-in with Credential Manager available.'
  }
  if (failure === 'timeout') return 'The Linux Secret Service keyring did not answer within 15 seconds. Unlock the keyring (a prompt may be waiting) or start its service, then retry.'
  if (failure === 'missing' || failure === 'denied') return 'Named account secrets on Linux require secret-tool (libsecret), and it could not be started. Install it (for example the libsecret-tools package) and enable an unlocked Secret Service keyring, then run account setup again.'
  return 'Named account secrets on Linux require secret-tool (libsecret) and an unlocked Secret Service keyring. Install or enable them, then run account setup again.'
}

/** Named keys and tokens use the OS keyring, separate from native OAuth files. */
export async function readSecret(io: Io, reference: SecretRef): Promise<string | null> {
  const platform = await hostPlatform(io)
  if (platform === 'darwin') return readItem(io, reference.service, reference.account)
  if (platform === 'win32') {
    const root = await io.env('SystemRoot') ?? await io.env('WINDIR')
    const command = root ? `${root.replace(/[\\/]+$/, '')}/System32/WindowsPowerShell/v1.0/powershell.exe` : 'powershell.exe'
    const cwd = root ?? await io.env('USERPROFILE') ?? 'C:\\'
    const result = await io.run([command, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_CREDENTIAL_STORE], trustedRun(cwd, { stdin: JSON.stringify({ operation: 'read', service: reference.service, account: reference.account }), timeoutMs: 15_000 }))
      .catch((error: unknown) => { throw new Error(secretStartProblem(runFailure(error), 'win32', command)) })
    if (result.exitCode === 44) return null
    if (result.exitCode !== 0 || result.isStdoutTruncated) throw new Error(`Cannot read Windows Credential Manager (exit ${result.exitCode}). Sign into an interactive Windows session and run account setup again.`)
    return result.stdout
  }
  const result = await io.run(['secret-tool', 'lookup', 'service', reference.service, 'account', reference.account], trustedRun('/', { timeoutMs: 15_000 }))
    .catch((error: unknown) => { throw new Error(secretStartProblem(runFailure(error), 'linux', 'secret-tool')) })
  if (result.exitCode === 1 && result.stderr.trim() === '') return null
  if (result.exitCode !== 0 || result.isStdoutTruncated) throw new Error(`Cannot read the Linux account keyring (secret-tool exit ${result.exitCode}). Check that secret-tool (libsecret) and an unlocked Secret Service keyring are available, then run account setup again.`)
  return result.stdout.replace(/\n$/, '')
}
