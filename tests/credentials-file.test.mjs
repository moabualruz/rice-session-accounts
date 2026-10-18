import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'

// Run the exact static programs the plugin passes to Node and to /bin/sh, rather than copies.
const moduleText = fs.readFileSync(new URL('../hooks/credentials.ts', import.meta.url), 'utf8')
const payload = /const NATIVE_FILE = String\.raw`([\s\S]*?)`\n/.exec(moduleText)?.[1]
assert.ok(payload, 'native credential helper must be present')
new vm.Script(payload)
const pendingScript = /const PENDING_SH = String\.raw`([\s\S]*?)`\n/.exec(moduleText)?.[1]
assert.ok(pendingScript, 'the darwin pending writer must be present')

const windows = process.platform === 'win32'

function fixture(work) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rice-account-store-test-'))
  const file = path.join(folder, '.credentials.json')
  const run = (operation, input, options = {}) => spawnSync(process.execPath, [...(options.preload ? ['--require', options.preload] : []), '-e', payload, operation, options.target ?? file], {
    input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', timeout: 15_000, env: { ...process.env, ...options.env },
  })
  try { work({ folder, file, run }) } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
}

const login = {
  unrelated: { keep: 'fixture-other' },
  claudeAiOauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: 1_000_000, extra: 'keep-oauth' },
}
const fresh = { accessToken: 'fixture-new-access', refreshToken: 'fixture-new-refresh', expiresAt: 2_000_000 }
const storeWith = oauth => ({ ...login, claudeAiOauth: { ...login.claudeAiOauth, ...oauth } })
const pendingDocument = (base, oauth) => ({ version: 2, base, credential: { claudeAiOauth: oauth } })
const writeJson = (file, value) => fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 })
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const ageFile = file => { const old = new Date(Date.now() - 10 * 60 * 1000); fs.utimesSync(file, old, old) }

/** Every file in the folder with its bytes, identity and modification time: a read must leave all of it as it was. */
function snapshot(folder) {
  return Object.fromEntries(fs.readdirSync(folder).sort().map(name => {
    const file = path.join(folder, name)
    const stat = fs.lstatSync(file)
    return [name, { text: stat.isFile() ? fs.readFileSync(file, 'utf8') : null, ino: stat.ino, mtimeMs: stat.mtimeMs }]
  }))
}

test('the native credential program reads and rotates a real file atomically with exact mode 0600', () => fixture(({ folder, file, run }) => {
  assert.equal(run('read').status, 44)
  fs.writeFileSync(file, JSON.stringify(login), { mode: 0o644 })
  const before = fs.statSync(file)
  assert.deepEqual(JSON.parse(run('read').stdout), login)
  const saved = run('write', { expectedRefreshToken: login.claudeAiOauth.refreshToken, oauth: fresh })
  assert.equal(saved.status, 0)
  const expected = { ...login, claudeAiOauth: { ...login.claudeAiOauth, ...fresh } }
  assert.deepEqual(JSON.parse(saved.stdout), expected)
  assert.deepEqual(readJson(file), expected)
  if (!windows) assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.notEqual(fs.statSync(file).ino, before.ino, 'write must replace the file atomically')
  assert.deepEqual(fs.readdirSync(folder), ['.credentials.json'])
}))

test('a newer grant prevents stale refresh writes, preserves the whole current document and leaves the pending file alone', () => fixture(({ file, run }) => {
  const current = { ...login, addedWhileRefreshing: 'preserved', claudeAiOauth: { ...login.claudeAiOauth, refreshToken: 'newer-native-grant' } }
  fs.writeFileSync(file, JSON.stringify(current), { mode: 0o600 })
  const pending = pendingDocument(login.claudeAiOauth.refreshToken, fresh)
  writeJson(`${file}.rice-pending`, pending)
  const attempted = run('write', { expectedRefreshToken: login.claudeAiOauth.refreshToken, oauth: login.claudeAiOauth })
  assert.equal(attempted.status, 47)
  assert.equal(attempted.stdout, '')
  assert.equal(attempted.stderr, '')
  assert.deepEqual(readJson(file), current)
  assert.deepEqual(readJson(`${file}.rice-pending`), pending, 'a refused write never removes the pending file')
}))

test('refresh retains unrelated fields added after the caller loaded its credential', () => fixture(({ file, run }) => {
  const current = { ...login, nativeMetadataAddedLater: { keep: true }, claudeAiOauth: { ...login.claudeAiOauth, nativeAddedLater: true } }
  fs.writeFileSync(file, JSON.stringify(current), { mode: 0o600 })
  const oauth = { accessToken: 'refreshed-access', refreshToken: 'refreshed-grant', expiresAt: 3_000_000 }
  const saved = run('write', { expectedRefreshToken: login.claudeAiOauth.refreshToken, oauth })
  assert.equal(saved.status, 0)
  assert.deepEqual(JSON.parse(saved.stdout), { ...current, claudeAiOauth: { ...current.claudeAiOauth, ...oauth } })
}))

