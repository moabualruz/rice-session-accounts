// CI-only macOS keychain proof: writeLogin/readLogin through the real `security` CLI.
// It runs ONLY on a darwin GitHub Actions runner with RICE_ACCOUNTS_PROOF_KEYCHAIN=1.
// Anywhere else it prints "skipped" and exits 0 before touching any keychain.
// On the runner it creates a temporary keychain, makes it the default and first
// in the user search list, proves the round trip with synthetic fixture
// credentials (a near-limit login, a reduced login and a refused over-limit
// login), and always restores the default keychain and search list and deletes
// the temporary keychain. No real credential is read or printed.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, promises as fsp, readFileSync, rmSync, statSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RICE_ACCOUNTS_PROOF_KEYCHAIN !== '1' || process.platform !== 'darwin') {
  console.log('skipped: the macOS keychain proof runs only on a darwin GitHub Actions runner with RICE_ACCOUNTS_PROOF_KEYCHAIN=1')
  process.exit(0)
}

// The hooks are TypeScript with extensionless relative imports: strip types
// (Node 22.6+; a flag before 22.18) and resolve `./name` to `./name.ts`.
if (!process.features?.typescript) {
  if (process.env.RICE_ACCOUNTS_PROOF_STRIPPED === '1') throw new Error('this Node cannot strip TypeScript types; use Node 22.6 or later')
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)], { stdio: 'inherit', env: { ...process.env, RICE_ACCOUNTS_PROOF_STRIPPED: '1' } })
  process.exit(child.status ?? 1)
}
register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try { return await next(specifier, context) } catch (error) {
    if (/^\\.{1,2}\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier)) return next(specifier + '.ts', context)
    throw error
  }
}`)}`)

const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const SECURITY = '/usr/bin/security'
const security = (...args) => spawnSync(SECURITY, args, { encoding: 'utf8', timeout: 30_000 })
const quoted = text => text.split('\n').map(line => line.trim().replace(/^"|"$/g, '')).filter(Boolean)

