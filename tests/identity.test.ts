import { expect, test } from 'claude-code/testing'

import type { Machine } from '../hooks/accounts'
import { accountIdentity } from '../hooks/identity'
import type { Io } from '../hooks/io'
import type { Credential } from '../hooks/keychain'

const machine: Machine = { claudeDir: '/home/me/.claude', user: 'me', storage: {} }

function credential(subscriptionType?: string, rateLimitTier?: string): Credential {
  return { claudeAiOauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: 1, subscriptionType, rateLimitTier } }
}

function metadata(email: string): string {
  return JSON.stringify({ oauthAccount: { emailAddress: email } })
}

function result(stdout = '', exitCode = 0) {
  return { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

function fixture(
  credentials: Record<string, Credential | 'unreadable'> = {},
  documents: Record<string, string> = {},
) {
  const commands: (readonly string[])[] = []
  const reads: string[] = []
  const io: Io = {
    run: async argv => {
      commands.push(argv)
      if (argv[0] === '/usr/bin/uname') return result('Linux\n')
      if (argv[0] !== 'node' || argv[3] !== 'read') throw new Error('unexpected process')
      const path = argv[4]
      if (!path) throw new Error('missing credential path')
      const document = credentials[path]
      if (document === 'unreadable') return result('', 46)
      return document ? result(JSON.stringify(document)) : result('', 44)
    },
    read: async path => {
      reads.push(path)
      const document = Object.hasOwn(documents, path) ? documents[path] : undefined
      if (document === undefined) throw new Error('metadata absent')
      return document
    },
    write: async () => { throw new Error('identity must not write') },
    exists: async () => { throw new Error('unexpected exists') },
    stat: async () => { throw new Error('unexpected stat') },
    env: async name => name === 'HOME' ? '/home/me' : undefined,
    now: async () => { throw new Error('identity must not refresh') },
    sleep: async () => { throw new Error('identity must not lock or refresh') },
    fetch: async () => { throw new Error('identity must not make provider requests') },
    log: () => { throw new Error('identity must not log credential material') },
  }

  return { io, commands, reads }
}

test('machine login reads native HOME metadata and its own credential tier', async () => {
  const world = fixture({ '/home/me/.claude/.credentials.json': credential('pro') }, {
    '/home/me/.claude.json': metadata('machine@example.test'),
    '/home/me/.claude/.claude.json': metadata('fallback@example.test'),
  })
  expect(await accountIdentity(world.io, { kind: 'login' }, machine)).toEqual({ email: 'machine@example.test', tier: 'Pro' })
  expect(world.reads).toEqual(['/home/me/.claude.json'])
  expect(world.commands[1]?.[4]).toBe('/home/me/.claude/.credentials.json')
})

test('native Windows machine login reads USERPROFILE metadata when HOME is unset', async () => {
  const profile = 'C:\\Users\\me'
  const world = fixture({}, { [`${profile}/.claude.json`]: metadata('windows@example.test') })
  world.io.env = async name => name === 'OS' ? 'Windows_NT' : name === 'USERPROFILE' ? profile : undefined
  world.io.run = async argv => {
    world.commands.push(argv)
    if (argv[0] === 'node' && argv[3] === 'read' && argv[4] === `${profile}\\.claude/.credentials.json`) return result(JSON.stringify(credential('pro')))
    throw new Error('unexpected process')
  }
  const windows: Machine = { claudeDir: `${profile}\\.claude`, user: 'me', storage: {} }
  expect(await accountIdentity(world.io, { kind: 'login' }, windows)).toEqual({ email: 'windows@example.test', tier: 'Pro' })
  expect(world.reads).toEqual([`${profile}/.claude.json`])
})

test('explicit machine config uses that config metadata without reading another login', async () => {
  const configured: Machine = { claudeDir: '/profiles/work', user: 'me', storage: { configDir: '/profiles/work' } }
  const world = fixture({ '/profiles/work/.credentials.json': credential('enterprise') }, {
    '/profiles/work/.claude.json': metadata('work@example.test'),
    '/home/me/.claude.json': metadata('personal@example.test'),
  })
  expect(await accountIdentity(world.io, { kind: 'login' }, configured)).toEqual({ email: 'work@example.test', tier: 'Enterprise' })
  expect(world.reads).toEqual(['/profiles/work/.claude.json'])
})

test('default machine metadata supports one bounded legacy config-directory fallback', async () => {
  const world = fixture({ '/home/me/.claude/.credentials.json': credential('team') }, {
    '/home/me/.claude/.claude.json': metadata('legacy@example.test'),
  })
  expect(await accountIdentity(world.io, { kind: 'login' }, machine)).toEqual({ email: 'legacy@example.test', tier: 'Team' })
  expect(world.reads).toEqual(['/home/me/.claude.json', '/home/me/.claude/.claude.json'])
})

test('isolated account email and tier stay separate for several saved accounts', async () => {
  const world = fixture({
    '/isolated/personal/.credentials.json': credential('max', 'default_claude_max_20x'),
    '/isolated/work/.credentials.json': credential('team', 'default_claude_max_5x'),
  }, {
    '/isolated/personal/.claude.json': metadata('personal@example.test'),
    '/isolated/work/.claude.json': metadata('work@example.test'),
    '/home/me/.claude.json': metadata('machine@example.test'),
  })
  expect(await accountIdentity(world.io, { kind: 'claudeai', loginDir: '/isolated/personal/' }, machine)).toEqual({ email: 'personal@example.test', tier: 'Max (20x)' })
  expect(await accountIdentity(world.io, { kind: 'claudeai', loginDir: '/isolated/work' }, machine)).toEqual({ email: 'work@example.test', tier: 'Team' })
  expect(world.reads).toEqual(['/isolated/personal/.claude.json', '/isolated/work/.claude.json'])
})

for (const [subscription, quota, tier] of [
  ['free', undefined, 'Free'], ['pro', undefined, 'Pro'], ['max', undefined, 'Max'],
  ['max', 'default_claude_max_5x', 'Max (5x)'], ['max', 'default_claude_max_20x', 'Max (20x)'],
  ['max', 'unrecognized_quota', 'Max'], ['team', 'default_claude_max_5x', 'Team'],
  ['enterprise', undefined, 'Enterprise'], [undefined, 'default_claude_max_5x', 'Unknown'],
  ['new_plan', 'default_claude_max_20x', 'Unknown'],
]) {
  test(`cached subscription ${subscription ?? 'missing'} and quota ${quota ?? 'missing'} display ${tier}`, async () => {
    const world = fixture({ '/isolated/.credentials.json': credential(subscription, quota) }, {
      '/isolated/.claude.json': metadata('saved@example.test'),
    })
    expect(await accountIdentity(world.io, { kind: 'claudeai', loginDir: '/isolated' }, machine)).toEqual({ email: 'saved@example.test', tier })
  })
}

test('missing or unreadable credentials never display stale metadata as a signed-in identity', async () => {
  const missing = fixture({}, { '/isolated/.claude.json': metadata('stale@example.test') })
  expect(await accountIdentity(missing.io, { kind: 'claudeai', loginDir: '/isolated' }, machine)).toEqual({ email: 'Not signed in', tier: 'Unknown' })
  expect(missing.reads).toEqual([])
  const inaccessible = fixture({ '/isolated/.credentials.json': 'unreadable' }, { '/isolated/.claude.json': metadata('stale@example.test') })
  expect(await accountIdentity(inaccessible.io, { kind: 'claudeai', loginDir: '/isolated' }, machine)).toEqual({ email: 'Unknown', tier: 'Unknown' })
  expect(inaccessible.reads).toEqual([])
})

test('missing or malformed isolated metadata never borrows the machine email', async () => {
  for (const document of [undefined, '{invalid', 'null', metadata(''), metadata('bad\nemail')]) {
    const world = fixture({ '/isolated/.credentials.json': credential('pro') }, {
      '/home/me/.claude.json': metadata('another@example.test'),
      ...(document === undefined ? {} : { '/isolated/.claude.json': document }),
    })
    expect(await accountIdentity(world.io, { kind: 'claudeai', loginDir: '/isolated' }, machine)).toEqual({ email: 'Unknown', tier: 'Pro' })
    expect(world.reads).toEqual(['/isolated/.claude.json'])
  }
})

test('macOS machine login reads its normal keychain and HOME metadata without exposing token bytes', async () => {
  const world = fixture({}, { '/Users/me/.claude.json': metadata('mac@example.test') })
  world.io.env = async name => name === 'HOME' ? '/Users/me' : undefined
  world.io.run = async argv => {
    world.commands.push(argv)
    if (argv[0] === '/usr/bin/uname') return result('Darwin\n')
    if (argv[0] === '/usr/bin/security') return result(JSON.stringify(credential('pro')))
    throw new Error('unexpected process')
  }
  const identity = await accountIdentity(world.io, { kind: 'login' }, { claudeDir: '/Users/me/.claude', user: 'me', storage: {} })
  expect(identity).toEqual({ email: 'mac@example.test', tier: 'Pro' })
  expect(world.commands[1]).toEqual(['/usr/bin/security', 'find-generic-password', '-s', 'Claude Code-credentials', '-a', 'me', '-w'])
  expect(JSON.stringify(identity).includes('fixture-access')).toBe(false)
  expect(JSON.stringify(identity).includes('fixture-refresh')).toBe(false)
})

test('API, cloud and setup-token rows never manufacture an email or read a token for display', async () => {
  const world = fixture()
  for (const [kind, tier] of [
    ['api-key', 'API'], ['gateway', 'Gateway'], ['bedrock', 'AWS Bedrock'],
    ['vertex', 'Google Vertex'], ['foundry', 'Azure Foundry'], ['claudeai-token', 'Unknown'],
  ] as const) {
    expect(await accountIdentity(world.io, { kind }, machine)).toEqual({ email: 'Not available', tier })
  }
  expect(world.commands).toEqual([])
  expect(world.reads).toEqual([])
})
