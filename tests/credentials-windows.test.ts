import { expect, test } from 'claude-code/testing'
import { hostPlatform, nativeCredentialPath, readLogin, readSecret } from '../hooks/credentials'
import type { Io } from '../hooks/io'
import { setupCommand } from '../hooks/setup'

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

test('a requested unsupported Windows browser store fails before reading another native store', async () => {
  const io = windowsIo(async () => { throw new Error('must not read another credential store') })
  const environment = io.env
  io.env = async name => name === 'FORCE_WINDOWS_CREDMAN' ? '1' : environment(name)
  let message = ''
  try { await readLogin(io, { storage: {}, defaultConfigDir: 'C:\\fixture\\.claude' }) }
  catch (error) { message = error instanceof Error ? error.message : String(error) }
  expect(message).toContain('FORCE_WINDOWS_CREDMAN')
})
