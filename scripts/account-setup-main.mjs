// Implementation of the terminal setup helper. Start it through
// account-setup.mjs, which checks the Node.js version before loading this file.
import { spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir, release } from 'node:os'
import { posix, win32 } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { isStoredAccountName, isWindowsDeviceName } from './account-names.mjs'
import { claudeInvocation, missingClaudeMessage, resolveClaude } from './claude-command.mjs'
import { WINDOWS_CREDENTIAL_STORE, WINDOWS_EXIT, WINDOWS_PRIVATE_DIRECTORY, windowsStoreProblem } from './windows-store-payloads.mjs'

const USAGE = 'Usage: node account-setup.mjs [--config-dir <directory>] [--login] [--email <expected-email>] [--manual | --browser <executable>] <saved name>'

function validEmail(value) {
  return typeof value === 'string' && value.length <= 254 && !/[\u0000-\u001f\u007f-\u009f]/.test(value) && /^[^@\s]+@[^@\s]+$/.test(value)
}
const AUTH_ENV = [
  'RICE_SESSION_ACCOUNTS_OAUTH_RELAY',
  'CLAUDECODE', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_BG_AUTH_SNAPSHOT_PATH',
  'CLAUDE_CODE_HOST_CREDS_FILE',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_MANTLE',
  'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_FOUNDRY_API_KEY',
]

export function loginEnvironment(environment, loginDir) {
  const env = { ...environment }
  for (const name of AUTH_ENV) delete env[name]
  env.CLAUDE_CONFIG_DIR = loginDir
  env.CLAUDE_SECURESTORAGE_CONFIG_DIR = loginDir
  return env
}

function pathsOf(platform) {
  return platform === 'win32' ? win32 : posix
}

function absoluteDirectory(value, platform) {
  return typeof value === 'string' && !/[\0\r\n]/.test(value) && (platform === 'win32'
    ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value)
    : value.startsWith('/'))
}

/** Lexically the same folder; Windows compares without letter case. */
function sameLocation(left, right, platform) {
  const paths = pathsOf(platform)
  const a = paths.resolve(left), b = paths.resolve(right)
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isInside(child, parent, platform) {
  const paths = pathsOf(platform)
  let c = paths.resolve(child), p = paths.resolve(parent)
  if (platform === 'win32') { c = c.toLowerCase(); p = p.toLowerCase() }
  return c === p || c.startsWith(p.endsWith(paths.sep) ? p : p + paths.sep)
}

/**
 * The user's home folder: USERPROFILE (then HOME) on Windows, HOME elsewhere,
 * and the operating system's record of the account when those are unset or
 * not absolute. Undefined when none is available.
 */
export function homeDirectory(platform, env, fallback = homedir) {
  for (const value of platform === 'win32' ? [env.USERPROFILE, env.HOME] : [env.HOME]) {
    if (absoluteDirectory(value, platform)) return value
  }
  try {
    const value = fallback()
    return absoluteDirectory(value, platform) ? value : undefined
  } catch { return undefined }
}

/** The only login folder setup prepares for an account: <config>/rice-session-accounts/logins/<name>. */
export function derivedLoginDir(configDir, name, platform) {
  return pathsOf(platform).join(configDir, 'rice-session-accounts', 'logins', name)
}

/** True inside WSL (1 or 2), detected from its environment or kernel release. */
export function isWsl(platform, env, osRelease = '') {
  return platform === 'linux' && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP || /microsoft|wsl/i.test(osRelease))
}

/** A Windows drive mounted into WSL (DrvFs), where Linux permissions are not enforced by default. */
export function onWindowsDrive(path) {
  return /^\/mnt\/[A-Za-z](?:\/|$)/.test(path)
}

export function drvfsWarning(configDir) {
  return `Warning: ${configDir} is on a Windows drive mounted into WSL. Linux file permissions are not enforced there, so this account's credential file cannot be made private. Prefer a config folder inside the Linux file system: run Claude Code in WSL with its default ~/.claude (or set CLAUDE_CONFIG_DIR to a Linux folder), add the account there, and run the setup command it prints.`
}

