import { expect, test } from 'claude-code/testing'

import { addAccount, defaultConfig, LOGIN_NAME, parseConfig, pathsFor, removeAccount, serializeConfig } from '../hooks/config'

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
  expect(claudeai.steps[0]).toBe('CLAUDE_CONFIG_DIR="/Users/me/.claude/rice-session-accounts/logins/work" claude auth login --claudeai')
  const key = addAccount(defaultConfig(), 'work-api', 'api-key', { label: 'Work console' }, paths)
  expect(key.config.accounts['work-api']?.secret).toEqual({ service: 'rice-session-accounts', account: 'work-api' })
  expect(key.steps.some(step => step.startsWith('security add-generic-password -U -s rice-session-accounts -a work-api -w'))).toBe(true)
  expect(() => addAccount(defaultConfig(), 'gw', 'gateway', {}, paths)).toThrow()
  expect(() => addAccount(defaultConfig(), 'v', 'vertex', {}, paths)).toThrow()
  expect(() => addAccount(claudeai.config, 'work', 'api-key', {}, paths)).toThrow()
})

test('a saved file reads back the same, and removing the default falls back to the machine login', async () => {
  const added = addAccount(defaultConfig(), 'cloud', 'bedrock', { aws_profile: 'work', region: 'us-east-1' }, paths).config
  const withDefault = { ...added, default: 'cloud' }
  expect(parseConfig(serializeConfig(withDefault)).config).toEqual(withDefault)
  expect(removeAccount(withDefault, 'cloud').default).toBe(LOGIN_NAME)
  expect(() => removeAccount(withDefault, LOGIN_NAME)).toThrow()
})
