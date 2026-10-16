import type { SecretRef } from './config'
import type { Io } from './io'
import { keychainAccountName, liveServiceName, parseCredential, readItem, writeItem } from './keychain'
import type { Credential, StorageVariables } from './keychain'

export type HostPlatform = 'darwin' | 'linux'
export type LoginLocation = { storage: StorageVariables; defaultConfigDir: string; user?: string }

const platforms = new WeakMap<Io, Promise<HostPlatform>>()

/** Detect the execution host, including Linux inside WSL, once per Io instance. */
export function hostPlatform(io: Io): Promise<HostPlatform> {
  const known = platforms.get(io)
  if (known) return known
  const pending = (async (): Promise<HostPlatform> => {
    const result = await io.run(['/usr/bin/uname', '-s'], { timeoutMs: 10_000 })
      .catch(() => { throw new Error('Cannot detect the host OS: /usr/bin/uname -s must be available.') })
    if (result.exitCode !== 0) throw new Error('Cannot detect the host OS: /usr/bin/uname -s failed.')
    if (result.stdout.trim() === 'Darwin') return 'darwin'
    if (result.stdout.trim() === 'Linux') return 'linux'
    throw new Error('Account storage supports macOS and Linux (including WSL).')
  })()
  platforms.set(io, pending)
  return pending
}

/** Native Linux secure storage is independent of CLAUDE_CONFIG_DIR when overridden. */
export function nativeCredentialPath(location: LoginLocation, home: string | undefined): string {
  const { secureStorageDir, configDir } = location.storage
  const folder = secureStorageDir === ''
    ? home ? `${home}/.claude` : undefined
    : secureStorageDir ?? configDir ?? location.defaultConfigDir
  if (!folder || !folder.startsWith('/') || folder.includes('\0')) throw new Error('The native credential directory must be an absolute path; HOME is required for an empty secure-storage override.')

  return `${folder.normalize('NFC').replace(/\/+$/, '')}/.credentials.json`
}

/**
 * Node 22+ supplies the no-follow, file mode and atomic rename primitives the
 * mod file API does not expose. Paths and static code are argv; secrets use
 * stdin/stdout only. Exit 43 means a valid document without OAuth; exit 44
 * means only ENOENT, never an unreadable store.
 */
const NATIVE_FILE = String.raw`
const fs = require('node:fs');
const crypto = require('node:crypto');
const [operation, path] = process.argv.slice(1);
const flags = fs.constants;
const limit = 1024 * 1024;
let temporary;
function fail(code) { process.exitCode = code; throw new Error('credential-operation-refused'); }
function read() {
  let fd;
  try {
    fd = fs.openSync(path, flags.O_RDONLY | flags.O_NOFOLLOW | flags.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) fail(46);
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > limit) fail(46);
    const value = JSON.parse(bytes.toString('utf8', 0, size));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(46);
    const oauth = value?.claudeAiOauth;
    if (oauth === undefined || oauth === null) fail(43);
    if (typeof oauth?.accessToken !== 'string' || typeof oauth.refreshToken !== 'string' || !Number.isFinite(oauth.expiresAt)) fail(46);
    return value;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
try {
  if (Number(process.versions.node.split('.')[0]) < 22) fail(50);
  if (!path?.startsWith('/') || path.includes('\0')) fail(46);
  let document = read();
  if (operation === 'write') {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (document.claudeAiOauth.refreshToken !== input.expectedRefreshToken) fail(47);
    const oauth = input.oauth;
    if (typeof oauth?.accessToken !== 'string' || typeof oauth.refreshToken !== 'string' || !Number.isFinite(oauth.expiresAt)) fail(46);
    document = { ...document, claudeAiOauth: { ...document.claudeAiOauth, accessToken: oauth.accessToken, refreshToken: oauth.refreshToken, expiresAt: oauth.expiresAt } };
    const encoded = JSON.stringify(document);
    if (Buffer.byteLength(encoded) > limit) fail(46);
    temporary = path + '.rice-' + process.pid + '-' + crypto.randomUUID();
    const fd = fs.openSync(temporary, flags.O_WRONLY | flags.O_CREAT | flags.O_EXCL | flags.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, encoded, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, path);
    temporary = undefined;
  } else if (operation !== 'read') fail(46);
  process.stdout.write(JSON.stringify(document));
} catch (error) {
  if (!process.exitCode) process.exitCode = error?.code === 'ENOENT' ? 44 : error?.code === 'ELOOP' ? 45 : 46;
} finally {
  if (temporary) { try { fs.unlinkSync(temporary); } catch {} }
}
`

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

