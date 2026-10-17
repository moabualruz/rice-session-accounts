// Native Windows, synthetic stores only. Node22.23+ can load setup.ts directly.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { WINDOWS_CREDENTIAL_STORE, WINDOWS_EXIT, WINDOWS_PRIVATE_DIRECTORY } from './windows-store-payloads.mjs'

assert.equal(process.platform, 'win32', 'this proof requires actual Windows')
const root = fileURLToPath(new URL('../', import.meta.url))
const { legacyCleanupText, setupCommand, signOutHint } = await import(pathToFileURL(process.argv[2] ?? join(root, 'hooks/setup.ts')).href)
/** Every file the terminal helper loads; the copied plugin folder must hold all of them. */
const HELPER_FILES = ['account-setup.mjs', 'account-setup-main.mjs', 'account-names.mjs', 'claude-command.mjs', 'shell-quote.mjs', 'windows-store-payloads.mjs']
const nativeFile = /const NATIVE_FILE = String\.raw`([\s\S]*?)`\n/.exec(readFileSync(join(root, 'hooks/credentials.ts'), 'utf8'))?.[1]
assert(nativeFile)
new vm.Script(nativeFile)
const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
const fixture = mkdtempSync(join(tmpdir(), 'rice accounts 名 storage '))
const reference = { service: `Rice.Accounts.Test.${randomUUID()}`, account: 'fixture-名' }
const secret = `not-a-real-token-${randomUUID()}-名`
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const ps = (script, input, extra = {}) => spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { input: JSON.stringify(input), env: { ...process.env, ...extra }, encoding: 'utf8', timeout: 30000, windowsHide: true })
const credential = operation => ps(WINDOWS_CREDENTIAL_STORE, { ...reference, operation, ...(operation === 'write' ? { secret } : {}) })
const ACL_PROBE = "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);$v=[Console]::In.ReadToEnd()|ConvertFrom-Json;$a=[System.IO.Directory]::GetAccessControl($v.path,[System.Security.AccessControl.AccessControlSections]'Access,Owner');$s=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;[pscustomobject]@{owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $s;protected=$a.AreAccessRulesProtected;onlySelf=@($a.Access|Where-Object{$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $s}).Count -eq 0}|ConvertTo-Json -Compress"
const COMMAND_WRAPPER = '$ErrorActionPreference="Continue";Invoke-Expression $env:RICE_ACCOUNT_SETUP_COMMAND;exit $LASTEXITCODE'
let wroteCredential = false, failed = false
emit({ phase: 'windows-storage-supervisor', pid: process.pid, fixture, ownedCredentialReference: reference })
try {
  for (const source of [WINDOWS_PRIVATE_DIRECTORY, WINDOWS_CREDENTIAL_STORE, ACL_PROBE, COMMAND_WRAPPER]) {
    const compiled = ps('[void][ScriptBlock]::Create($env:RICE_ACCOUNT_PARSE_SOURCE)', {}, { RICE_ACCOUNT_PARSE_SOURCE: source })
    assert.equal(compiled.status, 0, 'native PowerShell parses the complete source before execution')
  }
  const loginDir = join(fixture, 'private 名 login')
  const prepared = ps(WINDOWS_PRIVATE_DIRECTORY, { path: loginDir })
  emit({ phase: 'private-windows-login-directory', exitCode: prepared.status })
  assert.equal(prepared.status, 0)
  const acl = ps(ACL_PROBE, { path: loginDir })
  const permissions = JSON.parse(acl.stdout)
  assert.equal(acl.status, 0)
  assert(permissions.owner && permissions.protected && permissions.onlySelf, 'the login folder is protected and owned by this user')
  emit({ phase: 'private-login-acl', ...permissions })
  // A folder that already exists with inherited, shared rules is repaired, not refused.
  const configRoot = join(fixture, 'config root')
  const unprotected = join(configRoot, 'rice-session-accounts', 'logins', 'pre-existing')
  mkdirSync(unprotected, { recursive: true })
  writeFileSync(join(unprotected, 'sentinel'), 'kept\n')
  const before = JSON.parse(ps(ACL_PROBE, { path: unprotected }).stdout)
  assert.equal(before.protected, false, 'the fixture starts with inherited rules')
  const repaired = ps(WINDOWS_PRIVATE_DIRECTORY, { path: unprotected, root: configRoot })
  assert.equal(repaired.status, 0, repaired.stderr)
  const after = JSON.parse(ps(ACL_PROBE, { path: unprotected }).stdout)
  assert(after.owner && after.protected && after.onlySelf, 'the pre-existing login folder is repaired to owner-only rules')
  assert.equal(readFileSync(join(unprotected, 'sentinel'), 'utf8'), 'kept\n')
  emit({ phase: 'private-login-repair', before: before.protected, ...after })
  // An 8.3 short spelling of the folder (when the volume generates one) is expanded before access rules are checked.
  const shortName = spawnSync(join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/d', '/s', '/c', `"chcp 65001>nul & for %I in ("${configRoot}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true, timeout: 15000 })
  const shortRoot = shortName.stdout.trim()
  if (shortName.status === 0 && shortRoot && shortRoot !== configRoot && existsSync(shortRoot)) {
    const viaShort = ps(WINDOWS_PRIVATE_DIRECTORY, { path: join(shortRoot, 'rice-session-accounts', 'logins', 'short-name'), root: shortRoot })
    assert.equal(viaShort.status, 0, viaShort.stderr)
    const shortAcl = JSON.parse(ps(ACL_PROBE, { path: join(configRoot, 'rice-session-accounts', 'logins', 'short-name') }).stdout)
    assert(shortAcl.owner && shortAcl.protected && shortAcl.onlySelf)
    emit({ phase: 'private-login-short-name', expanded: true })
  } else emit({ phase: 'private-login-short-name', skipped: 'this volume generated no 8.3 name' })
  // Distinct causes: a path too long for Windows PowerShell 5.1, a missing drive, and ConstrainedLanguage mode.
  const tooLong = ps(WINDOWS_PRIVATE_DIRECTORY, { path: join(fixture, 'x'.repeat(250)) })
  assert.equal(tooLong.status, WINDOWS_EXIT.PATH_TOO_LONG, tooLong.stderr)
  const missingDrive = 'ZYXWVUTSRQPONMLKJIHGFED'.split('').find(letter => !existsSync(`${letter}:\\`))
  if (missingDrive) assert.equal(ps(WINDOWS_PRIVATE_DIRECTORY, { path: `${missingDrive}:\\rice-accounts-missing\\login` }).status, WINDOWS_EXIT.NOT_FOUND)
  for (const payload of [WINDOWS_PRIVATE_DIRECTORY, WINDOWS_CREDENTIAL_STORE]) {
    const constrained = ps(`$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\n${payload}`, { path: join(fixture, 'constrained'), operation: 'read', ...reference })
    assert.equal(constrained.status, WINDOWS_EXIT.CONSTRAINED_LANGUAGE, constrained.stderr)
  }
  assert.equal(existsSync(join(fixture, 'constrained')), false)
  emit({ phase: 'windows-distinct-failures', pathTooLong: true, missingDrive: Boolean(missingDrive), constrainedLanguage: true })
  const file = join(loginDir, '.credentials.json')
  const document = { unrelated: { keep: 'fixture-名' }, claudeAiOauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: 100000, extra: 'preserved' } }
  writeFileSync(file, JSON.stringify(document))
  const runFile = (operation, input, path = file) => spawnSync(process.execPath, ['-e', nativeFile, operation, path], { input: input ? JSON.stringify(input) : undefined, encoding: 'utf8', timeout: 15000 })
  const loaded = runFile('read')
  assert.equal(loaded.status, 0)
  assert(JSON.stringify(JSON.parse(loaded.stdout)) === JSON.stringify(document), 'the exact native fixture document is read')
  const oauth = { accessToken: 'fixture-fresh-access', refreshToken: 'fixture-fresh-refresh', expiresAt: 200000 }
  const rotated = runFile('write', { expectedRefreshToken: 'fixture-refresh', oauth })
  assert.equal(rotated.status, 0)
  const expected = { ...document, claudeAiOauth: { ...document.claudeAiOauth, ...oauth } }
  assert(JSON.stringify(JSON.parse(readFileSync(file, 'utf8'))) === JSON.stringify(expected), 'rotation preserves all unrelated native fields')
  assert.equal(runFile('write', { expectedRefreshToken: 'fixture-refresh', oauth }).status, 47, 'a stale renewal is refused')
  emit({ phase: 'native-windows-file', read: true, rotated: true, unrelatedFieldsPreserved: true, staleRefreshRefused: true })
  const target = join(fixture, 'unrelated junction target'), junction = join(fixture, 'reparse credentials')
  mkdirSync(target)
  writeFileSync(join(target, 'sentinel'), 'unchanged fixture\n')
  symlinkSync(target, junction, 'junction')
  assert.equal(runFile('read', undefined, junction).status, 45)
  assert.equal(ps(WINDOWS_PRIVATE_DIRECTORY, { path: junction }).status, 46)
  assert.equal(readFileSync(join(target, 'sentinel'), 'utf8'), 'unchanged fixture\n')
  emit({ phase: 'windows-reparse-refusal', credentialReadRefused: true, loginPrepareRefused: true, targetPreserved: true })
  assert.equal(credential('read').status, 44, 'the unique synthetic credential is initially absent')
  const stored = credential('write')
  wroteCredential = stored.status === 0
  emit({ phase: 'windows-credential-manager-write', exitCode: stored.status, stdoutEmpty: stored.stdout === '' })
  assert.equal(stored.status, 0)
  const recalled = credential('read')
  assert.equal(recalled.status, 0)
  assert(recalled.stdout === secret, 'Credential Manager returns the exact in-memory Unicode fixture')
  emit({ phase: 'windows-credential-manager-read', exactMatch: true, secretInArguments: false, secretInFiles: false })
  // U+2019 is a single quote to PowerShell too, so the printed command must double it.
  const plugin = join(fixture, "plugin's ’ 名 folder")
  mkdirSync(join(plugin, 'scripts'), { recursive: true })
  for (const name of HELPER_FILES) cpSync(join(root, 'scripts', name), join(plugin, 'scripts', name))
  const config = join(fixture, "config's ‘ 名 folder")
  const copiedCommand = setupCommand(plugin, `${config}\\`, 'fixture-account', 'win32')
  for (const source of [copiedCommand, signOutHint(join(config, 'rice-session-accounts', 'logins', 'fixture-account'), 'win32'), legacyCleanupText(config, 'win32').split('\n').at(-1).replace(/^In PowerShell: /, '')]) {
    assert.equal(ps('[void][ScriptBlock]::Create($env:RICE_ACCOUNT_PARSE_SOURCE)', {}, { RICE_ACCOUNT_PARSE_SOURCE: source }).status, 0, source)
  }
  const copied = ps(COMMAND_WRAPPER, {}, { RICE_ACCOUNT_SETUP_COMMAND: copiedCommand })
  assert.equal(copied.status, 1)
  assert.match(copied.stderr, /First run \/rice-account add/)
  assert(copied.stderr.includes(config), 'the helper received the config folder with its quotes intact')
  assert.equal(existsSync(config), false, 'a missing account command does not create config or credential folders')
  emit({ phase: 'copied-powershell-command', helperReached: true, spacesApostrophesUnicodeQuotesPreserved: true, missingAccountNoWrites: true })
  emit({ windowsAccountStorage: 'pass' })
} catch (error) {
  failed = true
  emit({ phase: 'windows-storage-proof-failure', errorName: error.name, message: error.message })
  throw error
} finally {
  const deleted = credential('delete')
  const absent = credential('read')
  emit({ phase: 'owned-credential-cleanup', wroteCredential, deleted: deleted.status === 0, absent: absent.status === 44 })
  rmSync(fixture, { recursive: true, force: true })
  if (!failed) {
    assert.equal(deleted.status, 0, 'the uniquely owned synthetic credential is deleted')
    assert.equal(absent.status, 44)
  }
}
