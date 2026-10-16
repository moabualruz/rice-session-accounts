// Native Windows, synthetic stores only. Node22.23+ can load setup.ts directly.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { WINDOWS_CREDENTIAL_STORE, WINDOWS_PRIVATE_DIRECTORY } from './windows-store-payloads.mjs'

assert.equal(process.platform, 'win32', 'this proof requires actual Windows')
const root = fileURLToPath(new URL('../', import.meta.url))
const { setupCommand } = await import(pathToFileURL(process.argv[2] ?? join(root, 'hooks/setup.ts')).href)
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
  const plugin = join(fixture, "plugin's 名 folder")
  mkdirSync(join(plugin, 'scripts'), { recursive: true })
  for (const name of ['account-setup.mjs', 'windows-store-payloads.mjs']) cpSync(join(root, 'scripts', name), join(plugin, 'scripts', name))
  const config = join(fixture, "config's 名 folder")
  const copiedCommand = setupCommand(plugin, config, 'fixture-account', 'win32')
  assert.equal(ps('[void][ScriptBlock]::Create($env:RICE_ACCOUNT_PARSE_SOURCE)', {}, { RICE_ACCOUNT_PARSE_SOURCE: copiedCommand }).status, 0)
  const copied = ps(COMMAND_WRAPPER, {}, { RICE_ACCOUNT_SETUP_COMMAND: copiedCommand })
  assert.equal(copied.status, 1)
  assert.match(copied.stderr, /First run \/rice-account add/)
  assert.equal(existsSync(config), false, 'a missing account command does not create config or credential folders')
  emit({ phase: 'copied-powershell-command', helperReached: true, spacesApostrophesUnicodePreserved: true, missingAccountNoWrites: true })
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
