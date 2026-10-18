// Adapted from simplecore-inc/claude-mods mods/accounts/hooks/io.ts at 722763c
// (MIT, Copyright (c) 2026 SimpleCORE Inc., see LICENSES/simplecore-claude-mods.MIT.txt).
// Modified: trimmed to what rice-session-accounts uses; no store or listing; trusted
// process options and process-failure classification added.
import type { FsStat, HttpInit, HttpResponse, ProcessRunInit, ProcessRunResult } from 'claude-code'

/** The environment variables the modules read, each read by its literal name in register.ts. */
export type EnvName = 'HOME' | 'USER' | 'OS' | 'USERPROFILE' | 'USERNAME' | 'SystemRoot' | 'WINDIR' | 'CLAUDE_CODE_FORCE_WINDOWS_CREDMAN' | 'CLAUDE_CONFIG_DIR' | 'CLAUDE_SECURESTORAGE_CONFIG_DIR'
  | 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR' | 'ANTHROPIC_FEDERATION_RULE_ID' | 'ANTHROPIC_ORGANIZATION_ID'

/**
 * What the modules reach the machine through; register.ts builds it over `$`.
 * `run` takes the host's `{ cwd, env, stdin, timeoutMs }`: `cwd` replaces the
 * session's working directory and `env` is set over the host environment.
 */
export type Io = {
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
  stat: (path: string) => Promise<FsStat>
  env: (name: EnvName) => Promise<string | undefined>
  now: () => Promise<number>
  sleep: (ms: number) => Promise<void>
  fetch: (url: string, init?: HttpInit) => Promise<HttpResponse>
  /** A line for the debug log; never a secret. */
  log: (text: string) => void
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Variables set on every credential-related child. Windows searches the
 * current directory before PATH unless NoDefaultCurrentDirectoryInExePath is
 * set, and NODE_OPTIONS could preload code into the Node credential program.
 */
export const TRUSTED_ENV: Readonly<Record<string, string>> = { NoDefaultCurrentDirectoryInExePath: '1', NODE_OPTIONS: '' }

/**
 * Options for a credential-related child: a trusted working directory (never
 * the session's project folder, which may be a cloned repository holding a
 * planted program) and the trusted environment above.
 */
export function trustedRun(cwd: string, init: { stdin?: string; timeoutMs?: number } = {}): ProcessRunInit {
  return { ...init, cwd, env: { ...TRUSTED_ENV } }
}

/** Why `io.run` rejected: it ran out of time, its program was not found, could not be executed, or something else. */
export type RunFailure = 'timeout' | 'missing' | 'denied' | 'failed'

/**
 * Classifies an `io.run` rejection. The host rejects with "still running
 * after N ms" when the timeout kills the child, and with the spawn error
 * (ENOENT, EACCES) when the program cannot start.
 */
export function runFailure(error: unknown): RunFailure {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : ''
  const text = `${code} ${message(error)}`
  if (/still running after|timed? ?out|ETIMEDOUT/i.test(text)) return 'timeout'
  if (/ENOENT|not found|no such file|cannot find/i.test(text)) return 'missing'
  if (/EACCES|EPERM|ENOEXEC|permission denied|not executable/i.test(text)) return 'denied'
  return 'failed'
}
