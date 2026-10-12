// Adapted from simplecore-inc/claude-mods mods/accounts/hooks/lock.ts at 722763c
// (MIT, Copyright (c) 2026 SimpleCORE Inc., see LICENSES/simplecore-claude-mods.MIT.txt).
// Modified: POSIX only (the Windows PowerShell paths removed).
import type { Io } from './io'

/**
 * Locks held across processes, laid out as proper-lockfile lays them: a
 * directory only one process can make, taken as abandoned once its
 * modification time is older than the lock's stale time.
 */
export type Lock = { release: () => Promise<void> }

export class LockBusyError extends Error {}

export type LockOptions = { staleMs: number; tries: number }

export function retryDelay(attempt: number): number {
  return Math.min(1000, 100 * 2 ** attempt)
}

const MAKE = ['/bin/sh', '-c', 'mkdir -p "$(dirname "$0")" && mkdir "$0"']
const REMOVE = ['/bin/sh', '-c', '[ ! -d "$0" ] || rmdir "$0"']

/** Takes the lock at `path`, taking over one abandoned past its stale time; `LockBusyError` when it stays held. */
export async function acquire(io: Io, path: string, options: LockOptions): Promise<Lock> {
  for (let attempt = 0; attempt < options.tries; attempt += 1) {
    const made = await io.run([...MAKE, path], { timeoutMs: 10_000 })
    if (made.exitCode === 0) {
      const mtimeMs = (await io.stat(path).catch(() => null))?.mtimeMs ?? 0

      return {
        release: async () => {
          // Taken over as stale and made again by another process: that lock is not this one's to remove.
          const now = (await io.stat(path).catch(() => null))?.mtimeMs
          if (now === undefined || now !== mtimeMs) return
          await io.run([...REMOVE, path], { timeoutMs: 10_000 })
        },
      }
    }
    const held = await io.stat(path).catch(() => null)
    if (held === null) throw new Error(`cannot make the lock ${path}: ${made.stderr.trim()}`)
    if ((await io.now()) - held.mtimeMs > options.staleMs) {
      if ((await io.stat(path).catch(() => null))?.mtimeMs === held.mtimeMs) await io.run([...REMOVE, path], { timeoutMs: 10_000 })
      continue
    }
    if (attempt + 1 < options.tries) await io.sleep(retryDelay(attempt))
  }

  throw new LockBusyError(`the lock ${path} is held by another process`)
}

/** Runs `work` holding the lock at `path`, and gives the lock up after, whatever `work` did. */
export async function withLock<T>(io: Io, path: string, options: LockOptions, work: () => Promise<T>): Promise<T> {
  const lock = await acquire(io, path, options)
  try {
    return await work()
  } finally {
    await lock.release().catch((error: unknown) => io.log(`cannot release ${path}: ${error instanceof Error ? error.message : String(error)}`))
  }
}