/** True when this is Windows Node.js (node.exe) started from WSL or given a Linux path. */
export function windowsNodeInWsl(platform, env, configCandidate, cwd = '', script = '') {
  if (platform !== 'win32') return false
  const wslShare = /^\\\\wsl(?:\$|\.localhost)\\/i
  return wslShare.test(cwd) || wslShare.test(script) || Boolean(env.WSL_DISTRO_NAME) || (typeof configCandidate === 'string' && configCandidate.startsWith('/'))
}

export const WINDOWS_NODE_IN_WSL = 'This is Windows Node.js (node.exe), but the command came from WSL or names a Linux path. Inside WSL, run setup with a Linux Node.js 22 or newer (install one in WSL, for example from your distribution or with nvm, so that "command -v node" shows a Linux path), then rerun this command. On Windows itself, pass a Windows folder such as C:\\Users\\you\\.claude.'

function ownedFolder(path, uid) {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) {
    throw Error(`${path} must be a folder owned by you, not a link or a file. Move it aside, then rerun setup.`)
  }
}

/**
 * Login owns credential storage. This helper never copies a credential to a
 * file. It creates <config>/rice-session-accounts/logins/<name> one level at a
 * time below the checked config folder, refusing links and foreign owners at
 * every level, and makes the login folder private.
 */
function privateDirectory(path, context = {}) {
  if (process.platform === 'win32') {
    const result = execute(windowsPowerShell(process.env), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_PRIVATE_DIRECTORY], { input: JSON.stringify({ path, root: context.configDir }) })
    if (result.status !== 0) throw Error(windowsStoreProblem(result.status, 'the isolated login folder', result.errorText))
    return
  }
  const uid = process.getuid()
  const target = posix.resolve(path)
  const root = context.configDir ? posix.resolve(context.configDir) : undefined
  if (root && root !== '/' && target.startsWith(`${root}/`)) {
    let current = root
    for (const part of target.slice(root.length + 1).split('/')) {
      current = posix.join(current, part)
      try { mkdirSync(current, { mode: 0o700 }) }
      catch (error) { if (error?.code !== 'EEXIST') throw Error(`Cannot create ${current} (${error?.code ?? 'error'}). Check the config folder's permissions, then rerun setup.`) }
      ownedFolder(current, uid)
    }
  } else {
    mkdirSync(target, { recursive: true, mode: 0o700 })
  }
  ownedFolder(target, uid)
  chmodSync(target, 0o700)
  const mode = lstatSync(target).mode & 0o777
  if ((mode & 0o077) !== 0 && !context.drvfs) {
    throw Error(`Cannot make ${target} private: its permissions are still ${mode.toString(8)} after chmod 700. Use a Claude config folder on a file system that supports file permissions.`)
  }
}

function inspectPath(path) {
  let stat
  try { stat = lstatSync(path) }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined
    throw Error(`Cannot inspect ${path} (${error?.code ?? 'error'}). Check its permissions, then rerun setup.`)
  }
  return { directory: stat.isDirectory(), symlink: stat.isSymbolicLink(), uid: stat.uid, mode: stat.mode }
}

function windowsPowerShell(env) {
  const root = env.SystemRoot || env.WINDIR
  return root ? win32.join(root, 'System32/WindowsPowerShell/v1.0/powershell.exe') : 'powershell.exe'
}

async function hiddenInput(label) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw Error('Run setup in an interactive terminal to enter a credential.')
  const silent = new Writable({ write(_chunk, _encoding, done) { done() } })
  const prompt = createInterface({ input: process.stdin, output: silent, terminal: true, historySize: 0 })
  process.stderr.write(`${label} (hidden): `)
  try {
    const value = await Promise.race([
      prompt.question(''),
      new Promise((_, reject) => prompt.once('SIGINT', () => reject(Error('Setup cancelled. Run the same command to resume.')))),
    ])
    if (!value.trim()) throw Error('No credential entered. Run the same command to resume.')
    return value.trim()
  } finally {
    prompt.close()
    process.stderr.write('\n')
  }
}

