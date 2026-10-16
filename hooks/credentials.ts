import type { SecretRef } from './config'
import type { Io } from './io'
import { keychainAccountName, liveServiceName, parseCredential, readItem, writeItem } from './keychain'
import type { Credential, StorageVariables } from './keychain'
import { WINDOWS_CREDENTIAL_STORE } from '../scripts/windows-store-payloads.mjs'

export type HostPlatform = 'darwin' | 'linux' | 'win32'
export type LoginLocation = { storage: StorageVariables; defaultConfigDir: string; user?: string }

const platforms = new WeakMap<Io, Promise<HostPlatform>>()

/** Detect the execution host, including Linux inside WSL, once per Io instance. */
export function hostPlatform(io: Io): Promise<HostPlatform> {
  const known = platforms.get(io)
  if (known) return known
  const pending = (async (): Promise<HostPlatform> => {
    if (await io.env('OS') === 'Windows_NT') return 'win32'
    // Alpine and unmerged-/usr systems ship /bin/uname only; NixOS has neither path.
    let system: string | undefined
    for (const command of ['/usr/bin/uname', '/bin/uname', 'uname']) {
      const result = await io.run([command, '-s'], { timeoutMs: 10_000 }).catch(() => undefined)
      if (result?.exitCode === 0) { system = result.stdout.trim(); break }
    }
    if (system === undefined) throw new Error('Cannot detect the host OS: uname -s must be available.')
    if (system === 'Darwin') return 'darwin'
    if (system === 'Linux') return 'linux'
    throw new Error('Account storage supports macOS, Linux (including WSL) and native Windows.')
  })()
  platforms.set(io, pending)
  return pending
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
 * Node 22+ supplies the no-follow, file mode and atomic rename primitives the
 * mod file API does not expose. Paths and static code are argv; secrets use
 * stdin/stdout only. Exit 43 means a valid document without OAuth; exit 44
 * means only ENOENT, never an unreadable store.
 */
const NATIVE_FILE = String.raw`
const fs = require('node:fs');
const crypto = require('node:crypto');
const paths = require('node:path');
const [operation, path] = process.argv.slice(1);
const flags = fs.constants;
const limit = 1024 * 1024;
let temporary;
function fail(code) { process.exitCode = code; throw new Error('credential-operation-refused'); }
function read() {
  let fd;
  try {
    const link = fs.lstatSync(path, { bigint: true });
    if (link.isSymbolicLink()) fail(45);
    if (!link.isFile() || link.size > limit) fail(46);
    fd = fs.openSync(path, flags.O_RDONLY | (flags.O_NOFOLLOW ?? 0) | (flags.O_NONBLOCK ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) fail(46);
    const identity = fs.fstatSync(fd, { bigint: true });
    if (identity.ino !== link.ino || identity.dev !== link.dev) fail(45);
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
  if (!path || !paths.isAbsolute(path) || /[\0\r\n]/.test(path) || process.platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(path)) fail(46);
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
    const fd = fs.openSync(temporary, flags.O_WRONLY | flags.O_CREAT | flags.O_EXCL | (flags.O_NOFOLLOW ?? 0), 0o600);
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
    .catch(() => { throw new Error('Native file account storage requires Node.js 22 or later on PATH. Install it, then run account setup again.') })
  if ((result.exitCode === 43 || result.exitCode === 44) && operation === 'read') return null
  if (result.exitCode === 50) throw new Error('Native file account storage requires Node.js 22 or later on PATH.')
  if (result.exitCode === 45) throw new Error('Refused a symbolic link at the native credential file. Run account setup with its own login directory.')
  if (result.exitCode === 47) throw new Error('The login changed while it was renewed. Retry the account switch to read the newer login.')
  if (result.exitCode !== 0 || result.isStdoutTruncated) throw new Error(`Cannot ${operation} the native Claude credential file. Check its permissions and run account setup again.`)

  return credential(result.stdout)
}

async function fileStoreAvailable(io: Io, platform: HostPlatform): Promise<void> {
  if (platform !== 'win32') return
  const forced = await io.env('FORCE_WINDOWS_CREDMAN')
  if (forced && !/^(?:0|false|no|off)$/i.test(forced)) throw new Error('The optional FORCE_WINDOWS_CREDMAN native browser store is not supported by Rice Accounts. Start this session without that override, or use a claudeai-token account in Windows Credential Manager.')
}

export async function readLogin(io: Io, location: LoginLocation): Promise<Credential | null> {
  const platform = await hostPlatform(io)
  if (platform === 'darwin') {
    const service = await liveServiceName(location.storage, location.defaultConfigDir)
    const text = await readItem(io, service, keychainAccountName(location.user))
    return text === null ? null : credential(text)
  }

  await fileStoreAvailable(io, platform)
  const home = platform === 'win32' ? await io.env('USERPROFILE') ?? await io.env('HOME') : await io.env('HOME')
  return nativeFile(io, 'read', nativeCredentialPath(location, home, platform))
}

/** Persist a rotated grant without replacing unrelated native credential fields. */
export async function writeLogin(io: Io, location: LoginLocation, fresh: Credential, previous: Credential): Promise<Credential> {
  const platform = await hostPlatform(io)
  if (platform === 'darwin') {
    const service = await liveServiceName(location.storage, location.defaultConfigDir)
    await writeItem(io, service, keychainAccountName(location.user), JSON.stringify(fresh))
    return fresh
  }
  await fileStoreAvailable(io, platform)
  const home = platform === 'win32' ? await io.env('USERPROFILE') ?? await io.env('HOME') : await io.env('HOME')
  const saved = await nativeFile(io, 'write', nativeCredentialPath(location, home, platform), JSON.stringify({
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
  const platform = await hostPlatform(io)
  if (platform === 'darwin') return readItem(io, reference.service, reference.account)
  if (platform === 'win32') {
    const root = await io.env('SystemRoot') ?? await io.env('WINDIR')
    const command = root ? `${root.replace(/[\\/]+$/, '')}/System32/WindowsPowerShell/v1.0/powershell.exe` : 'powershell.exe'
    const result = await io.run([command, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_CREDENTIAL_STORE], { stdin: JSON.stringify({ operation: 'read', service: reference.service, account: reference.account }), timeoutMs: 15_000 })
      .catch(() => { throw new Error('Windows account secrets require Windows PowerShell and an interactive Windows sign-in with Credential Manager available.') })
    if (result.exitCode === 44) return null
    if (result.exitCode !== 0 || result.isStdoutTruncated) throw new Error('Cannot read Windows Credential Manager. Sign into an interactive Windows session and run account setup again.')
    return result.stdout
  }
  const result = await io.run(['secret-tool', 'lookup', 'service', reference.service, 'account', reference.account], { timeoutMs: 15_000 })
    .catch(() => { throw new Error('Named account secrets on Linux require secret-tool (libsecret) and an unlocked Secret Service keyring. Install or enable them, then run account setup again.') })
  if (result.exitCode === 1 && result.stderr.trim() === '') return null
  if (result.exitCode !== 0 || result.isStdoutTruncated) throw new Error('Cannot read the Linux account keyring. Check that secret-tool (libsecret) and an unlocked Secret Service keyring are available, then run account setup again.')
  return result.stdout.replace(/\n$/, '')
}