test('refreshTokenExpiresAt travels with the grant: written when a renewal has one, kept from the store when it has none', () => fixture(({ file, run }) => {
  const stored = { ...login, claudeAiOauth: { ...login.claudeAiOauth, refreshTokenExpiresAt: 5_000_000 } }
  writeJson(file, stored)
  const withExpiry = { ...fresh, refreshTokenExpiresAt: 9_000_000 }
  assert.equal(run('pending', { base: 'fixture-refresh', credential: { claudeAiOauth: withExpiry } }).status, 0)
  assert.deepEqual(readJson(`${file}.rice-pending`), pendingDocument('fixture-refresh', withExpiry))
  assert.deepEqual(JSON.parse(run('read').stdout), { ...stored, claudeAiOauth: { ...stored.claudeAiOauth, ...withExpiry } })
  assert.equal(run('write', { expectedRefreshToken: 'fixture-refresh', oauth: withExpiry }).status, 0)
  assert.equal(readJson(file).claudeAiOauth.refreshTokenExpiresAt, 9_000_000)
  // A renewal without one (or with a value that is not a number) keeps the stored one.
  const next = { accessToken: 'fixture-third-access', refreshToken: 'fixture-third-refresh', expiresAt: 3_000_000 }
  assert.equal(run('write', { expectedRefreshToken: fresh.refreshToken, oauth: { ...next, refreshTokenExpiresAt: 'soon' } }).status, 0)
  assert.deepEqual(readJson(file), { ...stored, claudeAiOauth: { ...stored.claudeAiOauth, ...next, refreshTokenExpiresAt: 9_000_000 } })
  assert.equal(run('pending', { base: 'fixture-third-refresh', credential: { claudeAiOauth: { ...next, refreshTokenExpiresAt: 'soon' } } }).status, 0)
  assert.deepEqual(readJson(`${file}.rice-pending`), pendingDocument('fixture-third-refresh', next))
}))

test('symlink reads and writes are refused without altering their target', { skip: windows ? 'creating a Windows file symlink requires Developer Mode or elevation; Windows reparse refusal is checked separately' : false }, () => fixture(({ file, run }) => {
  fs.writeFileSync(`${file}.target`, JSON.stringify(login), { mode: 0o600 })
  fs.symlinkSync(`${file}.target`, file)
  assert.equal(run('read').status, 45)
  assert.equal(run('examine').status, 45)
  assert.equal(run('write', { expectedRefreshToken: login.claudeAiOauth.refreshToken, oauth: login.claudeAiOauth }).status, 45)
  assert.deepEqual(readJson(`${file}.target`), login)
}))

test('malformed credentials fail without echoing input bytes or treating failure as missing', () => fixture(({ file, run }) => {
  fs.writeFileSync(file, '{"fixture-secret-with-invalid-json', { mode: 0o600 })
  for (const operation of ['read', 'examine']) {
    const attempted = run(operation)
    assert.equal(attempted.status, 46)
    assert.equal(attempted.stdout, '')
    assert.equal(attempted.stderr, '')
  }
}))

test('a valid native machine store without OAuth is distinct from malformed or missing credentials', () => fixture(({ file, run }) => {
  fs.writeFileSync(file, JSON.stringify({ apiKey: 'fixture-console-key', unrelated: true }), { mode: 0o600 })
  const noOAuth = run('read')
  assert.equal(noOAuth.status, 43)
  assert.equal(noOAuth.stdout, '')
  assert.equal(noOAuth.stderr, '')
  assert.equal(run('examine').status, 43)
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'incomplete-fixture' } }))
  assert.equal(run('read').status, 46)
}))

test('a write to a missing store reports only ENOENT, so the renewal is not mistaken for a saved one; examine reports it as null', () => fixture(({ file, run }) => {
  assert.equal(run('write', { expectedRefreshToken: 'fixture-refresh', oauth: fresh }).status, 44)
  const missing = run('examine')
  assert.equal(missing.status, 0)
  assert.deepEqual(JSON.parse(missing.stdout), { stored: null, pending: null })
  writeJson(`${file}.rice-pending`, pendingDocument('fixture-refresh', fresh))
  assert.deepEqual(JSON.parse(run('examine').stdout), { stored: null, pending: { base: 'fixture-refresh', credential: { claudeAiOauth: fresh } } })
  assert.equal(run('read').status, 44, 'an orphaned pending renewal is never used without a store')
  assert.equal(fs.existsSync(file), false)
}))

