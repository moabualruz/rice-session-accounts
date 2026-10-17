import type { ProcessRunInit } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { freshLogin, RENEWAL_LOCK } from '../hooks/accounts'
import { pathsFor } from '../hooks/config'
import { forgetHostPlatform, forgetUnsavedLogins, hasUnsavedLogin, hostPlatform, nativeCredentialPath, readLogin, readSecret, writeLogin } from '../hooks/credentials'
import type { LoginLocation } from '../hooks/credentials'
import type { Io } from '../hooks/io'
import type { Credential } from '../hooks/keychain'
import { liveServiceName, SECURITY_LINE_LIMIT } from '../hooks/keychain'
import { acquire } from '../hooks/lock'

const login: Credential = { claudeAiOauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: 1_000_000 } }
const TRUSTED_ENV = { NoDefaultCurrentDirectoryInExePath: '1', NODE_OPTIONS: '' }
const ROTATION = JSON.stringify({ access_token: 'rotated-access', refresh_token: 'rotated-grant', expires_in: 3600 })

function result(stdout = '', exitCode = 0, stderr = '') {
  return { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false }
}

/** Module state outlives a test: platform detection and unsaved renewals start fresh in each fixture. */
function reset(): void {
  forgetHostPlatform()
  forgetUnsavedLogins()
}

function fixture(run: Io['run']): Io {
  reset()
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
  reset()
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
  const calls: { argv: readonly string[]; init: ProcessRunInit | undefined }[] = []
  const io = fixture(async (argv, init) => {
    calls.push({ argv, init })
    if (argv[0] === '/bin/sh' || argv[0] === '/usr/bin/uname') throw new Error('ENOENT: no POSIX executable on native Windows')
    if (argv[0] === 'node' && argv[1] === '-e' && argv.length === 5 && argv[4] === lockPath) return result()
    if (argv[0] === 'node' && argv[3] === 'read') return argv[4] === nativePath ? result(JSON.stringify(expired)) : result('', 44)
    if (argv[0] === 'node' && argv[3] === 'pending' && argv[4] === nativePath) return result()
    if (argv[0] === 'node' && argv[3] === 'write' && argv[4] === nativePath) {
      const input = JSON.parse(init?.stdin ?? '{}') as { oauth: Credential['claudeAiOauth'] }
      return result(JSON.stringify({ ...expired, claudeAiOauth: { ...expired.claudeAiOauth, ...input.oauth } }))
    }
    throw new Error('unexpected executable')
  })
  io.env = async name => name === 'OS' ? 'Windows_NT' : name === 'USERPROFILE' ? 'C:\\Users\\me' : undefined
  io.fetch = async () => ({ ok: true, status: 200, headers: {}, text: ROTATION })
  const saved = await freshLogin(io, 'personal-live', { kind: 'claudeai', loginDir }, pathsFor('C:\\Users\\me\\.claude'), {
    claudeDir: 'C:\\Users\\me\\.claude', user: 'me', storage: {},
  })
  expect(saved.claudeAiOauth.accessToken).toBe('rotated-access')
  expect(calls.filter(call => call.argv[4] === lockPath).map(call => call.argv[3])).toEqual(['make', 'touch', 'touch', 'remove'])
  expect(calls.some(call => call.argv[0] === '/bin/sh' || call.argv[0] === '/usr/bin/uname')).toBe(false)
  // A cloned project folder could hold a planted node.exe: every Node run uses the Claude config folder.
  for (const call of calls) {
    expect(call.init?.cwd).toBe('C:\\Users\\me\\.claude')
    expect(call.init?.env).toEqual(TRUSTED_ENV)
  }
})

test('Linux storage directories follow native secure-storage override and empty override semantics', async () => {
  const location = { storage: { configDir: '/profiles/work' }, defaultConfigDir: '/home/me/.claude' }
  expect(nativeCredentialPath(location, '/home/me')).toBe('/profiles/work/.credentials.json')
  expect(nativeCredentialPath({ ...location, storage: { ...location.storage, secureStorageDir: '/separate/auth/' } }, '/home/me')).toBe('/separate/auth/.credentials.json')
  expect(nativeCredentialPath({ ...location, storage: { ...location.storage, secureStorageDir: '' } }, '/home/me')).toBe('/home/me/.claude/.credentials.json')
  expect(() => nativeCredentialPath({ ...location, storage: { secureStorageDir: '' } }, undefined)).toThrow()
})

