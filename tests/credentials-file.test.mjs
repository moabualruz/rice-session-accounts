import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
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
  const run = (operation, input, options = {}) => spawnSync(process.execPath, [...(options.preload ? ['--require', options.preload] : []), '-e', payload, operation, file], {
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

test('the native credential program reads and rotates a real file atomically with exact mode 0600', () => fixture(({ folder, file, run }) => {
  assert.equal(run('read').status, 44)
  fs.writeFileSync(file, JSON.stringify(login), { mode: 0o644 })
  const before = fs.statSync(file)
  assert.deepEqual(JSON.parse(run('read').stdout), login)
  const saved = run('write', { expectedRefreshToken: login.claudeAiOauth.refreshToken, oauth: fresh })
  assert.equal(saved.status, 0)
  const expected = { ...login, claudeAiOauth: { ...login.claudeAiOauth, ...fresh } }
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

test('a write to a missing store reports only ENOENT, so the renewal is not mistaken for a saved one', () => fixture(({ file, run }) => {
  assert.equal(run('write', { expectedRefreshToken: 'fixture-refresh', oauth: fresh }).status, 44)
  assert.equal(fs.existsSync(file), false)
}))

test('the pending write keeps only the renewed grant in an owner-only file beside the store', () => fixture(({ folder, file, run }) => {
  fs.writeFileSync(file, JSON.stringify(login), { mode: 0o600 })
  const written = run('pending', { claudeAiOauth: { ...fresh, extra: 'not kept' } })
  assert.equal(written.status, 0)
  assert.equal(written.stdout, '')
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.rice-pending`, 'utf8')), { claudeAiOauth: fresh })
  if (process.platform !== 'win32') assert.equal(fs.statSync(`${file}.rice-pending`).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), login, 'the store is untouched by a pending write')
  assert.deepEqual(fs.readdirSync(folder).sort(), ['.credentials.json', '.credentials.json.rice-pending'])
  assert.equal(run('pending', { claudeAiOauth: { accessToken: 'x' } }).status, 46)
}))

test('a read adopts a newer pending renewal into the store, keeps unrelated fields and removes the pending file', () => fixture(({ folder, file, run }) => {
  fs.writeFileSync(file, JSON.stringify(login), { mode: 0o600 })
  fs.writeFileSync(`${file}.rice-pending`, JSON.stringify({ claudeAiOauth: fresh }), { mode: 0o600 })
  const read = run('read')
  assert.equal(read.status, 0)
  const expected = { ...login, claudeAiOauth: { ...login.claudeAiOauth, ...fresh } }
  assert.deepEqual(JSON.parse(read.stdout), expected)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), expected)
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(fs.readdirSync(folder), ['.credentials.json'])
}))

test('a pending renewal no newer than the store is removed; an unparseable one is kept and ignored', () => fixture(({ folder, file, run }) => {
  const current = { ...login, claudeAiOauth: { ...login.claudeAiOauth, ...fresh } }
  fs.writeFileSync(file, JSON.stringify(current), { mode: 0o600 })
  fs.writeFileSync(`${file}.rice-pending`, JSON.stringify({ claudeAiOauth: login.claudeAiOauth }), { mode: 0o600 })
  assert.deepEqual(JSON.parse(run('read').stdout), current)
  assert.deepEqual(fs.readdirSync(folder), ['.credentials.json'])
  fs.writeFileSync(`${file}.rice-pending`, '{"fixture-partial', { mode: 0o600 })
  const read = run('read')
  assert.equal(read.status, 0)
  assert.deepEqual(JSON.parse(read.stdout), current)
  assert.equal(fs.existsSync(`${file}.rice-pending`), true)
}))

test('a successful write removes the pending copy of the same renewal; a refused one removes only a superseded copy', () => fixture(({ folder, file, run }) => {
  fs.writeFileSync(file, JSON.stringify(login), { mode: 0o600 })
  assert.equal(run('pending', { claudeAiOauth: fresh }).status, 0)
  assert.equal(run('write', { expectedRefreshToken: login.claudeAiOauth.refreshToken, oauth: fresh }).status, 0)
  assert.deepEqual(fs.readdirSync(folder), ['.credentials.json'])
  // Another writer saved a different grant: this session's pending copy is discarded with the refusal.
  const other = { ...login, claudeAiOauth: { ...login.claudeAiOauth, refreshToken: 'other-grant', expiresAt: 9_000_000 } }
  fs.writeFileSync(file, JSON.stringify(other), { mode: 0o600 })
  const mine = { accessToken: 'mine-access', refreshToken: 'mine-grant', expiresAt: 3_000_000 }
  assert.equal(run('pending', { claudeAiOauth: mine }).status, 0)
  assert.equal(run('write', { expectedRefreshToken: fresh.refreshToken, oauth: mine }).status, 47)
  assert.deepEqual(fs.readdirSync(folder), ['.credentials.json'])
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), other)
}))

test('temporary copies left by a killed write are adopted when newer and removed after five minutes; young ones are left alone', () => fixture(({ folder, file, run }) => {
  fs.writeFileSync(file, JSON.stringify(login), { mode: 0o600 })
  const old = new Date(Date.now() - 10 * 60 * 1000)
  const legacy = `${file}.rice-4242-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0`
  fs.writeFileSync(legacy, JSON.stringify({ ...login, claudeAiOauth: { ...login.claudeAiOauth, ...fresh } }), { mode: 0o600 })
  fs.utimesSync(legacy, old, old)
  const broken = `${file}.rice-4243-00112233445566778899aabbccddeeff`
  fs.writeFileSync(broken, '{"fixture-partial', { mode: 0o600 })
  fs.utimesSync(broken, old, old)
  const young = `${file}.rice-4244-ffeeddccbbaa99887766554433221100`
  fs.writeFileSync(young, JSON.stringify({ claudeAiOauth: { ...fresh, refreshToken: 'young-grant', expiresAt: 5_000_000 } }), { mode: 0o600 })
  const unrelated = path.join(folder, 'notes.rice-1-not-ours')
  fs.writeFileSync(unrelated, 'kept')
  const read = run('read')
  assert.equal(read.status, 0)
  assert.equal(JSON.parse(read.stdout).claudeAiOauth.refreshToken, fresh.refreshToken)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth.refreshToken, fresh.refreshToken)
  assert.deepEqual(fs.readdirSync(folder).sort(), ['.credentials.json', path.basename(young), 'notes.rice-1-not-ours'].sort())
}))

/** A preload that injects faults into the program's own `fs` calls and reports them on stderr. */
function faultPreload(folder) {
  const preload = path.join(folder, 'fault-preload.cjs')
  fs.writeFileSync(preload, `
const fs = require('fs');
const fault = process.env.RICE_TEST_FAULT;
let failures = Number(process.env.RICE_TEST_FAILURES || '0');
const rename = fs.renameSync, open = fs.openSync, write = fs.writeFileSync;
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
`)
  return preload
}

test('a rename held by antivirus or an indexer is retried, and the folder is synced after it on POSIX', () => fixture(({ folder, file, run }) => {
  fs.writeFileSync(file, JSON.stringify(login), { mode: 0o600 })
  const preload = faultPreload(folder)
  const saved = run('write', { expectedRefreshToken: login.claudeAiOauth.refreshToken, oauth: fresh }, { preload, env: { RICE_TEST_FAULT: 'rename', RICE_TEST_FAILURES: '3', RICE_TEST_CODE: 'EBUSY' } })
  assert.equal(saved.status, 0)
  const events = saved.stderr.split('\n').filter(Boolean)
  assert.equal(events.filter(event => event === 'fault:rename').length, 4)
  if (process.platform !== 'win32') assert.ok(events.lastIndexOf('fault:open-folder') > events.lastIndexOf('fault:rename'), 'the folder is synced after the rename')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth.refreshToken, fresh.refreshToken)
  assert.deepEqual(fs.readdirSync(folder).sort(), ['.credentials.json', 'fault-preload.cjs'])
}))

test('a rename that stays refused for about three seconds exits 48 and leaves the store and no temporary file', () => fixture(({ folder, file, run }) => {
  fs.writeFileSync(file, JSON.stringify(login), { mode: 0o600 })
  const preload = faultPreload(folder)
  const started = Date.now()
  const refused = run('write', { expectedRefreshToken: login.claudeAiOauth.refreshToken, oauth: fresh }, { preload, env: { RICE_TEST_FAULT: 'rename', RICE_TEST_FAILURES: '-1', RICE_TEST_CODE: 'EPERM' } })
  const elapsed = Date.now() - started
  assert.equal(refused.status, 48)
  assert.ok(elapsed >= 2500 && elapsed < 12_000, `retries last about 3 s (took ${elapsed} ms)`)
  assert.equal(refused.stdout, '')
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), login)
  assert.deepEqual(fs.readdirSync(folder).sort(), ['.credentials.json', 'fault-preload.cjs'])
}))

test('a full disk exits 49 and leaves no temporary file', () => fixture(({ folder, file, run }) => {
  fs.writeFileSync(file, JSON.stringify(login), { mode: 0o600 })
  const preload = faultPreload(folder)
  const full = run('write', { expectedRefreshToken: login.claudeAiOauth.refreshToken, oauth: fresh }, { preload, env: { RICE_TEST_FAULT: 'nospace' } })
  assert.equal(full.status, 49)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), login)
  assert.deepEqual(fs.readdirSync(folder).sort(), ['.credentials.json', 'fault-preload.cjs'])
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

test('the native file and lock programs are ES5 and pass node --check', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rice-account-syntax-test-'))
  try {
    for (const [name, program] of [['native-file.js', payload], ['native-lock.js', lockPayload]]) {
      for (const [form, label] of ES2015_FORMS) assert.equal(form.test(program), false, `${name} uses ${label}`)
      const file = path.join(folder, name)
      fs.writeFileSync(file, program)
      const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 15_000 })
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
