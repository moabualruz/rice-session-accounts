import { expect, test } from 'claude-code/testing'

import { addAccount, defaultConfig, isAccountName, KINDS, LOGIN_NAME, parseConfig, pathsFor, removeAccount, RESERVED_NAMES, savedAccount, serializeConfig } from '../hooks/config'

const paths = pathsFor('/Users/me/.claude/')

function errorOf(run: () => unknown): string {
  try { run() } catch (error) { return error instanceof Error ? error.message : String(error) }
  return ''
}

test('new account names are safe folders on every platform and never a command word or object key', () => {
  for (const name of ['work', 'Work-2', 'a.b', 'a_b', 'x', '9lives', 'console', 'conx', 'com10', 'lpt', 'listing', 'user', 'a'.repeat(40)]) {
    expect([name, isAccountName(name)]).toEqual([name, true])
  }
  for (const name of [
    '', '.hidden', '-x', '_x', 'a b', 'a/b', 'a\\b', 'a:b', 'a'.repeat(41), 'naïve', 'work.', 'work..',
    'con', 'CON', 'Con.txt', 'nul', 'nul.tar.gz', 'prn', 'aux', 'com0', 'com1', 'COM9', 'lpt1', 'lpt9.log',
    'list', 'LIST', 'usage', 'check', 'default', 'setup', 'add', 'remove', 'use', 'help', 'login', 'set-default', 'setup-native',
    'constructor', 'toString', 'tostring', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', '__proto__', 'prototype',
  ]) {
    expect([name, isAccountName(name)]).toEqual([name, false])
  }
  for (const word of ['list', 'usage', 'check', 'default', 'setup', 'add', 'remove', 'use', 'help', 'login', 'set-default', 'setup-native', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    expect(RESERVED_NAMES).toContain(word)
  }
})

test('adding a reserved, device or trailing-dot name says why instead of reporting an inherited key', () => {
  expect(errorOf(() => addAccount(defaultConfig(), 'toString', 'claudeai', {}, paths))).toContain('reserved')
  expect(errorOf(() => addAccount(defaultConfig(), 'toString', 'claudeai', {}, paths))).not.toContain('undefined')
  expect(errorOf(() => addAccount(defaultConfig(), 'hasOwnProperty', 'claudeai-token', {}, paths))).toContain('reserved')
  expect(errorOf(() => addAccount(defaultConfig(), 'list', 'claudeai', {}, paths))).toContain('reserved')
  expect(errorOf(() => addAccount(defaultConfig(), 'nul.txt', 'claudeai', {}, paths))).toContain('Windows device name')
  expect(errorOf(() => addAccount(defaultConfig(), 'work.', 'claudeai', {}, paths))).toContain('ends with a dot')
  expect(errorOf(() => addAccount(defaultConfig(), '../escape', 'claudeai', {}, paths))).toContain('not a usable name')
  expect(errorOf(() => removeAccount(defaultConfig(), 'toString'))).toContain('no account named toString')
  expect(savedAccount(defaultConfig(), 'constructor')).toBe(undefined)
})

test('names that differ only in letter case cannot be added, and existing pairs are both kept with a note', () => {
  const work = addAccount(defaultConfig(), 'work', 'claudeai', {}, paths).config
  expect(errorOf(() => addAccount(work, 'Work', 'claudeai', {}, paths))).toContain('only in letter case')
  expect(errorOf(() => addAccount(work, 'WORK', 'claudeai-token', {}, paths))).toContain('work')
  expect(errorOf(() => addAccount(defaultConfig(), 'Login', 'claudeai', {}, paths))).toContain('reserved')
  const loaded = parseConfig(JSON.stringify({ accounts: { Work: { kind: 'claudeai', loginDir: '/x/Work' }, work: { kind: 'claudeai', loginDir: '/x/work' } } }))
  expect(Object.keys(loaded.config.accounts).sort()).toEqual(['Work', 'login', 'work'])
  expect(loaded.problems).toEqual([])
  expect(loaded.notes.length).toBe(1)
  expect(loaded.notes[0]).toContain('Work')
  expect(loaded.notes[0]).toContain('work')
  expect(loaded.notes[0]).toContain('letter case')
})

test('accounts.json keys never resolve through inherited object properties', () => {
  const loaded = parseConfig('{"default":"constructor","accounts":{"__proto__":{"kind":"claudeai","loginDir":"/x"},"work":{"kind":"claudeai","loginDir":"/x/work","models":{"constructor":"fixture"}}}}')
  expect(loaded.config.default).toBe(LOGIN_NAME)
  expect(loaded.problems.some(problem => problem.includes('default names no saved account: constructor'))).toBe(true)
  expect(loaded.problems.some(problem => problem.includes('__proto__'))).toBe(true)
  const lookup = (record: object | undefined, key: string): unknown => (record as Record<string, unknown> | undefined)?.[key]
  expect(Object.getPrototypeOf(loaded.config.accounts)).toBe(null)
  expect(lookup(loaded.config.accounts, 'toString')).toBe(undefined)
  expect(lookup(loaded.config.accounts, 'hasOwnProperty')).toBe(undefined)
  expect(lookup(loaded.config.accounts.work?.models, 'constructor')).toBe('fixture')
  expect(lookup(loaded.config.accounts.work?.models, 'toString')).toBe(undefined)
  expect(Object.getPrototypeOf(addAccount(loaded.config, 'other', 'claudeai', {}, paths).config.accounts)).toBe(null)
  expect(Object.getPrototypeOf(removeAccount(loaded.config, 'work').accounts)).toBe(null)
  for (const text of ['[]', '"text"', 'null', '{"accounts":[{"kind":"claudeai"}]}', '{"accounts":{"work":null}}']) {
    expect(Object.keys(parseConfig(text).config.accounts)).toEqual([LOGIN_NAME])
  }
})

test('an existing account whose name is now reserved keeps working and is reported with one note each', () => {
  const text = JSON.stringify({
    default: 'list',
    accounts: {
      list: { kind: 'claudeai', loginDir: '/x/logins/list' },
      toString: { kind: 'claudeai-token', secret: { service: 'rice-session-accounts', account: 'toString' } },
      con: { kind: 'claudeai', loginDir: '/x/logins/con' },
      plain: { kind: 'claudeai', loginDir: '/x/logins/plain' },
    },
  })
  const loaded = parseConfig(text)
  expect(loaded.problems).toEqual([])
  expect(loaded.config.default).toBe('list')
  expect(Object.keys(loaded.config.accounts).sort()).toEqual(['con', 'list', 'login', 'plain', 'toString'])
  expect(loaded.notes.length).toBe(3)
  for (const name of ['list', 'toString', 'con']) {
    const note = loaded.notes.find(each => each.startsWith(`${name} `)) ?? ''
    expect(note).toContain('keeps working')
    expect(note).toContain(`/rice-account use ${name}`)
    expect(note.includes('\n')).toBe(false)
  }
  expect(savedAccount(loaded.config, 'toString')?.kind).toBe('claudeai-token')
  expect(addAccount(loaded.config, 'list', 'claudeai', {}, paths)).toEqual({ config: loaded.config, steps: [] })
  expect(JSON.parse(serializeConfig(loaded.config)).accounts.toString.kind).toBe('claudeai-token')
  const removed = removeAccount(loaded.config, 'list')
  expect(removed.default).toBe(LOGIN_NAME)
  expect(Object.keys(removed.accounts).sort()).toEqual(['con', 'login', 'plain', 'toString'])
  expect(Object.keys(removeAccount(loaded.config, 'toString').accounts).includes('toString')).toBe(false)
})

test('a missing or broken file still offers the machine login', async () => {
  expect(Object.keys(defaultConfig().accounts)).toEqual([LOGIN_NAME])
  const broken = parseConfig('{not json')
  expect(broken.config.default).toBe(LOGIN_NAME)
  expect(broken.problems.length).toBe(1)
})

test('bad accounts are skipped and said, good ones kept', async () => {
  const { config, problems } = parseConfig(
    JSON.stringify({
      default: 'work',
      accounts: {
        work: { kind: 'claudeai', loginDir: '/x/logins/work' },
        nokey: { kind: 'api-key' },
        odd: { kind: 'carrier-pigeon' },
        'bad name': { kind: 'bedrock' },
      },
    }),
  )
  expect(Object.keys(config.accounts).sort()).toEqual(['login', 'work'])
  expect(config.default).toBe('work')
  expect(problems.length).toBe(3)
})

test('adding an account names the folder and keychain item and never asks for a secret in the session', async () => {
  const claudeai = addAccount(defaultConfig(), 'work', 'claudeai', {}, paths)
  expect(claudeai.config.accounts.work?.loginDir).toBe('/Users/me/.claude/rice-session-accounts/logins/work')
  expect(claudeai.steps[0]).toContain('terminal setup helper')
  const token = addAccount(defaultConfig(), 'work-token', 'claudeai-token', { label: 'Work OAuth token' }, paths)
  expect(token.config.accounts['work-token']?.secret).toEqual({ service: 'rice-session-accounts', account: 'work-token' })
  expect(token.steps.some(step => step.includes('without echoing'))).toBe(true)
  expect(KINDS).toEqual(['login', 'claudeai', 'claudeai-token'])
  expect(() => addAccount(defaultConfig(), 'api', 'api-key', {}, paths)).toThrow('OAuth accounts only')
  expect(() => addAccount(defaultConfig(), 'gw', 'gateway', {}, paths)).toThrow()
  expect(() => addAccount(defaultConfig(), 'v', 'vertex', {}, paths)).toThrow()
  expect(() => addAccount(claudeai.config, 'work', 'claudeai-token', {}, paths)).toThrow()
})

test('a saved file reads back the same, and removing the default falls back to the machine login', async () => {
  const added = addAccount(defaultConfig(), 'work', 'claudeai', {}, paths).config
  const withDefault = { ...added, default: 'work' }
  expect(parseConfig(serializeConfig(withDefault)).config).toEqual(withDefault)
  expect(removeAccount(withDefault, 'work').default).toBe(LOGIN_NAME)
  expect(() => removeAccount(withDefault, LOGIN_NAME)).toThrow()
})

test('OAuth account edits preserve legacy provider metadata and model maps verbatim', async () => {
  const provider = {
    kind: 'bedrock', label: 'Preserved provider', awsProfile: 'work', region: 'us-east-1',
    models: { sonnet: 'provider-inference-profile', opus: 'provider-opus-profile' },
    customMetadata: { revision: 4, scopes: ['first', 'second'], options: { enabled: true } },
  }
  const incompleteProvider = { kind: 'api-key', customMetadata: ['preserve even without a credential reference'] }
  const loaded = parseConfig(JSON.stringify({ default: LOGIN_NAME, accounts: { cloud: provider, incomplete: incompleteProvider } }))
  const added = addAccount(loaded.config, 'personal', 'claudeai', {}, paths)
  const saved = JSON.parse(serializeConfig(added.config))
  expect(saved.accounts.cloud).toEqual(provider)
  expect(saved.accounts.incomplete).toEqual(incompleteProvider)
  expect(saved.accounts.personal.kind).toBe('claudeai')
  expect(saved.accounts.personal.loginDir).toBe(paths.loginDir('personal'))
  const removed = JSON.parse(serializeConfig(removeAccount(added.config, 'personal')))
  expect(removed.accounts.cloud).toEqual(provider)
  expect(removed.accounts.incomplete).toEqual(incompleteProvider)
  expect(() => addAccount(loaded.config, 'cloud', 'claudeai', {}, paths)).toThrow('preserved provider entry')
})