test('the pending write keeps the base and only the renewed grant in an owner-only version 2 file beside the store', () => fixture(({ folder, file, run }) => {
  fs.writeFileSync(file, JSON.stringify(login), { mode: 0o600 })
  const written = run('pending', { base: 'fixture-refresh', credential: { claudeAiOauth: { ...fresh, extra: 'not kept' }, other: 'not kept' } })
  assert.equal(written.status, 0)
  assert.equal(written.stdout, '')
  assert.deepEqual(readJson(`${file}.rice-pending`), pendingDocument('fixture-refresh', fresh))
  if (!windows) assert.equal(fs.statSync(`${file}.rice-pending`).mode & 0o777, 0o600)
  assert.deepEqual(readJson(file), login, 'the store is untouched by a pending write')
  assert.deepEqual(fs.readdirSync(folder).sort(), ['.credentials.json', '.credentials.json.rice-pending'])
  assert.equal(run('pending', { base: 'fixture-refresh', credential: { claudeAiOauth: { accessToken: 'x' } } }).status, 46)
  assert.equal(run('pending', { credential: { claudeAiOauth: fresh } }).status, 46, 'a base is required')
  assert.equal(run('pending', { base: '', credential: { claudeAiOauth: fresh } }).status, 46, 'an empty base is refused')
  assert.equal(run('pending', { claudeAiOauth: fresh }).status, 46, 'the version 1 request is refused')
  // A missing login folder is ENOENT (44); the caller reports the folder, not a vanished store.
  const target = path.join(folder, 'missing-login', '.credentials.json')
  assert.equal(run('pending', { base: 'fixture-refresh', credential: { claudeAiOauth: fresh } }, { target }).status, 44)
}))

test('a read returns the store with a usable pending renewal and never writes or removes a file', () => fixture(({ folder, file, run }) => {
  fs.writeFileSync(file, JSON.stringify(login), { mode: 0o600 })
  writeJson(`${file}.rice-pending`, pendingDocument('fixture-refresh', fresh))
  const leftover = `${file}.rice-4242-0f1e2d3c4b5a69788796a5b4c3d2e1f0`
  writeJson(leftover, storeWith({ refreshToken: 'fixture-leftover-refresh', expiresAt: 9_000_000 }))
  ageFile(leftover)
  const before = snapshot(folder)
  const read = run('read')
  assert.equal(read.status, 0)
  assert.deepEqual(JSON.parse(read.stdout), storeWith(fresh))
  assert.deepEqual(snapshot(folder), before, 'a read changes nothing')
  const inspected = run('examine')
  assert.equal(inspected.status, 0)
  assert.deepEqual(JSON.parse(inspected.stdout), { stored: login, pending: { base: 'fixture-refresh', credential: { claudeAiOauth: fresh } } })
  assert.deepEqual(snapshot(folder), before, 'an inspection changes nothing')
}))

test('rule B in the program: only a pending renewal based on the stored refresh token is used, whatever the expiry times', () => fixture(({ folder, file, run }) => {
  const salvaged = { accessToken: 'fixture-expired-access', refreshToken: 'fixture-salvaged-refresh', expiresAt: 0 }
  const cases = [
    ['usable', login, pendingDocument('fixture-refresh', fresh), fresh.refreshToken],
    ['salvaged with expiresAt 0', login, pendingDocument('fixture-refresh', salvaged), salvaged.refreshToken],
    ['redundant (the store caught up)', storeWith(fresh), pendingDocument('fixture-refresh', fresh), fresh.refreshToken],
    ['obsolete (the store moved past it, though it expires earlier)', storeWith({ refreshToken: 'fixture-later-refresh', expiresAt: 500 }), pendingDocument('fixture-refresh', { ...fresh, expiresAt: 9_000_000 }), 'fixture-later-refresh'],
    ['foreign (another sign-in)', storeWith({ refreshToken: 'fixture-other-account-refresh' }), pendingDocument('fixture-earlier-account-refresh', { ...fresh, expiresAt: 9_000_000 }), 'fixture-other-account-refresh'],
    ['version 1', login, { claudeAiOauth: { ...fresh, expiresAt: 9_000_000 } }, 'fixture-refresh'],
    ['malformed', login, '{"fixture-partial', 'fixture-refresh'],
  ]
  for (const [label, stored, pending, expected] of cases) {
    writeJson(file, stored)
    writeJson(`${file}.rice-pending`, pending)
    const before = snapshot(folder)
    const read = run('read')
    assert.equal(read.status, 0, label)
    assert.equal(JSON.parse(read.stdout).claudeAiOauth.refreshToken, expected, label)
    const inspected = JSON.parse(run('examine').stdout)
    assert.equal(inspected.pending === null, label.startsWith('version 1') || label === 'malformed', label)
    assert.deepEqual(snapshot(folder), before, `${label}: reading changes nothing`)
  }
}))