/** The last line a native payload wrote to stderr, without control characters, for its failure message. */
function errorLine(text) {
  if (typeof text !== 'string') return ''
  const lines = text.split(/\r?\n/).map(line => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()).filter(Boolean)
  return (lines.at(-1) ?? '').slice(0, 300)
}

function execute(command, args, options = {}) {
  let file = command
  let argv = args
  let env = options.env ?? process.env
  let windowsVerbatimArguments
  if (command === 'claude') {
    const resolved = resolveClaude({ platform: process.platform, env })
    if (resolved.kind === 'missing') throw Error(missingClaudeMessage(process.platform))
    const invocation = claudeInvocation(resolved, args, env)
    file = invocation.file
    argv = invocation.args
    env = invocation.env
    windowsVerbatimArguments = invocation.windowsVerbatimArguments
  }
  const result = spawnSync(file, argv, {
    encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: options.interactive ? undefined : 30_000,
    stdio: options.interactive ? 'inherit' : 'pipe', env, input: options.input,
    ...(windowsVerbatimArguments ? { windowsVerbatimArguments } : {}),
  })
  if (result.error) {
    if (result.error.code === 'ENOENT') throw Error(command === 'claude' ? missingClaudeMessage(process.platform) : `Required command is missing: ${command}. Install it, then rerun this setup command.`)
    throw Error(`${command} could not finish (${result.error.code ?? 'process error'}). Rerun this setup command.`)
  }
  return { status: result.status, stdout: result.stdout ?? '', hasErrorOutput: Boolean(result.stderr?.trim()), errorText: errorLine(result.stderr) }
}

const native = {
  env: process.env, platform: process.platform, major: Number(process.versions.node.split('.')[0]),
  homedir, osRelease: release(), cwd: () => process.cwd(), script: process.argv[1] ?? '',
  uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
  read: path => readFileSync(path, 'utf8'), inspect: inspectPath, realpath: path => realpathSync.native(path),
  prepare: privateDirectory, exec: execute, prompt: hiddenInput,
  log: text => console.log(text), warn: text => console.error(text),
}

function successful(result, description) {
  if (result.status !== 0) throw Error(`${description} did not finish successfully. Run the same setup command to resume.`)
}

function secretArguments(account, name) {
  const ref = account.secret
  if (!ref || typeof ref.service !== 'string' || typeof ref.account !== 'string' || !ref.service || !ref.account) {
    throw Error(`${name} has no valid credential reference. Check accounts.json.`)
  }
  return ref
}

