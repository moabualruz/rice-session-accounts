import type { CommandRunInput, On, ProcessRunInit } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { fixturePath } from './fixture-path'

import { freshLogin, LOCK_HEARTBEAT_LIMIT_MS, LOCK_HEARTBEAT_MS, RENEWAL_LOCK } from '../hooks/accounts'
import { defaultConfig, pathsFor, serializeConfig } from '../hooks/config'
import { bestLogin, forgetHostPlatform, forgetUnsavedLogins, hasUnsavedLogin, hostPlatform, nativeCredentialPath, parsePendingLogin, pendingState, readLogin, readSecret, writeLogin } from '../hooks/credentials'
import type { LoginLocation, PendingLogin } from '../hooks/credentials'
import type { Io } from '../hooks/io'
import type { Credential } from '../hooks/keychain'
import { liveServiceName, SECURITY_LINE_LIMIT } from '../hooks/keychain'
import { acquire } from '../hooks/lock'

const login: Credential = { claudeAiOauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: 1_000_000 } }
const TRUSTED_ENV = { NoDefaultCurrentDirectoryInExePath: '1', NODE_OPTIONS: '' }
const ROTATION = JSON.stringify({ access_token: 'rotated-access', refresh_token: 'rotated-grant', expires_in: 3600 })

/** The token endpoint's answer to the n-th renewal: the first rotates to `rotated-grant`, later ones to `rotated-grant-n`. */
function rotation(count: number): string {
  return count === 1 ? ROTATION : JSON.stringify({ access_token: `rotated-access-${count}`, refresh_token: `rotated-grant-${count}`, expires_in: 3600 })
}

type Response = Awaited<ReturnType<Io['fetch']>>

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

/** The refresh token a token request spends. */
function spentBy(init: { body?: unknown } | undefined): string {
  return (JSON.parse(String(init?.body ?? '{}')) as { refresh_token?: string }).refresh_token ?? ''
}

/** The grant a renewal changes, as the native file program and the keychain path copy it. */
function grantOf(oauth: Credential['claudeAiOauth']) {
  return { accessToken: oauth.accessToken, refreshToken: oauth.refreshToken, expiresAt: oauth.expiresAt, ...(typeof oauth.refreshTokenExpiresAt === 'number' ? { refreshTokenExpiresAt: oauth.refreshTokenExpiresAt } : {}) }
}

function withGrant(document: Credential, oauth: Credential['claudeAiOauth']): Credential {
  return { ...document, claudeAiOauth: { ...document.claudeAiOauth, ...grantOf(oauth) } }
}

