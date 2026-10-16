// This file is imported by the managed launcher inside the native main process.
// It never reads, writes or reports a credential. Worker imports cannot activate it.
import { writeFileSync, realpathSync } from 'node:fs'
import { isMainThread } from 'node:worker_threads'
import { INITIAL_ACCOUNT, INITIAL_ORIGINALS } from './startup.mjs'

export const AUTH_REVISION = 'RICE_SESSION_ACCOUNTS_AUTH_REVISION'
export const NATIVE_ACTIVE = 'RICE_SESSION_ACCOUNTS_NATIVE_ACTIVE'
export const REPAIR = 'Run /rice-account setup-native <absolute path to a qualified Claude executable>, then start a new session with rice-account-claude (or the configured rice-claude launcher).'

const bindings = {
  'linux-x64-2.1.296': {
    auth: '/$bunfs/root/chunk-0ycjphb5.js', resetAuth: 'm8', authSource: 'function m8(){Gbe.of(B().host).clear()}',
    usage: '/$bunfs/root/chunk-gr4a0fky.js', resetUsage: 'w$n', usageSource: 'function w$n(){se.resetCurrentLimits()}',
    storage: '/$bunfs/root/chunk-ph7a449e.js', storageFactory: 'Jn', storageSource: 'function Jn(){if(O)return O;return C}', invalidateSource: 'invalidateCache(){gxe()}',
  },
  'darwin-arm64-2.1.299': {
    auth: '/$bunfs/root/chunk-fk9f23h5.js', resetAuth: 'xY', authSource: 'function xY(){Zwe.of(B().host).clear()}',
    usage: '/$bunfs/root/chunk-kf1v7cpa.js', resetUsage: 'qBn', usageSource: 'function qBn(){se.resetCurrentLimits()}',
    storage: '/$bunfs/root/chunk-y44bscwh.js', storageFactory: 'Xn', storageSource: 'function Xn(){if(j)return j;return L(O,w)}', invalidateSource: 'invalidateCache(){e.invalidateCache?.(),r.invalidateCache?.()}',
  },
  'linux-x64-2.1.299': {
    auth: '/$bunfs/root/chunk-xywp7esx.js', resetAuth: 'S9', authSource: 'function S9(){Kwe.of(B().host).clear()}',
    usage: '/$bunfs/root/chunk-gmq0qwep.js', resetUsage: 'X1n', usageSource: 'function X1n(){se.resetCurrentLimits()}',
    storage: '/$bunfs/root/chunk-x35dw27e.js', storageFactory: 'Xn', storageSource: 'function Xn(){if(k)return k;return C}', invalidateSource: 'invalidateCache(){RIe()}',
  },
  'darwin-arm64-2.1.300': {
    auth: '/$bunfs/root/chunk-r81q0z6j.js', resetAuth: 'wX', authSource: 'function wX(){ave.of(j().host).clear()}',
    usage: '/$bunfs/root/chunk-n2vwh9c0.js', resetUsage: 'sGn', usageSource: 'function sGn(){se.resetCurrentLimits()}',
    storage: '/$bunfs/root/chunk-1hjbpfq4.js', storageFactory: 'Vn', storageSource: 'function Vn(){if(V)return V;return M(P,I)}', invalidateSource: 'invalidateCache(){e.invalidateCache?.(),r.invalidateCache?.()}',
  },
  'win32-x64-2.1.299': {
    auth: 'B:/~BUN/root/chunk-v7m9g1fp.js', resetAuth: 'w9', authSource: 'function w9(){Kwe.of(B().host).clear()}',
    usage: 'B:/~BUN/root/chunk-w4kds07w.js', resetUsage: 'ojn', usageSource: 'function ojn(){se.resetCurrentLimits()}',
    storage: 'B:/~BUN/root/chunk-9amknapp.js', storageFactory: 'Xn', storageSource: 'function Xn(){if(Z)return Z;if(LVn())return H(L,T);return T}', invalidateSource: 'invalidateCache(){AOe()}',
  },
}
const hostPrefix = `${process.platform}-${process.arch}-`
export const SUPPORTED_VERSIONS = Object.keys(bindings).filter(key => key.startsWith(hostPrefix)).map(key => key.slice(hostPrefix.length))

