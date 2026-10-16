import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'

// Run the exact static program the plugin passes to Node, rather than a copy.
const moduleText = fs.readFileSync(new URL('../hooks/credentials.ts', import.meta.url), 'utf8')
const payload = /const NATIVE_FILE = String\.raw`([\s\S]*?)`\n/.exec(moduleText)?.[1]
assert.ok(payload, 'native credential helper must be present')
new vm.Script(payload)

function fixture(work) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rice-account-store-test-'))
  const file = path.join(folder, '.credentials.json')
  const run = (operation, input) => spawnSync(process.execPath, ['-e', payload, operation, file], {
    input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', timeout: 15_000,
  })
  try { work({ folder, file, run }) } finally {
    for (const entry of fs.readdirSync(folder)) fs.unlinkSync(path.join(folder, entry))
    fs.rmdirSync(folder)
  }
}

const login = {
  unrelated: { keep: 'fixture-other' },
  claudeAiOauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: 1_000_000, extra: 'keep-oauth' },
}

test('the native credential program reads and rotates a real file atomically with exact mode 0600', () => fixture(({ folder, file, run }) => {
  assert.equal(run('read').status, 44)
  fs.writeFileSync(file, JSON.stringify(login), { mode: 0o644 })
  const before = fs.statSync(file)
  assert.deepEqual(JSON.parse(run('read').stdout), login)
  const oauth = { accessToken: 'fixture-new-access', refreshToken: 'fixture-new-refresh', expiresAt: 2_000_000 }
  const saved = run('write', { expectedRefreshToken: login.claudeAiOauth.refreshToken, oauth })
  assert.equal(saved.status, 0)
  const expected = { ...login, claudeAiOauth: { ...login.claudeAiOauth, ...oauth } }
  assert.deepEqual(JSON.parse(saved.stdout), expected)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), expected)
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.notEqual(fs.statSync(file).ino, before.ino, 'write must replace the file atomically')
  assert.deepEqual(fs.readdirSync(folder), ['.credentials.json'])
}))

test('a newer grant prevents stale refresh writes and preserves the whole current document', () => fixture(({ file, run }) => {
  const current = { ...login, addedWhileRefreshing: 'preserved', claudeAiOauth: { ...login.claudeAiOauth, refreshToken: 'newer-native-grant' } }
  fs.writeFileSync(file, JSON.stringify(current), { mode: 0o600 })
  const attempted = run('write', { expectedRefreshToken: login.claudeAiOauth.refreshToken, oauth: login.claudeAiOauth })
  assert.equal(attempted.status, 47)
  assert.equal(attempted.stdout, '')
  assert.equal(attempted.stderr, '')
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), current)
}))

test('refresh retains unrelated fields added after the caller loaded its credential', () => fixture(({ file, run }) => {
  const current = { ...login, nativeMetadataAddedLater: { keep: true }, claudeAiOauth: { ...login.claudeAiOauth, nativeAddedLater: true } }
  fs.writeFileSync(file, JSON.stringify(current), { mode: 0o600 })
  const oauth = { accessToken: 'refreshed-access', refreshToken: 'refreshed-grant', expiresAt: 3_000_000 }
  const saved = run('write', { expectedRefreshToken: login.claudeAiOauth.refreshToken, oauth })
  assert.equal(saved.status, 0)
  assert.deepEqual(JSON.parse(saved.stdout), { ...current, claudeAiOauth: { ...current.claudeAiOauth, ...oauth } })
}))

test('symlink reads and writes are refused without altering their target', { skip: process.platform === 'win32' ? 'creating a Windows file symlink requires Developer Mode or elevation; Windows reparse refusal is checked separately' : false }, () => fixture(({ file, run }) => {
  fs.writeFileSync(`${file}.target`, JSON.stringify(login), { mode: 0o600 })
  fs.symlinkSync(`${file}.target`, file)
  assert.equal(run('read').status, 45)
  assert.equal(run('write', { expectedRefreshToken: login.claudeAiOauth.refreshToken, oauth: login.claudeAiOauth }).status, 45)
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.target`, 'utf8')), login)
}))

test('malformed credentials fail without echoing input bytes or treating failure as missing', () => fixture(({ file, run }) => {
  fs.writeFileSync(file, '{"fixture-secret-with-invalid-json', { mode: 0o600 })
  const attempted = run('read')
  assert.equal(attempted.status, 46)
  assert.equal(attempted.stdout, '')
  assert.equal(attempted.stderr, '')
}))

test('a valid native machine store without OAuth is distinct from malformed or missing credentials', () => fixture(({ file, run }) => {
  fs.writeFileSync(file, JSON.stringify({ apiKey: 'fixture-console-key', unrelated: true }), { mode: 0o600 })
  const noOAuth = run('read')
  assert.equal(noOAuth.status, 43)
  assert.equal(noOAuth.stdout, '')
  assert.equal(noOAuth.stderr, '')
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'incomplete-fixture' } }))
  assert.equal(run('read').status, 46)
}))