test('platform detection runs uname once per process, not once per Io, and macOS keeps native keychain reads', async () => {
  const commands: (readonly string[])[] = []
  const run: Io['run'] = async argv => {
    commands.push(argv)
    if (argv[0] === '/usr/bin/uname') return result('Darwin\n')
    if (argv[0] === '/usr/bin/security') return result(JSON.stringify(login))
    throw new Error('unexpected executable')
  }
  const io = fixture(run)
  const location = { storage: {}, defaultConfigDir: '/home/me/.claude', user: 'me' }
  expect(await readLogin(io, location)).toEqual(login)
  expect(commands[1]).toEqual(['/usr/bin/security', 'find-generic-password', '-s', 'Claude Code-credentials', '-a', 'me', '-w'])
  // register.ts builds a new Io for every call: the detection must still be reused.
  const rebuilt: Io = { ...io, run }
  expect(await hostPlatform(rebuilt)).toBe('darwin')
  expect(await readLogin({ ...io, run }, location)).toEqual(login)
  expect(commands.filter(argv => argv[0] === '/usr/bin/uname').length).toBe(1)
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
  const io = fixture(async (argv, init) => {
    commands.push(argv)
    if (argv[0] === '/usr/bin/uname') return result('Linux\n')
    expect(init?.cwd).toBe('/')
    expect(init?.env).toEqual(TRUSTED_ENV)
    return result('fixture-key\n')
  })
  expect(await readSecret(io, { service: 'rice-session-accounts', account: 'work-api' })).toBe('fixture-key')
  expect(commands[1]).toEqual(['secret-tool', 'lookup', 'service', 'rice-session-accounts', 'account', 'work-api'])
  const absent = fixture(async argv => {
    if (argv[0] === '/usr/bin/uname') return result('Linux\n')
    throw new Error('ENOENT')
  })
  expect(await errorOf(() => readSecret(absent, { service: 's', account: 'a' }))).toContain('secret-tool (libsecret)')
  const slow = fixture(async argv => {
    if (argv[0] === '/usr/bin/uname') return result('Linux\n')
    throw new Error('$.process.run (rice-session-accounts): secret-tool aborted: still running after 15000ms')
  })
  const timeout = await errorOf(() => readSecret(slow, { service: 's', account: 'a' }))
  expect(timeout).toContain('did not answer within 15 seconds')
  expect(timeout.includes('require secret-tool')).toBe(false)
})

test('Windows named secrets tell a Credential Manager timeout from a missing PowerShell', async () => {
  const windows = (run: Io['run']): Io => {
    const io = fixture(run)
    io.env = async name => name === 'OS' ? 'Windows_NT' : name === 'SystemRoot' ? 'C:\\Windows' : undefined
    return io
  }
  const slow = windows(async (_argv, init) => {
    expect(init?.cwd).toBe('C:\\Windows')
    expect(init?.env).toEqual(TRUSTED_ENV)
    throw new Error('aborted: still running after 15000ms')
  })
  expect(await errorOf(() => readSecret(slow, { service: 's', account: 'a' }))).toContain('did not answer within 15 seconds')
  const missing = windows(async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) })
  expect(await errorOf(() => readSecret(missing, { service: 's', account: 'a' }))).toContain('could not be started')
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

// A Linux machine with one isolated login, whose native file program is simulated.
const LOGIN_DIR = '/isolated/personal'
const NATIVE = `${LOGIN_DIR}/.credentials.json`
const PENDING = `${NATIVE}.rice-pending`
const MACHINE = { claudeDir: '/home/me/.claude', user: 'me', storage: {} }
const LOCATION: LoginLocation = { storage: { configDir: LOGIN_DIR, secureStorageDir: LOGIN_DIR }, defaultConfigDir: '/home/me/.claude', user: 'me' }
const PATHS = pathsFor('/home/me/.claude')

type Call = { argv: readonly string[]; init: ProcessRunInit | undefined }
type LinuxState = { stored: Credential; pending?: string; writeExit?: number; pendingExit?: number; writes: string[]; order: string[] }

function linuxState(overrides: Partial<LinuxState> = {}): LinuxState {
  return { stored: { keep: 'unrelated', claudeAiOauth: { ...login.claudeAiOauth, expiresAt: 1 } }, writes: [], order: [], ...overrides }
}