/** Coalesce the native child-env sanitizer's temporary restore/set operations. */
export function observeAccountRevision(environment, reset, initial = {}) {
  let selected = environment[AUTH_REVISION], pending = false
  const changed = () => {
    if (pending) return
    pending = true
    queueMicrotask(() => {
      pending = false
      const next = environment[AUTH_REVISION]
      if (next === selected) return
      selected = next
      reset()
    })
  }
  return new Proxy(environment, {
    get(target, name) {
      if (name === INITIAL_ACCOUNT || name === INITIAL_ORIGINALS) return initial[name]
      return Reflect.get(target, name)
    },
    set(target, name, value) {
      if (name === INITIAL_ACCOUNT || name === INITIAL_ORIGINALS) { delete initial[name]; return true }
      const result = Reflect.set(target, name, value)
      if (name === AUTH_REVISION) changed()
      return result
    },
    deleteProperty(target, name) {
      if (name === INITIAL_ACCOUNT || name === INITIAL_ORIGINALS) { delete initial[name]; return true }
      const result = Reflect.deleteProperty(target, name)
      if (name === AUTH_REVISION) changed()
      return result
    },
  })
}

async function activate() {
  const version = process.env.RICE_SESSION_ACCOUNTS_NATIVE_VERSION
  const binding = bindings[hostPrefix + version]
  if (!binding) throw new Error('unsupported native runtime')
  const auth = await import(binding.auth), usage = await import(binding.usage)
  if (String(auth[binding.resetAuth]) !== binding.authSource || String(usage[binding.resetUsage]) !== binding.usageSource) throw new Error('native cache signature changed')
  if (!binding.storage) throw new Error('native browser storage has not passed compatibility proof')
  const storage = await import(binding.storage)
  if (String(storage[binding.storageFactory]) !== binding.storageSource || String(storage[binding.storageFactory]().invalidateCache) !== binding.invalidateSource) throw new Error('native storage cache signature changed')
  const initial = { [INITIAL_ACCOUNT]: process.env[INITIAL_ACCOUNT], [INITIAL_ORIGINALS]: process.env[INITIAL_ORIGINALS] }
  delete process.env[INITIAL_ACCOUNT]
  delete process.env[INITIAL_ORIGINALS]
  process.env = observeAccountRevision(process.env, () => {
    storage[binding.storageFactory]().invalidateCache()
    auth[binding.resetAuth]()
    // The stock reset also advances accountEpoch, rejecting in-flight old-account headers.
    usage[binding.resetUsage]()
  }, initial)
  process.env[NATIVE_ACTIVE] = '1'
  if (process.env.RICE_SESSION_ACCOUNTS_HANDSHAKE) writeFileSync(process.env.RICE_SESSION_ACCOUNTS_HANDSHAKE, JSON.stringify({ format: 1, version, pid: process.pid, executable: realpathSync(process.execPath) }), { flag: 'wx', mode: 0o600 })
}

if (isMainThread && globalThis.Bun?.isStandaloneExecutable) {
  const expected = process.env.RICE_SESSION_ACCOUNTS_NATIVE_EXECUTABLE ?? process.env.RICE_MULTI_MODELS_NATIVE_EXECUTABLE
  let selected = false
  try { selected = Boolean(expected) && realpathSync(expected) === realpathSync(process.execPath) } catch {}
  const probe = process.argv.includes('--version') && Boolean(process.env.RICE_SESSION_ACCOUNTS_HANDSHAKE || process.env.RICE_MULTI_MODELS_HANDSHAKE)
  if (!selected && !probe) delete process.env[NATIVE_ACTIVE]
  else try { await activate() } catch {
      process.stderr.write(`rice-session-accounts: native account cache bridge could not activate. ${REPAIR}\n`)
      process.exit(1)
    }
}
