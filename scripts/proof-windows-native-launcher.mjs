// Adapted from rice-multi-models/scripts/proof-windows-native-launcher.mjs (MIT).
// Native Windows proof in an isolated home. Uses --version, no account files or inference.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

assert.equal(process.platform, 'win32', 'this proof requires actual Windows')
assert(process.env.RICE_ACCOUNTS_PROOF_CLAUDE, 'provide the private qualified native Claude executable')
const native = realpathSync(process.env.RICE_ACCOUNTS_PROOF_CLAUDE)
const root = fileURLToPath(new URL('../', import.meta.url))
const fixture = mkdtempSync(join(tmpdir(), 'rice-launcher space-'))
const plugin = join(fixture, 'installed plugin'), config = join(fixture, '.claude'), bin = join(fixture, '.local/bin')
const entry = join(bin, 'rice-account-claude.mjs'), command = join(bin, 'rice-account-claude.cmd')
const selection = join(config, 'rice-session-accounts/native-launcher.json')
const env = Object.fromEntries(['PATH','SystemRoot','SystemDrive','ComSpec','PATHEXT'].filter(name=>process.env[name]!==undefined).map(name=>[name,process.env[name]]))
Object.assign(env,{HOME:fixture,USERPROFILE:fixture,CLAUDE_CONFIG_DIR:config,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1'})
delete env.BUN_OPTIONS
delete env.RICE_SESSION_ACCOUNTS_NATIVE_ACTIVE
delete env.RICE_SESSION_ACCOUNTS_AUTH_REVISION
delete env.RICE_ACCOUNTS_PROOF_CLAUDE
const run = (file, args, extra = {}) => spawnSync(process.execPath, [file, ...args], { env: { ...env, ...extra }, cwd: fixture, encoding: 'utf8', timeout: 30000 })
const quoted = value => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
const cmd = args => spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[command, ...args].map(quoted).join(' ')}"`], { env, cwd: fixture, encoding: 'utf8', timeout: 30000, windowsVerbatimArguments: true })
try {
  cpSync(join(root, 'native'), join(plugin, 'native'), { recursive: true })
  cpSync(join(root, '.claude-plugin'), join(plugin, '.claude-plugin'), { recursive: true })
  mkdirSync(join(config, 'plugins'), { recursive: true })
  const ledger = installPath => JSON.stringify({ version: 2, plugins: { 'rice-session-accounts@rice-mods': [{ scope: 'user', installPath }] } })
  writeFileSync(join(config, 'plugins/installed_plugins.json'), ledger(plugin))
  mkdirSync(bin, { recursive: true })
  for (const path of [entry, command]) {
    writeFileSync(path, 'owned unrelated command\r\n')
    const refused = run(join(plugin, 'native/launch.mjs'), ['--install', native])
    assert.notEqual(refused.status, 0, 'each unrelated launcher file is protected')
    assert.equal(readFileSync(path, 'utf8'), 'owned unrelated command\r\n')
    assert.equal(existsSync(selection), false, 'unrelated files prevent selection writes')
    assert.equal(existsSync(path === entry ? command : entry), false, 'refusal creates neither half of the pair')
    rmSync(path)
  }
  const installed = run(join(plugin, 'native/launch.mjs'), ['--install', native])
  assert.equal(installed.status, 0, 'private Windows bootstrap activates the real native adapter before installation')
  const saved = readFileSync(selection, 'utf8')
  assert.deepEqual(JSON.parse(saved), { format: 1, executable: native, claudeVersion: '2.1.299' })
  const version = cmd(['--version'])
  assert.equal(version.status, 0, 'plain managed .cmd launcher uses the saved qualified runtime')
  assert.match(version.stdout, /^2\.1\.299 \(Claude Code\)\s*$/)
  assert.equal(run(join(plugin, 'native/launch.mjs'), ['--install']).status, 0, 'setup repeats with the verified saved runtime')
  assert.equal(readFileSync(selection, 'utf8'), saved)
  const launcherBytes = [entry, command].map(path => readFileSync(path, 'utf8'))
  assert.notEqual(run(join(plugin, 'native/launch.mjs'), ['--install', join(fixture, 'missing.exe')]).status, 0)
  assert.equal(readFileSync(selection, 'utf8'), saved)
  assert.deepEqual([entry, command].map(path => readFileSync(path, 'utf8')), launcherBytes, 'failed verification preserves both managed files')
  writeFileSync(selection, '{invalid-selection-fixture')
  const invalid = cmd(['--version'])
  assert.notEqual(invalid.status, 0)
  assert.match(invalid.stderr, /\/rice-account setup-native/)
  assert.equal(readFileSync(selection, 'utf8'), '{invalid-selection-fixture')
  assert.equal(run(join(plugin, 'native/launch.mjs'), ['--install', native]).status, 0, 'explicit setup repairs a bad saved selection')
  const updated = join(fixture, 'updated plugin')
  cpSync(plugin, updated, { recursive: true })
  writeFileSync(join(config, 'plugins/installed_plugins.json'), ledger(updated))
  rmSync(plugin, { recursive: true })
  assert.equal(cmd(['--version']).status, 0, 'the managed entry resolves the updated plugin installation')
  const liveEntry = readFileSync(entry, 'utf8')
  writeFileSync(entry, '#!/usr/bin/env node\n// rice-session-accounts installed launcher\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
  const argumentsToPreserve = ['space value', 'unicode-名', 'a&b', 'literal^caret', 'single%sign', 'trailing\\', 'quote"inside']
  const echoed = cmd(argumentsToPreserve)
  writeFileSync(entry, liveEntry)
  assert.equal(echoed.status, 0)
  assert.deepEqual(JSON.parse(echoed.stdout), argumentsToPreserve, 'cmd forwards caller arguments without another shell or interpolation pass')
  process.stdout.write(`${JSON.stringify({ windowsNativeLauncher: 'pass', qualifiedVersion: '2.1.299', managedPair: true, persistedRuntime: true, pathSpaces: true, unrelatedFilesPreserved: true, pluginUpdateResolved: true, argumentsPreserved: argumentsToPreserve.length })}\n`)
} finally { rmSync(fixture, { recursive: true, force: true }) }