async function nativeFile(io: Io, operation: 'read' | 'write', path: string, stdin?: string): Promise<Credential | null> {
  const result = await io.run(['node', '-e', NATIVE_FILE, operation, path], { stdin, timeoutMs: 15_000 })
    .catch(() => { throw new Error('Linux account storage requires Node.js 22 or later on PATH. Install it, then run account setup again.') })
  if ((result.exitCode === 43 || result.exitCode === 44) && operation === 'read') return null
  if (result.exitCode === 50) throw new Error('Linux account storage requires Node.js 22 or later on PATH.')
  if (result.exitCode === 45) throw new Error('Refused a symbolic link at the native credential file. Run account setup with its own login directory.')
  if (result.exitCode === 47) throw new Error('The login changed while it was renewed. Retry the account switch to read the newer login.')
  if (result.exitCode !== 0 || result.isStdoutTruncated) throw new Error(`Cannot ${operation} the native Claude credential file. Check its permissions and run account setup again.`)

  return credential(result.stdout)
}

export async function readLogin(io: Io, location: LoginLocation): Promise<Credential | null> {
  if (await hostPlatform(io) === 'darwin') {
    const service = await liveServiceName(location.storage, location.defaultConfigDir)
    const text = await readItem(io, service, keychainAccountName(location.user))
    return text === null ? null : credential(text)
  }

  return nativeFile(io, 'read', nativeCredentialPath(location, await io.env('HOME')))
}

/** Persist a rotated grant without replacing unrelated native credential fields. */
export async function writeLogin(io: Io, location: LoginLocation, fresh: Credential, previous: Credential): Promise<Credential> {
  if (await hostPlatform(io) === 'darwin') {
    const service = await liveServiceName(location.storage, location.defaultConfigDir)
    await writeItem(io, service, keychainAccountName(location.user), JSON.stringify(fresh))
    return fresh
  }
  const saved = await nativeFile(io, 'write', nativeCredentialPath(location, await io.env('HOME')), JSON.stringify({
    expectedRefreshToken: previous.claudeAiOauth.refreshToken,
    oauth: {
      accessToken: fresh.claudeAiOauth.accessToken,
      refreshToken: fresh.claudeAiOauth.refreshToken,
      expiresAt: fresh.claudeAiOauth.expiresAt,
    },
  }))
  if (saved === null) throw new Error('The native credential file disappeared during renewal. Run account setup again.')
  return saved
}

/** Named keys and tokens use the OS keyring, separate from native OAuth files. */
export async function readSecret(io: Io, reference: SecretRef): Promise<string | null> {
  if (await hostPlatform(io) === 'darwin') return readItem(io, reference.service, reference.account)
  const result = await io.run(['secret-tool', 'lookup', 'service', reference.service, 'account', reference.account], { timeoutMs: 15_000 })
    .catch(() => { throw new Error('Named account secrets on Linux require secret-tool (libsecret) and an unlocked Secret Service keyring. Install or enable them, then run account setup again.') })
  if (result.exitCode === 1 && result.stderr.trim() === '') return null
  if (result.exitCode !== 0 || result.isStdoutTruncated) throw new Error('Cannot read the Linux account keyring. Check that secret-tool (libsecret) and an unlocked Secret Service keyring are available, then run account setup again.')
  return result.stdout.replace(/\n$/, '')
}