test('a store write never touches the pending file; clearpending removes it only for its own base and owner, and nothing else', () => fixture(({ folder, file, run }) => {
  fs.writeFileSync(file, JSON.stringify(login), { mode: 0o600 })
  writeJson(`${file}.rice-pending`, pendingDocument('fixture-refresh', fresh))
  const leftover = `${file}.rice-4243-00112233445566778899aabbccddeeff`
  writeJson(leftover, '{"fixture-partial')
  ageFile(leftover)
  assert.equal(run('write', { expectedRefreshToken: 'fixture-refresh', oauth: fresh }).status, 0)
  assert.equal(fs.existsSync(`${file}.rice-pending`), true, 'the pending file outlives the store write until it is cleared')
  writeJson(leftover, '{"fixture-partial')
  ageFile(leftover)
  const other = run('clearpending', { base: 'fixture-unrelated-refresh', tokens: [fresh.refreshToken] })
  assert.equal(other.status, 0)
  assert.equal(other.stdout, '')
  assert.equal(fs.existsSync(`${file}.rice-pending`), true, 'another base leaves the pending file')
  // Another session's later renewal under the same base is not this renewal's to remove.
  assert.equal(run('clearpending', { base: 'fixture-refresh', tokens: ['fixture-refresh', 'fixture-other-session'] }).status, 0)
  assert.equal(fs.existsSync(`${file}.rice-pending`), true, 'a pending renewal this caller does not own stays')
  assert.equal(run('clearpending', { base: 'fixture-refresh', tokens: [] }).status, 0)
  assert.equal(fs.existsSync(`${file}.rice-pending`), true, 'no owned token removes nothing')
  assert.equal(run('clearpending', { base: 'fixture-refresh', tokens: ['fixture-refresh', fresh.refreshToken] }).status, 0)
  assert.equal(fs.existsSync(`${file}.rice-pending`), false)
  assert.equal(fs.existsSync(leftover), true, 'clearpending removes only the pending file')
  assert.equal(run('clearpending', { base: 'fixture-refresh', tokens: [fresh.refreshToken] }).status, 0, 'nothing to clear is not an error')
  assert.equal(run('clearpending', {}).status, 46)
  assert.equal(run('clearpending', { base: 'fixture-refresh' }).status, 46, 'the owned tokens are required')
  assert.deepEqual(readJson(file), storeWith(fresh))
}))

test('readpending prints the pending renewal alone, even when the store cannot be read, and writes nothing', () => fixture(({ folder, file, run }) => {
  assert.deepEqual(JSON.parse(run('readpending').stdout), { pending: null }, 'no pending file is null, whatever the store')
  writeJson(`${file}.rice-pending`, pendingDocument('fixture-refresh', fresh))
  fs.writeFileSync(file, '{"not json', { mode: 0o600 })
  assert.equal(run('examine').status, 46, 'the store itself cannot be read')
  const before = snapshot(folder)
  const printed = run('readpending')
  assert.equal(printed.status, 0)
  assert.deepEqual(JSON.parse(printed.stdout), { pending: { base: 'fixture-refresh', credential: { claudeAiOauth: fresh } } })
  assert.deepEqual(snapshot(folder), before)
  writeJson(`${file}.rice-pending`, '{"fixture-partial')
  assert.deepEqual(JSON.parse(run('readpending').stdout), { pending: null })
}))

test('a version 1 or malformed pending file is ignored, and clearpending removes it only once it is older than five minutes', () => fixture(({ file, run }) => {
  fs.writeFileSync(file, JSON.stringify(login), { mode: 0o600 })
  const pending = `${file}.rice-pending`
  for (const content of [JSON.stringify({ claudeAiOauth: { ...fresh, expiresAt: 9_000_000 } }), '{"fixture-partial', JSON.stringify({ version: 3, base: 'fixture-refresh', credential: { claudeAiOauth: fresh } })]) {
    writeJson(pending, content)
    assert.equal(JSON.parse(run('examine').stdout).pending, null)
    assert.equal(JSON.parse(run('read').stdout).claudeAiOauth.refreshToken, 'fixture-refresh')
    assert.equal(run('clearpending', { base: 'fixture-refresh', tokens: [] }).status, 0)
    assert.equal(fs.existsSync(pending), true, 'a young file of another format is kept')
    ageFile(pending)
    assert.equal(run('read').status, 0)
    assert.equal(fs.existsSync(pending), true, 'a read never removes it')
    assert.equal(run('clearpending', { base: 'fixture-refresh', tokens: [] }).status, 0)
    assert.equal(fs.existsSync(pending), false, 'an old file of another format is removed')
  }
}))

