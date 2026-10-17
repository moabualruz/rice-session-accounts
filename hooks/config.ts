/**
 * The saved accounts: a JSON file of names, kinds and where each one's secret
 * lives. This file holds no credentials.
 */

import {
  accountNameProblem,
  caseConflict,
  isAccountName as sharedIsAccountName,
  isStoredAccountName,
  legacyNameNote,
  RESERVED_NAMES as SHARED_RESERVED_NAMES,
} from '../scripts/account-names.mjs'

/** Command words and inherited object keys that a new account cannot be named. */
export const RESERVED_NAMES: readonly string[] = SHARED_RESERVED_NAMES

/** A dictionary without inherited keys, so a name like toString finds nothing it did not save. */
function dictionary<T>(entries: Iterable<readonly [string, T]> = []): Record<string, T> {
  const result = Object.create(null) as Record<string, T>
  for (const [key, value] of entries) result[key] = value
  return result
}

export const KINDS = ['login', 'claudeai', 'claudeai-token'] as const
// Read legacy provider records so ordinary OAuth edits preserve them verbatim.
const STORED_KINDS = [...KINDS, 'api-key', 'gateway', 'bedrock', 'vertex', 'foundry'] as const
export type Kind = (typeof STORED_KINDS)[number]

/** The keychain service a secret saved by name lives under, its account being the saved account's name. */
export const SECRET_SERVICE = 'rice-session-accounts'

export type SecretRef = { service: string; account: string }

export type AccountConfig = {
  kind: Kind
  label?: string
  /** claudeai: the config folder an isolated `claude auth login` signed in. */
  loginDir?: string
  /** claudeai-token, api-key, gateway, and optionally bedrock (bearer token) and foundry (API key). */
  secret?: SecretRef
  /** gateway: required. bedrock, vertex, foundry: optional endpoint override. */
  baseUrl?: string
  awsProfile?: string
  region?: string
  projectId?: string
  resource?: string
  /** Model ids this account calls by another name (a Bedrock inference profile, say). */
  models?: Record<string, string>
}

export type Config = { default: string; accounts: Record<string, AccountConfig>; legacy?: Record<string, unknown> }

export const LOGIN_NAME = 'login'

export function defaultConfig(): Config {
  return { default: LOGIN_NAME, accounts: dictionary<AccountConfig>([[LOGIN_NAME, { kind: 'login', label: "this machine's /login" }]]) }
}

/** The saved account by exactly this name, never an inherited object key. */
export function savedAccount(config: Config, name: string): AccountConfig | undefined {
  return Object.hasOwn(config.accounts, name) ? config.accounts[name] : undefined
}

export type Paths = { base: string; config: string; loginDir: (name: string) => string; lock: (name: string) => string }

export function pathsFor(claudeDir: string): Paths {
  const base = `${claudeDir.replace(/\/+$/, '')}/rice-session-accounts`

  return {
    base,
    config: `${base}/accounts.json`,
    loginDir: name => `${base}/logins/${name}`,
    lock: name => `${base}/locks/${name}.lock`,
  }
}

/**
 * Names a new account may use: safe in a keychain account, a folder on macOS,
 * Linux and Windows, and a command line, and never a command word or an
 * inherited object key. Accounts saved under an older rule keep working.
 */
export function isAccountName(name: string): boolean {
  return sharedIsAccountName(name)
}

function isKind(value: unknown): value is Kind {
  return typeof value === 'string' && (STORED_KINDS as readonly string[]).includes(value)
}

function stringField(raw: Record<string, unknown>, key: string): string | undefined {
  return typeof raw[key] === 'string' && raw[key] !== '' ? (raw[key] as string) : undefined
}

/** Checks one account; the problems name what is missing for its kind. */
export function accountProblems(name: string, account: AccountConfig): string[] {
  const problems: string[] = []
  // Saved names keep the rule they were saved under; new names use isAccountName.
  if (!isStoredAccountName(name)) problems.push(`"${name}" is not a usable name (letters, digits, . _ -, up to 40)`)
  const needsSecret = account.kind === 'claudeai-token' || account.kind === 'api-key' || account.kind === 'gateway'
  if (needsSecret && !account.secret) problems.push(`${name}: a ${account.kind} account needs "secret"`)
  if (account.kind === 'claudeai' && !account.loginDir) problems.push(`${name}: a claudeai account needs "loginDir"`)
  if (account.kind === 'gateway' && !account.baseUrl) problems.push(`${name}: a gateway account needs "baseUrl"`)
  if (account.kind === 'vertex' && !account.projectId) problems.push(`${name}: a vertex account needs "projectId"`)
  if (account.kind === 'foundry' && !account.resource && !account.baseUrl) problems.push(`${name}: a foundry account needs "resource" or "baseUrl"`)

  return problems
}

