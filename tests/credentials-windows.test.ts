import { expect, test } from 'claude-code/testing'
import { hostPlatform, nativeCredentialPath, readLogin, readSecret } from '../hooks/credentials'
import type { Io } from '../hooks/io'
import { setupCommand, signOutHint } from '../hooks/setup'
import { WINDOWS_CREDENTIAL_STORE, WINDOWS_EXIT, WINDOWS_PRIVATE_DIRECTORY, windowsStoreProblem } from '../scripts/windows-store-payloads.mjs'

function windowsIo(run: Io['run']): Io {
  return {
    run,
    env: async name => name === 'OS' ? 'Windows_NT' : name === 'SystemRoot' ? 'C:\\Windows' : undefined,
    read: async () => { throw new Error('unexpected file read') },
    write: async () => { throw new Error('unexpected file write') },
    exists: async () => false,
    stat: async () => ({ kind: 'dir', size: 0, mtimeMs: 0, isLink: false }),
    now: async () => 0, sleep: async () => {},
    fetch: async () => { throw new Error('unexpected network') }, log: () => {},
  }
}

test('native Windows detection uses its environment and never attempts POSIX uname', async () => {
  const io = windowsIo(async () => { throw new Error('no process is required for Windows platform detection') })
  expect(await hostPlatform(io)).toBe('win32')
  expect(nativeCredentialPath({ storage: { configDir: 'C:\\Users\\fixture name\\.claude' }, defaultConfigDir: 'C:\\Users\\fixture name\\.claude' }, undefined, 'win32')).toBe('C:\\Users\\fixture name\\.claude/.credentials.json')
  expect(() => nativeCredentialPath({ storage: { configDir: '\\drive-relative' }, defaultConfigDir: '\\drive-relative' }, undefined, 'win32')).toThrow('absolute path')
})