test('temporary copies left by a killed write are never adopted; writes remove those older than five minutes', () => fixture(({ folder, file, run }) => {
  fs.writeFileSync(file, JSON.stringify(login), { mode: 0o600 })
  const legacy = `${file}.rice-4242-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0`
  writeJson(legacy, storeWith({ ...fresh, expiresAt: 9_000_000 }))
  ageFile(legacy)
  const broken = `${file}.rice-4243-00112233445566778899aabbccddeeff`
  writeJson(broken, '{"fixture-partial')
  ageFile(broken)
  const young = `${file}.rice-4244-ffeeddccbbaa99887766554433221100`
  writeJson(young, { claudeAiOauth: { ...fresh, refreshToken: 'young-grant', expiresAt: 5_000_000 } })
  const unrelated = path.join(folder, 'notes.rice-1-not-ours')
  fs.writeFileSync(unrelated, 'kept')
  ageFile(unrelated)
  const read = run('read')
  assert.equal(read.status, 0)
  assert.equal(JSON.parse(read.stdout).claudeAiOauth.refreshToken, 'fixture-refresh', 'a temporary copy is never adopted')
  assert.equal(fs.readdirSync(folder).length, 5, 'a read removes nothing')
  assert.equal(run('pending', { base: 'fixture-refresh', credential: { claudeAiOauth: fresh } }).status, 0)
  assert.deepEqual(fs.readdirSync(folder).sort(), ['.credentials.json', '.credentials.json.rice-pending', path.basename(young), 'notes.rice-1-not-ours'].sort())
  writeJson(legacy, '{"fixture-partial')
  ageFile(legacy)
  assert.equal(run('write', { expectedRefreshToken: 'fixture-refresh', oauth: fresh }).status, 0)
  assert.equal(fs.existsSync(legacy), false, 'a store write removes an old temporary copy too')
  assert.equal(fs.existsSync(young), true)
  assert.equal(fs.existsSync(unrelated), true)
}))

/** A preload that injects faults into the program's own `fs` calls and reports them on stderr. */
function faultPreload(folder) {
  const preload = path.join(folder, 'fault-preload.cjs')
  fs.writeFileSync(preload, `
const fs = require('fs');
const fault = process.env.RICE_TEST_FAULT;
let failures = Number(process.env.RICE_TEST_FAILURES || '0');
let again = Number(process.env.RICE_TEST_EAGAIN || '0');
const rename = fs.renameSync, open = fs.openSync, write = fs.writeFileSync, read = fs.readSync;
fs.renameSync = function () {
  process.stderr.write('fault:rename\\n');
  if (fault === 'rename' && failures !== 0) { failures -= 1; const error = new Error('fixture busy'); error.code = process.env.RICE_TEST_CODE; throw error; }
  return rename.apply(this, arguments);
};
fs.openSync = function (target, flags) {
  if (flags === 'r') { try { if (fs.statSync(target).isDirectory()) process.stderr.write('fault:open-folder\\n'); } catch (ignored) {} }
  return open.apply(this, arguments);
};
fs.writeFileSync = function (target) {
  if (fault === 'nospace' && typeof target === 'number') { const error = new Error('fixture full'); error.code = 'ENOSPC'; throw error; }
  return write.apply(this, arguments);
};
fs.readSync = function (fd) {
  if (fd === 0 && again > 0) { again -= 1; process.stderr.write('fault:eagain\\n'); const error = new Error('fixture again'); error.code = 'EAGAIN'; throw error; }
  return read.apply(this, arguments);
};
`)
  return preload
}

const renames = stderr => stderr.split('\n').filter(event => event === 'fault:rename').length

test('a rename held by antivirus or an indexer is retried, and the folder is synced after it on POSIX', () => fixture(({ folder, file, run }) => {
  fs.writeFileSync(file, JSON.stringify(login), { mode: 0o600 })
  const preload = faultPreload(folder)
  const saved = run('write', { expectedRefreshToken: login.claudeAiOauth.refreshToken, oauth: fresh }, { preload, env: { RICE_TEST_FAULT: 'rename', RICE_TEST_FAILURES: '3', RICE_TEST_CODE: 'EBUSY' } })
  assert.equal(saved.status, 0)
  const events = saved.stderr.split('\n').filter(Boolean)
  assert.equal(renames(saved.stderr), 4)
  if (!windows) assert.ok(events.lastIndexOf('fault:open-folder') > events.lastIndexOf('fault:rename'), 'the folder is synced after the rename')
  assert.equal(readJson(file).claudeAiOauth.refreshToken, fresh.refreshToken)
  assert.deepEqual(fs.readdirSync(folder).sort(), ['.credentials.json', 'fault-preload.cjs'])
}))