/** The problem a file that does not parse reports, so writers can keep it for repair. */
export const UNPARSED_CONFIG = 'accounts.json does not parse'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The file's accounts, the bad ones left out and said in problems; a file that
 * does not parse is all problem. Notes name saved accounts that keep working
 * but deserve attention, such as a name new accounts can no longer use.
 */
export function parseConfig(text: string): { config: Config; problems: string[]; notes: string[] } {
  const config = defaultConfig()
  const problems: string[] = []
  const notes: string[] = []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { config, problems: [`${UNPARSED_CONFIG}: ${error instanceof Error ? error.message : String(error)}`], notes }
  }
  const top: Record<string, unknown> = isRecord(raw) ? raw : {}
  if (isRecord(top.accounts)) {
    for (const [name, value] of Object.entries(top.accounts)) {
      const entry: Record<string, unknown> = isRecord(value) ? value : {}
      if (!isKind(entry.kind)) {
        problems.push(`${name}: unknown kind ${JSON.stringify(entry.kind)} (one of ${KINDS.join(', ')})`)
        continue
      }
      if (!(KINDS as readonly string[]).includes(entry.kind)) {
        config.legacy ??= dictionary<unknown>()
        config.legacy[name] = value
      }
      const secret = isRecord(entry.secret) ? (entry.secret as { service?: unknown; account?: unknown }) : undefined
      const models = isRecord(entry.models) ? entry.models : undefined
      const account: AccountConfig = {
        kind: entry.kind,
        label: stringField(entry, 'label'),
        loginDir: stringField(entry, 'loginDir'),
        secret: typeof secret?.service === 'string' && typeof secret.account === 'string' ? { service: secret.service, account: secret.account } : undefined,
        baseUrl: stringField(entry, 'baseUrl'),
        awsProfile: stringField(entry, 'awsProfile'),
        region: stringField(entry, 'region'),
        projectId: stringField(entry, 'projectId'),
        resource: stringField(entry, 'resource'),
        models: models
          ? dictionary<string>(Object.entries(models).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
          : undefined,
      }
      const found = accountProblems(name, account)
      if (found.length > 0) {
        problems.push(...found)
        continue
      }
      config.accounts[name] = account
      if (name !== LOGIN_NAME && (KINDS as readonly string[]).includes(account.kind)) {
        const note = legacyNameNote(name)
        if (note) notes.push(note)
      }
    }
  }
  const names = [...Object.keys(config.accounts), ...Object.keys(config.legacy ?? {})]
  const reported = new Set<string>()
  for (const name of names) {
    const other = caseConflict(names, name)
    if (!other || reported.has(name.toLowerCase())) continue
    reported.add(name.toLowerCase())
    notes.push(`${other} and ${name} differ only in letter case; macOS and Windows treat them as one login folder. Remove one of them.`)
  }
  if (typeof top.default === 'string') {
    if (savedAccount(config, top.default)) config.default = top.default
    else problems.push(`default names no saved account: ${top.default}`)
  }

  return { config, problems, notes }
}

export function serializeConfig(config: Config): string {
  return `${JSON.stringify({ default: config.default, accounts: { ...config.accounts, ...config.legacy } }, null, 2)}\n`
}

/** The options `/rice-account add` takes, as `key=value` words. */
export const ADD_OPTIONS = ['label', 'service'] as const

/**
 * A new account and what the person still does once, in a terminal, before
 * switching to it. Nothing secret is asked here: a secret is typed into the
 * keychain prompt, never into the session.
 */
