import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { REPAIR, SUPPORTED_VERSIONS } from './cache.mjs'
import { prepareAccountLaunch } from './startup.mjs'
import { absoluteWindowsPath, WINDOWS_LAUNCHER_MARKER, windowsBootstrapDirectory, windowsLauncher } from './windows.mjs'

const MARKER = '#!/usr/bin/env node\n// rice-session-accounts installed launcher\n'
export class NativeError extends Error { code = 'RICE_ACCOUNT_NATIVE' }
export const selectionPath = configDir => join(configDir, 'rice-session-accounts/native-launcher.json')
export const absoluteNativePath = value => typeof value === 'string' && !/[\0\r\n]/.test(value) && (process.platform === 'win32' ? absoluteWindowsPath(value) : isAbsolute(value))

function regular(path) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new NativeError(`Native selection must be a bounded regular file. ${REPAIR}`)
}

export function readSelection(configDir) {
  const path = selectionPath(configDir)
  try { regular(path) } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw new NativeError(`Cannot read the native launcher selection. ${REPAIR}`)
  }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (value?.format !== 1 || !absoluteNativePath(value.executable) || !SUPPORTED_VERSIONS.includes(value.claudeVersion)) throw new Error('invalid selection')
    return value
  } catch { throw new NativeError(`The saved native selection is invalid or unsupported. ${REPAIR}`) }
}

export function saveSelection(configDir, selection) {
  if (selection?.format !== 1 || !absoluteNativePath(selection.executable) || !SUPPORTED_VERSIONS.includes(selection.claudeVersion)) throw new NativeError(`Refused an unqualified native selection. ${REPAIR}`)
  const path = selectionPath(configDir)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try { regular(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(selection, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
}

/** Bun's preload option needs a whitespace-free path; the tiny file imports the real URL. */
export function bootstrap(cache = join(dirname(fileURLToPath(import.meta.url)), 'cache.mjs')) {
  const windows = process.platform === 'win32', uid = windows ? undefined : process.getuid()
  const source = `await import(${JSON.stringify(pathToFileURL(cache).href)});\n`
  const filename = createHash('sha256').update(source).update(readFileSync(cache)).update(readFileSync(new URL('./startup.mjs', import.meta.url))).digest('hex') + '.mjs'
  const directory = windows ? windowsBootstrapDirectory(filename) : join(/\s/.test(tmpdir()) ? '/tmp' : tmpdir(), `rice-accounts-${uid}`)
  if (!windows) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077)) throw new NativeError('Unsafe native bootstrap directory.')
  }
  const path = join(directory, filename)
  try { writeFileSync(path, source, { flag: 'wx', mode: 0o600 }) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const existing = lstatSync(path)
    if (!existing.isFile() || existing.isSymbolicLink() || (!windows && (existing.uid !== uid || (existing.mode & 0o077))) || readFileSync(path, 'utf8') !== source) throw new NativeError('Unsafe native bootstrap file.')
  }
  return windows ? path.replace(/\\/g, '/') : path
}