test('a rename that stays refused for about three seconds exits 48 and leaves the store and no temporary file', () => fixture(({ folder, file, run }) => {
  fs.writeFileSync(file, JSON.stringify(login), { mode: 0o600 })
  const preload = faultPreload(folder)
  const started = Date.now()
  // EPERM is what Windows reports for a file Defender holds; POSIX retries only EBUSY.
  const refused = run('write', { expectedRefreshToken: login.claudeAiOauth.refreshToken, oauth: fresh }, { preload, env: { RICE_TEST_FAULT: 'rename', RICE_TEST_FAILURES: '-1', RICE_TEST_CODE: windows ? 'EPERM' : 'EBUSY' } })
  const elapsed = Date.now() - started
  assert.equal(refused.status, 48)
  assert.ok(elapsed >= 2500 && elapsed < 12_000, `retries last about 3 s (took ${elapsed} ms)`)
  assert.equal(refused.stdout, '')
  assert.deepEqual(readJson(file), login)
  assert.deepEqual(fs.readdirSync(folder).sort(), ['.credentials.json', 'fault-preload.cjs'])
}))

test('on POSIX a rename refused for permission is not retried and exits 46 (not permitted), not 48', { skip: windows ? 'Windows retries EPERM and EACCES while Defender or an indexer holds the file' : false }, () => fixture(({ folder, file, run }) => {
  fs.writeFileSync(file, JSON.stringify(login), { mode: 0o600 })
  const preload = faultPreload(folder)
  for (const code of ['EACCES', 'EPERM']) {
    const started = Date.now()
    const refused = run('write', { expectedRefreshToken: login.claudeAiOauth.refreshToken, oauth: fresh }, { preload, env: { RICE_TEST_FAULT: 'rename', RICE_TEST_FAILURES: '-1', RICE_TEST_CODE: code } })
    assert.equal(refused.status, 46, code)
    assert.equal(renames(refused.stderr), 1, `${code} is not retried`)
    assert.ok(Date.now() - started < 2500, `${code} fails at once`)
    assert.deepEqual(readJson(file), login)
    assert.deepEqual(fs.readdirSync(folder).sort(), ['.credentials.json', 'fault-preload.cjs'])
  }
}))

test('a full disk exits 49 and leaves no temporary file', () => fixture(({ folder, file, run }) => {
  fs.writeFileSync(file, JSON.stringify(login), { mode: 0o600 })
  const preload = faultPreload(folder)
  const full = run('write', { expectedRefreshToken: login.claudeAiOauth.refreshToken, oauth: fresh }, { preload, env: { RICE_TEST_FAULT: 'nospace' } })
  assert.equal(full.status, 49)
  assert.deepEqual(readJson(file), login)
  assert.deepEqual(fs.readdirSync(folder).sort(), ['.credentials.json', 'fault-preload.cjs'])
}))

test('a renewal chain whose store writes fail keeps its first base, and the final save and clear leave only the store (fault injection)', () => fixture(({ folder, file, run }) => {
  fs.writeFileSync(file, JSON.stringify(login), { mode: 0o600 })
  const preload = faultPreload(folder)
  const failing = { preload, env: { RICE_TEST_FAULT: 'rename', RICE_TEST_FAILURES: '-1', RICE_TEST_CODE: 'EROFS' } }
  const first = { accessToken: 'fixture-access-1', refreshToken: 'fixture-refresh-1', expiresAt: 3_000_000 }
  const second = { accessToken: 'fixture-access-2', refreshToken: 'fixture-refresh-2', expiresAt: 0 }
  // Renewal 1 (S0 to S1): written ahead, then the store write fails.
  assert.equal(run('pending', { base: 'fixture-refresh', credential: { claudeAiOauth: first } }).status, 0)
  assert.equal(run('write', { expectedRefreshToken: 'fixture-refresh', oauth: first }, failing).status, 49)
  assert.equal(JSON.parse(run('read').stdout).claudeAiOauth.refreshToken, first.refreshToken)
  // Renewal 2 (S1 to S2) keeps S0 as the base and compares the store against S0, which it still holds.
  assert.equal(run('pending', { base: 'fixture-refresh', credential: { claudeAiOauth: second } }).status, 0)
  assert.equal(run('write', { expectedRefreshToken: 'fixture-refresh', oauth: second }, failing).status, 49)
  assert.deepEqual(readJson(`${file}.rice-pending`), pendingDocument('fixture-refresh', second))
  assert.deepEqual(readJson(file), login, 'the store still holds S0')
  assert.equal(JSON.parse(run('read').stdout).claudeAiOauth.refreshToken, second.refreshToken, 'a salvaged S2 (expiresAt 0) is used by its base')
  // The old defect: a write expecting S1 fails with 47; it must not delete the pending file holding S2.
  assert.equal(run('write', { expectedRefreshToken: first.refreshToken, oauth: second }).status, 47)
  assert.deepEqual(readJson(`${file}.rice-pending`), pendingDocument('fixture-refresh', second))
  // The store accepts writes again.
  assert.equal(run('write', { expectedRefreshToken: 'fixture-refresh', oauth: second }).status, 0)
  assert.equal(run('clearpending', { base: 'fixture-refresh', tokens: ['fixture-refresh', first.refreshToken, second.refreshToken] }).status, 0)
  assert.equal(readJson(file).claudeAiOauth.refreshToken, second.refreshToken)
  assert.deepEqual(fs.readdirSync(folder).sort(), ['.credentials.json', 'fault-preload.cjs'])
}))

