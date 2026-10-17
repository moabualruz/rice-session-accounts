// Adapted from simplecore-inc/claude-mods mods/accounts/hooks/lock.ts at 722763c
// (MIT, Copyright (c) 2026 SimpleCORE Inc., see LICENSES/simplecore-claude-mods.MIT.txt).
// Modified: the Windows PowerShell paths removed; native Windows uses a static Node program;
// a heartbeat keeps a long critical section from being taken over as stale; a failed stat
// is asked again, and a lock whose time stays unknown is owned only while it is young.
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

/** How many times a lock's modification time is asked for before it counts as unknown. */
export const STAT_TRIES = 3

/**
 * The lock's modification time, asked up to `STAT_TRIES` times: one failed
 * stat must not make a held lock look taken over, nor leave its holder unable
 * to release it. The attempts follow one another without a `$.clock` pause,
 * which a test clock would hold until it is moved. Undefined when it stays
 * unknown.
 */
async function mtimeOf(io: Io, path: string): Promise<number | undefined> {
  for (let attempt = 0; attempt < STAT_TRIES; attempt += 1) {
    const stat = await io.stat(path).catch(() => null)
    if (stat !== null) return stat.mtimeMs
  }

  return undefined
}

/**
 * The lock this session made at `path`. With its modification time known, the
 * lock is this session's while that time is the one it set: another session
 * that took it over as stale made it again with another time. When the time
 * cannot be read (now, or when the lock was made), the lock is this session's
 * only while it is far too young for anyone to take it over (half the stale
 * time since this session last made or renewed it, measured from before it
 * did), so a release still removes it and nobody is locked out for the whole
 * stale time.
 */
function held(io: Io, path: string, options: LockOptions, commands: Commands, init: ReturnType<typeof trustedRun>, madeAt: number | undefined, since: number): Lock {
  let mtimeMs = madeAt
  let renewedAt = since
  const lost = () => new LockLostError(`the lock ${path} was taken over by another session`)
  // Both times known: the lock is this session's while it is the one set. Either unknown (a failed stat is not a takeover): the youth rule.
  const isOwn = async (current: number | undefined): Promise<boolean> => mtimeMs !== undefined && current !== undefined
    ? current === mtimeMs
    : (await io.now()) - renewedAt < options.staleMs / 2

  return {
    release: async () => {
      // Taken over as stale and made again by another process: that lock is not this one's to remove.
      if (!(await isOwn(await mtimeOf(io, path)))) return
      await io.run([...commands.remove, path], init)
    },
    heartbeat: async () => {
      if (!(await isOwn(await mtimeOf(io, path)))) throw lost()
      const touching = await io.now()
      const touched = await io.run([...commands.touch, path], init)
      if (touched.exitCode !== 0) throw lost()
      mtimeMs = await mtimeOf(io, path)
      renewedAt = touching
    },
  }
}

async function startProblem(io: Io, commands: Commands, path: string, error: unknown): Promise<string> {
  const windows = commands.make[0] === 'node'
  const program = windows ? 'Node.js 22 or later (node on PATH)' : '/bin/sh'
  const failure = runFailure(error)
  if (failure === 'timeout') return `cannot take the renewal lock ${path}: ${program} did not finish within 10 seconds`
  // Windows starts the lock program in the Claude config folder: a missing folder fails the start with ENOENT too.
  if (failure === 'missing' && windows && (await io.stat(commands.cwd).catch(() => null))?.kind !== 'dir') {
    return `cannot take the renewal lock ${path}: its working folder ${commands.cwd} (the Claude configuration folder) does not exist. Start Claude Code once so it creates that folder, then retry.`
  }

  return `cannot take the renewal lock ${path}: ${program} could not be started${failure === 'missing' ? ' (not found)' : ''}`
}

/** Takes the lock at `path`, taking over one abandoned past its stale time; `LockBusyError` when it stays held. */
export async function acquire(io: Io, path: string, options: LockOptions): Promise<Lock> {
  const commands = await lockCommands(io, options)
  const init = trustedRun(commands.cwd, { timeoutMs: 10_000 })
  // Why the last attempt could not make the lock when nobody held it.
  let unmade: string | undefined
  for (let attempt = 0; attempt < options.tries; attempt += 1) {
    const before = await io.now()
    let made: Awaited<ReturnType<Io['run']>>
    try {
      made = await io.run([...commands.make, path], init)
    } catch (error) {
      throw new Error(await startProblem(io, commands, path, error))
    }
    if (made.exitCode === 0) return held(io, path, options, commands, init, await mtimeOf(io, path), before)
    const holder = await io.stat(path).catch(() => null)
    if (holder === null) {
      // The holder released it between the mkdir and the stat (or the mkdir failed for another reason): try again.
      unmade = made.stderr.trim() || `exit ${made.exitCode}`
      continue
    }
    unmade = undefined
    if ((await io.now()) - holder.mtimeMs > options.staleMs) {
      if ((await io.stat(path).catch(() => null))?.mtimeMs === holder.mtimeMs) await io.run([...commands.remove, path], init)
      continue
    }
    if (attempt + 1 < options.tries) await io.sleep(retryDelay(attempt))
  }
  if (unmade !== undefined) throw new Error(`cannot make the lock ${path}: ${unmade}`)

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