function credentialLine(service, account, secret) {
  if ([service, account].some(value => /["\\\n\r]/.test(value))) throw Error('The credential reference contains unsupported characters.')
  return `add-generic-password -U -s "${service}" -a "${account}" -X "${Buffer.from(secret).toString('hex')}"\n`
}

/**
 * The login folder for an account: the folder setup derives itself, and the
 * saved spelling Claude Code is started with (its macOS keychain item name
 * depends on that exact text). A saved loginDir that names another place is
 * refused, never created or changed.
 */
function loginFolder(account, name, deps) {
  const expected = derivedLoginDir(deps.configDir, name, deps.platform)
  const saved = account.loginDir
  if (saved === undefined) return { expected, saved: expected }
  if (!absoluteDirectory(saved, deps.platform)) throw Error(`${name} has no absolute loginDir. Check accounts.json.`)
  const dotted = saved.split(deps.platform === 'win32' ? /[\\/]/ : /\//).some(part => part === '.' || part === '..')
  if (dotted || !sameLocation(saved, expected, deps.platform)) {
    throw Error(`${name}'s saved loginDir is ${saved}, but setup only prepares the folder it derives from the config folder: ${expected}. If you moved or renamed the Claude config folder, run /rice-account remove ${name} and then /rice-account add ${name} in Claude Code, and run the new setup command it prints.`)
  }
  return { expected, saved }
}

/** All credential bytes remain in memory or the native credential-store process. */
async function secretSetup(account, name, deps, force) {
  const ref = secretArguments(account, name)
  const mac = deps.platform === 'darwin'
  const windows = deps.platform === 'win32'
  const command = windows ? windowsPowerShell(deps.env) : mac ? '/usr/bin/security' : 'secret-tool'
  const lookup = mac
    ? ['find-generic-password', '-s', ref.service, '-a', ref.account, '-w']
    : windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_CREDENTIAL_STORE]
      : ['lookup', 'service', ref.service, 'account', ref.account]
  const lookupOptions = windows ? { input: JSON.stringify({ operation: 'read', service: ref.service, account: ref.account }) } : undefined
  const existing = deps.exec(command, lookup, lookupOptions)
  if (!mac && !windows && existing.status !== 0 && existing.hasErrorOutput) {
    throw Error('Linux Secret Service is unavailable or locked. Start an accessible user keyring, unlock it, and rerun setup.')
  }
  if (!force && existing.status === 0 && existing.stdout.trim()) {
    deps.log('A credential is already stored. Use --login to replace it.')
    return
  }
  if (existing.status !== 0 && existing.status !== (mac || windows ? 44 : 1)) {
    throw Error(windows ? windowsStoreProblem(existing.status, 'Windows Credential Manager') : 'The credential store is unavailable or locked. Unlock it and rerun setup.')
  }
  if (account.kind === 'claudeai-token') {
    deps.log('Claude Code will generate a setup token. Copy it for the hidden prompt that follows.')
    const folder = loginFolder(account, name, deps)
    deps.prepare(folder.expected, deps.prepareContext)
    successful(deps.exec('claude', ['setup-token'], { interactive: true, env: loginEnvironment(deps.env, folder.saved) }), 'Token setup')
  }
  const secret = await deps.prompt('Claude setup token')
  const stored = windows
    ? deps.exec(command, lookup, { input: JSON.stringify({ operation: 'write', service: ref.service, account: ref.account, secret }) })
    : mac ? deps.exec(command, ['-i'], { input: credentialLine(ref.service, ref.account, secret) })
      : deps.exec(command, ['store', '--label', `Rice account ${name}`, 'service', ref.service, 'account', ref.account], { input: `${secret}\n` })
  if (windows && stored.status !== 0 && stored.status !== WINDOWS_EXIT.FAILED) throw Error(windowsStoreProblem(stored.status, 'Windows Credential Manager'))
  successful(stored, 'Credential storage')
  const verified = deps.exec(command, lookup, lookupOptions)
  if (verified.status !== 0 || verified.stdout.replace(/\r?\n$/, '') !== secret) {
    throw Error('The credential could not be read back from the credential store. Unlock it and rerun setup.')
  }
}

/** Refuses a config folder that is missing, not a folder, a link out of the home folder, or writable by others. */
function checkConfigFolder(configDir, name, home, deps) {
  const found = deps.inspect(configDir)
  if (!found) throw Error(`Cannot find the Claude config folder ${configDir}. First run /rice-account add ${name} inside Claude Code, then run the setup command it prints.`)
  let folder = found
  if (found.symlink) {
    let real
    try { real = deps.realpath(configDir) }
    catch { throw Error(`${configDir} is a link to a folder that does not exist. Fix the link, or start Claude Code with CLAUDE_CONFIG_DIR set to the real folder.`) }
    let realHome
    try { realHome = home ? deps.realpath(home) : undefined } catch { realHome = undefined }
    if (!realHome || !isInside(real, realHome, deps.platform)) {
      throw Error(`${configDir} is a link to ${real}, outside your home folder${home ? ` ${home}` : ''}. Setup does not create private login folders through such a link. Start Claude Code with CLAUDE_CONFIG_DIR set to the real folder, add the account there, and run the setup command it prints.`)
    }
    folder = deps.inspect(real)
    if (!folder) throw Error(`${configDir} is a link to a folder that does not exist. Fix the link, then rerun setup.`)
  }
  if (!folder.directory) throw Error(`${configDir} is not a folder. Pass the Claude config folder with --config-dir.`)
  if (deps.platform !== 'win32' && deps.uid !== undefined && folder.uid !== undefined) {
    if (folder.uid !== deps.uid) throw Error(`${configDir} belongs to another user. Run setup as the user who runs Claude Code.`)
    // A Windows drive in WSL reports every folder as writable by all; drvfsWarning already explains that.
    if (folder.mode !== undefined && (folder.mode & 0o002) !== 0 && !deps.prepareContext?.drvfs) throw Error(`${configDir} can be changed by every user on this machine. Run chmod o-w on it, then rerun setup.`)
  }
}

export async function runSetup(args, overrides = {}) {
  const deps = { ...native, ...overrides }
  if (deps.major < 22) throw Error('Account setup needs Node.js 22 or later.')
  if (!['darwin', 'linux', 'win32'].includes(deps.platform)) throw Error('Account setup supports macOS, Linux (including WSL) and native Windows.')
  const paths = pathsOf(deps.platform)
  let configArgument
  let force = false
  let expectedEmail
  let manual = false
  let browser
  const names = []
  for (let at = 0; at < args.length; at++) {
    const word = args[at]
    if (word === '--config-dir') {
      if (configArgument !== undefined || !args[at + 1] || args[at + 1].startsWith('--')) throw Error('--config-dir needs a directory and may be provided only once.')
      configArgument = args[++at]
    } else if (word === '--login') force = true
    else if (word === '--manual') {
      if (manual) throw Error('--manual may be provided only once.')
      manual = true
    } else if (word === '--browser') {
      if (browser !== undefined || !args[at + 1] || args[at + 1].startsWith('-') || /[\u0000-\u001f\u007f]/.test(args[at + 1])) throw Error('--browser needs one browser executable and may be provided only once.')
      browser = args[++at]
    }
    else if (word === '--email') {
      if (expectedEmail !== undefined || !validEmail(args[at + 1]) || args[at + 1].startsWith('-')) throw Error('--email needs one valid expected email address and may be provided only once.')
      expectedEmail = args[++at]
    } else if (word.startsWith('-')) throw Error(USAGE)
    else names.push(word)
  }
  if (manual && browser !== undefined) throw Error('Choose --manual or --browser, not both.')
  if (names.length !== 1 || !isStoredAccountName(names[0])) throw Error(USAGE)
  const name = names[0]
  if (deps.platform === 'win32' && (isWindowsDeviceName(name) || name.endsWith('.'))) {
    throw Error(`${name} cannot be a folder name on Windows (a device name or a trailing dot). Add the account again under another name with /rice-account add <name>.`)
  }

  // The config folder: --config-dir, else CLAUDE_CONFIG_DIR, else <home>/.claude.
  const home = homeDirectory(deps.platform, deps.env, deps.homedir)
  const source = configArgument !== undefined ? '--config-dir' : deps.env.CLAUDE_CONFIG_DIR ? 'CLAUDE_CONFIG_DIR' : undefined
  const candidate = configArgument ?? (deps.env.CLAUDE_CONFIG_DIR || undefined)
  if (windowsNodeInWsl(deps.platform, deps.env, candidate, typeof deps.cwd === 'function' ? deps.cwd() : '', deps.script)) throw Error(WINDOWS_NODE_IN_WSL)
  if (candidate === undefined && !home) throw Error('Cannot find your home folder. Set HOME (USERPROFILE on Windows), or pass --config-dir with the absolute path of the Claude config folder.')
  const raw = candidate ?? paths.join(home, '.claude')
  if (!absoluteDirectory(raw, deps.platform)) {
    throw Error(`${source ?? 'The Claude config folder'} must be an absolute path, and ${JSON.stringify(raw)} is not. Run the command printed by /rice-account setup ${name} inside Claude Code.`)
  }
  const configDir = paths.resolve(raw)
  deps.configDir = configDir
  const drvfs = isWsl(deps.platform, deps.env, deps.osRelease) && onWindowsDrive(configDir)
  deps.prepareContext = { configDir, drvfs }
  if (drvfs) (deps.warn ?? deps.log)(drvfsWarning(configDir))
  checkConfigFolder(configDir, name, home, deps)

  let config
  try { config = JSON.parse(deps.read(paths.join(configDir, 'rice-session-accounts', 'accounts.json'))) }
  catch { throw Error(`Cannot read accounts.json in ${configDir}. First run /rice-account add ${name} inside Claude Code.`) }
  const accounts = config !== null && typeof config === 'object' && config.accounts !== null && typeof config.accounts === 'object' && !Array.isArray(config.accounts) ? config.accounts : {}
  const account = Object.hasOwn(accounts, name) ? accounts[name] : undefined
  if (!account || typeof account !== 'object') throw Error(`${name} is not saved. First run /rice-account add ${name}.`)
  if (account.kind === 'login') throw Error('The built-in login uses claude auth login directly.')
  if (expectedEmail !== undefined && account.kind !== 'claudeai') throw Error('--email is supported only for claudeai browser login, not setup tokens or provider accounts.')
  if ((manual || browser !== undefined) && account.kind !== 'claudeai') throw Error('--manual and --browser are supported only for claudeai browser login.')
  if (account.kind === 'claudeai') {
    if (deps.platform === 'win32' && deps.env.FORCE_WINDOWS_CREDMAN && !/^(?:0|false|no|off)$/i.test(deps.env.FORCE_WINDOWS_CREDMAN)) throw Error('The optional FORCE_WINDOWS_CREDMAN browser store is not supported by Rice Accounts. Run this setup without that override, or add a claudeai-token account for Windows Credential Manager.')
    if (account.loginDir === undefined) throw Error(`${name} has no absolute loginDir. Check accounts.json.`)
    const folder = loginFolder(account, name, deps)
    deps.prepare(folder.expected, deps.prepareContext)
    const env = loginEnvironment(deps.env, folder.saved)
    // Native Claude honors BROWSER for this child only. Literal true keeps
    // its manual URL flow without opening the machine's default browser.
    if (manual) env.BROWSER = 'true'
    else if (browser !== undefined) env.BROWSER = browser
    const status = () => {
      const result = deps.exec('claude', ['auth', 'status', '--json'], { env })
      try {
        const value = JSON.parse(result.stdout)
        return {
          ready: result.status === 0 && value.loggedIn === true && value.authMethod === 'claude.ai' && value.apiProvider === 'firstParty',
          email: validEmail(value.email) ? value.email : undefined,
        }
      }
      catch { return { ready: false } }
    }
    let verified = force ? undefined : status()
    if (!verified?.ready) {
      deps.log(`Signing in ${name} with Claude Code. Complete its browser or terminal sign-in.`)
      if (manual) deps.log('Manual sign-in: open the printed URL in the browser already signed into the intended account, then paste its code here. The default browser will not open.')
      const args = ['auth', 'login', '--claudeai']
      if (expectedEmail !== undefined) args.push('--email', expectedEmail)
      successful(deps.exec('claude', args, { env, interactive: true }), 'Claude login')
      verified = status()
      if (!verified.ready) throw Error('Claude login is incomplete. Run the same command to resume.')
    }
    if (expectedEmail !== undefined && verified.email?.toLowerCase() !== expectedEmail.toLowerCase()) {
      const actual = verified.email ? `Claude is signed in as ${verified.email}` : 'the signed-in email is unavailable'
      throw Error(`Expected ${expectedEmail}, but ${actual}. Run the same setup command with --login and select the intended account in the browser. The --email hint only pre-populates the login page.`)
    }
    deps.log(`${name}: isolated Claude login is ready.`)
  } else if (account.kind === 'claudeai-token') {
    await secretSetup(account, name, deps, force)
    deps.log(`${name}: OAuth token storage is ready.`)
  } else throw Error('Rice Accounts supports Anthropic OAuth accounts only. Configure provider accounts in rice-multi-models.')
  deps.log(`Return to Claude Code: /rice-account check ${name}\nThen switch: /rice-account ${name}`)
}

/** The command-line entry: errors print one line on stderr and exit 1. */
export async function main(argv) {
  try {
    await runSetup(argv)
  } catch (error) {
    console.error(`rice-session-accounts: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
