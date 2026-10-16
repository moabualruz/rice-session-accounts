import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AUTH_REVISION, observeAccountRevision } from '../native/cache.mjs'
import { installedRoot } from '../native/entry.mjs'
import { readSelection, saveSelection, selectionPath } from '../native/launch.mjs'
import { INITIAL_ACCOUNT, INITIAL_ORIGINALS, MANAGED_AUTH, prepareAccountLaunch } from '../native/startup.mjs'

test('native account boundary resets once and ignores temporary child environment restoration', async () => {
  const environment = { [AUTH_REVISION]: 'login' }
  let resets = 0
  const observed = observeAccountRevision(environment, () => { resets += 1 })
  observed[AUTH_REVISION] = 'account-a'
  await Promise.resolve()
  assert.equal(resets, 1)
  observed.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-token-refresh'
  observed[AUTH_REVISION] = 'account-a'
  await Promise.resolve()
  assert.equal(resets, 1)
  delete observed[AUTH_REVISION]
  observed[AUTH_REVISION] = 'account-a'
  await Promise.resolve()
  assert.equal(resets, 1)
  observed[AUTH_REVISION] = 'account-b'
  await Promise.resolve()
  assert.equal(resets, 2)
  observed[AUTH_REVISION] = 'login'
  await Promise.resolve()
  assert.equal(resets, 3)
})

test('one-time startup auth metadata never enumerates or reappears in descendant environments', () => {
  const target = {}, initial = { [INITIAL_ACCOUNT]: 'personal', [INITIAL_ORIGINALS]: 'fixture-original-auth' }
  const observed = observeAccountRevision(target, () => {}, initial)
  assert.equal(observed[INITIAL_ORIGINALS], 'fixture-original-auth')
  assert.deepEqual({ ...observed }, {})
  delete observed[INITIAL_ORIGINALS]
  observed[INITIAL_ORIGINALS] = 'fixture-original-auth'
  assert.equal(observed[INITIAL_ORIGINALS], undefined)
  assert.equal(Object.hasOwn(target, INITIAL_ORIGINALS), false)
  delete observed[INITIAL_ACCOUNT]
  observed[INITIAL_ACCOUNT] = 'personal'
  assert.deepEqual({ ...observed }, {})
})

test('startup --account selects only auth before resume while preserving machine configuration and baseline in memory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rice-accounts-startup-'))
  try {
    mkdirSync(join(directory, 'rice-session-accounts'))
    writeFileSync(join(directory, 'rice-session-accounts/accounts.json'), JSON.stringify({ accounts: { personal: { kind: 'claudeai', loginDir: '/owned/isolated-login' } } }))
    const environment = { CLAUDE_CONFIG_DIR: directory, ANTHROPIC_API_KEY: 'fixture-machine-key', CLAUDE_CODE_OAUTH_TOKEN: 'fixture-injected', KEEP_SETTING: 'unchanged' }
    const selected = prepareAccountLaunch(['--account', 'personal', '--resume', 'owned-session'], environment, directory)
    assert.deepEqual(selected.args, ['--resume', 'owned-session'])
    assert.equal(selected.env.CLAUDE_CONFIG_DIR, directory)
    assert.equal(selected.env.KEEP_SETTING, 'unchanged')
    assert.equal(selected.env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
    assert.equal(selected.env.ANTHROPIC_API_KEY, undefined)
    assert.equal(selected.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, '/owned/isolated-login')
    assert.equal(selected.env[INITIAL_ACCOUNT], 'personal')
    assert.equal(JSON.parse(selected.env[INITIAL_ORIGINALS]).ANTHROPIC_API_KEY, 'fixture-machine-key')
    assert.equal(environment.ANTHROPIC_API_KEY, 'fixture-machine-key')
    assert.throws(() => prepareAccountLaunch(['--account', 'missing'], environment, directory), /saved claudeai/)
    assert.throws(() => prepareAccountLaunch(['--account', 'personal', '--account', 'personal'], environment, directory), /only once/)
    assert.deepEqual(prepareAccountLaunch(['--', '--account', 'literal-prompt'], environment, directory).args, ['--', '--account', 'literal-prompt'])
    const source = readFileSync(new URL('../hooks/env.ts', import.meta.url), 'utf8').match(/export const MANAGED = \[([\s\S]*?)\] as const/)[1]
    assert.deepEqual(MANAGED_AUTH, [...source.matchAll(/'([^']+)'/g)].map(match => match[1]))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('native selection is durable and refuses malformed or symlinked saved state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rice-accounts-selection-'))
  try {
    assert.equal(readSelection(directory), undefined)
    const value = { format: 1, executable: '/owned/qualified native/claude', claudeVersion: '2.1.299' }
    saveSelection(directory, value)
    assert.deepEqual(readSelection(directory), value)
    writeFileSync(selectionPath(directory), '{malformed')
    assert.throws(() => readSelection(directory), /setup-native/)
    rmSync(selectionPath(directory))
    const target = join(directory, 'unrelated')
    writeFileSync(target, 'untouched')
    symlinkSync(target, selectionPath(directory))
    assert.throws(() => saveSelection(directory, value), /regular file/)
    assert.equal(readFileSync(target, 'utf8'), 'untouched')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('launcher follows the current marketplace installation and project scope', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rice-accounts-entry-'))
  try {
    mkdirSync(join(directory, 'plugins'))
    writeFileSync(join(directory, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: {
      'rice-session-accounts@retired-repair': [{ scope: 'user', installPath: '/retired' }],
      'rice-session-accounts@rice-mods': [
        { scope: 'user', installPath: '/new/cache/0.3.0' },
        { scope: 'project', projectPath: '/owned/project', installPath: '/project/cache/0.3.0' },
      ],
    } }))
    assert.equal(installedRoot(directory, '/unrelated'), '/new/cache/0.3.0')
    assert.equal(installedRoot(directory, '/owned/project/nested'), '/project/cache/0.3.0')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