function linuxWorld(state: LinuxState) {
  reset()
  const calls: Call[] = []
  const logs: string[] = []
  let requests = 0
  const io: Io = {
    run: async (argv, init) => {
      calls.push({ argv, init })
      const [program, , script, operation, path] = argv
      if (program === '/usr/bin/uname') return result('Linux\n')
      if (program === '/bin/sh') {
        if (String(script).includes('touch')) state.order.push('touch')
        return result()
      }
      if (program === 'node' && operation === 'read') return path === NATIVE ? result(JSON.stringify(state.stored)) : result('', 44)
      if (program === 'node' && operation === 'pending' && path === NATIVE) {
        state.order.push('pending')
        if (state.pendingExit !== undefined) return result('', state.pendingExit)
        state.pending = init?.stdin
        return result()
      }
      if (program === 'node' && operation === 'write' && path === NATIVE) {
        state.order.push('write')
        state.writes.push(init?.stdin ?? '')
        if (state.writeExit !== undefined) return result('', state.writeExit)
        const input = JSON.parse(init?.stdin ?? '{}') as { expectedRefreshToken: string; oauth: Credential['claudeAiOauth'] }
        if (input.expectedRefreshToken !== state.stored.claudeAiOauth.refreshToken) return result('', 47)
        state.stored = { ...state.stored, claudeAiOauth: { ...state.stored.claudeAiOauth, ...input.oauth } }
        return result(JSON.stringify(state.stored))
      }
      throw new Error(`unexpected executable: ${program ?? ''}`)
    },
    read: async () => { throw new Error('unexpected read') },
    write: async () => { throw new Error('unexpected write') },
    exists: async () => false,
    stat: async () => ({ kind: 'dir', size: 0, mtimeMs: 1, isLink: false }),
    env: async name => name === 'HOME' ? '/home/me' : undefined,
    now: async () => 0,
    sleep: async () => {},
    fetch: async () => {
      requests += 1
      state.order.push('fetch')
      return { ok: true, status: 200, headers: {}, text: ROTATION }
    },
    log: text => { logs.push(text) },
  }

  return { io, calls, logs, requests: () => requests }
}

function renew(io: Io): Promise<Credential> {
  return freshLogin(io, 'personal', { kind: 'claudeai', loginDir: LOGIN_DIR }, PATHS, MACHINE)
}

test('freshLogin renews an isolated Linux grant and persists the rotation through stdin', async () => {
  const state = linuxState()
  const world = linuxWorld(state)
  const saved = await renew(world.io)
  expect(world.requests()).toBe(1)
  expect(saved.claudeAiOauth.accessToken).toBe('rotated-access')
  expect(saved.claudeAiOauth.refreshToken).toBe('rotated-grant')
  expect(saved.keep).toBe('unrelated')
  expect(JSON.parse(state.writes[0] ?? '{}')).toEqual({ expectedRefreshToken: 'fixture-refresh', oauth: { accessToken: 'rotated-access', refreshToken: 'rotated-grant', expiresAt: 3_600_000 } })
  // Write-ahead: the pending copy holds only the grant and is written before the store.
  expect(JSON.parse(state.pending ?? '{}')).toEqual({ claudeAiOauth: { accessToken: 'rotated-access', refreshToken: 'rotated-grant', expiresAt: 3_600_000 } })
  // Heartbeats before the token request and before the write.
  expect(state.order).toEqual(['touch', 'fetch', 'touch', 'pending', 'write'])
  expect(world.calls.some(call => call.argv.includes('rotated-access') || call.argv.includes('rotated-grant'))).toBe(false)
  expect(world.calls.some(call => call.argv[0] === '/usr/bin/security')).toBe(false)
  for (const call of world.calls) {
    expect(call.init?.cwd).toBe('/')
    expect(call.init?.env).toEqual(TRUSTED_ENV)
  }
})

