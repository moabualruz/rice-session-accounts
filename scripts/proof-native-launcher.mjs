// Own installation fixture, no account login or installed plugin changes.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const fixture = mkdtempSync(join(tmpdir(), 'rice-account-launcher-'))
const config = join(fixture, '.claude'), selection = join(config, 'rice-session-accounts/native-launcher.json')
const native = realpathSync(process.env.RICE_ACCOUNTS_PROOF_CLAUDE || execFileSync('which', ['claude'], { encoding: 'utf8' }).trim())
const env = { PATH: process.env.PATH, HOME: fixture, USERPROFILE: fixture, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' }
const run = (file, args) => spawnSync(process.execPath, [file, ...args], { cwd: fixture, env, encoding: 'utf8', timeout: 40000 })
try {
  mkdirSync(join(config, 'plugins'), { recursive: true })
  writeFileSync(join(config, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'rice-session-accounts@rice-mods': [{ scope: 'user', installPath: root }] } }))
  const installer = join(root, 'native/launch.mjs')
  const installed = run(installer, ['--install', native])
  assert.equal(installed.status, 0, installed.stderr)
  const saved = readFileSync(selection, 'utf8')
  const version = JSON.parse(saved).claudeVersion
  const helperProbe = join(fixture, 'inherited-helper.mjs')
  writeFileSync(helperProbe, `await import(${JSON.stringify(pathToFileURL(join(root, 'native/cache.mjs')).href)});if(process.env.RICE_SESSION_ACCOUNTS_NATIVE_ACTIVE)throw Error('helper inherited active marker');\n`)
  const unrelated = spawnSync(JSON.parse(saved).executable, ['--version'], { cwd: fixture, env: { ...env, BUN_OPTIONS: '--preload ' + helperProbe, RICE_SESSION_ACCOUNTS_NATIVE_VERSION: 'unsupported', RICE_SESSION_ACCOUNTS_NATIVE_EXECUTABLE: join(fixture, 'different-executable'), RICE_SESSION_ACCOUNTS_NATIVE_ACTIVE: '1' }, encoding: 'utf8', timeout: 15000 })
  assert.equal(unrelated.status, 0, 'inherited preload must skip unrelated standalone Bun helpers')
  mkdirSync(join(fixture, 'bin'))
  writeFileSync(join(fixture, 'bin/claude'), '#!/bin/sh\nprintf "9.9.9 (Claude Code)\\n"\n', { mode: 0o755 })
  env.PATH = join(fixture, 'bin') + ':' + env.PATH
  const launcher = join(fixture, '.local/bin/rice-account-claude')
  const plain = run(launcher, ['--version'])
  assert.equal(plain.status, 0, plain.stderr)
  assert.equal(plain.stdout.trim(), `${version} (Claude Code)`)
  const failed = run(installer, ['--install', join(fixture, 'missing-executable')])
  assert.notEqual(failed.status, 0)
  assert.match(failed.stderr, /setup-native/)
  assert.equal(readFileSync(selection, 'utf8'), saved)
  const managed = readFileSync(launcher, 'utf8')
  writeFileSync(launcher, 'owned unrelated launcher')
  assert.notEqual(run(installer, ['--install', native]).status, 0)
  assert.equal(readFileSync(selection, 'utf8'), saved)
  writeFileSync(launcher, managed)
  writeFileSync(selection, JSON.stringify({ format: 1, executable: join(fixture, 'disappeared'), claudeVersion: version }))
  const missing = run(launcher, ['--version'])
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /setup-native/)
  console.log(JSON.stringify({ scope: 'owned launcher installation and real native preload qualification', version, installed: true, inheritedHelperPreloadSkipped: true, plainLaunchSavedRuntimeWithUnsupportedPath: true, failedSetupPreservesSelection: true, unrelatedLauncherPreservesSelection: true, disappearedRuntimeRefuses: true }))
} finally { rmSync(fixture, { recursive: true, force: true }) }
