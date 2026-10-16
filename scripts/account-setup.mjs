#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, posix, win32 } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { WINDOWS_CREDENTIAL_STORE, WINDOWS_PRIVATE_DIRECTORY } from './windows-store-payloads.mjs'

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/
const USAGE = 'Usage: node account-setup.mjs [--config-dir <directory>] [--login] [--email <expected-email>] [--manual | --browser <executable>] <saved name>'

function validEmail(value) {
  return typeof value === 'string' && value.length <= 254 && !/[\u0000-\u001f\u007f-\u009f]/.test(value) && /^[^@\s]+@[^@\s]+$/.test(value)
}
const AUTH_ENV = [
  'RICE_SESSION_ACCOUNTS_OAUTH_RELAY',
  'CLAUDECODE', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
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

/** Login owns credential storage. This helper never copies a credential to a file. */
function privateDirectory(path) {
  if (process.platform === 'win32') {
    successful(execute(windowsPowerShell(process.env), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_PRIVATE_DIRECTORY], { input: JSON.stringify({ path }) }), 'Private Windows login directory setup')
    return
  }
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) {
    throw Error('The isolated login directory must be a directory owned by the current user, without a symlink.')
  }
  chmodSync(path, 0o700)
}

function windowsPowerShell(env) {
  const root = env.SystemRoot || env.WINDIR
  return root ? win32.join(root, 'System32/WindowsPowerShell/v1.0/powershell.exe') : 'powershell.exe'
}

function absoluteDirectory(value, platform) {
  return typeof value === 'string' && !/[\0\r\n]/.test(value) && (platform === 'win32'
    ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value)
    : value.startsWith('/'))
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

function execute(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: options.interactive ? undefined : 30_000,
    stdio: options.interactive ? 'inherit' : 'pipe', env: options.env ?? process.env, input: options.input,
  })
  if (result.error) {
    if (result.error.code === 'ENOENT') throw Error(`Required command is missing: ${command}. Install it, then rerun this setup command.`)
    throw Error(`${command} could not finish (${result.error.code ?? 'process error'}). Rerun this setup command.`)
  }
  return { status: result.status, stdout: result.stdout ?? '', hasErrorOutput: Boolean(result.stderr?.trim()) }
}

const native = {
  env: process.env, platform: process.platform, major: Number(process.versions.node.split('.')[0]),
  read: path => readFileSync(path, 'utf8'), prepare: privateDirectory,
  exec: execute, prompt: hiddenInput, log: text => console.log(text),
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
    throw Error('The credential store is unavailable or locked. Unlock it and rerun setup.')
  }
  if (account.kind === 'claudeai-token') {
    deps.log('Claude Code will generate a setup token. Copy it for the hidden prompt that follows.')
    const paths = deps.platform === 'win32' ? win32 : posix
    const tokenDir = account.loginDir ?? paths.join(deps.configDir, 'rice-session-accounts', 'logins', name)
    deps.prepare(tokenDir)
    successful(deps.exec('claude', ['setup-token'], { interactive: true, env: loginEnvironment(deps.env, tokenDir) }), 'Token setup')
  }
  const secret = await deps.prompt('Claude setup token')
  const stored = windows
    ? deps.exec(command, lookup, { input: JSON.stringify({ operation: 'write', service: ref.service, account: ref.account, secret }) })
    : mac ? deps.exec(command, ['-i'], { input: credentialLine(ref.service, ref.account, secret) })
      : deps.exec(command, ['store', '--label', `Rice account ${name}`, 'service', ref.service, 'account', ref.account], { input: `${secret}\n` })
  successful(stored, 'Credential storage')
  const verified = deps.exec(command, lookup, lookupOptions)
  if (verified.status !== 0 || verified.stdout.replace(/\r?\n$/, '') !== secret) {
    throw Error('The credential could not be read back from the credential store. Unlock it and rerun setup.')
  }
}

export async function runSetup(args, overrides = {}) {
  const deps = { ...native, ...overrides }
  if (deps.major < 22) throw Error('Account setup needs Node.js 22 or later.')
  if (!['darwin', 'linux', 'win32'].includes(deps.platform)) throw Error('Account setup supports macOS, Linux (including WSL) and native Windows.')
  const paths = deps.platform === 'win32' ? win32 : posix
  const home = deps.platform === 'win32' ? deps.env.USERPROFILE || deps.env.HOME || homedir() : deps.env.HOME || homedir()
  let configDir = deps.env.CLAUDE_CONFIG_DIR || paths.join(home, '.claude')
  let force = false
  let expectedEmail
  let manual = false
  let browser
  const names = []
  for (let at = 0; at < args.length; at++) {
    const word = args[at]
    if (word === '--config-dir') {
      if (!args[at + 1] || args[at + 1].startsWith('--')) throw Error('--config-dir needs a directory.')
      configDir = paths.resolve(args[++at])
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
  if (names.length !== 1 || !NAME.test(names[0])) throw Error(USAGE)
  deps.configDir = configDir
  const name = names[0]
  let config
  try { config = JSON.parse(deps.read(paths.join(configDir, 'rice-session-accounts', 'accounts.json'))) }
  catch { throw Error('Cannot read accounts.json. First run /rice-account add <name> inside Claude Code.') }
  const account = Object.hasOwn(config?.accounts ?? {}, name) ? config.accounts[name] : undefined
  if (!account || typeof account !== 'object') throw Error(`${name} is not saved. First run /rice-account add ${name}.`)
  if (account.kind === 'login') throw Error('The built-in login uses claude auth login directly.')
  if (expectedEmail !== undefined && account.kind !== 'claudeai') throw Error('--email is supported only for claudeai browser login, not setup tokens or provider accounts.')
  if ((manual || browser !== undefined) && account.kind !== 'claudeai') throw Error('--manual and --browser are supported only for claudeai browser login.')
  if (account.kind === 'claudeai') {
    if (deps.platform === 'win32' && deps.env.FORCE_WINDOWS_CREDMAN && !/^(?:0|false|no|off)$/i.test(deps.env.FORCE_WINDOWS_CREDMAN)) throw Error('The optional FORCE_WINDOWS_CREDMAN browser store is not supported by Rice Accounts. Run this setup without that override, or add a claudeai-token account for Windows Credential Manager.')
    if (!absoluteDirectory(account.loginDir, deps.platform)) throw Error(`${name} has no absolute loginDir. Check accounts.json.`)
    deps.prepare(account.loginDir)
    const env = loginEnvironment(deps.env, account.loginDir)
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSetup(process.argv.slice(2)).catch(error => {
    console.error(`rice-session-accounts: ${error.message}`)
    process.exitCode = 1
  })
}