test('a renewal whose store write fails keeps the new login in a pending file and memory, then saves it on the next use', async () => {
  const state = linuxState({ writeExit: 48 })
  const world = linuxWorld(state)
  const error = await errorOf(() => renew(world.io))
  expect(error).toContain('retrying for 3 seconds')
  expect(error).toContain(`kept in ${PENDING} (owner-only) and in this session's memory`)
  expect(error.includes('rotated-access') || error.includes('rotated-grant')).toBe(false)
  expect(JSON.parse(state.pending ?? '{}').claudeAiOauth.refreshToken).toBe('rotated-grant')
  // The store still holds the spent refresh token: every read prefers the kept login.
  expect((await readLogin(world.io, LOCATION))?.claudeAiOauth.refreshToken).toBe('rotated-grant')
  expect(await hasUnsavedLogin(world.io, LOCATION)).toBe(true)
  state.writeExit = undefined
  const saved = await renew(world.io)
  expect(saved.claudeAiOauth.refreshToken).toBe('rotated-grant')
  expect(world.requests()).toBe(1)
  expect(state.stored.claudeAiOauth.refreshToken).toBe('rotated-grant')
  expect(JSON.parse(state.writes.at(-1) ?? '{}').expectedRefreshToken).toBe('fixture-refresh')
  expect(await hasUnsavedLogin(world.io, LOCATION)).toBe(false)
})

test('a renewal that cannot write the pending file or the store says it is kept in memory only', async () => {
  const state = linuxState({ writeExit: 49, pendingExit: 49 })
  const world = linuxWorld(state)
  const error = await errorOf(() => renew(world.io))
  expect(error).toContain('no space is left')
  expect(error).toContain('kept in this session\'s memory only')
  expect(world.logs.some(line => line.includes('pending file'))).toBe(true)
})

test('renewing a login kept unsaved compares against the refresh token the store still holds', async () => {
  const state = linuxState({ writeExit: 48 })
  const world = linuxWorld(state)
  await errorOf(() => renew(world.io))
  const kept = await readLogin(world.io, LOCATION)
  if (!kept) throw new Error('the kept login must be read')
  const next = { ...kept, claudeAiOauth: { ...kept.claudeAiOauth, accessToken: 'second-access', refreshToken: 'second-grant', expiresAt: 7_200_000 } }
  state.writeExit = undefined
  const saved = await writeLogin(world.io, LOCATION, next, kept)
  expect(saved.claudeAiOauth.refreshToken).toBe('second-grant')
  expect(JSON.parse(state.writes.at(-1) ?? '{}').expectedRefreshToken).toBe('fixture-refresh')
})

test('a grant another session saved during the renewal is adopted instead of overwritten', async () => {
  const state = linuxState()
  const world = linuxWorld(state)
  const other = { ...state.stored, claudeAiOauth: { ...state.stored.claudeAiOauth, accessToken: 'other-access', refreshToken: 'other-session-grant', expiresAt: 9_000_000 } }
  const fetch = world.io.fetch
  world.io.fetch = async (url, init) => { state.stored = other; return fetch(url, init) }
  const saved = await renew(world.io)
  expect(saved.claudeAiOauth.refreshToken).toBe('other-session-grant')
  expect(state.stored).toEqual(other)
  expect(world.logs.some(line => line.includes('another session'))).toBe(true)
  expect(await hasUnsavedLogin(world.io, LOCATION)).toBe(false)
})

test('a lock taken over before the token request stops the renewal without spending the refresh token', async () => {
  const state = linuxState()
  const world = linuxWorld(state)
  let stats = 0
  world.io.stat = async () => ({ kind: 'dir', size: 0, mtimeMs: (stats += 1) === 1 ? 1 : 2, isLink: false })
  const error = await errorOf(() => renew(world.io))
  expect(error).toContain('Another session took over renewing personal')
  expect(world.requests()).toBe(0)
  expect(state.writes).toEqual([])
  // The taken-over lock is the other session's: it is not removed.
  expect(world.calls.some(call => String(call.argv[2]).includes('rmdir'))).toBe(false)
})

