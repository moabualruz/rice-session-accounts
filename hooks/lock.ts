// Adapted from simplecore-inc/claude-mods mods/accounts/hooks/lock.ts at 722763c
// (MIT, Copyright (c) 2026 SimpleCORE Inc., see LICENSES/simplecore-claude-mods.MIT.txt).
// Modified: the Windows PowerShell paths removed; native Windows uses a static Node program;
// a heartbeat keeps a long critical section from being taken over as stale.
import { hostPlatform } from './credentials'
import type { Io } from './io'
import { runFailure, trustedRun } from './io'

/**
 * Locks held across processes, laid out as proper-lockfile lays them: a
 * directory only one process can make, taken as abandoned once its
 * modification time is older than the lock's stale time. `heartbeat` renews
 * that time, and fails with `LockLostError` when another process already took
 * the lock over.
 */
export type Lock = { release: () => Promise<void>; heartbeat: () => Promise<void> }

export class LockBusyError extends Error {}

/** The lock was taken over as stale by another process. */
export class LockLostError extends Error {}

/** `cwd`: a trusted working folder for the lock programs on native Windows (the Claude config folder). */
export type LockOptions = { staleMs: number; tries: number; cwd?: string }

export function retryDelay(attempt: number): number {
  return Math.min(1000, 100 * 2 ** attempt)
}

const MAKE = ['/bin/sh', '-c', 'mkdir -p "$(dirname "$0")" && mkdir "$0"']
const REMOVE = ['/bin/sh', '-c', '[ ! -d "$0" ] || rmdir "$0"']
const TOUCH = ['/bin/sh', '-c', '[ -d "$0" ] && touch -c "$0"']

/**
 * Native Windows has no /bin/sh. Node 22+ is already its credential-file
 * prerequisite, so the same mkdir, rmdir and touch semantics run as a static
 * program, written in ES5 like the credential program.
 */
const NODE_LOCK = String.raw`
var fs = require('fs');
var paths = require('path');
var operation = process.argv[1];
var path = process.argv[2];
function codeOf(error) { return error && error.code ? String(error.code) : 'lock operation failed'; }
function invalid(text) { var error = new Error(text); error.code = 'EINVAL'; return error; }
try {
  if (!path || !paths.isAbsolute(path)) throw invalid('invalid lock path');
  if (operation === 'make') {
    fs.mkdirSync(paths.dirname(path), { recursive: true });
    fs.mkdirSync(path);
  } else if (operation === 'remove') {
    try { fs.rmdirSync(path); } catch (error) { if (codeOf(error) !== 'ENOENT') throw error; }
  } else if (operation === 'touch') {
    var now = new Date();
    fs.utimesSync(path, now, now);
  } else throw invalid('invalid lock operation');
} catch (error) {
  process.stderr.write(codeOf(error));
  process.exitCode = 1;
}
`

type Commands = { make: string[]; remove: string[]; touch: string[]; cwd: string }

async function lockCommands(io: Io, options: LockOptions): Promise<Commands> {
  if (await hostPlatform(io) !== 'win32') return { make: MAKE, remove: REMOVE, touch: TOUCH, cwd: '/' }
  const cwd = options.cwd ?? await io.env('USERPROFILE') ?? 'C:\\'

  return { make: ['node', '-e', NODE_LOCK, 'make'], remove: ['node', '-e', NODE_LOCK, 'remove'], touch: ['node', '-e', NODE_LOCK, 'touch'], cwd }
}

/** Takes the lock at `path`, taking over one abandoned past its stale time; `LockBusyError` when it stays held. */
export async function acquire(io: Io, path: string, options: LockOptions): Promise<Lock> {
  const commands = await lockCommands(io, options)
  const init = trustedRun(commands.cwd, { timeoutMs: 10_000 })
  for (let attempt = 0; attempt < options.tries; attempt += 1) {
    const made = await io.run([...commands.make, path], init).catch((error: unknown) => {
      const program = commands.make[0] === 'node' ? 'Node.js 22 or later (node on PATH)' : '/bin/sh'
      const failure = runFailure(error)
      throw new Error(failure === 'timeout'
        ? `cannot take the renewal lock ${path}: ${program} did not finish within 10 seconds`
        : `cannot take the renewal lock ${path}: ${program} could not be started${failure === 'missing' ? ' (not found)' : ''}`)
    })
    if (made.exitCode === 0) {
      let mtimeMs = (await io.stat(path).catch(() => null))?.mtimeMs ?? 0
      const lost = () => new LockLostError(`the lock ${path} was taken over by another session`)

      return {
        release: async () => {
          // Taken over as stale and made again by another process: that lock is not this one's to remove.
          const now = (await io.stat(path).catch(() => null))?.mtimeMs
          if (now === undefined || now !== mtimeMs) return
          await io.run([...commands.remove, path], init)
        },
        heartbeat: async () => {
          const before = (await io.stat(path).catch(() => null))?.mtimeMs
          if (before === undefined || before !== mtimeMs) throw lost()
          const touched = await io.run([...commands.touch, path], init)
          const after = (await io.stat(path).catch(() => null))?.mtimeMs
          if (touched.exitCode !== 0 || after === undefined) throw lost()
          mtimeMs = after
        },
      }
    }
    const held = await io.stat(path).catch(() => null)
    if (held === null) throw new Error(`cannot make the lock ${path}: ${made.stderr.trim()}`)
    if ((await io.now()) - held.mtimeMs > options.staleMs) {
      if ((await io.stat(path).catch(() => null))?.mtimeMs === held.mtimeMs) await io.run([...commands.remove, path], init)
      continue
    }
    if (attempt + 1 < options.tries) await io.sleep(retryDelay(attempt))
  }

  throw new LockBusyError(`another session is renewing this login (the lock ${path} is held); retry in a moment`)
}

/** Runs `work` holding the lock at `path`, and gives the lock up after, whatever `work` did. */
export async function withLock<T>(io: Io, path: string, options: LockOptions, work: (lock: Lock) => Promise<T>): Promise<T> {
  const lock = await acquire(io, path, options)
  try {
    return await work(lock)
  } finally {
    await lock.release().catch((error: unknown) => io.log(`cannot release ${path}: ${error instanceof Error ? error.message : String(error)}`))
  }
}