test('stdin that a non-blocking pipe answers with EAGAIN is read again until its end', () => fixture(({ folder, file, run }) => {
  fs.writeFileSync(file, JSON.stringify(login), { mode: 0o600 })
  const preload = faultPreload(folder)
  const written = run('pending', { base: 'fixture-refresh', credential: { claudeAiOauth: fresh } }, { preload, env: { RICE_TEST_EAGAIN: '3' } })
  assert.equal(written.status, 0, written.stderr)
  assert.equal(written.stderr.split('\n').filter(event => event === 'fault:eagain').length, 3)
  assert.deepEqual(readJson(`${file}.rice-pending`), pendingDocument('fixture-refresh', fresh))
  const saved = run('write', { expectedRefreshToken: 'fixture-refresh', oauth: fresh }, { preload, env: { RICE_TEST_EAGAIN: '2' } })
  assert.equal(saved.status, 0, saved.stderr)
  assert.equal(readJson(file).claudeAiOauth.refreshToken, fresh.refreshToken)
  // stdin is read in a loop over fs.readSync, never with one readFileSync(0) that EAGAIN would end.
  assert.equal(/readFileSync\(0/.test(payload), false)
  assert.match(payload, /code === 'EAGAIN'/)
}))

/** Runs the program in a sandbox with a fake `process`, to exercise the guards an old or foreign Node would hit. */
function sandboxed(program, { node, platform, argv }) {
  const fake = { argv: ['node', ...argv], versions: { node }, platform, exitCode: undefined, stdout: { write: () => true }, stderr: { write: () => true } }
  const require = createRequire(import.meta.url)
  vm.runInNewContext(program, { process: fake, require, Buffer })
  return fake.exitCode
}

test('Node older than 22 reaches the version guard (exit 50), and a Windows node.exe from WSL exits 51', () => {
  assert.equal(sandboxed(payload, { node: '12.22.9', platform: 'linux', argv: ['read', '/home/me/.claude/.credentials.json'] }), 50)
  assert.equal(sandboxed(payload, { node: '22.12.0', platform: 'win32', argv: ['read', '/home/me/.claude/.credentials.json'] }), 51)
  assert.equal(sandboxed(payload, { node: '12.22.9', platform: 'win32', argv: ['read', '/home/me/.claude/.credentials.json'] }), 51)
  assert.equal(sandboxed(payload, { node: '22.12.0', platform: 'linux', argv: ['read', 'relative/.credentials.json'] }), 46)
})

// Native Windows renewal locks run this static program because Windows has no /bin/sh.
const lockText = fs.readFileSync(new URL('../hooks/lock.ts', import.meta.url), 'utf8')
const lockPayload = /const NODE_LOCK = String\.raw`([\s\S]*?)`\n/.exec(lockText)?.[1]
assert.ok(lockPayload, 'native lock program must be present')
new vm.Script(lockPayload)

/**
 * ES5 only: Ubuntu 22.04's Node 12 must parse the programs to reach their guards.
 * The current Node checks the syntax (node --check); the scan rejects the
 * ES2015+ forms that an ES5 parser would refuse.
 */
const ES2015_FORMS = [
  [/=>/, 'arrow function'], [/\?\./, 'optional chaining'], [/\?\?/, 'nullish coalescing'], [/`/, 'template literal'],
  [/\$\{/, 'template substitution'], [/\b(?:let|const|class)\s/, 'let, const or class'], [/\.\.\./, 'spread or rest'],
  [/\bcatch\s*\{/, 'optional catch binding'], [/\bnode:/, 'node: specifier'], [/\b0[oObB]\d/, 'octal or binary literal'],
  [/\d+n\b/, 'BigInt literal'], [/\basync\b|\bawait\b|function\s*\*/, 'async or generator'], [/\*\*/, 'exponent operator'],
]

test('the native file and lock programs are ES5 and pass node --check, and the darwin writer passes sh -n', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rice-account-syntax-test-'))
  try {
    for (const [name, program] of [['native-file.js', payload], ['native-lock.js', lockPayload]]) {
      for (const [form, label] of ES2015_FORMS) assert.equal(form.test(program), false, `${name} uses ${label}`)
      const file = path.join(folder, name)
      fs.writeFileSync(file, program)
      const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 15_000 })
      assert.equal(checked.status, 0, checked.stderr)
    }
    if (!windows) {
      const checked = spawnSync('/bin/sh', ['-n', '-c', pendingScript], { encoding: 'utf8', timeout: 15_000 })
      assert.equal(checked.status, 0, checked.stderr)
    }
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('the native lock program makes one lock directory, refuses a held lock, touches and removes it idempotently', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rice-account-lock-test-'))
  const lock = path.join(folder, 'locks', 'personal-live.lock')
  const run = (operation, target = lock) => spawnSync(process.execPath, ['-e', lockPayload, operation, target], { encoding: 'utf8', timeout: 15_000 })
  try {
    assert.equal(run('make').status, 0)
    assert.equal(fs.statSync(lock).isDirectory(), true)
    const held = run('make')
    assert.notEqual(held.status, 0)
    assert.equal(held.stderr, 'EEXIST')
    const old = new Date(Date.now() - 120_000)
    fs.utimesSync(lock, old, old)
    assert.equal(run('touch').status, 0)
    assert.ok(Date.now() - fs.statSync(lock).mtimeMs < 60_000, 'touch renews the lock time')
    assert.equal(run('remove').status, 0)
    assert.equal(fs.existsSync(lock), false)
    assert.equal(run('remove').status, 0, 'an already removed lock is not an error')
    assert.notEqual(run('touch').status, 0, 'a removed lock is not recreated by a heartbeat')
    assert.notEqual(run('make', 'relative.lock').status, 0)
    assert.notEqual(run('unknown').status, 0)
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('the darwin pending writer gives each writer its own exclusive temporary name and removes only its stale ones', { skip: windows ? 'the darwin pending writer is a POSIX shell program' : false }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rice-account-pending-sh-test-'))
  const pending = path.join(folder, '.credentials.json.rice-pending')
  const temporary = /^\.credentials\.json\.rice-pending\.tmp\.(\d+)\.([0-9a-f]{16})$/
  try {
    const staleFixed = `${pending}.tmp`
    const staleUnique = `${pending}.tmp.123.00112233aabbccdd`
    const young = `${pending}.tmp.456.ffeeddccbbaa9988`
    const unrelated = path.join(folder, 'notes.tmp.1')
    for (const file of [staleFixed, staleUnique, young, unrelated]) fs.writeFileSync(file, '{"fixture-partial', { mode: 0o600 })
    for (const file of [staleFixed, staleUnique, unrelated]) ageFile(file)
    const start = () => {
      const child = spawn('/bin/sh', ['-c', pendingScript, pending], { stdio: ['pipe', 'ignore', 'ignore'] })
      return { child, exit: new Promise(resolve => child.on('close', resolve)) }
    }
    const first = start()
    const second = start()
    first.child.stdin.write('{"version":2,')
    second.child.stdin.write('{"version":2,')
    // Both writers now wait for the rest of stdin, each with its own temporary file.
    let names = []
    for (let tries = 0; tries < 400 && names.length < 2; tries += 1) {
      await new Promise(resolve => setTimeout(resolve, 25))
      names = fs.readdirSync(folder).filter(name => temporary.test(name) && name !== path.basename(young))
    }
    assert.equal(names.length, 2, `two writers keep two temporary files (${names.join(', ')})`)
    assert.deepEqual(names.map(name => temporary.exec(name)[1]).sort(), [String(first.child.pid), String(second.child.pid)].sort(), 'each name carries its writer\'s process id')
    assert.notEqual(temporary.exec(names[0])[2], temporary.exec(names[1])[2], 'and its own random suffix')
    first.child.stdin.end('"base":"fixture-first-base"}')
    assert.equal(await first.exit, 0)
    second.child.stdin.end('"base":"fixture-second-base"}')
    assert.equal(await second.exit, 0)
    assert.equal(readJson(pending).base, 'fixture-second-base')
    assert.equal(fs.statSync(pending).mode & 0o777, 0o600)
    assert.deepEqual(fs.readdirSync(folder).sort(), [path.basename(pending), path.basename(young), 'notes.tmp.1'].sort())
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('no program operation is named like a Node subcommand, which Node would run as its debugger instead of the program', () => {
  const operations = [...payload.matchAll(/operation === '([a-z]+)'/g)].map(match => match[1])
  assert.ok(operations.length >= 5, operations.join(','))
  for (const operation of operations) assert.ok(!['inspect', 'debug', 'repl', 'test'].includes(operation), operation)
})