test('the renewal lock is stale only after 150 seconds', async () => {
  expect(RENEWAL_LOCK.staleMs).toBeGreaterThanOrEqual(150_000)
  let sleeps = 0
  const held = fixture(async argv => {
    if (argv[0] === '/usr/bin/uname') return result('Linux\n')
    if (String(argv[2]).includes('mkdir -p')) return result('', 1, 'mkdir: File exists')
    throw new Error('a held lock must not be removed')
  })
  held.now = async () => 300_000
  held.stat = async () => ({ kind: 'dir', size: 0, mtimeMs: 200_000, isLink: false })
  held.sleep = async () => { sleeps += 1 }
  expect(await errorOf(() => acquire(held, '/locks/personal.lock', RENEWAL_LOCK))).toContain('another session is renewing this login')
  expect(sleeps).toBe(RENEWAL_LOCK.tries - 1)
  let made = 0, removed = 0
  const abandoned = fixture(async argv => {
    if (argv[0] === '/usr/bin/uname') return result('Linux\n')
    if (String(argv[2]).includes('mkdir -p')) return (made += 1) === 1 ? result('', 1) : result()
    if (String(argv[2]).includes('rmdir')) { removed += 1; return result() }
    return result()
  })
  abandoned.now = async () => 300_000
  abandoned.stat = async () => ({ kind: 'dir', size: 0, mtimeMs: 100_000, isLink: false })
  await acquire(abandoned, '/locks/personal.lock', RENEWAL_LOCK)
  expect(removed).toBe(1)
  expect(made).toBe(2)
})

test('token endpoint answers: only invalid_grant asks to sign in again, and bodies are never echoed', async () => {
  const answers = [
    { status: 400, text: JSON.stringify({ error: 'invalid_grant', error_description: 'fixture-echo' }), expected: 'sign it in again: /rice-account setup personal' },
    { status: 429, text: 'fixture-echo', expected: 'rate limiting' },
    { status: 503, text: 'fixture-echo', expected: 'HTTP 503' },
  ]
  for (const answer of answers) {
    const state = linuxState()
    const world = linuxWorld(state)
    world.io.fetch = async () => ({ ok: false, status: answer.status, headers: {}, text: answer.text })
    const error = await errorOf(() => renew(world.io))
    expect(error).toContain(answer.expected)
    expect(error.includes('fixture-echo')).toBe(false)
    if (answer.status !== 400) expect(error.includes('sign it in again')).toBe(false)
    expect(state.writes).toEqual([])
  }
  const state = linuxState()
  const offline = linuxWorld(state)
  offline.io.fetch = async () => { throw new Error('fetch failed: ECONNRESET fixture-echo') }
  const error = await errorOf(() => renew(offline.io))
  expect(error).toContain('ECONNRESET')
  expect(error.includes('fixture-echo')).toBe(false)
})

test('a response that rotated the refresh token without an access token still saves the rotation', async () => {
  const state = linuxState()
  const world = linuxWorld(state)
  world.io.fetch = async () => ({ ok: true, status: 200, headers: {}, text: JSON.stringify({ refresh_token: 'rotated-grant', expires_in: 3600 }) })
  const error = await errorOf(() => renew(world.io))
  expect(error).toContain('rotated refresh token was saved')
  expect(state.stored.claudeAiOauth.refreshToken).toBe('rotated-grant')
  expect(state.stored.claudeAiOauth.expiresAt).toBe(0)
})

test('native file program failures are classified, never all as a missing Node 22', async () => {
  const cases: [() => ReturnType<typeof result>, string][] = [
    [() => { throw new Error('$.process.run (rice-session-accounts): node aborted: still running after 15000ms') }, 'within 15 seconds'],
    [() => { throw Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }) }, 'no node program could be started from PATH'],
    [() => { throw new Error('spawn node EACCES') }, 'could not be executed'],
    [() => result('', 50), 'the node program found there is older'],
    [() => result('', 51), 'Install Linux Node.js 22 or later inside WSL'],
    [() => result('', 45), 'symbolic link'],
    [() => result('', 46), `Cannot read the native Claude credential file at ${NATIVE}`],
    [() => result('', 9), 'Node.js exited with code 9'],
  ]
  for (const [answer, expected] of cases) {
    const io = fixture(async argv => argv[0] === '/usr/bin/uname' ? result('Linux\n') : answer())
    const error = await errorOf(() => readLogin(io, LOCATION))
    expect(error).toContain(expected)
    if (!expected.includes('older') && !expected.includes('no node program')) expect(error.includes('requires Node.js 22')).toBe(false)
  }
})

