import { expect, test } from 'claude-code/testing'

import { addAccount, defaultConfig, KINDS, LOGIN_NAME, parseConfig, pathsFor, removeAccount, serializeConfig } from '../hooks/config'

const paths = pathsFor('/Users/me/.claude/')

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
