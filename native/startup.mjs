// Startup account selection happens before Claude can resume or compact a turn.
import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join, win32 } from 'node:path'

export const INITIAL_ACCOUNT = 'RICE_SESSION_ACCOUNTS_INITIAL_ACCOUNT'
export const INITIAL_ORIGINALS = 'RICE_SESSION_ACCOUNTS_INITIAL_ORIGINALS'
// Kept equal to hooks/env.ts by a contract test. Values remain in memory only.
export const MANAGED_AUTH = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_BG_AUTH_SNAPSHOT_PATH',
  'CLAUDE_CODE_HOST_CREDS_FILE', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
  'AWS_PROFILE', 'AWS_REGION', 'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION', 'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_API_KEY',
]
const CLEAR_AUTH = new Set(MANAGED_AUTH.filter(name => name.startsWith('CLAUDE_') || ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_FOUNDRY_API_KEY'].includes(name)))

export function startupArguments(args) {
  let account
  const native = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--') { native.push(...args.slice(index)); break }
    if (arg === '--account' || arg.startsWith('--account=')) {
      if (account !== undefined) throw new Error('Pass --account only once.')
      account = arg === '--account' ? args[++index] : arg.slice('--account='.length)
      if (!account || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(account)) throw new Error('Usage: rice-account-claude --account <saved browser account> [Claude arguments]')
    } else native.push(arg)
  }
  return { account, args: native }
}

export function accountStartup(configDir, environment, name) {
  if (name === undefined) return { ...environment }
  if (name === 'login') throw new Error('--account login cannot recover a selected parent process\'s machine baseline. Omit --account in a normal terminal, or use /rice-account login inside the existing managed session.')
  const path = join(configDir, 'rice-session-accounts/accounts.json'), info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('The saved account configuration is not a bounded regular file.')
  const config = JSON.parse(readFileSync(path, 'utf8')), account = config?.accounts?.[name]
  const absolute = typeof account?.loginDir === 'string' && (process.platform === 'win32' ? win32.isAbsolute(account.loginDir) && (/^[A-Za-z]:[\\/]/.test(account.loginDir) || /^\\\\[^\\]+\\[^\\]+/.test(account.loginDir)) : isAbsolute(account.loginDir))
  if (!account || account.kind !== 'claudeai' || !absolute || /[\0\r\n]/.test(account.loginDir)) throw new Error('--account requires a saved claudeai browser account with an absolute native login directory. Complete /rice-account setup <name> first.')
  const selected = { ...environment }
  selected[INITIAL_ORIGINALS] = JSON.stringify(Object.fromEntries(MANAGED_AUTH.map(key => [key, environment[key] ?? null])))
  selected[INITIAL_ACCOUNT] = name
  for (const key of CLEAR_AUTH) delete selected[key]
  delete selected.RICE_SESSION_ACCOUNTS_OAUTH_RELAY
  selected.CLAUDE_SECURESTORAGE_CONFIG_DIR = account.loginDir
  selected.RICE_SESSION_ACCOUNTS_AUTH_REVISION = name
  return selected
}

/** Shared with rice-claude; no subprocess, login, network or configuration write. */
export function prepareAccountLaunch(args, environment, configDir) {
  const parsed = startupArguments(args)
  return { args: parsed.args, env: accountStartup(configDir, environment, parsed.account) }
}