export function addAccount(
  config: Config,
  name: string,
  kind: Kind,
  options: Record<string, string>,
  paths: Paths,
): { config: Config; steps: string[] } {
  if (!isStoredAccountName(name)) throw new Error(accountNameProblem(name))
  if (!(KINDS as readonly string[]).includes(kind)) throw new Error('Rice Accounts supports Anthropic OAuth accounts only. Use rice-multi-models for provider accounts.')
  if (config.legacy && Object.hasOwn(config.legacy, name)) throw new Error(`${name} is a preserved provider entry. Use another name for an OAuth account.`)
  for (const option of Object.keys(options)) {
    if (!(ADD_OPTIONS as readonly string[]).includes(option)) throw new Error(`Unknown option: ${option}`)
  }
  const allowed: Record<Kind, readonly string[]> = {
    login: [], claudeai: ['label'], 'claudeai-token': ['label', 'service'], 'api-key': ['label', 'service'],
    gateway: ['label', 'service', 'base_url'], bedrock: ['label', 'aws_profile', 'region', 'base_url', 'secret', 'service'],
    vertex: ['label', 'project', 'region', 'base_url'], foundry: ['label', 'resource', 'base_url', 'secret', 'service'],
  }
  for (const option of Object.keys(options)) {
    if (!allowed[kind].includes(option)) throw new Error(`Option ${option} does not apply to ${kind}`)
  }
  if (options.secret && !((kind === 'bedrock' && options.secret === 'bearer') || (kind === 'foundry' && options.secret === 'key'))) {
    throw new Error('Use secret=bearer for Bedrock or secret=key for Foundry.')
  }
  if (options.service && (kind === 'bedrock' || kind === 'foundry') && !options.secret) throw new Error('service= requires secret=bearer for Bedrock or secret=key for Foundry.')
  const existing = savedAccount(config, name)
  if (existing) {
    if (existing.kind !== kind || Object.keys(options).length > 0) {
      throw new Error(`${name} is already saved as ${existing.kind}; use /rice-account setup ${name} to finish it. Existing settings were kept.`)
    }
    return { config, steps: [] }
  }
  // An account saved under an older rule stays usable above; a new one meets the current rule.
  const problem = accountNameProblem(name)
  if (problem) throw new Error(problem)
  const other = caseConflict([...Object.keys(config.accounts), ...Object.keys(config.legacy ?? {})], name)
  if (other) throw new Error(`${name} differs from the saved account ${other} only in letter case; macOS and Windows would store both in one login folder. Choose another name.`)
  const service = options.service ?? SECRET_SERVICE
  const secret: SecretRef = { service, account: name }
  const storeSecret = (what: string) => `The terminal setup helper will ask for the ${what} without echoing it.`
  const account: AccountConfig = { kind, label: options.label }
  const steps: string[] = []
  switch (kind) {
    case 'login':
      throw new Error("the machine's /login is saved already as \"login\"")
    case 'claudeai': {
      account.loginDir = paths.loginDir(name)
      steps.push('The terminal setup helper signs in this isolated account using Claude Code.')
      break
    }
    case 'claudeai-token':
      account.secret = secret
      steps.push('claude setup-token   # sign in as that account; it prints a one-year token')
      steps.push(storeSecret('token'))
      break
    default:
      throw new Error('Rice Accounts supports Anthropic OAuth accounts only.')
  }
  const problems = accountProblems(name, account)
  if (problems.length > 0) throw new Error(problems.join('; '))

  return { config: { ...config, accounts: dictionary<AccountConfig>([...Object.entries(config.accounts), [name, account] as const]) }, steps: [...steps, `then: /rice-account ${name}`] }
}

/** The config without an account; the default goes back to the machine login when it named it. */
export function removeAccount(config: Config, name: string): Config {
  if (name === LOGIN_NAME) throw new Error("the machine's /login cannot be removed")
  if (!savedAccount(config, name)) throw new Error(`no account named ${name}`)
  const accounts = dictionary<AccountConfig>(Object.entries(config.accounts).filter(([saved]) => saved !== name))

  return { ...config, default: config.default === name ? LOGIN_NAME : config.default, accounts }
}

export function describeAccount(name: string, account: AccountConfig): string {
  const where =
    account.kind === 'bedrock'
      ? [account.awsProfile && `profile ${account.awsProfile}`, account.region].filter(Boolean).join(', ')
      : account.kind === 'vertex'
        ? [account.projectId, account.region].filter(Boolean).join(', ')
        : account.kind === 'foundry'
          ? (account.resource ?? account.baseUrl ?? '')
          : account.kind === 'gateway'
            ? (account.baseUrl ?? '')
            : ''

  return `${name}  ${account.kind}${account.label ? `  "${account.label}"` : ''}${where ? `  (${where})` : ''}`
}