test('store write failures name the held file or the full disk and where the renewal was kept', async () => {
  for (const [exit, expected] of [[48, 'could not be replaced after retrying for 3 seconds'], [49, 'no space is left on its disk, or the file system is read-only']] as const) {
    const state = linuxState({ writeExit: exit })
    const world = linuxWorld(state)
    const fresh = { ...state.stored, claudeAiOauth: { ...state.stored.claudeAiOauth, accessToken: 'rotated-access', refreshToken: 'rotated-grant', expiresAt: 3_600_000 } }
    const error = await errorOf(() => writeLogin(world.io, LOCATION, fresh, state.stored))
    expect(error).toContain(expected)
    expect(error).toContain(`kept in ${PENDING}`)
  }
})

// A macOS machine with one isolated login whose keychain item and pending file are simulated.
const MAC_CLAUDE = '/Users/me/.claude'
const MAC_LOGIN = `${MAC_CLAUDE}/rice-session-accounts/logins/personal`
const MAC_PENDING = `${MAC_LOGIN}/.credentials.json.rice-pending`
const MAC_MACHINE = { claudeDir: MAC_CLAUDE, user: 'me', storage: {} }
const MAC_LOCATION: LoginLocation = { storage: { configDir: MAC_LOGIN, secureStorageDir: MAC_LOGIN }, defaultConfigDir: MAC_CLAUDE, user: 'me' }

function decodeHex(hex: string): string {
  return new TextDecoder().decode(new Uint8Array(hex.match(/../g)?.map(pair => Number.parseInt(pair, 16)) ?? []))
}

async function macWorld(initial: Credential, options: { stderr?: string; pending?: string } = {}) {
  reset()
  const service = await liveServiceName({ configDir: MAC_LOGIN, secureStorageDir: MAC_LOGIN }, MAC_CLAUDE)
  const state = { items: new Map<string, string>([[service, JSON.stringify(initial)]]), pending: options.pending, lines: [] as string[], removed: [] as string[] }
  const logs: string[] = []
  let requests = 0
  const io: Io = {
    run: async (argv, init) => {
      if (argv[0] === '/usr/bin/uname') return result('Darwin\n')
      if (argv[0] === '/usr/bin/security' && argv[1] === 'find-generic-password') {
        const item = state.items.get(argv[3] ?? '')
        return item === undefined ? result('', 44) : result(item)
      }
      if (argv[0] === '/usr/bin/security' && argv[1] === '-i') {
        const line = init?.stdin ?? ''
        state.lines.push(line)
        if (options.stderr) return result('', 0, options.stderr)
        const match = /-s "([^"]+)" -X "([0-9a-f]+)"/.exec(line)
        state.items.set(match?.[1] ?? '', decodeHex(match?.[2] ?? ''))
        return result()
      }
      if (argv[0] === '/bin/sh' && String(argv[2]).includes('umask 077')) {
        expect(argv[3]).toBe(MAC_PENDING)
        state.pending = init?.stdin
        return result()
      }
      if (argv[0] === '/bin/sh') return result()
      if (argv[0] === '/bin/rm') {
        const files = argv.slice(3)
        state.removed.push(...files)
        if (files.includes(MAC_PENDING)) state.pending = undefined
        return result()
      }
      throw new Error(`unexpected executable: ${argv[0] ?? ''}`)
    },
    read: async path => {
      if (path === MAC_PENDING && state.pending !== undefined) return state.pending
      throw new Error('ENOENT')
    },
    write: async () => { throw new Error('unexpected write') },
    exists: async () => false,
    stat: async path => {
      if (path === MAC_PENDING) {
        if (state.pending === undefined) throw new Error('ENOENT')
        return { kind: 'file', size: state.pending.length, mtimeMs: 1, isLink: false }
      }
      if (path.endsWith('.tmp')) throw new Error('ENOENT')
      return { kind: 'dir', size: 0, mtimeMs: 1, isLink: false }
    },
    env: async name => name === 'HOME' ? '/Users/me' : undefined,
    now: async () => 0,
    sleep: async () => {},
    fetch: async () => { requests += 1; return { ok: true, status: 200, headers: {}, text: ROTATION } },
    log: text => { logs.push(text) },
  }

  return { io, service, state, logs, requests: () => requests }
}

function renewMac(io: Io): Promise<Credential> {
  return freshLogin(io, 'personal', { kind: 'claudeai', loginDir: MAC_LOGIN }, pathsFor(MAC_CLAUDE), MAC_MACHINE)
}

const macExpired: Credential = { claudeAiOauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: 1, scopes: ['user:inference'] }, keep: 'small' }

