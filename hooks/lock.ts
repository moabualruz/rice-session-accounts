// Adapted from simplecore-inc/claude-mods mods/accounts/hooks/lock.ts at 722763c
// (MIT, Copyright (c) 2026 SimpleCORE Inc., see LICENSES/simplecore-claude-mods.MIT.txt).
// Modified: the Windows PowerShell paths removed; native Windows uses a static Node program.
import { hostPlatform } from './credentials'
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

/**
 * Native Windows has no /bin/sh. Node 22+ is already its credential-file
 * prerequisite, so the same mkdir and rmdir semantics run as a static program.
 */
const NODE_LOCK = String.raw`
const fs = require('node:fs');
const paths = require('node:path');
const [operation, path] = process.argv.slice(1);
try {
  if (!path || !paths.isAbsolute(path)) throw Object.assign(new Error('invalid lock path'), { code: 'EINVAL' });
  if (operation === 'make') {
    fs.mkdirSync(paths.dirname(path), { recursive: true });
    fs.mkdirSync(path);
  } else if (operation === 'remove') {
    try { fs.rmdirSync(path); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  } else throw Object.assign(new Error('invalid lock operation'), { code: 'EINVAL' });
} catch (error) {
  process.stderr.write(String(error?.code ?? 'lock operation failed'));
  process.exitCode = 1;
}
`

async function lockCommands(io: Io): Promise<{ make: string[]; remove: string[] }> {
  return await hostPlatform(io) === 'win32'
    ? { make: ['node', '-e', NODE_LOCK, 'make'], remove: ['node', '-e', NODE_LOCK, 'remove'] }
    : { make: MAKE, remove: REMOVE }
}

/** Takes the lock at `path`, taking over one abandoned past its stale time; `LockBusyError` when it stays held. */
export async function acquire(io: Io, path: string, options: LockOptions): Promise<Lock> {
  const commands = await lockCommands(io)
  for (let attempt = 0; attempt < options.tries; attempt += 1) {
    const made = await io.run([...commands.make, path], { timeoutMs: 10_000 })
    if (made.exitCode === 0) {
      const mtimeMs = (await io.stat(path).catch(() => null))?.mtimeMs ?? 0

      return {
        release: async () => {
          // Taken over as stale and made again by another process: that lock is not this one's to remove.
          const now = (await io.stat(path).catch(() => null))?.mtimeMs
          if (now === undefined || now !== mtimeMs) return
          await io.run([...commands.remove, path], { timeoutMs: 10_000 })
        },
      }
    }
    const held = await io.stat(path).catch(() => null)
    if (held === null) throw new Error(`cannot make the lock ${path}: ${made.stderr.trim()}`)
    if ((await io.now()) - held.mtimeMs > options.staleMs) {
      if ((await io.stat(path).catch(() => null))?.mtimeMs === held.mtimeMs) await io.run([...commands.remove, path], { timeoutMs: 10_000 })
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
