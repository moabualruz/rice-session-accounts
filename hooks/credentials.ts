import type { SecretRef } from './config'
import type { Io, RunFailure } from './io'
import { message, runFailure, trustedRun } from './io'
import { fitCredential, KeychainError, keychainAccountName, liveServiceName, parseCredential, readItem, resolveKeychainAccount, writeItem } from './keychain'
import type { Credential, StorageVariables } from './keychain'
import { WINDOWS_CREDENTIAL_STORE } from '../scripts/windows-store-payloads.mjs'

export type HostPlatform = 'darwin' | 'linux' | 'win32'
export type LoginLocation = { storage: StorageVariables; defaultConfigDir: string; user?: string }

/** Appended to the native credential path: the renewed login written ahead of the store. */
export const PENDING_SUFFIX = '.rice-pending'
/** A leftover temporary or pending copy older than this is recovered or removed. */
export const STALE_COPY_MS = 5 * 60 * 1000

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
 * Operations: `read` prints the document, first adopting a newer renewal from
 * the `.rice-pending` file or a temporary copy older than five minutes (left
 * by a killed write), then removing those copies; `write` replaces only the
 * OAuth grant when the stored refresh token is still the expected one;
 * `pending` writes the renewal ahead of the store. Writes create an exclusive
 * 0600 temporary file, fsync it, rename it over the target (retried for about
 * 3 seconds while Windows Defender or an indexer holds the file) and fsync the
 * folder on POSIX.
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
function isNewer(candidate, current) { return candidate.expiresAt > current.expiresAt && candidate.refreshToken !== current.refreshToken; }
function copy(source) {
  var target = {};
  for (var key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) Object.defineProperty(target, key, { value: source[key], enumerable: true, writable: true, configurable: true });
  }
  return target;
}
function merged(document, oauth) {
  var next = copy(document);
  var inner = copy(document.claudeAiOauth);
  inner.accessToken = oauth.accessToken;
  inner.refreshToken = oauth.refreshToken;
  inner.expiresAt = oauth.expiresAt;
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
function renameWithRetry(from, to) {
  for (var attempt = 0; ; attempt += 1) {
    try { fs.renameSync(from, to); return; } catch (error) {
      var code = error && error.code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error;
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
function leftovers() {
  var found = [];
  var pending = grantOf(readJson(pendingPath, false));
  if (pending) found.push({ file: pendingPath, oauth: pending });
  var folder = paths.dirname(path);
  var prefix = paths.basename(path) + '.rice-';
  var names = [];
  try { names = fs.readdirSync(folder); } catch (ignored) {}
  var now = Date.now();
  for (var index = 0; index < names.length; index += 1) {
    var name = names[index];
    if (name.indexOf(prefix) !== 0 || !/^[0-9]+-[0-9a-f-]{16,64}$/.test(name.slice(prefix.length))) continue;
    var file = paths.join(folder, name);
    var stat = null;
    try { stat = fs.lstatSync(file); } catch (ignored) {}
    if (stat === null || !stat.isFile() || now - stat.mtimeMs < staleMs) continue;
    found.push({ file: file, oauth: grantOf(readJson(file, false)) });
  }
  return found;
}
function adopt(document) {
  var found = leftovers();
  var best = null;
  for (var index = 0; index < found.length; index += 1) {
    var oauth = found[index].oauth;
    if (oauth && isNewer(oauth, document.claudeAiOauth) && (best === null || oauth.expiresAt > best.expiresAt)) best = oauth;
  }
  var next = best === null ? document : merged(document, best);
  if (best !== null) {
    try { writeAtomic(path, next); } catch (ignored) {
      if (temporary) { remove(temporary); temporary = undefined; }
      return next;
    }
  }
  for (var each = 0; each < found.length; each += 1) remove(found[each].file);
  return next;
}
function clearPending(oauth) {
  var held = grantOf(readJson(pendingPath, false));
  if (held && (held.refreshToken === oauth.refreshToken || held.expiresAt <= oauth.expiresAt)) remove(pendingPath);
}
function input() {
  var value = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!isObject(value)) fail(46);
  return value;
}
try {
  if (process.platform === 'win32' && typeof path === 'string' && /^\/(?!\/)/.test(path)) fail(51);
  if (Number(String(process.versions.node).split('.')[0]) < 22) fail(50);
  if (!path || !paths.isAbsolute(path) || /[\0\r\n]/.test(path) || process.platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(path)) fail(46);
  var output = null;
  if (operation === 'read') {
    output = adopt(readStored());
  } else if (operation === 'write') {
    var request = input();
    var oauth = request.oauth;
    if (!isOAuth(oauth) || typeof request.expectedRefreshToken !== 'string') fail(46);
    var current = readStored();
    if (current.claudeAiOauth.refreshToken !== request.expectedRefreshToken) {
      clearPending(oauth);
      fail(47);
    }
    output = merged(current, oauth);
    writeAtomic(path, output);
    clearPending(oauth);
  } else if (operation === 'pending') {
    var renewal = input().claudeAiOauth;
    if (!isOAuth(renewal)) fail(46);
    writeAtomic(pendingPath, { claudeAiOauth: { accessToken: renewal.accessToken, refreshToken: renewal.refreshToken, expiresAt: renewal.expiresAt } });
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
 * owner-only (umask 077) copy through an exclusive temporary file, renames it
 * into place and asks the system to flush (`sync`).
 */
const PENDING_SH = [
  'umask 077',
  'rm -f "$0.tmp" || exit 1',
  'set -C',
  'if cat > "$0.tmp" && mv -f "$0.tmp" "$0"; then /bin/sync 2>/dev/null; exit 0; fi',
  'rm -f "$0.tmp"',
  'exit 1',
].join('\n')

type OAuthGrant = Pick<Credential['claudeAiOauth'], 'accessToken' | 'refreshToken' | 'expiresAt'>
type KeychainStore = { kind: 'keychain'; key: string; service: string; account: string | undefined; writeAccount: string; pendingPath: string | undefined; cwd: string }
type FileStore = { kind: 'file'; key: string; path: string; pendingPath: string; cwd: string; platform: HostPlatform }
type Store = KeychainStore | FileStore

/** Another writer saved a different grant; the caller adopts it. */
class LoginChangedError extends Error {}

/** A renewal the server granted that could not be saved; the message says where it was kept. */
export class LoginNotSavedError extends Error {}

function credential(text: string): Credential | null {
  try {
    const document: unknown = JSON.parse(text)
    if (document === null || typeof document !== 'object' || Array.isArray(document)) throw new Error('invalid document')
    const oauth = (document as { claudeAiOauth?: unknown }).claudeAiOauth
    if (oauth === undefined || oauth === null) return null
    const value = parseCredential(text)
    if (!Number.isFinite(value.claudeAiOauth.expiresAt)) throw new Error('missing expiry')
    return value
  } catch {
    throw new Error('The credential store contains no valid Claude OAuth login. Run account setup again.')
  }
}

function grantOf(value: unknown): OAuthGrant | null {
  const oauth = (value as { claudeAiOauth?: Partial<OAuthGrant> } | null)?.claudeAiOauth
  return typeof oauth?.accessToken === 'string' && typeof oauth.refreshToken === 'string' && typeof oauth.expiresAt === 'number' && Number.isFinite(oauth.expiresAt)
    ? { accessToken: oauth.accessToken, refreshToken: oauth.refreshToken, expiresAt: oauth.expiresAt }
    : null
}

function isNewer(candidate: OAuthGrant, current: OAuthGrant): boolean {
  return candidate.expiresAt > current.expiresAt && candidate.refreshToken !== current.refreshToken
}

function merged(document: Credential, oauth: OAuthGrant): Credential {
  return { ...document, claudeAiOauth: { ...document.claudeAiOauth, accessToken: oauth.accessToken, refreshToken: oauth.refreshToken, expiresAt: oauth.expiresAt } }
}

async function fileStoreAvailable(io: Io, platform: HostPlatform): Promise<void> {
  if (platform !== 'win32') return
  const forced = await io.env('FORCE_WINDOWS_CREDMAN')
  if (forced && !/^(?:0|false|no|off)$/i.test(forced)) throw new Error('The optional FORCE_WINDOWS_CREDMAN native browser store is not supported by Rice Accounts. Start this session without that override, or use a claudeai-token account in Windows Credential Manager.')
}

async function storeOf(io: Io, location: LoginLocation): Promise<Store> {
  const platform = await hostPlatform(io)
  if (platform === 'darwin') {
    const service = await liveServiceName(location.storage, location.defaultConfigDir)
    const account = await resolveKeychainAccount(io, location.user)
    let pendingPath: string | undefined
    try { pendingPath = `${nativeCredentialPath(location, await io.env('HOME'), platform)}${PENDING_SUFFIX}` } catch { pendingPath = undefined }

    return { kind: 'keychain', key: `keychain\0${service}\0${account ?? ''}`, service, account, writeAccount: account ?? keychainAccountName(undefined), pendingPath, cwd: '/' }
  }
  await fileStoreAvailable(io, platform)
  const home = platform === 'win32' ? await io.env('USERPROFILE') ?? await io.env('HOME') : await io.env('HOME')
  const path = nativeCredentialPath(location, home, platform)
  // POSIX never searches the working folder for a program; Windows does, so
  // there it is the Claude config folder, which only this user writes.
  const cwd = platform === 'win32' ? location.defaultConfigDir : '/'

  return { kind: 'file', key: `file\0${path}`, path, pendingPath: `${path}${PENDING_SUFFIX}`, cwd, platform }
}

function nodeStartProblem(failure: RunFailure, store: FileStore, operation: string): string {
  const doing = operation === 'read' ? 'reading' : 'writing'
  switch (failure) {
    case 'timeout':
      return `Node.js did not finish ${doing} the native Claude credential file at ${store.path} within 15 seconds; another program (for example antivirus or a search indexer) may be holding it. Retry in a moment.`
    case 'missing':
      return `Native file account storage needs Node.js 22 or later, and no node program could be started from PATH${store.platform === 'win32' ? ` (working folder ${store.cwd})` : ''}. Install Node.js 22 or later, then run account setup again.`
    case 'denied':
      return 'The node program on PATH could not be executed for native file account storage. Check that Node.js 22 or later is installed and executable, then run account setup again.'
    default:
      return 'Node.js could not be started for native file account storage. Check that Node.js 22 or later is on PATH, then run account setup again.'
  }
}

function nodeExitProblem(code: number, store: FileStore, operation: string): string {
  const verb = operation === 'read' ? 'read' : 'write'
  switch (code) {
    case FILE_EXIT.missing:
      return 'The native credential file disappeared during renewal. Run account setup again.'
    case FILE_EXIT.link:
      return 'Refused a symbolic link at the native credential file. Run account setup with its own login directory.'
    case FILE_EXIT.invalid:
      return `Cannot ${verb} the native Claude credential file at ${store.path}: it is unreadable, malformed or not permitted. Check its permissions and run account setup again.`
    case FILE_EXIT.busy:
      return `Another program (for example antivirus or a search indexer) kept the native credential file at ${store.path} open, so it could not be replaced after retrying for 3 seconds.`
    case FILE_EXIT.full:
      return `Cannot write the native credential file at ${store.path}: no space is left on its disk, or the file system is read-only.`
    case FILE_EXIT.oldNode:
      return 'Native file account storage requires Node.js 22 or later on PATH; the node program found there is older. Install Node.js 22 or later, then run account setup again.'
    case FILE_EXIT.windowsNode:
      return 'This WSL session found a Windows node.exe through Windows interop. Install Linux Node.js 22 or later inside WSL so node on PATH is the Linux build, then run account setup again.'
    default:
      return `Cannot ${verb} the native Claude credential file at ${store.path}: Node.js exited with code ${code}. Check its permissions and run account setup again.`
  }
}

async function nativeFile(io: Io, store: FileStore, operation: 'read' | 'write' | 'pending', stdin?: string): Promise<Credential | null> {
  const init = trustedRun(store.cwd, stdin === undefined ? { timeoutMs: 15_000 } : { stdin, timeoutMs: 15_000 })
  const result = await io.run(['node', '-e', NATIVE_FILE, operation, store.path], init)
    .catch((error: unknown) => { throw new Error(nodeStartProblem(runFailure(error), store, operation)) })
  if (operation === 'read' && (result.exitCode === FILE_EXIT.noOAuth || result.exitCode === FILE_EXIT.missing)) return null
  if (operation === 'write' && result.exitCode === FILE_EXIT.changed) throw new LoginChangedError('The login changed while it was renewed. Retry the account switch to read the newer login.')
  if (result.exitCode !== 0) throw new Error(nodeExitProblem(result.exitCode, store, operation))
  if (operation === 'pending') return null
  if (result.isStdoutTruncated) throw new Error(nodeExitProblem(FILE_EXIT.invalid, store, operation))

  return credential(result.stdout)
}

/** Remove files by absolute path; only POSIX (darwin) needs this, the Node program removes its own. */
async function removeFiles(io: Io, cwd: string, files: string[]): Promise<void> {
  if (files.length === 0) return
  await io.run(['/bin/rm', '-f', '--', ...files], trustedRun(cwd, { timeoutMs: 10_000 }))
    .then(ran => { if (ran.exitCode !== 0) io.log(`could not remove ${files.join(', ')} (rm exit ${ran.exitCode})`) })
    .catch((error: unknown) => io.log(`could not remove ${files.join(', ')}: ${message(error)}`))
}

type Leftover = { path: string; oauth: OAuthGrant | null }

/** The darwin pending copy and a leftover temporary copy of it older than five minutes. */
async function keychainLeftovers(io: Io, store: KeychainStore): Promise<Leftover[]> {
  if (store.pendingPath === undefined) return []
  const found: Leftover[] = []
  for (const [path, stale] of [[store.pendingPath, false], [`${store.pendingPath}.tmp`, true]] as const) {
    const stat = await io.stat(path).catch(() => null)
    if (stat === null || stat.isLink || stat.kind !== 'file' || stat.size > 64 * 1024) continue
    if (stale) {
      const now = await io.now().catch(() => undefined)
      if (now === undefined || now - stat.mtimeMs < STALE_COPY_MS) continue
    }
    const oauth = await io.read(path).then(text => {
      try { return grantOf(JSON.parse(text)) } catch { return null }
    }, () => null)
    // An unreadable pending copy is kept for inspection; a stale temporary copy is removed either way.
    if (oauth !== null || stale) found.push({ path, oauth })
  }

  return found
}

/** Store a login in the keychain within the line limit and read it back. */
async function writeKeychain(io: Io, store: KeychainStore, document: Credential): Promise<Credential> {
  const { text, dropped } = fitCredential(document, store.service, store.writeAccount)
  if (dropped.length > 0) io.log(`the macOS keychain line limit left ${dropped.join(', ')} out of the stored login "${store.service}"; the OAuth login was kept whole`)
  await writeItem(io, store.service, store.writeAccount, text)
  const check = await readItem(io, store.service, store.writeAccount)
  const written = check === null ? null : credential(check)
  if (written === null || written.claudeAiOauth.refreshToken !== document.claudeAiOauth.refreshToken || written.claudeAiOauth.accessToken !== document.claudeAiOauth.accessToken) {
    throw new KeychainError(`the keychain item "${store.service}" did not read back as written`)
  }

  return written
}

async function readKeychainLogin(io: Io, store: KeychainStore): Promise<Credential | null> {
  const text = await readItem(io, store.service, store.account)
  const stored = text === null ? null : credential(text)
  if (stored === null) return null
  const found = await keychainLeftovers(io, store).catch(() => [])
  if (found.length === 0) return stored
  let best: OAuthGrant | null = null
  for (const { oauth } of found) {
    if (oauth && isNewer(oauth, stored.claudeAiOauth) && (best === null || oauth.expiresAt > best.expiresAt)) best = oauth
  }
  let result = stored
  if (best !== null) {
    const next = merged(stored, best)
    try {
      result = await writeKeychain(io, store, next)
      io.log(`saved the renewed login kept in ${store.pendingPath ?? 'the pending file'} to the keychain`)
    } catch (error) {
      io.log(`the renewed login kept in ${store.pendingPath ?? 'the pending file'} is still unsaved: ${message(error)}`)
      return next
    }
  }
  await removeFiles(io, store.cwd, found.map(each => each.path))

  return result
}

async function readStored(io: Io, store: Store): Promise<Credential | null> {
  return store.kind === 'keychain' ? readKeychainLogin(io, store) : nativeFile(io, store, 'read')
}

/**
 * Renewals the server granted that are not saved yet, by store: the fresh
 * login and the refresh token the store still holds (spent by that renewal).
 */
const unsaved = new Map<string, { fresh: Credential; spent: string }>()

/** Forget unsaved renewals; for tests. */
export function forgetUnsavedLogins(): void {
  unsaved.clear()
}

function preferUnsaved(key: string, stored: Credential | null): Credential | null {
  const entry = unsaved.get(key)
  if (!entry || stored === null) return stored
  const held = stored.claudeAiOauth.refreshToken
  if (held === entry.fresh.claudeAiOauth.refreshToken) { unsaved.delete(key); return stored }
  // The store still holds the refresh token the renewal spent: only the fresh login works.
  if (held === entry.spent) return entry.fresh
  // Another writer saved a different grant since; it wins.
  unsaved.delete(key)
  return stored
}

/**
 * The login at `location`, adopting a renewal written ahead of the store, and
 * preferring a renewal this process could not save over a store that still
 * holds the refresh token that renewal spent.
 */
export async function readLogin(io: Io, location: LoginLocation): Promise<Credential | null> {
  const store = await storeOf(io, location)
  let stored: Credential | null
  try {
    stored = await readStored(io, store)
  } catch (error) {
    const entry = unsaved.get(store.key)
    if (!entry) throw error
    io.log(`the credential store is unreadable (${message(error)}); using the renewed login kept in memory`)
    return entry.fresh
  }

  return preferUnsaved(store.key, stored)
}

async function writePending(io: Io, store: Store, fresh: Credential): Promise<string> {
  const document = JSON.stringify({ claudeAiOauth: { accessToken: fresh.claudeAiOauth.accessToken, refreshToken: fresh.claudeAiOauth.refreshToken, expiresAt: fresh.claudeAiOauth.expiresAt } })
  if (store.kind === 'file') {
    await nativeFile(io, store, 'pending', document)
    return store.pendingPath
  }
  if (store.pendingPath === undefined) throw new Error('the login has no folder to keep a pending copy in')
  const ran = await io.run(['/bin/sh', '-c', PENDING_SH, store.pendingPath], trustedRun(store.cwd, { stdin: document, timeoutMs: 15_000 }))
  if (ran.exitCode !== 0) throw new Error(`the pending copy could not be written (exit ${ran.exitCode})`)
  return store.pendingPath
}

/** Save `fresh` when the store still holds `expected`; adopt another writer's different grant instead of overwriting it. */
async function saveToStore(io: Io, store: Store, fresh: Credential, expected: string): Promise<{ saved: Credential; adopted: boolean }> {
  if (store.kind === 'file') {
    try {
      const saved = await nativeFile(io, store, 'write', JSON.stringify({
        expectedRefreshToken: expected,
        oauth: {
          accessToken: fresh.claudeAiOauth.accessToken,
          refreshToken: fresh.claudeAiOauth.refreshToken,
          expiresAt: fresh.claudeAiOauth.expiresAt,
        },
      }))
      if (saved === null) throw new Error('The native credential file disappeared during renewal. Run account setup again.')
      return { saved, adopted: false }
    } catch (error) {
      if (!(error instanceof LoginChangedError)) throw error
      const current = await nativeFile(io, store, 'read')
      if (current === null) throw new Error('The native credential file disappeared during renewal. Run account setup again.')
      return { saved: current, adopted: current.claudeAiOauth.refreshToken !== fresh.claudeAiOauth.refreshToken }
    }
  }
  // The keychain has no compare-and-swap: read the item again immediately before writing.
  const text = await readItem(io, store.service, store.account)
  const stored = text === null ? null : credential(text)
  if (stored === null) throw new Error(`The keychain login "${store.service}" disappeared during renewal. Run account setup again.`)
  if (stored.claudeAiOauth.refreshToken === fresh.claudeAiOauth.refreshToken) return { saved: stored, adopted: false }
  if (stored.claudeAiOauth.refreshToken !== expected) return { saved: stored, adopted: true }

  return { saved: await writeKeychain(io, store, merged(stored, fresh.claudeAiOauth)), adopted: false }
}

/**
 * Persist a rotated grant without replacing unrelated native credential
 * fields. The server already spent the previous refresh token, so the fresh
 * login is kept in memory and written ahead to an owner-only pending file
 * before the store write; a failed store write throws `LoginNotSavedError`
 * naming where it was kept, and the next read saves it.
 */
export async function writeLogin(io: Io, location: LoginLocation, fresh: Credential, previous: Credential): Promise<Credential> {
  const store = await storeOf(io, location)
  const earlier = unsaved.get(store.key)
  // Renewing an unsaved login: the store still holds the token spent before it.
  const expected = earlier && earlier.fresh.claudeAiOauth.refreshToken === previous.claudeAiOauth.refreshToken ? earlier.spent : previous.claudeAiOauth.refreshToken
  unsaved.set(store.key, { fresh, spent: expected })
  let kept: string | undefined
  try {
    kept = await writePending(io, store, fresh)
  } catch (error) {
    io.log(`could not keep the renewed login in a pending file: ${message(error)}`)
  }
  try {
    const { saved, adopted } = await saveToStore(io, store, fresh, expected)
    unsaved.delete(store.key)
    if (adopted) io.log('another session saved a different login while this one renewed; kept that login')
    if (store.kind === 'keychain' && kept !== undefined) await removeFiles(io, store.cwd, [kept])
    return saved
  } catch (error) {
    const where = kept === undefined ? 'in this session\'s memory only' : `in ${kept} (owner-only) and in this session's memory`
    throw new LoginNotSavedError(`${message(error).replace(/\.?$/, '.')} The renewed login was kept ${where}; it is saved automatically the next time this account is used.`)
  }
}

/** Whether this process holds a renewal for `location` that is not saved yet. */
export async function hasUnsavedLogin(io: Io, location: LoginLocation): Promise<boolean> {
  if (unsaved.size === 0) return false
  return unsaved.has((await storeOf(io, location)).key)
}

/**
 * Try again to save a renewal this process holds for `location`. Resolves the
 * login to use: the saved one, another writer's newer one, or the unsaved
 * fresh one when the store still refuses (logged, not thrown: the fresh login
 * works). Null when there is none, or the store no longer has a login.
 */
export async function saveUnsavedLogin(io: Io, location: LoginLocation): Promise<Credential | null> {
  const store = await storeOf(io, location)
  const entry = unsaved.get(store.key)
  if (!entry) return null
  let stored: Credential | null
  try {
    stored = await readStored(io, store)
  } catch (error) {
    io.log(`the renewed login is still unsaved: ${message(error)}`)
    return entry.fresh
  }
  if (stored === null) return null
  if (stored.claudeAiOauth.refreshToken !== entry.spent) {
    unsaved.delete(store.key)
    return stored
  }
  try {
    const { saved } = await saveToStore(io, store, entry.fresh, entry.spent)
    unsaved.delete(store.key)
    if (store.kind === 'keychain' && store.pendingPath !== undefined) await removeFiles(io, store.cwd, [store.pendingPath])
    return saved
  } catch (error) {
    io.log(`the renewed login is still unsaved: ${message(error)}`)
    return entry.fresh
  }
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
    fitCredential(merged(current, { accessToken: grown(oauth.accessToken), refreshToken: grown(oauth.refreshToken), expiresAt: Number.MAX_SAFE_INTEGER }), store.service, store.writeAccount)
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
