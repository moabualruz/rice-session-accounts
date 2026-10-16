// Adapted from simplecore-inc/claude-mods mods/accounts/hooks/io.ts at 722763c
// (MIT, Copyright (c) 2026 SimpleCORE Inc., see LICENSES/simplecore-claude-mods.MIT.txt).
// Modified: trimmed to what rice-session-accounts uses; no store or listing.
import type { FsStat, HttpInit, HttpResponse, ProcessRunInit, ProcessRunResult } from 'claude-code'

/** The environment variables the modules read, each read by its literal name in register.ts. */
export type EnvName = 'HOME' | 'USER' | 'OS' | 'USERPROFILE' | 'USERNAME' | 'SystemRoot' | 'WINDIR' | 'FORCE_WINDOWS_CREDMAN' | 'CLAUDE_CONFIG_DIR' | 'CLAUDE_SECURESTORAGE_CONFIG_DIR'

/** What the modules reach the machine through; register.ts builds it over `$`. */
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
