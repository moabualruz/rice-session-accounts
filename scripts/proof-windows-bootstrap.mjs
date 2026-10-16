// Shared with rice-multi-models (MIT), adapted for the Accounts native helper.
// This fixture uses --version only, no account files, provider requests or installations.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

assert.equal(process.platform, 'win32', 'this proof requires the actual Windows runtime')
const helper = process.argv[2] ?? fileURLToPath(new URL('../native/windows.mjs', import.meta.url)), native = process.env.RICE_ACCOUNTS_PROOF_CLAUDE
assert(isAbsolute(helper), 'provide an absolute immutable windows-bootstrap helper')
assert(native && isAbsolute(native), 'provide the private qualified native Claude executable')
const { windowsBootstrapDirectory, WINDOWS_BOOTSTRAP_SCRIPT } = await import(pathToFileURL(helper).href)
const fixture = mkdtempSync(join(tmpdir(), 'rice-windows-bootstrap space-'))
const ownedFiles = []
const observations = []
try {
  const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const parser = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[void][ScriptBlock]::Create($env:RICE_NATIVE_PARSE_SOURCE)'], {
    env: { ...process.env, RICE_NATIVE_PARSE_SOURCE: WINDOWS_BOOTSTRAP_SCRIPT }, encoding: 'utf8', timeout: 15000, windowsHide: true,
  })
  assert.equal(parser.status, 0, 'the native PowerShell parser accepts the complete helper before execution')
  function probe(name, options) {
    const filename = `${createHash('sha256').update(randomUUID()).digest('hex')}.mjs`
    const directory = windowsBootstrapDirectory(filename, options)
    assert(!/\s/.test(directory), 'the Bun preload directory has no whitespace')
    const file = join(directory, filename), marker = join(fixture, `${name}.json`)
    ownedFiles.push(file)
    writeFileSync(file, 'import {writeFileSync} from "node:fs";writeFileSync(process.env.RICE_NATIVE_PROOF_MARKER,JSON.stringify({loaded:true,bun:!!globalThis.Bun,pid:process.pid}));\n', { flag: 'wx' })
    const result = spawnSync(native, ['--version'], {
      env: { ...process.env, BUN_OPTIONS: `--preload ${file.replace(/\\/g, '/')}`, RICE_NATIVE_PROOF_MARKER: marker, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      encoding: 'utf8', timeout: 15000, windowsHide: true,
    })
    const loaded = (() => { try { return JSON.parse(readFileSync(marker, 'utf8')) } catch { return undefined } })()
    observations.push({ name, exitCode: result.status, loaded: loaded?.loaded === true, bun: loaded?.bun === true, qualified299: /^2\.1\.299 \(Claude Code\)\s*$/.test(result.stdout), directory })
    assert.equal(result.status, 0, `${name}: native --version exits successfully`)
    assert.equal(loaded?.loaded, true, `${name}: the preload actually executed`)
    assert.equal(loaded?.bun, true)
    assert.equal(loaded?.pid, result.pid)
    assert.match(result.stdout, /^2\.1\.299 \(Claude Code\)\s*$/)
    return directory
  }
  probe('shortened-directory-lowercase-file', { temporaryDirectory: fixture })
  const blocker = join(fixture, 'not-a-directory')
  writeFileSync(blocker, 'owned fallback trigger\n', { flag: 'wx' })
  const fallback = probe('protected-system-temp-fallback', { temporaryDirectory: blocker })
  const windowsTemp = join(process.env.SystemRoot, 'Temp').toLowerCase()
  assert(fallback.toLowerCase().startsWith(windowsTemp + '\\'), 'the unavailable user temporary base uses the protected system temporary fallback')
  const unsafeBase = join(fixture, 'unmanaged-base'), unsafeDirectory = join(unsafeBase, basename(fallback))
  mkdirSync(unsafeDirectory, { recursive: true })
  const unrelated = join(unsafeDirectory, 'unrelated.txt')
  writeFileSync(unrelated, 'retain this unmanaged directory\n')
  assert.throws(() => windowsBootstrapDirectory(`${'a'.repeat(64)}.mjs`, { temporaryDirectory: unsafeBase }), error => error.code === 'RICE_ACCOUNT_NATIVE', 'an existing directory with inherited permissions is refused')
  assert.equal(readFileSync(unrelated, 'utf8'), 'retain this unmanaged directory\n')
  observations.push({ name: 'inherited-acl-refusal', refused: true, unrelatedPreserved: true })
  process.stdout.write(`${JSON.stringify({ windowsBootstrap: 'pass', observations })}\n`)
} finally {
  for (const file of ownedFiles) { try { unlinkSync(file) } catch {} }
  rmSync(fixture, { recursive: true, force: true })
}