test('a macOS renewal stays under the security -i line limit, dropping only large optional keys', async () => {
  const world = await macWorld({ ...macExpired, mcpOAuth: { server: 'm'.repeat(5000) } })
  const saved = await renewMac(world.io)
  expect(world.requests()).toBe(1)
  expect(world.state.lines.length).toBe(1)
  expect((world.state.lines[0] ?? '').length).toBeLessThanOrEqual(SECURITY_LINE_LIMIT)
  const item = JSON.parse(world.state.items.get(world.service) ?? '{}') as Credential
  expect(item.claudeAiOauth.refreshToken).toBe('rotated-grant')
  expect(item.claudeAiOauth.scopes).toEqual(['user:inference'])
  expect(item.keep).toBe('small')
  expect('mcpOAuth' in item).toBe(false)
  expect(saved.claudeAiOauth.accessToken).toBe('rotated-access')
  expect(world.logs.some(line => line.includes('mcpOAuth'))).toBe(true)
  expect(world.logs.some(line => line.includes('rotated'))).toBe(false)
  // Written ahead, then removed once the keychain holds the renewal.
  expect(world.state.removed).toEqual([MAC_PENDING])
  expect(world.state.pending).toBe(undefined)
})

test('a macOS login too large for the keychain is refused before the refresh token is spent', async () => {
  const world = await macWorld({ ...macExpired, claudeAiOauth: { ...macExpired.claudeAiOauth, organizationNotes: 'n'.repeat(1900) } })
  const error = await errorOf(() => renewMac(world.io))
  expect(error).toContain('too large to store in the macOS keychain')
  expect(error).toContain('not spent')
  expect(world.requests()).toBe(0)
  expect(world.state.lines).toEqual([])
})

test('macOS re-reads the item before writing and adopts another session\'s grant', async () => {
  const world = await macWorld(macExpired)
  const other = { ...macExpired, claudeAiOauth: { ...macExpired.claudeAiOauth, accessToken: 'other-access', refreshToken: 'other-session-grant', expiresAt: 9_000_000 } }
  const fetch = world.io.fetch
  world.io.fetch = async (url, init) => { world.state.items.set(world.service, JSON.stringify(other)); return fetch(url, init) }
  const saved = await renewMac(world.io)
  expect(saved.claudeAiOauth.refreshToken).toBe('other-session-grant')
  expect(world.state.lines).toEqual([])
  expect(world.state.pending).toBe(undefined)
})

test('security -i error text is a failed write: the renewal is kept in the pending file and adopted on a later read', async () => {
  const world = await macWorld(macExpired, { stderr: 'security: Unknown command "3f7b"\n' })
  const error = await errorOf(() => renewMac(world.io))
  expect(error).toContain('security reported an error')
  expect(error).toContain(`kept in ${MAC_PENDING}`)
  expect(JSON.parse(world.state.items.get(world.service) ?? '{}').claudeAiOauth.refreshToken).toBe('fixture-refresh')
  expect(JSON.parse(world.state.pending ?? '{}').claudeAiOauth.refreshToken).toBe('rotated-grant')
  expect((await readLogin(world.io, MAC_LOCATION))?.claudeAiOauth.refreshToken).toBe('rotated-grant')
})

test('a macOS read adopts a newer pending renewal into the keychain and removes the pending file', async () => {
  const pending = JSON.stringify({ claudeAiOauth: { accessToken: 'pending-access', refreshToken: 'pending-grant', expiresAt: 5_000_000 } })
  const world = await macWorld(macExpired, { pending })
  const read = await readLogin(world.io, MAC_LOCATION)
  expect(read?.claudeAiOauth.refreshToken).toBe('pending-grant')
  expect(read?.keep).toBe('small')
  expect(JSON.parse(world.state.items.get(world.service) ?? '{}').claudeAiOauth.refreshToken).toBe('pending-grant')
  expect(world.state.removed).toEqual([MAC_PENDING])
  const older = await macWorld({ ...macExpired, claudeAiOauth: { ...macExpired.claudeAiOauth, expiresAt: 9_000_000 } }, { pending })
  expect((await readLogin(older.io, MAC_LOCATION))?.claudeAiOauth.refreshToken).toBe('fixture-refresh')
  expect(older.state.lines).toEqual([])
  expect(older.state.removed).toEqual([MAC_PENDING])
})
