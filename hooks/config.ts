/**
 * The saved accounts: a JSON file of names, kinds and where each one's secret
 * lives. Secrets themselves stay in the macOS keychain; this file holds none.
 */

export const KINDS = ['login', 'claudeai', 'claudeai-token', 'api-key', 'gateway', 'bedrock', 'vertex', 'foundry'] as const
export type Kind = (typeof KINDS)[number]

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

export type Config = { default: string; accounts: Record<string, AccountConfig> }

export const LOGIN_NAME = 'login'

export function defaultConfig(): Config {
  return { default: LOGIN_NAME, accounts: { [LOGIN_NAME]: { kind: 'login', label: "this machine's /login" } } }
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

/** Names that are safe in a keychain account, a folder and a command line. */
export function isAccountName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(name)
}

function isKind(value: unknown): value is Kind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value)
}

function stringField(raw: Record<string, unknown>, key: string): string | undefined {
  return typeof raw[key] === 'string' && raw[key] !== '' ? (raw[key] as string) : undefined
}

/** Checks one account; the problems name what is missing for its kind. */
export function accountProblems(name: string, account: AccountConfig): string[] {
  const problems: string[] = []
  if (!isAccountName(name)) problems.push(`"${name}" is not a usable name (letters, digits, . _ -, up to 40)`)
  const needsSecret = account.kind === 'claudeai-token' || account.kind === 'api-key' || account.kind === 'gateway'
  if (needsSecret && !account.secret) problems.push(`${name}: a ${account.kind} account needs "secret"`)
  if (account.kind === 'claudeai' && !account.loginDir) problems.push(`${name}: a claudeai account needs "loginDir"`)
  if (account.kind === 'gateway' && !account.baseUrl) problems.push(`${name}: a gateway account needs "baseUrl"`)
  if (account.kind === 'vertex' && !account.projectId) problems.push(`${name}: a vertex account needs "projectId"`)
  if (account.kind === 'foundry' && !account.resource && !account.baseUrl) problems.push(`${name}: a foundry account needs "resource" or "baseUrl"`)

  return problems
}

/** The file's accounts, the bad ones left out and said; a file that does not parse is all problem. */
export function parseConfig(text: string): { config: Config; problems: string[] } {
  const config = defaultConfig()
  const problems: string[] = []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { config, problems: [`accounts.json does not parse: ${error instanceof Error ? error.message : String(error)}`] }
  }
  const top = (raw ?? {}) as { default?: unknown; accounts?: unknown }
  if (top.accounts && typeof top.accounts === 'object') {
    for (const [name, value] of Object.entries(top.accounts as Record<string, unknown>)) {
      const entry = (value ?? {}) as Record<string, unknown>
      if (!isKind(entry.kind)) {
        problems.push(`${name}: unknown kind ${JSON.stringify(entry.kind)} (one of ${KINDS.join(', ')})`)
        continue
      }
      const secret = entry.secret as { service?: unknown; account?: unknown } | undefined
      const models = entry.models && typeof entry.models === 'object' ? (entry.models as Record<string, unknown>) : undefined
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
          ? Object.fromEntries(Object.entries(models).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
          : undefined,
      }
      const found = accountProblems(name, account)
      if (found.length > 0) {
        problems.push(...found)
        continue
      }
      config.accounts[name] = account
    }
  }
  if (typeof top.default === 'string') {
    if (config.accounts[top.default]) config.default = top.default
    else problems.push(`default names no saved account: ${top.default}`)
  }

  return { config, problems }
}

export function serializeConfig(config: Config): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

/** The options `/rice-account add` takes, as `key=value` words. */
export const ADD_OPTIONS = ['label', 'aws_profile', 'region', 'project', 'resource', 'base_url', 'service', 'secret'] as const

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
  if (!isAccountName(name)) throw new Error(`"${name}" is not a usable name (letters, digits, . _ -, up to 40)`)
  if (config.accounts[name]) throw new Error(`an account named ${name} is saved already; /rice-account remove ${name} first`)
  const service = options.service ?? SECRET_SERVICE
  const secret: SecretRef = { service, account: name }
  const storeSecret = (what: string) => `security add-generic-password -U -s ${service} -a ${name} -w   # then paste the ${what} at the prompt`
  const account: AccountConfig = { kind, label: options.label }
  const steps: string[] = []
  switch (kind) {
    case 'login':
      throw new Error("the machine's /login is saved already as \"login\"")
    case 'claudeai': {
      account.loginDir = paths.loginDir(name)
      steps.push(`CLAUDE_CONFIG_DIR="${account.loginDir}" claude auth login --claudeai`)
      steps.push('# signs that folder in with its own keychain item; your main login and other sessions stay as they are')
      break
    }
    case 'claudeai-token':
      account.secret = secret
      steps.push('claude setup-token   # sign in as that account; it prints a one-year token')
      steps.push(storeSecret('token'))
      break
    case 'api-key':
      account.secret = secret
      steps.push(storeSecret('Console API key'))
      break
    case 'gateway':
      if (!options.base_url) throw new Error('a gateway account needs base_url=<https://...>')
      account.baseUrl = options.base_url
      account.secret = secret
      steps.push(storeSecret('gateway token'))
      break
    case 'bedrock':
      account.awsProfile = options.aws_profile
      account.region = options.region
      account.baseUrl = options.base_url
      if (options.secret === 'bearer') {
        account.secret = secret
        steps.push(storeSecret('Bedrock API key (bearer token)'))
      } else {
        steps.push(`aws sso login${options.aws_profile ? ` --profile ${options.aws_profile}` : ''}   # or any way that gives this AWS profile credentials`)
      }
      break
    case 'vertex':
      if (!options.project) throw new Error('a vertex account needs project=<gcp-project-id>')
      account.projectId = options.project
      account.region = options.region
      account.baseUrl = options.base_url
      steps.push('gcloud auth application-default login   # or set GOOGLE_APPLICATION_CREDENTIALS before starting Claude Code')
      break
    case 'foundry':
      if (!options.resource && !options.base_url) throw new Error('a foundry account needs resource=<name> or base_url=<https://...>')
      account.resource = options.resource
      account.baseUrl = options.base_url
      if (options.secret === 'key') {
        account.secret = secret
        steps.push(storeSecret('Foundry API key'))
      } else {
        steps.push('az login   # Foundry then uses your Azure credentials')
      }
      break
  }
  const problems = accountProblems(name, account)
  if (problems.length > 0) throw new Error(problems.join('; '))

  return { config: { ...config, accounts: { ...config.accounts, [name]: account } }, steps: [...steps, `then: /rice-account ${name}`] }
}

/** The config without an account; the default goes back to the machine login when it named it. */
export function removeAccount(config: Config, name: string): Config {
  if (name === LOGIN_NAME) throw new Error("the machine's /login cannot be removed")
  if (!config.accounts[name]) throw new Error(`no account named ${name}`)
  const accounts = { ...config.accounts }
  delete accounts[name]

  return { default: config.default === name ? LOGIN_NAME : config.default, accounts }
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