export function qualify(native, environment, preload) {
  const plain = { ...environment }
  delete plain.BUN_OPTIONS
  const versionProbe = spawnSync(native, ['--version'], { env: plain, encoding: 'utf8', timeout: 15000 })
  const version = versionProbe.stdout?.match(/^(\d+\.\d+\.\d+)\s/m)?.[1]
  if (versionProbe.status !== 0 || !SUPPORTED_VERSIONS.includes(version)) throw new NativeError(`Selected Claude ${version ?? 'unknown'} is unavailable or has not passed the account cache compatibility proof. Qualified versions: ${SUPPORTED_VERSIONS.join(', ')}. ${REPAIR}`)
  const temporary = mkdtempSync(join(dirname(preload), 'verify-')), handshake = join(temporary, 'ready.json')
  try {
    const probe = spawnSync(native, ['--version'], { env: { ...environment, BUN_OPTIONS: `${environment.BUN_OPTIONS ?? ''} --preload ${preload}`.trim(), RICE_SESSION_ACCOUNTS_NATIVE_VERSION: version, RICE_SESSION_ACCOUNTS_HANDSHAKE: handshake }, encoding: 'utf8', timeout: 15000 })
    let ready
    try { ready = JSON.parse(readFileSync(handshake, 'utf8')) } catch {}
    if (probe.status !== 0 || ready?.format !== 1 || ready.version !== version || ready.pid !== probe.pid || !absoluteNativePath(ready.executable)) throw new NativeError(`The selected native Claude executable could not activate the account cache bridge. ${REPAIR}`)
    return { format: 1, executable: ready.executable, claudeVersion: version }
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}

export async function launch(args) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new NativeError('The account launcher requires Node.js 22 or newer.')
  const installing = args[0] === '--install', explicit = installing ? args[1] : undefined
  if (installing && (args.length > 2 || explicit !== undefined && !absoluteNativePath(explicit))) throw new NativeError(`Usage: /rice-account setup-native [absolute path to a qualified Claude executable]. ${REPAIR}`)
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const windows = process.platform === 'win32'
  const directory = join(homedir(), '.local/bin'), target = join(directory, windows ? 'rice-account-claude.cmd' : 'rice-account-claude')
  const entry = windows ? join(directory, 'rice-account-claude.mjs') : target
  const managed = [{ path: entry, marker: MARKER }, ...(windows ? [{ path: target, marker: WINDOWS_LAUNCHER_MARKER }] : [])]
  if (installing) {
    for (const file of managed) try {
      const existing = lstatSync(file.path)
      if (!existing.isFile() || existing.isSymbolicLink() || !readFileSync(file.path, 'utf8').replace(/\r\n/g, '\n').startsWith(file.marker.replace(/\r\n/g, '\n'))) throw new NativeError('rice-account-claude already exists and is not this mod\'s managed launcher.')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const override = explicit ?? process.env.RICE_ACCOUNT_CLAUDE_EXECUTABLE
  const saved = override ? undefined : readSelection(configDir)
  const native = override || saved?.executable || 'claude'
  const preload = bootstrap()
  const environment = { ...process.env }
  delete environment.RICE_SESSION_ACCOUNTS_HANDSHAKE
  delete environment.RICE_SESSION_ACCOUNTS_NATIVE_ACTIVE
  let prepared = { args, env: environment }
  if (!installing) {
    try { prepared = prepareAccountLaunch(args, environment, configDir) } catch {
      throw new NativeError('--account could not select that saved browser account. Run /rice-account setup <name> and use one saved claudeai browser account name.')
    }
  }
  const selection = qualify(native, prepared.env, preload)
  if (installing) {
    mkdirSync(directory, { recursive: true })
    const outputs = [{ path: entry, bytes: readFileSync(new URL('./entry.mjs', import.meta.url)) }, ...(windows ? [{ path: target, bytes: Buffer.from(windowsLauncher(process.execPath)) }] : [])]
    const temporary = outputs.map(() => join(directory, `.rice-account-claude-${randomUUID()}`))
    try {
      outputs.forEach((output, index) => {
        writeFileSync(temporary[index], output.bytes, { flag: 'wx', mode: 0o755 })
        if (!windows) chmodSync(temporary[index], 0o755)
      })
      outputs.forEach((output, index) => renameSync(temporary[index], output.path))
    } finally { temporary.forEach(path => rmSync(path, { force: true })) }
    saveSelection(configDir, selection)
    process.stdout.write(`Installed ${target}. Saved verified native Claude ${selection.claudeVersion}. Start a new session with rice-account-claude. Your official Claude executable and machine login are unchanged.\n`)
    return 0
  }
  args = prepared.args
  const selectedEnvironment = prepared.env
  selectedEnvironment.BUN_OPTIONS = `${environment.BUN_OPTIONS ?? ''} --preload ${preload}`.trim()
  selectedEnvironment.RICE_SESSION_ACCOUNTS_NATIVE_VERSION = selection.claudeVersion
  selectedEnvironment.RICE_SESSION_ACCOUNTS_NATIVE_EXECUTABLE = selection.executable
  const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const child = spawn(selection.executable, ['--plugin-dir', pluginRoot, ...args], { env: selectedEnvironment, stdio: 'inherit' })
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'], handlers = signals.map(signal => () => child.kill(signal))
  signals.forEach((signal, index) => process.on(signal, handlers[index]))
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', () => reject(new NativeError(`The selected native executable could not start. ${REPAIR}`)))
      child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)))
    })
  } finally { signals.forEach((signal, index) => process.off(signal, handlers[index])) }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  process.exitCode = await launch(process.argv.slice(2)).catch(error => {
    process.stderr.write(`rice-session-accounts: ${error?.code === 'RICE_ACCOUNT_NATIVE' ? error.message : 'native launcher setup failed; update the plugin and run /rice-account setup-native'}\n`)
    return 1
  })
}