test('the Windows token lookup keeps references on stdin and returns only the native store output', async () => {
  let called = false
  const io = windowsIo(async (argv, init) => {
    called = true
    expect(argv[0]).toBe('C:\\Windows/System32/WindowsPowerShell/v1.0/powershell.exe')
    expect(argv.at(-1)).toContain('CredReadW')
    expect(JSON.parse(init?.stdin ?? '{}')).toEqual({ operation: 'read', service: 'fixture-service', account: 'fixture-account' })
    return { exitCode: 0, stdout: 'fixture-token-output', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  })
  expect(await readSecret(io, { service: 'fixture-service', account: 'fixture-account' })).toBe('fixture-token-output')
  expect(called).toBe(true)
})

test('the copied Windows setup command uses PowerShell quoting for spaces and apostrophes', () => {
  expect(setupCommand("C:\\Users\\fixture's name\\plugin", "C:\\Users\\fixture's name\\.claude", 'personal', 'win32')).toBe("& node 'C:\\Users\\fixture''s name\\plugin/scripts/account-setup.mjs' --config-dir 'C:\\Users\\fixture''s name\\.claude' 'personal'")
})

test('Windows commands keep typographic apostrophes, $ and backticks literal and drop the trailing separator PowerShell 5.1 mangles', () => {
  const command = setupCommand('C:\\Users\\Zoë O\u2019Brien\\plugin', 'C:\\Users\\Zoë O\u2019Brien\\$cfg `x`\\', 'personal', 'win32')
  expect(command).toBe("& node 'C:\\Users\\Zoë O\u2019\u2019Brien\\plugin/scripts/account-setup.mjs' --config-dir 'C:\\Users\\Zoë O\u2019\u2019Brien\\$cfg `x`' 'personal'")
  expect(signOutHint('C:\\Users\\Zoë O\u2019Brien\\.claude/rice-session-accounts/logins/personal', 'win32')).toContain("'C:\\Users\\Zoë O\u2019\u2019Brien\\.claude/rice-session-accounts/logins/personal'")
})

test('Windows storage payloads report distinct causes and keep 46 as the catch-all', () => {
  expect([WINDOWS_EXIT.FAILED, WINDOWS_EXIT.PATH_TOO_LONG, WINDOWS_EXIT.CONSTRAINED_LANGUAGE, WINDOWS_EXIT.ACCESS_DENIED, WINDOWS_EXIT.NOT_FOUND, WINDOWS_EXIT.NO_LOGON_SESSION]).toEqual([46, 48, 49, 51, 52, 53])
  expect(windowsStoreProblem(48)).toContain('too long')
  expect(windowsStoreProblem(49)).toContain('ConstrainedLanguage')
  expect(windowsStoreProblem(51, 'the isolated login folder', 'UnauthorizedAccessException')).toContain('denied access to the isolated login folder (UnauthorizedAccessException)')
  expect(windowsStoreProblem(52)).toContain('does not exist')
  expect(windowsStoreProblem(53)).toContain('interactive Windows sign-in')
  expect(windowsStoreProblem(46)).toContain('exit 46')
  for (const payload of [WINDOWS_PRIVATE_DIRECTORY, WINDOWS_CREDENTIAL_STORE]) {
    expect(payload.includes("LanguageMode -ne 'FullLanguage'")).toBe(true)
    expect(payload.indexOf("LanguageMode -ne 'FullLanguage'") < payload.indexOf('[Console]::In.ReadToEnd()')).toBe(true)
  }
  expect(WINDOWS_PRIVATE_DIRECTORY).toContain('[System.IO.Directory]::SetAccessControl($path, $repair)')
})

async function errorOf(work: () => Promise<unknown>): Promise<string> {
  try { await work(); return '' } catch (error) { return error instanceof Error ? error.message : String(error) }
}

test('a requested unsupported Windows browser store fails before reading another native store', async () => {
  const io = windowsIo(async () => { throw new Error('must not read another credential store') })
  const environment = io.env
  io.env = async name => name === 'CLAUDE_CODE_FORCE_WINDOWS_CREDMAN' ? '1' : environment(name)
  const message = await errorOf(() => readLogin(io, { storage: {}, defaultConfigDir: 'C:\\fixture\\.claude' }))
  expect(message).toContain('Windows Credential Manager (CLAUDE_CODE_FORCE_WINDOWS_CREDMAN is 1)')
  expect(message).toContain('the credentials file C:\\fixture\\.claude/.credentials.json')
  expect(message).toContain('claudeai-token')
  expect(message).toContain('without CLAUDE_CODE_FORCE_WINDOWS_CREDMAN')
})

/** A Windows machine whose config files are `files`; its credentials file is absent, so a read that is not refused answers null. */
function credmanWorld(files: Record<string, string>, variables: Record<string, string> = {}): Io {
  const io = windowsIo(async argv => {
    if (argv[0] === 'node') return { exitCode: 44, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    throw new Error('unexpected executable')
  })
  io.env = async name => variables[name] ?? (name === 'OS' ? 'Windows_NT' : name === 'USERPROFILE' ? 'C:\\Users\\me' : undefined)
  io.stat = async path => {
    const text = files[path]
    if (text === undefined) throw new Error('ENOENT')
    return { kind: 'file', size: text.length, mtimeMs: 0, isLink: false }
  }
  io.read = async path => {
    const text = files[path]
    if (text === undefined) throw new Error('ENOENT')
    return text
  }
  return io
}

test('Claude Code\'s own rule decides Credential Manager: the exact variable, else the cached flag in .config.json, else in .claude.json', async () => {
  const machine = { storage: {}, defaultConfigDir: 'C:\\Users\\me\\.claude' }
  const loginDir = 'C:\\Users\\me\\.claude/rice-session-accounts/logins/work'
  const account = { storage: { configDir: loginDir, secureStorageDir: loginDir }, defaultConfigDir: 'C:\\Users\\me\\.claude' }
  const flagged = JSON.stringify({ cachedGrowthBookFeatures: { tengu_windows_credman: true } })
  const plain = JSON.stringify({ cachedGrowthBookFeatures: { tengu_windows_credman: false }, oauthAccount: {} })
  const machineGlobal = 'C:\\Users\\me/.claude.json'
  const machineLegacy = 'C:\\Users\\me\\.claude/.config.json'
  const refusal = (files: Record<string, string>, location: typeof machine | typeof account = machine, variables: Record<string, string> = {}) =>
    errorOf(() => readLogin(credmanWorld(files, variables), location))

  // Only exactly 1 counts; the name without the CLAUDE_CODE_ prefix is not Claude Code's.
  expect(await refusal({}, machine, { CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: '1' })).toContain('(CLAUDE_CODE_FORCE_WINDOWS_CREDMAN is 1)')
  const ignored: Record<string, string>[] = [{ CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: 'true' }, { CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: '0' }, { FORCE_WINDOWS_CREDMAN: '1' }]
  for (const variables of ignored) {
    expect(await refusal({}, machine, variables)).toBe('')
  }
  // The machine login: the global config in the home folder.
  const cached = await refusal({ [machineGlobal]: flagged })
  expect(cached).toContain(`(its cached setting tengu_windows_credman is on in ${machineGlobal})`)
  expect(cached).toContain('Use a claudeai-token account instead')
  expect(cached.includes('without CLAUDE_CODE_FORCE_WINDOWS_CREDMAN')).toBe(false)
  expect(await refusal({ [machineGlobal]: plain })).toBe('')
  // A legacy .config.json that is present and not empty is read instead, even without the flag.
  expect(await refusal({ [machineLegacy]: plain, [machineGlobal]: flagged })).toBe('')
  expect(await refusal({ [machineLegacy]: flagged, [machineGlobal]: plain })).toContain(`on in ${machineLegacy}`)
  expect(await refusal({ [machineLegacy]: '', [machineGlobal]: flagged })).toContain(`on in ${machineGlobal}`)
  // An isolated login: the config Claude Code reads with CLAUDE_CONFIG_DIR set to its folder.
  expect(await refusal({ [`${loginDir}/.claude.json`]: flagged }, account)).toContain(`for ${loginDir} in Windows Credential Manager`)
  expect(await refusal({ [machineGlobal]: flagged }, account)).toBe('')
  // A config that cannot be parsed, or a flag that is not true, counts as off.
  for (const text of ['{"cachedGrowthBookFeatures":', 'null', JSON.stringify({ cachedGrowthBookFeatures: { tengu_windows_credman: 'true' } })]) {
    expect(await refusal({ [machineGlobal]: text })).toBe('')
  }
})
