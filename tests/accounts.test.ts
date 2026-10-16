import { expect, test } from 'claude-code/testing'

import { freshLogin } from '../hooks/accounts'
import { pathsFor } from '../hooks/config'
import { hostPlatform, nativeCredentialPath, readLogin, readSecret } from '../hooks/credentials'
import type { Io } from '../hooks/io'
import type { Credential } from '../hooks/keychain'

const login: Credential = { claudeAiOauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: 1_000_000 } }

function result(stdout = '', exitCode = 0, stderr = '') {
  return { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false }
}

function fixture(run: Io['run']): Io {
  return {
    run,
    read: async () => { throw new Error('unexpected read') },
    write: async () => { throw new Error('unexpected write') },
    exists: async () => false,
    stat: async () => ({ kind: 'dir', size: 0, mtimeMs: 1, isLink: false }),
    env: async name => name === 'HOME' ? '/home/me' : undefined,
    now: async () => 0,
    sleep: async () => { throw new Error('unexpected sleep') },
    fetch: async () => { throw new Error('unexpected network request') },
    log: () => {},
  }
}

async function errorOf(work: () => Promise<unknown>): Promise<string> {
  try { await work(); return '' } catch (error) { return error instanceof Error ? error.message : 'unknown error' }
}

test('a Linux isolated login reads the native credential file without launching macOS security', async () => {
  const folder = '/home/me/.claude/rice-session-accounts/logins/personal-live'
  const commands: string[][] = []
  const document = { claudeAiOauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: 1_000_000 } }
  const io: Io = {
    run: async argv => {
      commands.push([...argv])
      if (argv[0] === '/usr/bin/uname' && argv[1] === '-s') {
        return { exitCode: 0, stdout: 'Linux\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      }
      if (argv[0] === 'node' && argv[3] === 'read' && argv[4] === `${folder}/.credentials.json`) {
        return { exitCode: 0, stdout: JSON.stringify(document), stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      }
      throw new Error(`unexpected executable on Linux: ${argv[0]}`)
    },
    read: async path => {
      if (path !== `${folder}/.credentials.json`) throw new Error(`unexpected read: ${path}`)
      return JSON.stringify(document)
    },
    write: async () => { throw new Error('unexpected write') },
    exists: async path => path === `${folder}/.credentials.json`,
    stat: async () => { throw new Error('unexpected stat') },
    env: async name => name === 'HOME' ? '/home/me' : undefined,
    now: async () => 0,
    sleep: async () => { throw new Error('unexpected sleep') },
    fetch: async () => { throw new Error('unexpected network request') },
    log: () => {},
  }
  const result = await freshLogin(io, 'personal-live', { kind: 'claudeai', loginDir: folder }, pathsFor('/home/me/.claude'), {
    claudeDir: '/home/me/.claude', user: 'me', storage: {},
  })

  expect(result).toEqual(document)
  expect(commands.some(argv => argv[0] === '/usr/bin/security')).toBe(false)
})

test('Linux platform detection falls back to /bin/uname when /usr/bin/uname is absent', async () => {
  const commands: (readonly string[])[] = []
  const io = fixture(async argv => {
    commands.push(argv)
    if (argv[0] === '/usr/bin/uname') throw new Error('ENOENT')
    if (argv[0] === '/bin/uname') return result('Linux\n')
    throw new Error('unexpected executable')
  })
  expect(await hostPlatform(io)).toBe('linux')
  expect(commands.map(argv => argv[0])).toEqual(['/usr/bin/uname', '/bin/uname'])
})

test('freshLogin renews an isolated native Windows grant without a POSIX shell for its lock', async () => {
  const loginDir = 'C:\\Users\\me\\.claude/rice-session-accounts/logins/personal-live'
  const nativePath = `${loginDir}/.credentials.json`
  const lockPath = 'C:\\Users\\me\\.claude/rice-session-accounts/locks/personal-live.lock'
  const expired = { ...login, claudeAiOauth: { ...login.claudeAiOauth, expiresAt: 1 } }
  const commands: (readonly string[])[] = []
  const io = fixture(async (argv, init) => {
    commands.push(argv)
    if (argv[0] === '/bin/sh' || argv[0] === '/usr/bin/uname') throw new Error('ENOENT: no POSIX executable on native Windows')
    if (argv[0] === 'node' && argv[1] === '-e' && argv.length === 5 && argv[4] === lockPath) return result()
    if (argv[0] === 'node' && argv[3] === 'read') return argv[4] === nativePath ? result(JSON.stringify(expired)) : result('', 44)
    if (argv[0] === 'node' && argv[3] === 'write' && argv[4] === nativePath) {
      const input = JSON.parse(init?.stdin ?? '{}') as { oauth: Credential['claudeAiOauth'] }
      return result(JSON.stringify({ ...expired, claudeAiOauth: { ...expired.claudeAiOauth, ...input.oauth } }))
    }
    throw new Error('unexpected executable')
  })
  io.env = async name => name === 'OS' ? 'Windows_NT' : name === 'USERPROFILE' ? 'C:\\Users\\me' : undefined
  io.fetch = async () => ({ ok: true, status: 200, headers: {}, text: JSON.stringify({ access_token: 'rotated-access', refresh_token: 'rotated-grant', expires_in: 3600 }) })
  const saved = await freshLogin(io, 'personal-live', { kind: 'claudeai', loginDir }, pathsFor('C:\\Users\\me\\.claude'), {
    claudeDir: 'C:\\Users\\me\\.claude', user: 'me', storage: {},
  })
  expect(saved.claudeAiOauth.accessToken).toBe('rotated-access')
  expect(commands.filter(argv => argv[4] === lockPath).map(argv => argv[3])).toEqual(['make', 'remove'])
  expect(commands.some(argv => argv[0] === '/bin/sh' || argv[0] === '/usr/bin/uname')).toBe(false)
})

test('Linux storage directories follow native secure-storage override and empty override semantics', async () => {
  const location = { storage: { configDir: '/profiles/work' }, defaultConfigDir: '/home/me/.claude' }
  expect(nativeCredentialPath(location, '/home/me')).toBe('/profiles/work/.credentials.json')
  expect(nativeCredentialPath({ ...location, storage: { ...location.storage, secureStorageDir: '/separate/auth/' } }, '/home/me')).toBe('/separate/auth/.credentials.json')
  expect(nativeCredentialPath({ ...location, storage: { ...location.storage, secureStorageDir: '' } }, '/home/me')).toBe('/home/me/.claude/.credentials.json')
  expect(() => nativeCredentialPath({ ...location, storage: { secureStorageDir: '' } }, undefined)).toThrow()
})

test('platform detection is cached per instance and macOS keeps native keychain reads', async () => {
  const commands: (readonly string[])[] = []
  const io = fixture(async argv => {
    commands.push(argv)
    if (argv[0] === '/usr/bin/uname') return result('Darwin\n')
    if (argv[0] === '/usr/bin/security') return result(JSON.stringify(login))
    throw new Error('unexpected executable')
  })
  const location = { storage: {}, defaultConfigDir: '/home/me/.claude', user: 'me' }
  expect(await readLogin(io, location)).toEqual(login)
  expect(await hostPlatform(io)).toBe('darwin')
  expect(commands.filter(argv => argv[0] === '/usr/bin/uname').length).toBe(1)
  expect(commands[1]).toEqual(['/usr/bin/security', 'find-generic-password', '-s', 'Claude Code-credentials', '-a', 'me', '-w'])
})

test('a valid machine credential document without OAuth has no grant to compare', async () => {
  for (const os of ['Linux', 'Darwin']) {
    const io = fixture(async argv => {
      if (argv[0] === '/usr/bin/uname') return result(`${os}\n`)
      if (argv[0] === 'node') return result('', 43)
      if (argv[0] === '/usr/bin/security') return result(JSON.stringify({ apiKey: 'fixture-console-key', otherMetadata: true }))
      throw new Error('unexpected executable')
    })
    expect(await readLogin(io, { storage: {}, defaultConfigDir: '/home/me/.claude' })).toBe(null)
  }
})

test('Linux named secrets use libsecret attributes and report a missing keyring dependency', async () => {
  const commands: (readonly string[])[] = []
  const io = fixture(async argv => {
    commands.push(argv)
    if (argv[0] === '/usr/bin/uname') return result('Linux\n')
    return result('fixture-key\n')
  })
  expect(await readSecret(io, { service: 'rice-session-accounts', account: 'work-api' })).toBe('fixture-key')
  expect(commands[1]).toEqual(['secret-tool', 'lookup', 'service', 'rice-session-accounts', 'account', 'work-api'])
  const absent = fixture(async argv => {
    if (argv[0] === '/usr/bin/uname') return result('Linux\n')
    throw new Error('ENOENT')
  })
  expect(await errorOf(() => readSecret(absent, { service: 's', account: 'a' }))).toContain('secret-tool (libsecret)')
})

test('renewal refuses the machine grant and unreadable machine storage before making a network request', async () => {
  for (const machineExit of [0, 46]) {
    let requests = 0
    const expired = { claudeAiOauth: { ...login.claudeAiOauth, expiresAt: 1 } }
    const io = fixture(async argv => {
      if (argv[0] === '/usr/bin/uname') return result('Linux\n')
      if (argv[0] === '/bin/sh') return result()
      if (argv[0] === 'node' && argv[3] === 'read') {
        return argv[4] === '/home/me/.claude/.credentials.json' ? result(JSON.stringify(expired), machineExit) : result(JSON.stringify(expired))
      }
      throw new Error('unexpected executable')
    })
    io.fetch = async () => { requests += 1; throw new Error('must not refresh') }
    const error = await errorOf(() => freshLogin(io, 'personal-live', { kind: 'claudeai', loginDir: '/isolated/personal' }, pathsFor('/home/me/.claude'), {
      claudeDir: '/home/me/.claude', user: 'me', storage: {},
    }))
    expect(error).toContain(machineExit === 0 ? 'this machine\'s own /login' : 'Cannot read the native Claude credential file')
    expect(requests).toBe(0)
  }
})

test('freshLogin renews an isolated Linux grant and persists the rotation through stdin', async () => {
  const nativePath = '/isolated/personal/.credentials.json'
  const expired = { ...login, keep: 'unrelated', claudeAiOauth: { ...login.claudeAiOauth, expiresAt: 1 } }
  const commands: (readonly string[])[] = []
  let written = ''
  let requests = 0
  const io = fixture(async (argv, init) => {
    commands.push(argv)
    if (argv[0] === '/usr/bin/uname') return result('Linux\n')
    if (argv[0] === '/bin/sh') return result()
    if (argv[0] === 'node' && argv[3] === 'read') return argv[4] === nativePath ? result(JSON.stringify(expired)) : result('', 44)
    if (argv[0] === 'node' && argv[3] === 'write' && argv[4] === nativePath) {
      written = init?.stdin ?? ''
      const input = JSON.parse(written) as { oauth: Credential['claudeAiOauth'] }
      return result(JSON.stringify({ ...expired, claudeAiOauth: { ...expired.claudeAiOauth, ...input.oauth } }))
    }
    throw new Error('unexpected executable')
  })
  io.fetch = async () => {
    requests += 1
    return { ok: true, status: 200, headers: {}, text: JSON.stringify({ access_token: 'rotated-access', refresh_token: 'rotated-grant', expires_in: 3600 }) }
  }
  const saved = await freshLogin(io, 'personal-live', { kind: 'claudeai', loginDir: '/isolated/personal' }, pathsFor('/home/me/.claude'), {
    claudeDir: '/home/me/.claude', user: 'me', storage: {},
  })
  expect(requests).toBe(1)
  expect(saved.claudeAiOauth.accessToken).toBe('rotated-access')
  expect(saved.claudeAiOauth.refreshToken).toBe('rotated-grant')
  expect(saved.keep).toBe('unrelated')
  expect(JSON.parse(written)).toEqual({ expectedRefreshToken: 'fixture-refresh', oauth: { accessToken: 'rotated-access', refreshToken: 'rotated-grant', expiresAt: 3_600_000 } })
  expect(commands.some(argv => argv.includes('rotated-access') || argv.includes('rotated-grant'))).toBe(false)
  expect(commands.some(argv => argv[0] === '/usr/bin/security')).toBe(false)
})