function pendingText(base: string, oauth: Credential['claudeAiOauth']): string {
  return JSON.stringify({ version: 2, base, credential: { claudeAiOauth: grantOf(oauth) } })
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
      if (argv[0] === 'node' && argv[3] === 'examine' && argv[4] === `${folder}/.credentials.json`) {
        return { exitCode: 0, stdout: JSON.stringify({ stored: document, pending: null }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
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

/** A native Windows machine whose Node credential and lock programs are simulated; `writeExit` fails the store write. */
function windowsWorld(loginDir: string, lockPath: string, writeExit?: number) {
  const nativePath = `${loginDir}/.credentials.json`
  const expired = { ...login, claudeAiOauth: { ...login.claudeAiOauth, expiresAt: 1 } }
  const calls: { argv: readonly string[]; init: ProcessRunInit | undefined }[] = []
  const io = fixture(async (argv, init) => {
    calls.push({ argv, init })
    if (argv[0] === '/bin/sh' || argv[0] === '/usr/bin/uname') throw new Error('ENOENT: no POSIX executable on native Windows')
    if (argv[0] === 'node' && argv[1] === '-e' && argv.length === 5 && argv[4] === lockPath) return result()
    if (argv[0] === 'node' && argv[3] === 'read') return argv[4] === nativePath ? result(JSON.stringify(expired)) : result('', 44)
    if (argv[0] === 'node' && argv[3] === 'examine' && argv[4] === nativePath) return result(JSON.stringify({ stored: expired, pending: null }))
    if (argv[0] === 'node' && (argv[3] === 'pending' || argv[3] === 'clearpending') && argv[4] === nativePath) return result()
    if (argv[0] === 'node' && argv[3] === 'write' && argv[4] === nativePath) {
      if (writeExit !== undefined) return result('', writeExit)
      const input = JSON.parse(init?.stdin ?? '{}') as { oauth: Credential['claudeAiOauth'] }
      return result(JSON.stringify({ ...expired, claudeAiOauth: { ...expired.claudeAiOauth, ...input.oauth } }))
    }
    throw new Error('unexpected executable')
  })
  io.env = async name => name === 'OS' ? 'Windows_NT' : name === 'USERPROFILE' ? 'C:\\Users\\me' : undefined
  io.fetch = async () => ({ ok: true, status: 200, headers: {}, text: ROTATION })

  return { io, calls }
}

test('freshLogin renews an isolated native Windows grant without a POSIX shell for its lock', async () => {
  const loginDir = 'C:\\Users\\me\\.claude/rice-session-accounts/logins/personal-live'
  const lockPath = 'C:\\Users\\me\\.claude/rice-session-accounts/locks/personal-live.lock'
  const { io, calls } = windowsWorld(loginDir, lockPath)
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

test('on Windows a renewal kept unsaved is found again whatever the case or separators of its path', async () => {
  const loginDir = 'C:\\Users\\me\\.claude/rice-session-accounts/logins/personal-live'
  const lockPath = 'C:\\Users\\me\\.claude/rice-session-accounts/locks/personal-live.lock'
  const { io } = windowsWorld(loginDir, lockPath, 49)
  const error = await errorOf(() => freshLogin(io, 'personal-live', { kind: 'claudeai', loginDir }, pathsFor('C:\\Users\\me\\.claude'), {
    claudeDir: 'C:\\Users\\me\\.claude', user: 'me', storage: {},
  }))
  expect(error).toContain('no space is left')
  const other = 'c:/users/ME/.claude\\rice-session-accounts\\logins\\personal-live'
  expect(await hasUnsavedLogin(io, { storage: { configDir: other, secureStorageDir: other }, defaultConfigDir: 'C:\\Users\\me\\.claude' })).toBe(true)
})

test('a missing Claude config folder on Windows is reported as such, not as a missing Node.js', async () => {
  const io = fixture(async () => { throw Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }) })
  io.env = async name => name === 'OS' ? 'Windows_NT' : name === 'USERPROFILE' ? 'C:\\Users\\me' : undefined
  io.stat = async () => { throw new Error('ENOENT: no such folder') }
  const error = await errorOf(() => readLogin(io, { storage: {}, defaultConfigDir: 'C:\\Users\\me\\.claude' }))
  expect(error).toContain('The Claude configuration folder C:\\Users\\me\\.claude does not exist')
  expect(error.includes('no node program')).toBe(false)
  const locked = await errorOf(() => acquire(io, 'C:\\Users\\me\\.claude/rice-session-accounts/locks/personal.lock', { ...RENEWAL_LOCK, cwd: 'C:\\Users\\me\\.claude' }))
  expect(locked).toContain('C:\\Users\\me\\.claude (the Claude configuration folder) does not exist')
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

test('renewal refuses the machine grant, and fails closed saying why when machine storage is unreadable, before any network request', async () => {
  for (const machineExit of [0, 46]) {
    let requests = 0
    const expired = { claudeAiOauth: { ...login.claudeAiOauth, expiresAt: 1 } }
    const io = fixture(async argv => {
      if (argv[0] === '/usr/bin/uname') return result('Linux\n')
      if (argv[0] === '/bin/sh') return result()
      if (argv[0] === 'node' && argv[4] === '/home/me/.claude/.credentials.json') return result(JSON.stringify(expired), machineExit)
      if (argv[0] === 'node' && argv[3] === 'examine') return result(JSON.stringify({ stored: expired, pending: null }))
      if (argv[0] === 'node' && argv[3] === 'read') return result(JSON.stringify(expired))
      throw new Error('unexpected executable')
    })
    io.fetch = async () => { requests += 1; throw new Error('must not refresh') }
    const error = await errorOf(() => freshLogin(io, 'personal-live', { kind: 'claudeai', loginDir: '/isolated/personal' }, pathsFor('/home/me/.claude'), {
      claudeDir: '/home/me/.claude', user: 'me', storage: {},
    }))
    if (machineExit === 0) {
      expect(error).toContain('this machine\'s own /login')
    } else {
      expect(error).toContain('this machine\'s own login could not be read to check that personal-live is a different sign-in')
      expect(error).toContain('Cannot read the native Claude credential file')
      expect(error).toContain('No token request was made')
    }
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
type LinuxState = {
  stored: Credential | null
  /** The pending file's text, as the program wrote it. */
  pending?: string
  now: number
  writeExit?: number
  pendingExit?: number
  /** A program runner of an earlier version: it answers `read` and `write`, and exit 44 for every other operation. */
  readOnly?: boolean
  /** stdin of every store write and every pending write. */
  writes: string[]
  pendings: string[]
  /** Program operations, lock heartbeats (`touch`) and token requests (`fetch`), in order. */
  order: string[]
}

function linuxState(overrides: Partial<LinuxState> = {}): LinuxState {
  return { stored: { keep: 'unrelated', claudeAiOauth: { ...login.claudeAiOauth, expiresAt: 1 } }, now: 0, writes: [], pendings: [], order: [], ...overrides }
}

/** The native file program's documented behavior, with rule B as the program applies it. */
function nativeProgram(state: LinuxState, operation: string, stdin: string | undefined) {
  state.order.push(operation)
  const pending = state.pending === undefined ? null : parsePendingLogin(state.pending)
  switch (operation) {
    case 'read':
      if (state.stored === null) return result('', 44)
      return result(JSON.stringify(pending && pending.base === state.stored.claudeAiOauth.refreshToken ? withGrant(state.stored, pending.credential.claudeAiOauth) : state.stored))
    case 'examine':
      if (state.readOnly) return result('', 44)
      return result(JSON.stringify({ stored: state.stored, pending }))
    case 'pending': {
      state.pendings.push(stdin ?? '')
      if (state.readOnly) return result('', 44)
      if (state.pendingExit !== undefined) return result('', state.pendingExit)
      const input = JSON.parse(stdin ?? '{}') as PendingLogin
      state.pending = pendingText(input.base, input.credential.claudeAiOauth)
      return result()
    }
    case 'write': {
      state.writes.push(stdin ?? '')
      if (state.writeExit !== undefined) return result('', state.writeExit)
      if (state.stored === null) return result('', 44)
      const input = JSON.parse(stdin ?? '{}') as { expectedRefreshToken: string; oauth: Credential['claudeAiOauth'] }
      if (input.expectedRefreshToken !== state.stored.claudeAiOauth.refreshToken) return result('', 47)
      state.stored = withGrant(state.stored, input.oauth)
      return result(JSON.stringify(state.stored))
    }
    case 'readpending':
      if (state.readOnly) return result('', 44)
      return result(JSON.stringify({ pending }))
    case 'clearpending': {
      if (state.readOnly) return result('', 44)
      const input = JSON.parse(stdin ?? '{}') as { base: string; tokens: string[] }
      if (pending?.base === input.base && input.tokens.includes(pending.credential.claudeAiOauth.refreshToken)) state.pending = undefined
      return result()
    }
    default:
      throw new Error(`unexpected operation ${operation}`)
  }
}

function linuxWorld(state: LinuxState) {
  reset()
  const calls: Call[] = []
  const logs: string[] = []
  const sent: string[] = []
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
      // The machine's own store is absent; only the isolated login exists.
      if (program === 'node') return path === NATIVE ? nativeProgram(state, String(operation), init?.stdin) : result('', 44)
      throw new Error(`unexpected executable: ${program ?? ''}`)
    },
    read: async () => { throw new Error('unexpected read') },
    write: async () => { throw new Error('unexpected write') },
    exists: async () => false,
    stat: async () => ({ kind: 'dir', size: 0, mtimeMs: 1, isLink: false }),
    env: async name => name === 'HOME' ? '/home/me' : undefined,
    now: async () => state.now,
    sleep: async () => {},
    fetch: async (_url, init) => {
      requests += 1
      state.order.push('fetch')
      sent.push(spentBy(init))
      return { ok: true, status: 200, headers: {}, text: rotation(requests) }
    },
    log: text => { logs.push(text) },
  }

  return { io, calls, logs, sent, requests: () => requests }
}

function renew(io: Io): Promise<Credential> {
  return freshLogin(io, 'personal', { kind: 'claudeai', loginDir: LOGIN_DIR }, PATHS, MACHINE)
}

test('freshLogin renews an isolated Linux grant: written ahead with the stored token as base, saved by compare-and-swap, then cleared', async () => {
  const state = linuxState()
  const world = linuxWorld(state)
  const saved = await renew(world.io)
  expect(world.requests()).toBe(1)
  expect(world.sent).toEqual(['fixture-refresh'])
  expect(saved.claudeAiOauth.accessToken).toBe('rotated-access')
  expect(saved.claudeAiOauth.refreshToken).toBe('rotated-grant')
  expect(saved.keep).toBe('unrelated')
  const grant = { accessToken: 'rotated-access', refreshToken: 'rotated-grant', expiresAt: 3_600_000 }
  expect(JSON.parse(state.writes[0] ?? '{}')).toEqual({ expectedRefreshToken: 'fixture-refresh', oauth: grant })
  // Write-ahead: the pending copy holds the base and only the grant, and is written before the store.
  expect(JSON.parse(state.pendings[0] ?? '{}')).toEqual({ base: 'fixture-refresh', credential: { claudeAiOauth: grant } })
  expect(state.pending).toBe(undefined)
  const cleared = world.calls.find(call => call.argv[3] === 'clearpending')
  // Only the renewal's own tokens clear a pending file: the one it spent and the one it saved.
  expect(JSON.parse(cleared?.init?.stdin ?? '{}')).toEqual({ base: 'fixture-refresh', tokens: ['fixture-refresh', 'rotated-grant'] })
  // A plain read, the inspection under the lock, heartbeats before the token request and before the write.
  // A saved login is inspected without the lock, then again under it; the lock is extended before the request and after the write-ahead.
  expect(state.order).toEqual(['examine', 'examine', 'touch', 'fetch', 'pending', 'touch', 'write', 'clearpending'])
  expect(world.calls.some(call => call.argv.includes('rotated-access') || call.argv.includes('rotated-grant'))).toBe(false)
  expect(world.calls.some(call => call.argv[0] === '/usr/bin/security')).toBe(false)
  for (const call of world.calls) {
    expect(call.init?.cwd).toBe('/')
    expect(call.init?.env).toEqual(TRUSTED_ENV)
  }
})

test('a renewal records refreshTokenExpiresAt as Claude Code does, and a later renewal without one keeps it through the pending file and the store', async () => {
  const state = linuxState({ stored: { keep: 'unrelated', claudeAiOauth: { ...login.claudeAiOauth, expiresAt: 1, refreshTokenExpiresAt: 50, clientId: 'fixture-client', scopes: ['user:inference'] } } })
  const world = linuxWorld(state)
  const answers = [
    JSON.stringify({ access_token: 'rotated-access', refresh_token: 'rotated-grant', expires_in: 3600, refresh_token_expires_in: 86_400 }),
    JSON.stringify({ access_token: 'rotated-access-2', refresh_token: 'rotated-grant-2', expires_in: 3600 }),
  ]
  const bodies: Record<string, string>[] = []
  world.io.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, string>)
    state.order.push('fetch')
    return { ok: true, status: 200, headers: {}, text: answers[bodies.length - 1] ?? '' }
  }
  const first = await renew(world.io)
  expect(first.claudeAiOauth.refreshTokenExpiresAt).toBe(86_400_000)
  // Written ahead with the grant, then saved by compare-and-swap with it.
  expect((JSON.parse(state.pendings[0] ?? '{}') as PendingLogin).credential.claudeAiOauth.refreshTokenExpiresAt).toBe(86_400_000)
  expect(JSON.parse(state.writes[0] ?? '{}').oauth.refreshTokenExpiresAt).toBe(86_400_000)
  state.now = 4_000_000
  const second = await renew(world.io)
  expect(second.claudeAiOauth.refreshTokenExpiresAt).toBe(86_400_000)
  expect(state.stored).toEqual({ keep: 'unrelated', claudeAiOauth: { accessToken: 'rotated-access-2', refreshToken: 'rotated-grant-2', expiresAt: 7_600_000, refreshTokenExpiresAt: 86_400_000, clientId: 'fixture-client', scopes: ['user:inference'] } })
  // The login's own OAuth client renews it, as in Claude Code.
  expect(bodies.map(body => body.client_id)).toEqual(['fixture-client', 'fixture-client'])
})

test('a program runner that cannot examine the store refuses to renew: no guess, no token request', async () => {
  const state = linuxState({ readOnly: true })
  const world = linuxWorld(state)
  expect(await errorOf(() => renew(world.io))).toContain('disappeared while the login was renewed')
  expect(world.requests()).toBe(0)
  expect(state.order).toEqual(['examine'])
  expect(state.writes).toEqual([])
})

test('a renewal whose store write fails keeps the new login in a pending file and memory, then saves it on the next use', async () => {
  const state = linuxState({ writeExit: 48 })
  const world = linuxWorld(state)
  const error = await errorOf(() => renew(world.io))
  expect(error).toContain('retrying for 3 seconds')
  expect(error).toContain(`kept in ${PENDING} (owner-only) and in this session's memory`)
  expect(error).toContain('saved automatically')
  expect(error.includes('rotated-access') || error.includes('rotated-grant')).toBe(false)
  expect(parsePendingLogin(state.pending ?? '')?.base).toBe('fixture-refresh')
  expect(parsePendingLogin(state.pending ?? '')?.credential.claudeAiOauth.refreshToken).toBe('rotated-grant')
  // The store still holds the spent refresh token: every read prefers the kept login.
  expect((await readLogin(world.io, LOCATION))?.claudeAiOauth.refreshToken).toBe('rotated-grant')
  expect(await hasUnsavedLogin(world.io, LOCATION)).toBe(true)
  state.writeExit = undefined
  const saved = await renew(world.io)
  expect(saved.claudeAiOauth.refreshToken).toBe('rotated-grant')
  expect(world.requests()).toBe(1)
  expect(state.stored?.claudeAiOauth.refreshToken).toBe('rotated-grant')
  expect(JSON.parse(state.writes.at(-1) ?? '{}').expectedRefreshToken).toBe('fixture-refresh')
  expect(state.pending).toBe(undefined)
  expect(await hasUnsavedLogin(world.io, LOCATION)).toBe(false)
})

test('a renewal chain whose store writes keep failing keeps the first base, deletes nothing, and the final save clears the pending file', async () => {
  // Renewal 2 runs in a new process (only the pending file remembers S1), or in the same one (memory too).
  for (const newProcess of [true, false]) {
    const state = linuxState({ writeExit: 49 })
    const world = linuxWorld(state)
    // Renewal 1, S0 to S1: the store write fails, and the pending file holds {base: S0, credential: S1}.
    expect(await errorOf(() => renew(world.io))).toContain('no space is left')
    expect(parsePendingLogin(state.pending ?? '')).toEqual({ base: 'fixture-refresh', credential: { claudeAiOauth: { accessToken: 'rotated-access', refreshToken: 'rotated-grant', expiresAt: 3_600_000 } } })
    if (newProcess) forgetUnsavedLogins()
    state.now = 4_000_000
    // Renewal 2, S1 to S2: it spends S1, compares the store against S0 again, and its store write fails too.
    expect(await errorOf(() => renew(world.io))).toContain(`kept in ${PENDING}`)
    expect(world.sent).toEqual(['fixture-refresh', 'rotated-grant'])
    expect(state.writes.map(text => (JSON.parse(text) as { expectedRefreshToken: string }).expectedRefreshToken)).toEqual(['fixture-refresh', 'fixture-refresh'])
    expect(parsePendingLogin(state.pending ?? '')).toEqual({ base: 'fixture-refresh', credential: { claudeAiOauth: { accessToken: 'rotated-access-2', refreshToken: 'rotated-grant-2', expiresAt: 7_600_000 } } })
    expect(state.stored?.claudeAiOauth.refreshToken).toBe('fixture-refresh')
    expect(state.order.includes('clearpending')).toBe(false)
    // Reads use S2 and never write.
    const before = state.order.length
    expect((await readLogin(world.io, LOCATION))?.claudeAiOauth.refreshToken).toBe('rotated-grant-2')
    expect(state.order.slice(before).every(operation => operation === 'read' || operation === 'examine')).toBe(true)
    // The store accepts writes again: S2 is saved without another token request, and the pending file goes.
    state.writeExit = undefined
    const saved = await renew(world.io)
    expect(saved.claudeAiOauth.refreshToken).toBe('rotated-grant-2')
    expect(world.requests()).toBe(2)
    expect(state.stored?.claudeAiOauth.refreshToken).toBe('rotated-grant-2')
    expect(JSON.parse(state.writes.at(-1) ?? '{}').expectedRefreshToken).toBe('fixture-refresh')
    expect(state.pending).toBe(undefined)
    expect(await hasUnsavedLogin(world.io, LOCATION)).toBe(false)
  }
})

test('plain reads never write or remove anything, whatever pending file they find', async () => {
  const s0 = linuxState().stored as Credential
  const s1 = { accessToken: 'rotated-access', refreshToken: 'rotated-grant', expiresAt: 3_600_000 }
  const cases: [string, Credential, string, string][] = [
    ['usable', s0, pendingText('fixture-refresh', s1), 'rotated-grant'],
    ['redundant', withGrant(s0, s1), pendingText('fixture-refresh', s1), 'rotated-grant'],
    ['obsolete', withGrant(s0, { ...s1, refreshToken: 'other-grant' }), pendingText('fixture-refresh', s1), 'other-grant'],
    ['version 1', s0, JSON.stringify({ claudeAiOauth: { ...s1, expiresAt: 9_000_000 } }), 'fixture-refresh'],
  ]
  for (const [label, stored, pending, expected] of cases) {
    const state = linuxState({ stored, pending })
    const world = linuxWorld(state)
    expect([label, (await readLogin(world.io, LOCATION))?.claudeAiOauth.refreshToken]).toEqual([label, expected])
    expect(state.order).toEqual(['read'])
    expect(state.pending).toBe(pending)
    expect(state.stored).toEqual(stored)
  }
  // With a renewal kept in memory, a read inspects instead, still without writing.
  const state = linuxState({ writeExit: 48 })
  const world = linuxWorld(state)
  await errorOf(() => renew(world.io))
  const kept = state.pending
  const before = state.order.length
  expect((await readLogin(world.io, LOCATION))?.claudeAiOauth.refreshToken).toBe('rotated-grant')
  expect(state.order.slice(before)).toEqual(['examine'])
  expect(state.pending).toBe(kept)
})

test('rule B decides lineage by the base refresh token, never by expiry', async () => {
  const stored = (refreshToken: string, expiresAt = 1_000): Credential => ({ claudeAiOauth: { accessToken: 'fixture-access', refreshToken, expiresAt } })
  const renewal = (base: string, refreshToken: string, expiresAt = 2_000): PendingLogin => ({ base, credential: { claudeAiOauth: { accessToken: `access-${refreshToken}`, refreshToken, expiresAt } } })
  expect(pendingState(stored('s0'), renewal('s0', 's1'))).toBe('usable')
  expect(pendingState(stored('s1'), renewal('s0', 's1'))).toBe('redundant')
  // Obsolete: the store moved past the renewal, even to a login that expires sooner.
  expect(pendingState(stored('s2', 10), renewal('s0', 's1', 9_000_000))).toBe('obsolete')
  // Foreign: the store was signed in again; a leftover of an earlier sign-in is not merged in.
  expect(pendingState(stored('other-account'), renewal('earlier-account', 'earlier-renewal', 9_000_000))).toBe('obsolete')
  expect(bestLogin(stored('other-account'), renewal('earlier-account', 'earlier-renewal', 9_000_000)).login?.claudeAiOauth.refreshToken).toBe('other-account')
  expect(pendingState(null, renewal('s0', 's1'))).toBe('orphaned')
  expect(bestLogin(null, renewal('s0', 's1')).login).toBe(null)
  // A salvaged login (expiresAt 0) based on the stored token is usable, though the store expires later.
  const salvaged = renewal('s0', 's1-salvaged', 0)
  expect(pendingState(stored('s0', 5_000_000), salvaged)).toBe('usable')
  expect(bestLogin(stored('s0', 5_000_000), salvaged).login?.claudeAiOauth.refreshToken).toBe('s1-salvaged')
  // Version 1, other versions and malformed files are not renewals at all.
  const grant = { accessToken: 'access-s1', refreshToken: 's1', expiresAt: 2_000 }
  expect(parsePendingLogin(JSON.stringify({ claudeAiOauth: grant }))).toBe(null)
  expect(parsePendingLogin('{"fixture-partial')).toBe(null)
  expect(parsePendingLogin(JSON.stringify({ version: 3, base: 's0', credential: { claudeAiOauth: grant } }))).toBe(null)
  expect(parsePendingLogin(JSON.stringify({ version: 2, base: '', credential: { claudeAiOauth: grant } }))).toBe(null)
  expect(parsePendingLogin(JSON.stringify({ version: 2, base: 's0', credential: { claudeAiOauth: { accessToken: 'a' } } }))).toBe(null)
  expect(parsePendingLogin(JSON.stringify({ version: 2, base: 's0', credential: { claudeAiOauth: grant } }))).toEqual(renewal('s0', 's1'))
  // Memory and the pending file on one chain: the later one wins.
  const memory = { ...renewal('s0', 's2'), spent: ['s1'] }
  expect(bestLogin(stored('s0'), renewal('s0', 's1'), memory).source).toBe('memory')
  expect(bestLogin(stored('s0'), renewal('s0', 's2'), memory).source).toBe('memory')
  expect(bestLogin(stored('s0'), renewal('s0', 's3'), memory).source).toBe('pending')
  expect(bestLogin(stored('s9'), renewal('s0', 's1'), memory)).toEqual({ login: stored('s9'), source: 'store', candidate: null })
  // The login keeps the stored document's other fields.
  expect(bestLogin({ ...stored('s0'), keep: 'kept' }, renewal('s0', 's1')).login?.keep).toBe('kept')
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
  expect(state.pending).toBe(undefined)
})

test('a renewal that cannot write the pending file or the store says it is kept in memory only', async () => {
  const state = linuxState({ writeExit: 49, pendingExit: 49 })
  const world = linuxWorld(state)
  const error = await errorOf(() => renew(world.io))
  expect(error).toContain('no space is left')
  expect(error).toContain('kept in this session\'s memory only')
  expect(world.logs.some(line => line.includes('pending file'))).toBe(true)
})

test('a compare-and-swap mismatch keeps the store another session saved and removes only the obsolete pending file', async () => {
  const state = linuxState()
  const world = linuxWorld(state)
  const stored = state.stored as Credential
  const other = { ...stored, claudeAiOauth: { ...stored.claudeAiOauth, accessToken: 'other-access', refreshToken: 'other-session-grant', expiresAt: 9_000_000 } }
  const fetch = world.io.fetch
  world.io.fetch = async (url, init) => { state.stored = other; return fetch(url, init) }
  const saved = await renew(world.io)
  expect(saved.claudeAiOauth.refreshToken).toBe('other-session-grant')
  expect(state.stored).toEqual(other)
  // This renewal's pending file {base: S0, credential: S1} is obsolete against the new store: it goes.
  expect(state.order.slice(-3)).toEqual(['write', 'examine', 'clearpending'])
  expect(state.pending).toBe(undefined)
  expect(world.logs.some(line => line.includes('another session'))).toBe(true)
  expect(await hasUnsavedLogin(world.io, LOCATION)).toBe(false)
})

test('a compare-and-swap mismatch keeps a pending renewal that is usable against the new store', async () => {
  const state = linuxState({ pendingExit: 49 })
  const world = linuxWorld(state)
  const stored = state.stored as Credential
  const signedIn = { ...stored, claudeAiOauth: { ...stored.claudeAiOauth, accessToken: 'other-access', refreshToken: 'other-session-grant', expiresAt: 9_000_000 } }
  const theirs = pendingText('other-session-grant', { accessToken: 'their-access', refreshToken: 'their-renewal', expiresAt: 9_500_000 })
  const fetch = world.io.fetch
  world.io.fetch = async (url, init) => { state.stored = signedIn; state.pending = theirs; return fetch(url, init) }
  const saved = await renew(world.io)
  expect(saved.claudeAiOauth.refreshToken).toBe('their-renewal')
  expect(state.stored).toEqual(signedIn)
  expect(state.pending).toBe(theirs)
  expect(state.order.includes('clearpending')).toBe(false)
  expect(await hasUnsavedLogin(world.io, LOCATION)).toBe(false)
})

test('a stalled session that saves its older renewal after a newer one began does not cost the newer login', async () => {
  // Session A renewed B to X and wrote {B, X} ahead, then stalled before its store write. Session C found {B, X},
  // renewed X to Y and wrote {B, Y}. A wakes: it saves X (the store held B), then clears only the pending file it owns.
  const stalled = { accessToken: 'stalled-access', refreshToken: 'stalled-grant', expiresAt: 1 }
  const state = linuxState({ pending: pendingText('fixture-refresh', stalled) })
  const world = linuxWorld(state)
  const run = world.io.run
  let woke = false
  let clearedByStalled: string | undefined
  world.io.run = async (argv, init) => {
    if (!woke && argv[3] === 'write') {
      woke = true
      state.stored = withGrant(state.stored as Credential, stalled)
      nativeProgram(state, 'clearpending', JSON.stringify({ base: 'fixture-refresh', tokens: ['fixture-refresh', 'stalled-grant'] }))
      clearedByStalled = state.pending
    }
    return run(argv, init)
  }
  const saved = await renew(world.io)
  expect(world.sent).toEqual(['stalled-grant'])
  expect(parsePendingLogin(clearedByStalled ?? '')?.credential.claudeAiOauth.refreshToken).toBe('rotated-grant')
  expect(saved.claudeAiOauth.refreshToken).toBe('rotated-grant')
  expect(state.stored?.claudeAiOauth.refreshToken).toBe('rotated-grant')
  expect(state.pending).toBe(undefined)
  expect(world.logs.some(line => line.includes('saving the newer one over it'))).toBe(true)
  // The second store write compared against the older renewal the stalled session had saved.
  expect(state.writes.map(text => (JSON.parse(text) as { expectedRefreshToken: string }).expectedRefreshToken)).toEqual(['fixture-refresh', 'stalled-grant'])
  expect(await hasUnsavedLogin(world.io, LOCATION)).toBe(false)
})

test('a store that cannot be read still answers with the newest renewal: a later pending renewal beats the one in memory', async () => {
  const state = linuxState({ writeExit: 48 })
  const world = linuxWorld(state)
  await errorOf(() => renew(world.io))
  const run = world.io.run
  world.io.run = async (argv, init) => argv[3] === 'examine' ? result('', 46) : run(argv, init)
  expect((await readLogin(world.io, LOCATION))?.claudeAiOauth.refreshToken).toBe('rotated-grant')
  // Another session renewed further under the same base while this one's store was unreadable.
  state.pending = pendingText('fixture-refresh', { accessToken: 'later-access', refreshToken: 'later-grant', expiresAt: 9_000_000 })
  expect((await readLogin(world.io, LOCATION))?.claudeAiOauth.refreshToken).toBe('later-grant')
  // A pending file with another base is not on this chain.
  state.pending = pendingText('someone-else', { accessToken: 'foreign-access', refreshToken: 'foreign-grant', expiresAt: 9_000_000 })
  expect((await readLogin(world.io, LOCATION))?.claudeAiOauth.refreshToken).toBe('later-grant')
  // The memory now holds the later renewal and the ones it descends from.
  state.pending = undefined
  expect((await readLogin(world.io, LOCATION))?.claudeAiOauth.refreshToken).toBe('later-grant')
})

test('after a plugin reload an unsaved renewal is saved when the lock is free, and used as it is when another session holds the lock', async () => {
  const state = linuxState({ writeExit: 48 })
  const world = linuxWorld(state)
  await errorOf(() => renew(world.io))
  forgetUnsavedLogins()
  state.writeExit = undefined
  // The lock is held by another session: no wait, no token request, the kept renewal is used.
  const run = world.io.run
  world.io.run = async (argv, init) => argv[0] === '/bin/sh' && String(argv[2]).includes('mkdir') ? result('', 1, 'mkdir: File exists') : run(argv, init)
  world.io.stat = async () => ({ kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
  const used = await renew(world.io)
  expect(used.claudeAiOauth.refreshToken).toBe('rotated-grant')
  expect(state.stored?.claudeAiOauth.refreshToken).toBe('fixture-refresh')
  expect(world.requests()).toBe(1)
  // The lock is free: the renewal is saved without another token request.
  world.io.run = run
  const saved = await renew(world.io)
  expect(saved.claudeAiOauth.refreshToken).toBe('rotated-grant')
  expect(state.stored?.claudeAiOauth.refreshToken).toBe('rotated-grant')
  expect(state.pending).toBe(undefined)
  expect(world.requests()).toBe(1)
  // Saved, it is answered without the lock.
  const before = state.order.length
  await renew(world.io)
  expect(state.order.slice(before)).toEqual(['examine'])
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

test('the renewal lock is renewed every 45 seconds while the token request hangs, which is never timed out', async () => {
  const state = linuxState()
  const world = linuxWorld(state)
  const pauses: number[] = []
  let answer: (() => void) | undefined
  world.io.fetch = () => new Promise<Response>(resolve => {
    state.order.push('fetch')
    answer = () => resolve({ ok: true, status: 200, headers: {}, text: ROTATION })
  })
  world.io.sleep = async ms => {
    pauses.push(ms)
    // The token endpoint answers during the third pause, more than 135 s after the request.
    if (pauses.length === 3) answer?.()
  }
  const saved = await renew(world.io)
  expect(saved.claudeAiOauth.refreshToken).toBe('rotated-grant')
  expect(pauses).toEqual([LOCK_HEARTBEAT_MS, LOCK_HEARTBEAT_MS, LOCK_HEARTBEAT_MS])
  expect(LOCK_HEARTBEAT_MS * 3).toBeLessThan(RENEWAL_LOCK.staleMs)
  expect(state.order).toEqual(['examine', 'examine', 'touch', 'fetch', 'touch', 'touch', 'pending', 'touch', 'write', 'clearpending'])
})

test('a lock taken over while the token request hangs still saves what the server returned, and starts nothing else', async () => {
  const state = linuxState()
  const world = linuxWorld(state)
  let mtime = 1
  world.io.stat = async () => ({ kind: 'dir', size: 0, mtimeMs: mtime, isLink: false })
  let answer: (() => void) | undefined
  world.io.fetch = () => new Promise<Response>(resolve => {
    state.order.push('fetch')
    answer = () => resolve({ ok: true, status: 200, headers: {}, text: ROTATION })
  })
  // Another session takes the lock over as stale during the first pause; the token endpoint answers once that is noticed.
  world.io.sleep = async () => { mtime = 2 }
  const log = world.io.log
  world.io.log = text => {
    log(text)
    if (text.includes('took over')) answer?.()
  }
  const saved = await renew(world.io)
  expect(saved.claudeAiOauth.refreshToken).toBe('rotated-grant')
  expect(state.stored?.claudeAiOauth.refreshToken).toBe('rotated-grant')
  expect(state.order).toEqual(['examine', 'examine', 'touch', 'fetch', 'pending', 'write', 'clearpending'])
  expect(world.logs.some(line => line.includes('took over'))).toBe(true)
  // The lock is now the other session's: it is not removed.
  expect(world.calls.some(call => String(call.argv[2]).includes('rmdir'))).toBe(false)
})

test('the lock stops being renewed after 10 minutes of a hanging token request, and the answer that arrives is still saved', async () => {
  const state = linuxState()
  const world = linuxWorld(state)
  const pauses: number[] = []
  let answer: (() => void) | undefined
  world.io.fetch = () => new Promise<Response>(resolve => {
    state.order.push('fetch')
    answer = () => resolve({ ok: true, status: 200, headers: {}, text: ROTATION })
  })
  world.io.sleep = async ms => { pauses.push(ms) }
  const log = world.io.log
  world.io.log = text => {
    log(text)
    if (text.includes('is no longer renewed')) answer?.()
  }
  const saved = await renew(world.io)
  expect(saved.claudeAiOauth.refreshToken).toBe('rotated-grant')
  // One heartbeat before the request and one per pause inside the limit; none after it, and none before the store write.
  const beats = Math.floor(LOCK_HEARTBEAT_LIMIT_MS / LOCK_HEARTBEAT_MS)
  expect(state.order.filter(operation => operation === 'touch').length).toBe(1 + beats)
  expect(pauses.length).toBe(beats + 1)
  expect(state.order.slice(-3)).toEqual(['pending', 'write', 'clearpending'])
  expect(world.logs.some(line => line.includes('no longer held meanwhile'))).toBe(true)
  expect(state.stored?.claudeAiOauth.refreshToken).toBe('rotated-grant')
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

/** A Linux lock whose /bin/sh commands are recorded as make, touch and remove. */
function lockWorld(mkdir: () => ReturnType<typeof result> = () => result()) {
  const commands: string[] = []
  const io = fixture(async argv => {
    if (argv[0] === '/usr/bin/uname') return result('Linux\n')
    const script = String(argv[2])
    if (script.includes('mkdir -p')) { commands.push('make'); return mkdir() }
    commands.push(script.includes('rmdir') ? 'remove' : 'touch')
    return result()
  })

  return { io, commands }
}

test('a failed stat right after taking the lock is asked again at once, and a lock whose time stays unknown is owned only while it is young', async () => {
  // Two failed stats, then the time: the lock is held with that time, so heartbeat and release work.
  // The fixture's sleep throws: no `$.clock` pause is taken, which a test clock would hold.
  const asked = lockWorld()
  let stats = 0
  asked.io.stat = async () => {
    stats += 1
    if (stats <= 2) throw new Error('EIO: fixture stat failure')
    return { kind: 'dir', size: 0, mtimeMs: 7, isLink: false }
  }
  const lock = await acquire(asked.io, '/locks/personal.lock', RENEWAL_LOCK)
  await lock.heartbeat()
  await lock.release()
  expect(asked.commands).toEqual(['make', 'touch', 'remove'])
  // The time stays unknown: never a time of 0 that makes every heartbeat fail and every release keep the lock.
  // Made once, it is this session's while younger than half the stale time since it was made or renewed.
  const unknown = lockWorld()
  let clock = 1_000
  unknown.io.now = async () => clock
  unknown.io.stat = async () => { throw new Error('EIO: fixture stat failure') }
  const young = await acquire(unknown.io, '/locks/personal.lock', RENEWAL_LOCK)
  clock += 60_000
  await young.heartbeat()
  clock += 60_000
  await young.release()
  expect(unknown.commands).toEqual(['make', 'touch', 'remove'])
  // Past half the stale time without a heartbeat it may be another session's: the heartbeat says so and release keeps it.
  const old = await acquire(unknown.io, '/locks/personal.lock', RENEWAL_LOCK)
  clock += RENEWAL_LOCK.staleMs / 2
  expect(await errorOf(() => old.heartbeat())).toContain('taken over')
  await old.release()
  expect(unknown.commands).toEqual(['make', 'touch', 'remove', 'make'])
})

test('a stat that fails while the lock is held is not a takeover: the youth rule decides, and an old unknown time is', async () => {
  const held = lockWorld()
  let failing = false
  held.io.stat = async () => {
    if (failing) throw new Error('EIO: fixture stat failure')
    return { kind: 'dir', size: 0, mtimeMs: 7, isLink: false }
  }
  let clock = 1_000
  held.io.now = async () => clock
  const lock = await acquire(held.io, '/locks/personal.lock', RENEWAL_LOCK)
  failing = true
  // The time was known when the lock was made; three failed stats now do not lose the lock.
  clock += 60_000
  await lock.heartbeat()
  clock += 60_000
  await lock.heartbeat()
  expect(held.commands).toEqual(['make', 'touch', 'touch'])
  // Left unrenewed past half the stale time while the time stays unknown, another session may own it.
  clock += RENEWAL_LOCK.staleMs / 2
  expect(await errorOf(() => lock.heartbeat())).toContain('taken over')
})

test('a lock released between a failed mkdir and its stat is taken on the next try; one that cannot be made says why', async () => {
  let made = 0
  const released = lockWorld(() => (made += 1) === 1 ? result('', 1, 'mkdir: File exists') : result())
  let stats = 0
  released.io.stat = async () => {
    stats += 1
    if (stats === 1) throw new Error('ENOENT: the holder released it')
    return { kind: 'dir', size: 0, mtimeMs: 3, isLink: false }
  }
  await acquire(released.io, '/locks/personal.lock', RENEWAL_LOCK)
  expect(released.commands).toEqual(['make', 'make'])
  const denied = lockWorld(() => result('', 1, 'mkdir: /locks: Permission denied'))
  denied.io.stat = async () => { throw new Error('ENOENT') }
  const error = await errorOf(() => acquire(denied.io, '/locks/personal.lock', RENEWAL_LOCK))
  expect(error).toContain('cannot make the lock /locks/personal.lock: mkdir: /locks: Permission denied')
  expect(error.includes('another session')).toBe(false)
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
  expect(state.stored?.claudeAiOauth.refreshToken).toBe('rotated-grant')
  expect(state.stored?.claudeAiOauth.expiresAt).toBe(0)
  expect(state.pending).toBe(undefined)
})

test('a salvaged rotation (expiresAt 0) whose store write fails stays usable by its base, and is renewed from next', async () => {
  const state = linuxState({ writeExit: 49 })
  const world = linuxWorld(state)
  const fetch = world.io.fetch
  world.io.fetch = async (_url, init) => {
    world.sent.push(spentBy(init))
    return { ok: true, status: 200, headers: {}, text: JSON.stringify({ refresh_token: 'salvaged-grant', expires_in: 3600 }) }
  }
  const error = await errorOf(() => renew(world.io))
  expect(error).toContain('returned no usable access token')
  expect(error).toContain(`kept in ${PENDING}`)
  const kept = parsePendingLogin(state.pending ?? '')
  expect(kept?.base).toBe('fixture-refresh')
  expect(kept?.credential.claudeAiOauth.expiresAt).toBe(0)
  // A new process: the pending file alone keeps the salvaged login, which a later expiry never hides.
  forgetUnsavedLogins()
  expect((await readLogin(world.io, LOCATION))?.claudeAiOauth.refreshToken).toBe('salvaged-grant')
  state.writeExit = undefined
  world.io.fetch = fetch
  const saved = await renew(world.io)
  expect(world.sent).toEqual(['fixture-refresh', 'salvaged-grant'])
  expect(saved.claudeAiOauth.refreshToken).toBe('rotated-grant')
  expect(JSON.parse(state.writes.at(-1) ?? '{}').expectedRefreshToken).toBe('fixture-refresh')
  expect(state.pending).toBe(undefined)
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

test('store write failures say what failed and where the renewal was kept, and promise an automatic save only when one can happen', async () => {
  const cases = [
    [48, 'could not be replaced after retrying for 3 seconds', true],
    [49, 'no space is left on its disk, or the file system is read-only', true],
    [46, 'permission was denied', true],
    [43, 'no longer holds a Claude OAuth login', false],
    [44, 'disappeared while the login was renewed', false],
  ] as const
  for (const [exit, expected, automatic] of cases) {
    const state = linuxState({ writeExit: exit })
    const world = linuxWorld(state)
    const stored = state.stored as Credential
    const fresh = { ...stored, claudeAiOauth: { ...stored.claudeAiOauth, accessToken: 'rotated-access', refreshToken: 'rotated-grant', expiresAt: 3_600_000 } }
    const error = await errorOf(() => writeLogin(world.io, LOCATION, fresh, stored))
    expect([exit, error.includes(expected)]).toEqual([exit, true])
    expect(error).toContain(`kept in ${PENDING}`)
    expect([exit, error.includes('saved automatically')]).toEqual([exit, automatic])
    expect([exit, error.includes('sign this account in again')]).toEqual([exit, !automatic])
    expect(error.includes('Node.js exited with code')).toBe(false)
    expect(error.includes('rotated-grant')).toBe(false)
  }
  // A pending copy whose folder is missing names the folder, not a vanished store.
  const state = linuxState({ pendingExit: 44, writeExit: 49 })
  const world = linuxWorld(state)
  await errorOf(() => renew(world.io))
  expect(world.logs.some(line => line.includes('the login folder does not exist'))).toBe(true)
})

// A macOS machine with one isolated login whose keychain items and pending file are simulated.
const MAC_CLAUDE = '/Users/me/.claude'
const MAC_LOGIN = `${MAC_CLAUDE}/rice-session-accounts/logins/personal`
const MAC_PENDING = `${MAC_LOGIN}/.credentials.json.rice-pending`
const MAC_MACHINE = { claudeDir: MAC_CLAUDE, user: 'me' as string | undefined, storage: {} }
const MAC_LOCATION: LoginLocation = { storage: { configDir: MAC_LOGIN, secureStorageDir: MAC_LOGIN }, defaultConfigDir: MAC_CLAUDE, user: 'me' }

function decodeHex(hex: string): string {
  return new TextDecoder().decode(new Uint8Array(hex.match(/../g)?.map(pair => Number.parseInt(pair, 16)) ?? []))
}

type MacItem = { service: string; account: string; text: string }

async function macWorld(initial: Credential, options: { stderr?: string; pending?: string; account?: string } = {}) {
  reset()
  const service = await liveServiceName({ configDir: MAC_LOGIN, secureStorageDir: MAC_LOGIN }, MAC_CLAUDE)
  const state = {
    items: [{ service, account: options.account ?? 'me', text: JSON.stringify(initial) }] as MacItem[],
    pending: options.pending,
    stderr: options.stderr,
    now: 0,
    lines: [] as string[],
    finds: [] as (readonly string[])[],
    removed: [] as string[],
    writers: 0,
    sent: [] as string[],
  }
  const logs: string[] = []
  let requests = 0
  const item = () => state.items.find(entry => entry.service === service)
  const io: Io = {
    run: async (argv, init) => {
      if (argv[0] === '/usr/bin/uname') return result('Darwin\n')
      // The login name cannot be found here: the account is known only from `user`.
      if (argv[0] === '/usr/bin/id') return result('', 1)
      if (argv[0] === '/usr/bin/security' && argv[1] === 'find-generic-password') {
        const named = (flag: string) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined
        const wanted = named('-s')
        const account = named('-a')
        if (wanted === service) state.finds.push(argv)
        const found = state.items.find(entry => entry.service === wanted && (account === undefined || entry.account === account))
        return found === undefined ? result('', 44) : result(found.text)
      }
      if (argv[0] === '/usr/bin/security' && argv[1] === '-i') {
        const line = init?.stdin ?? ''
        state.lines.push(line)
        if (state.stderr) return result('', 0, state.stderr)
        const match = /-a "([^"]+)" -s "([^"]+)" -X "([0-9a-f]+)"/.exec(line)
        const written = { account: match?.[1] ?? '', service: match?.[2] ?? '', text: decodeHex(match?.[3] ?? '') }
        const index = state.items.findIndex(entry => entry.service === written.service && entry.account === written.account)
        if (index >= 0) state.items[index] = written
        else state.items.push(written)
        return result()
      }
      if (argv[0] === '/bin/sh' && String(argv[2]).includes('umask 077')) {
        expect(argv[3]).toBe(MAC_PENDING)
        state.writers += 1
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
      return { kind: 'dir', size: 0, mtimeMs: 1, isLink: false }
    },
    env: async name => name === 'HOME' ? '/Users/me' : undefined,
    now: async () => state.now,
    sleep: async () => {},
    fetch: async (_url, init) => {
      requests += 1
      state.sent.push(spentBy(init))
      return { ok: true, status: 200, headers: {}, text: rotation(requests) }
    },
    log: text => { logs.push(text) },
  }

  return { io, service, state, item, logs, requests: () => requests }
}

/** `null` is an unknown login name (an undefined argument would take the default). */
function renewMac(io: Io, user: string | null = 'me'): Promise<Credential> {
  return freshLogin(io, 'personal', { kind: 'claudeai', loginDir: MAC_LOGIN }, pathsFor(MAC_CLAUDE), { ...MAC_MACHINE, user: user ?? undefined })
}

const macExpired: Credential = { claudeAiOauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: 1, scopes: ['user:inference'] }, keep: 'small' }

test('a macOS renewal stays under the security -i line limit, dropping only large optional keys', async () => {
  const world = await macWorld({ ...macExpired, mcpOAuth: { server: 'm'.repeat(5000) } })
  const saved = await renewMac(world.io)
  expect(world.requests()).toBe(1)
  expect(world.state.lines.length).toBe(1)
  expect((world.state.lines[0] ?? '').length).toBeLessThanOrEqual(SECURITY_LINE_LIMIT)
  const item = JSON.parse(world.item()?.text ?? '{}') as Credential
  expect(item.claudeAiOauth.refreshToken).toBe('rotated-grant')
  expect(item.claudeAiOauth.scopes).toEqual(['user:inference'])
  expect(item.keep).toBe('small')
  expect('mcpOAuth' in item).toBe(false)
  expect(saved.claudeAiOauth.accessToken).toBe('rotated-access')
  expect(world.logs.some(line => line.includes('mcpOAuth'))).toBe(true)
  expect(world.logs.some(line => line.includes('rotated'))).toBe(false)
  // Written ahead, then removed once the keychain holds the renewal.
  expect(world.state.writers).toBe(1)
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

test('macOS re-reads the item before writing and keeps another session\'s grant, removing the obsolete pending file', async () => {
  const world = await macWorld(macExpired)
  const other = { ...macExpired, claudeAiOauth: { ...macExpired.claudeAiOauth, accessToken: 'other-access', refreshToken: 'other-session-grant', expiresAt: 9_000_000 } }
  const fetch = world.io.fetch
  world.io.fetch = async (url, init) => {
    const entry = world.item()
    if (entry) entry.text = JSON.stringify(other)
    return fetch(url, init)
  }
  const saved = await renewMac(world.io)
  expect(saved.claudeAiOauth.refreshToken).toBe('other-session-grant')
  expect(world.state.lines).toEqual([])
  expect(world.state.pending).toBe(undefined)
  expect(world.state.removed).toEqual([MAC_PENDING])
})

test('macOS clears only the pending file this renewal owns: a later renewal by another session under the same base stays', async () => {
  const world = await macWorld(macExpired)
  const theirs = pendingText('fixture-refresh', { accessToken: 'later-access', refreshToken: 'later-grant', expiresAt: 9_000_000 })
  const run = world.io.run
  world.io.run = async (argv, init) => {
    const ran = await run(argv, init)
    // Another session wrote its later renewal after this one's write-ahead.
    if (argv[0] === '/usr/bin/security' && argv[1] === '-i') world.state.pending = theirs
    return ran
  }
  const saved = await renewMac(world.io)
  expect(saved.claudeAiOauth.refreshToken).toBe('rotated-grant')
  expect(world.state.removed).toEqual([])
  expect(world.state.pending).toBe(theirs)
})

test('security -i error text is a failed write: the renewal is kept in the pending file and used by later reads', async () => {
  const world = await macWorld(macExpired, { stderr: 'security: Unknown command "3f7b"\n' })
  const error = await errorOf(() => renewMac(world.io))
  expect(error).toContain('security reported an error')
  expect(error).toContain(`kept in ${MAC_PENDING}`)
  expect(JSON.parse(world.item()?.text ?? '{}').claudeAiOauth.refreshToken).toBe('fixture-refresh')
  expect(parsePendingLogin(world.state.pending ?? '')).toEqual({ base: 'fixture-refresh', credential: { claudeAiOauth: { accessToken: 'rotated-access', refreshToken: 'rotated-grant', expiresAt: 3_600_000 } } })
  forgetUnsavedLogins()
  expect((await readLogin(world.io, MAC_LOCATION))?.claudeAiOauth.refreshToken).toBe('rotated-grant')
})

test('macOS reads use a usable pending renewal but never write the keychain or remove a file', async () => {
  const renewed = { accessToken: 'pending-access', refreshToken: 'pending-grant', expiresAt: 5_000_000 }
  const cases: [string, Credential, string, string][] = [
    ['usable', macExpired, pendingText('fixture-refresh', renewed), 'pending-grant'],
    ['obsolete', withGrant(macExpired, { ...renewed, refreshToken: 'other-grant', expiresAt: 1 }), pendingText('fixture-refresh', renewed), 'other-grant'],
    ['version 1', macExpired, JSON.stringify({ claudeAiOauth: renewed }), 'fixture-refresh'],
  ]
  for (const [label, stored, pending, expected] of cases) {
    const world = await macWorld(stored, { pending })
    const read = await readLogin(world.io, MAC_LOCATION)
    expect([label, read?.claudeAiOauth.refreshToken]).toEqual([label, expected])
    expect(read?.keep).toBe('small')
    expect(world.state.lines).toEqual([])
    expect(world.state.removed).toEqual([])
    expect(world.state.writers).toBe(0)
    expect(world.state.pending).toBe(pending)
  }
})

test('macOS: a renewal chain whose keychain writes fail keeps the first base, reads one item throughout, and the final save clears the pending file', async () => {
  const world = await macWorld(macExpired, { stderr: 'security: SecKeychainItemModifyContent: fixture failure\n' })
  expect(await errorOf(() => renewMac(world.io))).toContain(`kept in ${MAC_PENDING}`)
  forgetUnsavedLogins()
  world.state.now = 4_000_000
  expect(await errorOf(() => renewMac(world.io))).toContain('security reported an error')
  expect(world.state.sent).toEqual(['fixture-refresh', 'rotated-grant'])
  expect(parsePendingLogin(world.state.pending ?? '')).toEqual({ base: 'fixture-refresh', credential: { claudeAiOauth: { accessToken: 'rotated-access-2', refreshToken: 'rotated-grant-2', expiresAt: 7_600_000 } } })
  expect(JSON.parse(world.item()?.text ?? '{}').claudeAiOauth.refreshToken).toBe('fixture-refresh')
  expect(world.state.removed).toEqual([])
  world.state.stderr = undefined
  const saved = await renewMac(world.io)
  expect(saved.claudeAiOauth.refreshToken).toBe('rotated-grant-2')
  expect(world.requests()).toBe(2)
  expect(JSON.parse(world.item()?.text ?? '{}').claudeAiOauth.refreshToken).toBe('rotated-grant-2')
  expect(world.state.pending).toBe(undefined)
  expect(world.state.removed).toEqual([MAC_PENDING])
  // Every read of the login's item (plain, before a write, read-back) names the account the writes use.
  expect(world.state.finds.length).toBeGreaterThan(5)
  for (const argv of world.state.finds) expect(argv.slice(2)).toEqual(['-s', world.service, '-a', 'me', '-w'])
  for (const line of world.state.lines) expect(line.startsWith(`add-generic-password -U -a "me" -s "${world.service}" -X "`)).toBe(true)
  expect(world.state.items.length).toBe(1)
})

test('a macOS login Claude Code kept in its plaintext file instead of the keychain is named with its fix, and never used, renewed or changed', async () => {
  const plaintext = `${MAC_LOGIN}/.credentials.json`
  const files: Record<string, string> = { [plaintext]: JSON.stringify(macExpired) }
  const world = await macWorld(macExpired)
  const { stat, read } = world.io
  const consulted: string[] = []
  world.io.stat = async path => {
    const text = files[path]
    if (path === plaintext) consulted.push(path)
    return text === undefined ? stat(path) : { kind: 'file', size: text.length, mtimeMs: 1, isLink: false }
  }
  world.io.read = async path => files[path] ?? read(path)
  // Claude Code reads the keychain item first: while there is one, the file is not consulted.
  expect((await readLogin(world.io, MAC_LOCATION))?.claudeAiOauth.refreshToken).toBe('fixture-refresh')
  expect(consulted).toEqual([])
  world.state.items = []
  const error = await errorOf(() => renewMac(world.io))
  expect(error).toContain(`is in its plaintext credentials file ${plaintext}, not in the macOS keychain item "${world.service}"`)
  expect(error).toContain('security unlock-keychain')
  expect(error).toContain('/rice-account setup <name> prints, with --login added')
  expect(error).toContain('claude auth login')
  expect(error.includes('fixture-access') || error.includes('fixture-refresh')).toBe(false)
  expect(await errorOf(() => readLogin(world.io, MAC_LOCATION))).toContain('plaintext credentials file')
  expect(world.requests()).toBe(0)
  expect(world.state.lines).toEqual([])
  expect(world.state.writers).toBe(0)
  expect(world.state.removed).toEqual([])
  expect(files[plaintext]).toBe(JSON.stringify(macExpired))
  // A file without a login, or none, is no login: not signed in, as before.
  files[plaintext] = JSON.stringify({ mcpOAuth: { server: 'fixture' } })
  expect(await errorOf(() => renewMac(world.io))).toContain('personal is not signed in yet')
  delete files[plaintext]
  expect(await readLogin(world.io, MAC_LOCATION)).toBe(null)
})

test('macOS without a known login name reads, compares and reads back the same item without -a, and writes it as claude-code-user', async () => {
  const world = await macWorld(macExpired, { account: 'claude-code-user' })
  const saved = await renewMac(world.io, null)
  expect(saved.claudeAiOauth.refreshToken).toBe('rotated-grant')
  expect(world.state.finds.length).toBeGreaterThan(3)
  for (const argv of world.state.finds) expect(argv.slice(2)).toEqual(['-s', world.service, '-w'])
  expect(world.state.lines.length).toBe(1)
  expect((world.state.lines[0] ?? '').startsWith(`add-generic-password -U -a "claude-code-user" -s "${world.service}" -X "`)).toBe(true)
  expect(world.state.items.length).toBe(1)
  expect(JSON.parse(world.item()?.text ?? '{}').claudeAiOauth.refreshToken).toBe('rotated-grant')
})

// The plugin in a Linux host: what its requests carry, and the usage it hands the engine.
const HOST_HOME = '/fixture/identity-host'
const HOST_CONFIG = `${HOST_HOME}/.claude`
const HOST_PATHS = pathsFor(HOST_CONFIG)
const HOST_NOW = 1_800_000_000_000
const HOST_LOCK = { make: 'mkdir -p "$(dirname "$0")" && mkdir "$0"', touch: '[ -d "$0" ] && touch -c "$0"', remove: '[ ! -d "$0" ] || rmdir "$0"' }
const USAGE_DRIVER = { plugins: [{ name: 'usage-driver', register(on: On) {
  on('command.run', { command: 'usage-probe' }, async $ => ({ text: JSON.stringify((await $.session.usage()).rateLimits) }))
} }] }

function hostCommand(args: string, name = 'rice-account'): CommandRunInput {
  return { command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }
}

function identityHost(on: On) {
  const work = HOST_PATHS.loginDir('work')
  const documents = new Map<string, string>([
    [HOST_PATHS.config, serializeConfig({ ...defaultConfig(), accounts: { ...defaultConfig().accounts, work: { kind: 'claudeai', loginDir: work } } })],
    [`${work}/.credentials.json`, JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-access-work', refreshToken: 'fixture-refresh-work', expiresAt: 1 } })],
    [`${work}/.claude.json`, JSON.stringify({ oauthAccount: { emailAddress: 'work@example.test' } })],
    [`${HOST_CONFIG}/.credentials.json`, JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-access-machine', refreshToken: 'fixture-refresh-machine', expiresAt: HOST_NOW + 3_600_000 } })],
  ])
  const environment = new Map([['HOME', HOST_HOME], ['USER', 'fixture'], ['CLAUDE_CONFIG_DIR', HOST_CONFIG]])
  const kept = new Map<string, { value: unknown; version: number }>()
  const locks = new Map<string, number>()
  const requests: { url: string; agent: string | undefined }[] = []
  const status: (string | undefined)[] = []
  // No settings override the account: a switch is checked against them.
  on('settings.read', () => ({ value: {} }))
  const answer = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  const json = (body: unknown) => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify(body) } })
  mock.clock(on, { now: HOST_NOW })
  mock.store(on)
  on('state.get', (_host, input) => ({ value: (kept.get(String(input.key)) ?? { value: undefined, version: 0 }) as never }))
  on('state.set', (_host, input) => {
    const version = (kept.get(String(input.key))?.version ?? 0) + 1
    kept.set(String(input.key), { value: input.value, version })
    return { value: { isSet: true, version } }
  })
  on('env.get', (_host, input) => ({ value: environment.get(input.name) }))
  on('env.set', (_host, input) => {
    if (input.value === undefined) environment.delete(input.name)
    else environment.set(input.name, input.value)
    return { value: {} }
  })
  on('fs.exists', (_host, input) => ({ value: documents.has(fixturePath(input.path)) }))
  on('fs.read', (_host, input) => {
    const text = documents.get(fixturePath(input.path))
    if (text === undefined) throw new Error('ENOENT: isolated fixture file')
    return { value: text }
  })
  on('fs.write', (_host, input) => { documents.set(fixturePath(input.path), input.text); return { value: undefined } })
  on('fs.stat', (_host, input) => {
    const modified = locks.get(fixturePath(input.path))
    if (modified === undefined) throw new Error('ENOENT: isolated fixture file')
    return { value: { kind: 'dir' as const, size: 0, mtimeMs: modified, isLink: false } }
  })
  on('fs.list', () => ({ value: [] }))
  on('process.run', (_host, input) => {
    const [program, , script, operation, path = ''] = input.argv
    if (program === '/usr/bin/uname') return answer(0, 'Linux\n')
    if (program === '/bin/sh' && script === HOST_LOCK.make) { locks.set(fixturePath(operation ?? ''), HOST_NOW); return answer(0) }
    if (program === '/bin/sh' && script === HOST_LOCK.touch) { locks.set(fixturePath(operation ?? ''), HOST_NOW + 1); return answer(0) }
    if (program === '/bin/sh' && script === HOST_LOCK.remove) { locks.delete(fixturePath(operation ?? '')); return answer(0) }
    if (program !== 'node') return answer(127)
    const text = documents.get(path)
    if (operation === 'read') return text === undefined ? answer(44) : answer(0, text)
    if (operation === 'examine') return answer(0, JSON.stringify({ stored: text === undefined ? null : JSON.parse(text), pending: null }))
    if (operation === 'write') {
      const current = JSON.parse(text ?? '{}') as Credential
      const request = JSON.parse(input.init?.stdin ?? '{}') as { oauth: Credential['claudeAiOauth'] }
      const saved = { ...current, claudeAiOauth: { ...current.claudeAiOauth, ...request.oauth } }
      documents.set(path, JSON.stringify(saved))
      return answer(0, JSON.stringify(saved))
    }
    return answer(0)
  })
  on('http.fetch', (_host, input) => {
    requests.push({ url: input.url, agent: input.init?.headers?.['User-Agent'] })
    if (input.url === 'https://platform.claude.com/v1/oauth/token') return json({ access_token: 'fixture-access-work-renewed', refresh_token: 'fixture-refresh-work-2', expires_in: 3600 })
    if (input.url === 'https://api.anthropic.com/api/oauth/profile') return json({ account: { email: 'machine@example.test' } })
    return json({ limits: [
      { kind: 'session', percent: 12.345, resets_at: '2026-10-18T15:00:00+00:00' },
      { kind: 'weekly_all', percent: 40 },
      { kind: 'weekly_opus', percent: 7.000000000000001, scope: { model: { display_name: 'Opus' } } },
    ] })
  })
  on('session.version', () => ({ value: { version: '2.1.302' } }))
  on('session.start', (_host, input) => ({ cwd: input.cwd }))
  on('session.usage', () => ({ value: { startedAt: HOST_NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('command.register', (_host, input) => ({ value: { command: input.name } }))
  on('ui.status', (_host, input) => { status.push(input.text); return { value: undefined } })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))

  return { requests, status }
}

test('usage, profile and token requests carry Claude Code\'s User-Agent, and session.usage gets only the windows the engine declares', USAGE_DRIVER, async ($, on) => {
  const host = identityHost(on)
  await $.session.start({ cwd: HOST_HOME, surface: 'terminal', isInteractive: true })
  expect((await $.command.run(hostCommand('check'))).text ?? '').toContain('login: signed in as machine@example.test')
  expect((await $.command.run(hostCommand('work'))).text ?? '').toContain('now uses work')
  expect(JSON.parse((await $.command.run(hostCommand('', 'usage-probe'))).text ?? '[]')).toEqual([
    { kind: 'five_hour', percentUsed: 12.3, resetsAt: '2026-10-18T15:00:00+00:00' },
    { kind: 'seven_day', percentUsed: 40 },
  ])
  // The plugin's own status line still shows the model's window.
  expect(host.status.at(-1) ?? '').toContain('5h 12%, wk 40%, Opus 7%')
  expect(host.requests.map(request => request.url)).toEqual([
    'https://api.anthropic.com/api/oauth/profile',
    'https://platform.claude.com/v1/oauth/token',
    'https://api.anthropic.com/api/oauth/usage',
  ])
  for (const request of host.requests) expect(request.agent).toBe('claude-cli/2.1.302 (external, cli)')
})