/** The Io the hooks expect, over child_process and fs, with the host's run semantics (reject on spawn failure or timeout). */
function machineIo() {
  return {
    run: async (argv, init = {}) => {
      const timeout = init.timeoutMs ?? 30_000
      const ran = spawnSync(argv[0], argv.slice(1), { cwd: init.cwd, env: { ...process.env, ...init.env }, input: init.stdin ?? '', encoding: 'utf8', timeout })
      if (ran.error?.code === 'ETIMEDOUT') throw new Error(`aborted: still running after ${timeout}ms`)
      if (ran.error) throw ran.error
      return { exitCode: ran.status ?? 1, stdout: ran.stdout, stderr: ran.stderr, isStdoutTruncated: false, isStderrTruncated: false }
    },
    read: path => fsp.readFile(path, 'utf8'),
    write: (path, text) => fsp.writeFile(path, text, { mode: 0o600 }),
    exists: path => fsp.access(path).then(() => true, () => false),
    stat: async path => {
      const link = await fsp.lstat(path)
      const target = link.isSymbolicLink() ? await fsp.stat(path).catch(() => link) : link
      return { kind: target.isFile() ? 'file' : target.isDirectory() ? 'dir' : 'other', size: target.size, mtimeMs: target.mtimeMs, isLink: link.isSymbolicLink() }
    },
    env: async name => process.env[name],
    now: async () => Date.now(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    fetch: async () => { throw new Error('the keychain proof makes no network requests') },
    // Hooks log only non-secret text by contract.
    log: text => emit({ phase: 'hook-log', text }),
  }
}

const folder = mkdtempSync(join(tmpdir(), 'rice-keychain-proof-'))
const keychain = join(folder, 'rice-accounts-proof.keychain-db')
// A disposable password for a throwaway keychain on an ephemeral runner; it protects no real secret.
const keychainPassword = randomBytes(24).toString('hex')
const originalDefault = quoted(security('default-keychain', '-d', 'user').stdout)[0]
const originalList = quoted(security('list-keychains', '-d', 'user').stdout)
emit({ phase: 'keychain-proof-start', keychain, originalDefault: originalDefault ?? null, originalSearchList: originalList })
let failed = false
try {
  assert.equal(security('create-keychain', '-p', keychainPassword, keychain).status, 0, 'create the temporary keychain')
  assert.equal(security('set-keychain-settings', keychain).status, 0, 'no auto-lock for the temporary keychain')
  assert.equal(security('unlock-keychain', '-p', keychainPassword, keychain).status, 0, 'unlock the temporary keychain')
  assert.equal(security('list-keychains', '-d', 'user', '-s', keychain, ...originalList).status, 0, 'search the temporary keychain first')
  assert.equal(security('default-keychain', '-d', 'user', '-s', keychain).status, 0, 'write new items to the temporary keychain')

  const { forgetUnsavedLogins, readLogin, writeLogin } = await import('../hooks/credentials.ts')
  const { addLineLength, keychainAccountName, liveServiceName, readItem, SECURITY_LINE_LIMIT, writeItem } = await import('../hooks/keychain.ts')
  const io = machineIo()
  const loginDir = join(folder, 'login')
  mkdirSync(loginDir, { mode: 0o700 })
  const location = { storage: { configDir: loginDir, secureStorageDir: loginDir }, defaultConfigDir: join(folder, 'config'), user: process.env.USER }
  const service = await liveServiceName(location.storage, location.defaultConfigDir)
  const account = keychainAccountName(process.env.USER)
  const pending = join(loginDir, '.credentials.json.rice-pending')
  const later = Date.now() + 3_600_000
  const rotate = (credential, label, length = credential.claudeAiOauth.accessToken.length) => ({
    ...credential,
    claudeAiOauth: { ...credential.claudeAiOauth, accessToken: `fixture-${label}-access`.padEnd(length, 'a'), refreshToken: `fixture-${label}-refresh`.padEnd(length, 'r'), expiresAt: credential.claudeAiOauth.expiresAt + 60_000 },
  })
  const stored = async () => JSON.parse(await readItem(io, service, account))

  // 1. A round trip through the real security CLI.
  const seed = { claudeAiOauth: { accessToken: 'fixture-seed-access'.padEnd(108, 'a'), refreshToken: 'fixture-seed-refresh'.padEnd(108, 'r'), expiresAt: later, scopes: ['user:inference', 'user:profile'] }, keep: 'fixture-small' }
  await writeItem(io, service, account, JSON.stringify(seed))
  const first = await readLogin(io, location)
  assert.deepEqual(first, seed)
  const renewed = rotate(first, 'round-trip')
  const saved = await writeLogin(io, location, renewed, first)
  assert.equal(saved.claudeAiOauth.refreshToken, renewed.claudeAiOauth.refreshToken)
  assert.deepEqual(await readLogin(io, location), renewed)
  assert.equal(existsSync(pending), false, 'the pending copy is removed once the keychain holds the renewal')
  emit({ phase: 'round-trip', service, written: true, readBack: true, pendingRemoved: true })

  // 2. A near-limit login is stored whole: the line stays at or below the limit and nothing is cut.
  const base = { ...renewed, nearLimit: '' }
  const room = SECURITY_LINE_LIMIT - addLineLength(service, account, JSON.stringify(base))
  const near = { ...base, nearLimit: 'p'.repeat(Math.floor(room / 2) - 4) }
  const nearLength = addLineLength(service, account, JSON.stringify(near))
  assert.ok(nearLength <= SECURITY_LINE_LIMIT && nearLength > SECURITY_LINE_LIMIT - 20, `near-limit line is ${nearLength}`)
  await writeItem(io, service, account, JSON.stringify(near))
  const nearRead = await readLogin(io, location)
  assert.deepEqual(nearRead, near)
  const nearRenewed = rotate(nearRead, 'near')
  await writeLogin(io, location, nearRenewed, nearRead)
  assert.deepEqual(await stored(), nearRenewed, 'a near-limit login is stored whole, not truncated')
  emit({ phase: 'near-limit', lineLength: addLineLength(service, account, JSON.stringify(nearRenewed)), limit: SECURITY_LINE_LIMIT, storedWhole: true })

  // 3. Longer tokens push it over the limit: the optional key is left out, the OAuth login kept whole.
  const longer = rotate(nearRenewed, 'longer', nearRenewed.claudeAiOauth.accessToken.length + 120)
  const reduced = await writeLogin(io, location, longer, nearRenewed)
  const reducedItem = await stored()
  assert.deepEqual(reducedItem.claudeAiOauth, longer.claudeAiOauth)
  assert.equal('nearLimit' in reducedItem, false)
  assert.equal(reducedItem.keep, 'fixture-small')
  assert.deepEqual(reduced, reducedItem)
  emit({ phase: 'reduced-login', dropped: ['nearLimit'], oauthKeptWhole: true })

  // 4. An OAuth login too large on its own is refused: the item is unchanged and the renewal is kept in an owner-only pending file.
  const before = await readItem(io, service, account)
  const huge = rotate(reducedItem, 'huge', 3000)
  let refusal = ''
  try { await writeLogin(io, location, huge, reducedItem) } catch (error) { refusal = error.message }
  assert.match(refusal, /security -i limit/)
  assert.match(refusal, /kept in .*\.rice-pending/)
  assert.equal(await readItem(io, service, account), before, 'a refused write leaves the keychain item exactly as it was')
  assert.equal(statSync(pending).mode & 0o777, 0o600)
  assert.equal(JSON.parse(readFileSync(pending, 'utf8')).claudeAiOauth.refreshToken, huge.claudeAiOauth.refreshToken)
  forgetUnsavedLogins()
  rmSync(pending)
  emit({ phase: 'refused-over-limit', itemUnchanged: true, pendingOwnerOnly: true })

  assert.equal(security('delete-generic-password', '-s', service, '-a', account, keychain).status, 0)
  emit({ macosKeychainProof: 'pass' })
} catch (error) {
  failed = true
  emit({ phase: 'keychain-proof-failure', errorName: error?.name, message: error?.message })
  throw error
} finally {
  const restoredDefault = originalDefault ? security('default-keychain', '-d', 'user', '-s', originalDefault).status === 0 : true
  const restoredList = security('list-keychains', '-d', 'user', '-s', ...originalList).status === 0
  const deleted = !existsSync(keychain) || security('delete-keychain', keychain).status === 0
  rmSync(folder, { recursive: true, force: true })
  emit({ phase: 'keychain-proof-cleanup', restoredDefault, restoredList, deleted })
  if (!failed) assert.ok(restoredDefault && restoredList && deleted, 'the default keychain and search list are restored and the temporary keychain deleted')
}
