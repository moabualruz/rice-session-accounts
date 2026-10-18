import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookFailure, Register, Timer, On } from 'claude-code'

import type { AccountSnapshot, ActiveAccount, EnvSnapshot } from '../types'
import { loginEmail, materialFor } from './accounts'
import type { Machine } from './accounts'
import { ARGUMENT_HINT, completions, helpText, parseCommand } from './command-line'
import { ADD_OPTIONS, addAccount, defaultConfig, describeAccount, KINDS, LOGIN_NAME, parseConfig, pathsFor, removeAccount, serializeConfig, UNPARSED_CONFIG } from './config'
import type { AccountConfig, Config, Kind } from './config'
import { readLogin } from './credentials'
import { argvInvokesClaude, commandInvokesClaude, GUARD_FAILED } from './descendants'
import { headerToken, MANAGED, oauthHeaders, planEnv, withoutAuthHeaders } from './env'
import type { Managed, Originals } from './env'
import { accountIdentity } from './identity'
import type { EnvName, Io } from './io'
import { message } from './io'
import { withLock } from './lock'
import { loginSourceOf, NOT_OAUTH_LOGIN } from './login'
import type { LoginSource } from './login'
import { EXPIRY_MARGIN_MS, oauthInit, parseProfile, parseUsage, PROFILE_URL, USAGE_URL } from './oauth'
import { ACCOUNT_PICKER_ID, openAccountPicker, renderAccountPicker } from './picker'
import type { AccountRow } from './picker'
import { refusalText, SessionAuthorizations, UNKNOWN_HANDLE } from './session-auth'
import { legacyCleanupText, setupText, signOutHint } from './setup'

const PLUGIN = 'rice-session-accounts'
const activeAtom = atom({ plugin: 'rice-session-accounts', key: 'active' } as const, null)
const originalsAtom = atom({ plugin: 'rice-session-accounts', key: 'originals' } as const, null)
const problemAtom = atom({ plugin: 'rice-session-accounts', key: 'problem' } as const, null)
const authorizationsAtom = atom({ plugin: 'rice-session-accounts', key: 'authorizations' } as const, null)

const ACCOUNT_RECOVERY = 'The session account is not confirmed. Run /rice-account login or select a saved account again before continuing.'
const ACCOUNT_CHANGING = 'The session account is changing. Retry when the selection completes.'
const ACCOUNT_CHANGED = 'The session account changed while this request was prepared. Retry the request.'
const LOCKOUT_STATUS = 'account not confirmed | run /rice-account login or select an account'
/** At most one usage lookup per this long after a turn, and after /usage. */
const USAGE_REFRESH_MS = 60_000
/** A failed renewal waits this long, doubling per failure up to the maximum, before it is tried again. */
const RENEWAL_BACKOFF_MS = 30_000
const RENEWAL_BACKOFF_MAX_MS = 600_000
const LOADING_USAGE = 'loading usage'
/** What a lockout puts in place of the unconfirmed bearer, so requests nothing hooks fail loudly instead of using the wrong account. */
const LOCKOUT_BEARER = 'rice-session-accounts-account-not-confirmed'

type ReportedLimit = { kind: string; percentUsed: number; resetsAt?: string }
type AccountReport = { name: string; generation: number; email: string; tier: string; rateLimits: ReportedLimit[]; problem?: string; isStale?: boolean }

/**
 * Everything this module holds in memory. `$.state` and the process
 * environment outlive a reload of this module, and the module outlives a
 * /clear (which empties the state while this process keeps the account it
 * switched to): each puts the other back. A fresh load of the module (first
 * start, reload, worker respawn, enable) is the only time `session.start`
 * reaches it, so that hook starts from `freshModule()` and then restores the
 * safety state from `$.state`.
 */
function freshModule() {
  return {
    isStarted: false,
    mirror: { active: null as ActiveAccount | null, originals: null as EnvSnapshot | null },
    renewal: undefined as Timer | undefined,
    expiresAt: undefined as number | undefined,
    knownNames: [LOGIN_NAME] as string[],
    /** Explicit selections in the order they began, and the newest one committed. */
    selections: 0,
    committedSelection: 0,
    /** Advanced by each committed switch; reports of an older generation are discarded. */
    transitionGeneration: 0,
    /** Advanced by each attempt to change the environment, committed or rolled back. */
    commitAttempts: 0,
    commitTail: Promise.resolve() as Promise<void>,
    committingAccount: false,
    accountReport: undefined as AccountReport | undefined,
    transitionProblem: undefined as string | undefined,
    usageCheckedAt: undefined as number | undefined,
    renewalFailures: new Map<string, { streak: number; retryAt: number }>(),
    authorizations: new SessionAuthorizations(),
  }
}

let local = freshModule()

// Claude 2.1.296 follows `$` only into helpers declared in this module.

/**
 * The selected account. Before `session.start` reached a freshly loaded
 * module (a reload's first moments), the one a previous load kept in
 * `$.state` counts, since the environment still carries its header.
 */
async function activeAccount($: EngineInterface): Promise<ActiveAccount | null> {
  if (local.mirror.active || local.isStarted) return local.mirror.active
  return (await read($, activeAtom)) ?? null
}

/** The bearer requests on this session carry: the selected header's, or the machine login's. */
async function currentAccessToken($: EngineInterface, active: ActiveAccount | null): Promise<string | undefined> {
  if (active) return headerToken(await $.env.get('ANTHROPIC_CUSTOM_HEADERS'))
  const login = await loginToken($)
  return 'token' in login ? login.token : undefined
}

async function variable($: EngineInterface, name: EnvName): Promise<string | undefined> {
  switch (name) {
    case 'HOME':
      return $.env.get('HOME')
    case 'USER':
      return $.env.get('USER')
    case 'OS':
      return $.env.get('OS')
    case 'USERPROFILE':
      return $.env.get('USERPROFILE')
    case 'USERNAME':
      return $.env.get('USERNAME')
    case 'SystemRoot':
      return $.env.get('SystemRoot')
    case 'WINDIR':
      return $.env.get('WINDIR')
    case 'CLAUDE_CODE_FORCE_WINDOWS_CREDMAN':
      return $.env.get('CLAUDE_CODE_FORCE_WINDOWS_CREDMAN')
    case 'CLAUDE_CONFIG_DIR':
      return $.env.get('CLAUDE_CONFIG_DIR')
    case 'CLAUDE_SECURESTORAGE_CONFIG_DIR':
      return $.env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR')
  }
}

async function getManaged($: EngineInterface, name: Managed): Promise<string | undefined> {
  switch (name) {
    case 'ANTHROPIC_API_KEY':
      return $.env.get('ANTHROPIC_API_KEY')
    case 'ANTHROPIC_AUTH_TOKEN':
      return $.env.get('ANTHROPIC_AUTH_TOKEN')
    case 'ANTHROPIC_CUSTOM_HEADERS':
      return $.env.get('ANTHROPIC_CUSTOM_HEADERS')
    case 'CLAUDE_CODE_OAUTH_TOKEN':
      return $.env.get('CLAUDE_CODE_OAUTH_TOKEN')
    case 'CLAUDE_SECURESTORAGE_CONFIG_DIR':
      return $.env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR')
    case 'ANTHROPIC_BASE_URL':
      return $.env.get('ANTHROPIC_BASE_URL')
    case 'CLAUDE_CODE_USE_BEDROCK':
      return $.env.get('CLAUDE_CODE_USE_BEDROCK')
    case 'CLAUDE_CODE_USE_VERTEX':
      return $.env.get('CLAUDE_CODE_USE_VERTEX')
    case 'CLAUDE_CODE_USE_FOUNDRY':
      return $.env.get('CLAUDE_CODE_USE_FOUNDRY')
    case 'CLAUDE_CODE_USE_ANTHROPIC_AWS':
      return $.env.get('CLAUDE_CODE_USE_ANTHROPIC_AWS')
    case 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD':
      return $.env.get('CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD')
    case 'CLAUDE_CODE_USE_MANTLE':
      return $.env.get('CLAUDE_CODE_USE_MANTLE')
    case 'CLAUDE_CODE_USE_GATEWAY':
      return $.env.get('CLAUDE_CODE_USE_GATEWAY')
    case 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR':
      return $.env.get('CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR')
    case 'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR':
      return $.env.get('CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR')
    case 'CLAUDE_BG_AUTH_SNAPSHOT_PATH':
      return $.env.get('CLAUDE_BG_AUTH_SNAPSHOT_PATH')
    case 'CLAUDE_CODE_HOST_CREDS_FILE':
      return $.env.get('CLAUDE_CODE_HOST_CREDS_FILE')
    case 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST':
      return $.env.get('CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST')
    case 'CLAUDE_CODE_HOST_AUTH_ENV_VAR':
      return $.env.get('CLAUDE_CODE_HOST_AUTH_ENV_VAR')
    case 'AWS_PROFILE':
      return $.env.get('AWS_PROFILE')
    case 'AWS_REGION':
      return $.env.get('AWS_REGION')
    case 'AWS_BEARER_TOKEN_BEDROCK':
      return $.env.get('AWS_BEARER_TOKEN_BEDROCK')
    case 'ANTHROPIC_BEDROCK_BASE_URL':
      return $.env.get('ANTHROPIC_BEDROCK_BASE_URL')
    case 'ANTHROPIC_VERTEX_PROJECT_ID':
      return $.env.get('ANTHROPIC_VERTEX_PROJECT_ID')
    case 'CLOUD_ML_REGION':
      return $.env.get('CLOUD_ML_REGION')
    case 'ANTHROPIC_VERTEX_BASE_URL':
      return $.env.get('ANTHROPIC_VERTEX_BASE_URL')
    case 'ANTHROPIC_FOUNDRY_RESOURCE':
      return $.env.get('ANTHROPIC_FOUNDRY_RESOURCE')
    case 'ANTHROPIC_FOUNDRY_BASE_URL':
      return $.env.get('ANTHROPIC_FOUNDRY_BASE_URL')
    case 'ANTHROPIC_FOUNDRY_API_KEY':
      return $.env.get('ANTHROPIC_FOUNDRY_API_KEY')
  }
}

async function setManaged($: EngineInterface, name: Managed, value: string | undefined): Promise<unknown> {
  switch (name) {
    case 'ANTHROPIC_API_KEY':
      return $.env.set('ANTHROPIC_API_KEY', value)
    case 'ANTHROPIC_AUTH_TOKEN':
      return $.env.set('ANTHROPIC_AUTH_TOKEN', value)
    case 'ANTHROPIC_CUSTOM_HEADERS':
      return $.env.set('ANTHROPIC_CUSTOM_HEADERS', value)
    case 'CLAUDE_CODE_OAUTH_TOKEN':
      return $.env.set('CLAUDE_CODE_OAUTH_TOKEN', value)
    case 'CLAUDE_SECURESTORAGE_CONFIG_DIR':
      return $.env.set('CLAUDE_SECURESTORAGE_CONFIG_DIR', value)
    case 'ANTHROPIC_BASE_URL':
      return $.env.set('ANTHROPIC_BASE_URL', value)
    case 'CLAUDE_CODE_USE_BEDROCK':
      return $.env.set('CLAUDE_CODE_USE_BEDROCK', value)
    case 'CLAUDE_CODE_USE_VERTEX':
      return $.env.set('CLAUDE_CODE_USE_VERTEX', value)
    case 'CLAUDE_CODE_USE_FOUNDRY':
      return $.env.set('CLAUDE_CODE_USE_FOUNDRY', value)
    case 'CLAUDE_CODE_USE_ANTHROPIC_AWS':
      return $.env.set('CLAUDE_CODE_USE_ANTHROPIC_AWS', value)
    case 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD':
      return $.env.set('CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', value)
    case 'CLAUDE_CODE_USE_MANTLE':
      return $.env.set('CLAUDE_CODE_USE_MANTLE', value)
    case 'CLAUDE_CODE_USE_GATEWAY':
      return $.env.set('CLAUDE_CODE_USE_GATEWAY', value)
    case 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR':
      return $.env.set('CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', value)
    case 'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR':
      return $.env.set('CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR', value)
    case 'CLAUDE_BG_AUTH_SNAPSHOT_PATH':
      return $.env.set('CLAUDE_BG_AUTH_SNAPSHOT_PATH', value)
    case 'CLAUDE_CODE_HOST_CREDS_FILE':
      return $.env.set('CLAUDE_CODE_HOST_CREDS_FILE', value)
    case 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST':
      return $.env.set('CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', value)
    case 'CLAUDE_CODE_HOST_AUTH_ENV_VAR':
      return $.env.set('CLAUDE_CODE_HOST_AUTH_ENV_VAR', value)
    case 'AWS_PROFILE':
      return $.env.set('AWS_PROFILE', value)
    case 'AWS_REGION':
      return $.env.set('AWS_REGION', value)
    case 'AWS_BEARER_TOKEN_BEDROCK':
      return $.env.set('AWS_BEARER_TOKEN_BEDROCK', value)
    case 'ANTHROPIC_BEDROCK_BASE_URL':
      return $.env.set('ANTHROPIC_BEDROCK_BASE_URL', value)
    case 'ANTHROPIC_VERTEX_PROJECT_ID':
      return $.env.set('ANTHROPIC_VERTEX_PROJECT_ID', value)
    case 'CLOUD_ML_REGION':
      return $.env.set('CLOUD_ML_REGION', value)
    case 'ANTHROPIC_VERTEX_BASE_URL':
      return $.env.set('ANTHROPIC_VERTEX_BASE_URL', value)
    case 'ANTHROPIC_FOUNDRY_RESOURCE':
      return $.env.set('ANTHROPIC_FOUNDRY_RESOURCE', value)
    case 'ANTHROPIC_FOUNDRY_BASE_URL':
      return $.env.set('ANTHROPIC_FOUNDRY_BASE_URL', value)
    case 'ANTHROPIC_FOUNDRY_API_KEY':
      return $.env.set('ANTHROPIC_FOUNDRY_API_KEY', value)
  }
}

/** Sets one managed variable and reads it back; a refusal or a value that did not stick throws. */
/** A refusal text that may echo the value it was asked to set, with that value and any bearer removed. */
function redacted(text: string, value: string | undefined): string {
  const hidden = value && value.length >= 8 ? text.split(value).join('[value]') : text
  return hidden.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
}

async function setManagedChecked($: EngineInterface, name: Managed, value: string | undefined): Promise<void> {
  let refusal: string | undefined
  try {
    const outcome = await setManaged($, name, value)
    // The engine holds a write it will not make by resolving with a reason.
    if (typeof outcome === 'object' && outcome !== null && 'deny' in outcome && typeof outcome.deny === 'string') refusal = outcome.deny
  } catch (error) { refusal = message(error) }
  if (refusal !== undefined) refusal = redacted(refusal, value)
  if (refusal !== undefined || (await getManaged($, name)) !== value) {
    throw new Error(`Claude refused the session environment change for ${name}${refusal ? ` (${refusal.replace(/\.$/, '')})` : ''}. The account was not switched.`)
  }
}

function machineIo($: EngineInterface): Io {
  return {
    run: (argv, init) => $.process.run(argv, init),
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    exists: path => $.fs.exists(path),
    stat: path => $.fs.stat(path),
    env: name => variable($, name),
    now: () => $.clock.now(),
    sleep: ms => $.clock.sleep(ms),
    fetch: (url, init) => $.http.fetch(url, init),
    log: text => $.ui.log(text, { to: 'debug' }),
  }
}

async function machineOf($: EngineInterface): Promise<Machine> {
  const configDir = await variable($, 'CLAUDE_CONFIG_DIR')
  const windows = await variable($, 'OS') === 'Windows_NT'
  const home = (windows ? await variable($, 'USERPROFILE') : undefined) || await variable($, 'HOME')
  if (!configDir && !home) {
    throw new Error(`Rice Accounts cannot find the Claude configuration folder: ${windows ? 'USERPROFILE' : 'HOME'} and CLAUDE_CONFIG_DIR are both unset. Start Claude with one of them set.`)
  }
  const originals = (await read($, originalsAtom)) ?? local.mirror.originals

  return {
    claudeDir: configDir || `${home}/.claude`,
    user: (windows ? await variable($, 'USERNAME') : undefined) ?? await variable($, 'USER'),
    storage: { configDir: configDir || undefined, secureStorageDir: originals ? originals.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? undefined : await variable($, 'CLAUDE_SECURESTORAGE_CONFIG_DIR') },
  }
}

function oauthNames(config: Config): string[] {
  return Object.entries(config.accounts).filter(([, account]) => (KINDS as readonly string[]).includes(account.kind)).map(([name]) => name)
}

async function loadConfig($: EngineInterface): Promise<{ config: Config; problems: string[] }> {
  const paths = pathsFor((await machineOf($)).claudeDir)
  if (!(await $.fs.exists(paths.config))) {
    local.knownNames = [LOGIN_NAME]
    return { config: defaultConfig(), problems: [] }
  }
  const loaded = parseConfig(await $.fs.read(paths.config))
  local.knownNames = oauthNames(loaded.config)

  return loaded
}

/** Defaults stand in for a file that does not parse; writing them would discard every saved entry. */
async function writableConfig($: EngineInterface): Promise<Config> {
  const { config, problems } = await loadConfig($)
  const unparsed = problems.find(problem => problem.startsWith(UNPARSED_CONFIG))
  if (unparsed) throw new Error(`${unparsed}. Repair accounts.json first; it was left unchanged.`)
  return config
}

/**
 * Reads, changes and writes accounts.json under a lock beside it, so two
 * sessions editing at once cannot lose each other's change. The file is read
 * again inside the lock; `edit` decides from that copy.
 */
async function editConfig<T>($: EngineInterface, edit: (config: Config) => { config?: Config; result: T }): Promise<T> {
  const machine = await machineOf($)
  const paths = pathsFor(machine.claudeDir)
  // A file that does not parse is refused before any lock is taken.
  await writableConfig($)
  return withLock(machineIo($), `${paths.config}.lock`, { staleMs: 30_000, tries: 20 }, async () => {
    const config = await writableConfig($)
    const edited = edit(config)
    if (edited.config && edited.config !== config) {
      await $.fs.write(paths.config, serializeConfig(edited.config))
      local.knownNames = oauthNames(edited.config)
    }
    return edited.result
  })
}

/** The managed variables as this process started, taken once and kept across reloads and /clear. */
async function originalsOf($: EngineInterface): Promise<Originals> {
  const kept = (await read($, originalsAtom)) ?? local.mirror.originals
  if (kept) {
    if (!local.mirror.originals) local.mirror = { ...local.mirror, originals: kept }
    if (!(await read($, originalsAtom))) await update($, originalsAtom, () => kept)

    return kept as Originals
  }
  const taken = {} as Originals
  for (const name of MANAGED) taken[name] = (await getManaged($, name)) ?? null
  // A lockout leaves its placeholder bearer in the header; it is not a launch value.
  if (headerToken(taken.ANTHROPIC_CUSTOM_HEADERS ?? undefined) === LOCKOUT_BEARER) taken.ANTHROPIC_CUSTOM_HEADERS = withoutAuthHeaders(taken.ANTHROPIC_CUSTOM_HEADERS ?? undefined) ?? null
  local.mirror = { ...local.mirror, originals: taken }
  await update($, originalsAtom, () => taken)

  return taken
}

/**
 * The machine login's OAuth token for usage and profile lookups, or why there
 * is none: one rule for every caller, in native precedence (an API key or a
 * provider has no subscription usage; a launch CLAUDE_CODE_OAUTH_TOKEN comes
 * before the stored /login, which is read only when nothing else was given).
 */
async function loginToken($: EngineInterface): Promise<{ token: string } | { problem: string }> {
  const source = await loginSource($)
  if (source.kind === 'not-oauth') return { problem: NOT_OAUTH_LOGIN }
  if (source.kind === 'launch-token') return { token: source.token }
  const machine = await machineOf($)
  const stored = await readLogin(machineIo($), { storage: machine.storage, defaultConfigDir: machine.claudeDir, user: machine.user })
  return stored ? { token: stored.claudeAiOauth.accessToken } : { problem: 'This machine has no saved Claude OAuth login. Run claude auth login in a terminal.' }
}

/**
 * How the machine login authenticates, from the launch values. Read-only, so
 * a render hook (the account picker) may ask: until the launch values are
 * kept, nothing has changed the environment, which then still holds them.
 */
async function loginSource($: EngineInterface): Promise<LoginSource> {
  const kept = (await read($, originalsAtom)) ?? local.mirror.originals
  if (kept) return loginSourceOf(kept as Originals)
  const current = {} as Originals
  for (const name of MANAGED) current[name] = (await getManaged($, name)) ?? null
  return loginSourceOf(current)
}

function snapshotOf(account: AccountConfig): AccountSnapshot | undefined {
  if (account.kind !== 'claudeai' && account.kind !== 'claudeai-token') return undefined
  return {
    kind: account.kind,
    ...(account.loginDir ? { loginDir: account.loginDir } : {}),
    ...(account.secret ? { secret: { service: account.secret.service, account: account.secret.account } } : {}),
    ...(account.label ? { label: account.label } : {}),
  }
}

/** The kept account of a switch, when the state holds a usable one (state written by 0.4.1 holds none). */
function keptAccount(active: ActiveAccount | null | undefined): AccountConfig | undefined {
  const kept = active?.account
  if (!kept || kept.kind !== 'claudeai' && kept.kind !== 'claudeai-token') return undefined
  if (kept.kind === 'claudeai' && typeof kept.loginDir !== 'string') return undefined
  if (kept.kind === 'claudeai-token' && (typeof kept.secret?.service !== 'string' || typeof kept.secret.account !== 'string')) return undefined
  return { kind: kept.kind, loginDir: kept.loginDir, secret: kept.secret, label: kept.label }
}

/** The session account's configuration: the copy taken when it was selected, else the machine login. */
function sessionAccount(): { name: string; account: AccountConfig | undefined } {
  const active = local.mirror.active
  if (!active) return { name: LOGIN_NAME, account: { kind: 'login' } }
  return { name: active.name, account: keptAccount(active) }
}

/**
 * The unconfirmed-account problem: this module's, or, until `session.start`
 * has taken the kept state back, one a previous load left in `$.state`.
 */
async function lockoutProblem($: EngineInterface): Promise<string | undefined> {
  if (local.transitionProblem || local.isStarted) return local.transitionProblem
  const kept: unknown = await read($, problemAtom)
  if (kept === null || kept === undefined) return undefined
  // A stored lockout that is not text is damaged state: stay locked rather than guess.
  return typeof kept === 'string' && kept !== '' ? kept : ACCOUNT_RECOVERY
}

/** Locks the session account out until a verified selection: kept in `$.state` so a reload keeps it. */
async function enterLockout($: EngineInterface, problem: string): Promise<void> {
  local.transitionProblem = problem
  local.accountReport = undefined
  // A lookup begun before the lockout must not overwrite its status.
  local.commitAttempts += 1
  await neutralizeBearer($)
  local.renewal?.cancel()
  local.renewal = undefined
  $.ui.status(LOCKOUT_STATUS)
  try { await update($, problemAtom, () => problem) } catch (error) { $.ui.log(`The account lockout could not be kept for a reload: ${message(error)}`, { to: 'debug' }) }
}

/**
 * While the account is unconfirmed, requests that no hook sees (the permission
 * classifier, titles, MCP servers, other tools) must not go out on a bearer
 * nobody confirmed: the generated bearer line becomes one no server accepts.
 * Best effort; a verified switch or `login` sets the real headers again.
 */
async function neutralizeBearer($: EngineInterface): Promise<void> {
  try {
    const headers = await $.env.get('ANTHROPIC_CUSTOM_HEADERS')
    if (!headerToken(headers) || headerToken(headers) === LOCKOUT_BEARER) return
    await $.env.set('ANTHROPIC_CUSTOM_HEADERS', oauthHeaders(headers, LOCKOUT_BEARER))
  } catch (error) {
    $.ui.log(`The unconfirmed bearer could not be neutralized: ${message(error)}`, { to: 'debug' })
  }
}

async function leaveLockout($: EngineInterface): Promise<void> {
  local.transitionProblem = undefined
  try {
    if (await read($, problemAtom)) await update($, problemAtom, () => null)
  } catch (error) { $.ui.log(`The cleared account lockout could not be kept for a reload: ${message(error)}`, { to: 'debug' }) }
}

async function keepAuthorizations($: EngineInterface): Promise<void> {
  try { await update($, authorizationsAtom, () => local.authorizations.snapshot()) } catch (error) { $.ui.log(`The authorization table could not be kept for a reload: ${message(error)}`, { to: 'debug' }) }
}

function reportStatus(report: AccountReport): string {
  const limits = report.rateLimits.map(limit => `${limit.kind === 'five_hour' ? '5h' : limit.kind === 'seven_day' ? 'wk' : limit.kind} ${Math.round(limit.percentUsed)}%`).join(', ')
  return `account ${report.name} | ${report.email} | ${report.tier}${limits ? ` | ${limits}${report.isStale ? ' (stale)' : ''}` : ''}${report.problem ? ` | ${report.problem}` : ''}`
}

function withReportedLimits<T>(result: T, rateLimits: ReportedLimit[]): T {
  if (typeof result !== 'object' || result === null || !('value' in result) || typeof result.value !== 'object' || result.value === null) return result
  return { ...result, value: { ...result.value, rateLimits } }
}

function reportedLimits(text: string): ReportedLimit[] {
  return parseUsage(JSON.parse(text)).map(limit => ({
    kind: limit.label === '5h' ? 'five_hour' : limit.label === 'wk' ? 'seven_day' : limit.label,
    percentUsed: limit.percent,
    ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}),
  }))
}

/** Which selection a piece of report work belongs to; it is applied only while that selection still stands. */
type Selection = { name: string; generation: number; attempt: number }

function selection(): Selection {
  return { name: local.mirror.active?.name ?? LOGIN_NAME, generation: local.transitionGeneration, attempt: local.commitAttempts }
}

function isCurrent(taken: Selection): boolean {
  return !local.committingAccount && taken.generation === local.transitionGeneration && taken.attempt === local.commitAttempts && taken.name === (local.mirror.active?.name ?? LOGIN_NAME)
}

/**
 * Looks up the selected account's identity and usage for the status line and
 * `session.usage`. Never rejects: every failure becomes the report's problem.
 * A lookup begun for A can finish after B was selected, so the result is
 * applied only while the selection it was begun for still stands.
 */
async function refreshReport($: EngineInterface, taken: Selection, account: AccountConfig, secret?: string): Promise<void> {
  const previous = local.accountReport?.name === taken.name ? local.accountReport : undefined
  let identity = { email: previous?.email ?? 'Unknown', tier: previous?.tier ?? 'Unknown' }
  let rateLimits: ReportedLimit[] = [], problem: string | undefined
  try {
    const machine = await machineOf($)
    identity = await accountIdentity(machineIo($), account, machine, account.kind === 'login' ? await loginSource($) : undefined)
    let token = secret
    if (account.kind === 'login') {
      const login = await loginToken($)
      if ('problem' in login) problem = 'usage unavailable for this login'
      else token = login.token
    }
    if (!problem) {
      if (!token) problem = 'usage unavailable'
      else {
        local.usageCheckedAt = await $.clock.now()
        const response = await $.http.fetch(USAGE_URL, oauthInit({ token }))
        if (!response.ok) problem = `usage unavailable (HTTP ${response.status})`
        else {
          try { rateLimits = reportedLimits(response.text) } catch { problem = 'usage unavailable (the usage response did not parse)' }
        }
      }
    }
  } catch (error) {
    problem = `usage unavailable (${message(error).replace(/\.$/, '')})`
  }
  if (!isCurrent(taken)) return
  // A failed lookup keeps the limits already shown, marked stale, rather than blanking them.
  local.accountReport = problem !== undefined && previous && previous.rateLimits.length > 0
    ? { ...previous, generation: taken.generation, ...identity, isStale: true, problem: problem.replace(/^usage unavailable/, 'usage not refreshed') }
    : { name: taken.name, generation: taken.generation, ...identity, rateLimits, problem }
  $.ui.status(reportStatus(local.accountReport))
}

/** After a main-loop turn: at most one usage lookup a minute, none while nonessential traffic is off. */
async function refreshAfterTurn($: EngineInterface): Promise<void> {
  const report = local.accountReport
  if (!report || local.transitionProblem || local.committingAccount) return
  const now = await $.clock.now()
  const isLoading = report.problem === LOADING_USAGE
  if (!isLoading && local.usageCheckedAt !== undefined && now - local.usageCheckedAt < USAGE_REFRESH_MS) return
  if (await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')) return
  const taken = selection()
  const { account } = sessionAccount()
  if (!account) return
  const token = account.kind === 'login' ? undefined : await currentAccessToken($, local.mirror.active)
  if (!isCurrent(taken)) return
  local.usageCheckedAt = now
  await refreshReport($, taken, account, token)
}

function scheduleRenewal($: EngineInterface, name: string, wait: number): void {
  local.renewal?.cancel()
  local.renewal = $.clock.after(Math.max(1_000, wait), () => {
    void renewIfActive($, name)
  })
}

function scheduleExpiry($: EngineInterface, name: string, now: number): void {
  local.renewal?.cancel()
  local.renewal = undefined
  if (local.expiresAt === undefined) return
  scheduleRenewal($, name, Math.max(30_000, local.expiresAt - EXPIRY_MARGIN_MS - now))
}

/**
 * Renews the session account's credential before it expires. A failure backs
 * off per account (30 s doubling to 10 minutes, reset by a success) and tells
 * the person once per run of failures.
 */
async function renewIfActive($: EngineInterface, name: string): Promise<void> {
  if (local.transitionProblem || local.mirror.active?.name !== name) return
  const now = await $.clock.now()
  const failure = local.renewalFailures.get(name)
  if (failure && now < failure.retryAt) return
  try {
    await switchTo($, name, true)
    local.renewalFailures.delete(name)
  } catch (error) {
    const streak = (failure?.streak ?? 0) + 1
    const wait = Math.min(RENEWAL_BACKOFF_MAX_MS, RENEWAL_BACKOFF_MS * 2 ** (streak - 1))
    local.renewalFailures.set(name, { streak, retryAt: now + wait })
    $.ui.log(`Could not renew ${name}: ${message(error)} Next attempt in ${Math.round(wait / 1000)} s.`, { to: 'debug' })
    if (streak === 1) $.ui.toast(`Rice Accounts could not renew ${name}: ${message(error).replace(/\.$/, '')}. It retries in the background.`)
    if (local.mirror.active?.name === name && !local.transitionProblem) scheduleRenewal($, name, wait)
  }
}

/**
 * Puts this process on an account: its secret read, the managed variables
 * set, the state and status updated. `isQuiet` renews or restores the
 * account the session holds, from the copy taken when it was selected.
 */
async function switchTo($: EngineInterface, name: string, isQuiet = false, expectedSelection?: number): Promise<string> {
  const sequence = isQuiet ? expectedSelection ?? local.committedSelection : ++local.selections
  let account = isQuiet && local.mirror.active?.name === name ? keptAccount(local.mirror.active) : undefined
  if (!account) {
    const { config, problems } = await loadConfig($)
    account = config.accounts[name]
    if (!account) {
      const extra = problems.length > 0 ? ` (accounts.json: ${problems.join('; ')})` : ''
      throw new Error(`No account named ${name}. Saved: ${oauthNames(config).join(', ')}${extra}.`)
    }
  }
  if (!(KINDS as readonly string[]).includes(account.kind)) throw new Error('Rice Accounts switches Anthropic OAuth accounts only. Configure provider accounts in rice-multi-models. This saved entry was kept.')
  const machine = await machineOf($)
  const originals = await originalsOf($)
  const material = await materialFor(machineIo($), name, account, pathsFor(machine.claudeDir), machine)
  // Credential refresh may finish after the person selected another account.
  // Prepare in parallel, then serialize environment/state commits and reject old work.
  const preceding = local.commitTail
  let releaseCommit = () => {}
  local.commitTail = new Promise<void>(resolve => { releaseCommit = resolve })
  await preceding
  let taken = selection()
  let keepsReport = false
  try {
    if (isQuiet ? local.committedSelection !== sequence || local.mirror.active?.name !== name : sequence < local.committedSelection) {
      if (isQuiet) return ''
      throw new Error('Another account choice superseded this switch. The newer selection was kept.')
    }
    // A renewal keeps the account and its report; only a new selection reports afresh.
    keepsReport = isQuiet && local.accountReport?.name === name && local.accountReport.problem !== LOADING_USAGE
    const plan = planEnv(account, material.secret, originals)
    const previous = {
      mirror: local.mirror, active: (await read($, activeAtom)) ?? null, expiresAt: local.expiresAt,
      report: local.accountReport, problem: local.transitionProblem,
    }
    local.committingAccount = true
    local.commitAttempts += 1
    const precedingValues = new Map<Managed, string | undefined>()
    let stateAttempted = false, timerChanged = false
    try {
      for (const variableName of MANAGED) {
        const before = await getManaged($, variableName)
        if (before === plan[variableName]) continue
        precedingValues.set(variableName, before)
        await setManagedChecked($, variableName, plan[variableName])
      }
      const now = await $.clock.now()
      const snapshot = snapshotOf(account)
      const active: ActiveAccount | null = name === LOGIN_NAME ? null : { name, switchedAt: now, ...(snapshot ? { account: snapshot } : {}) }
      stateAttempted = true
      await update($, activeAtom, () => active)
      const saved = await read($, activeAtom)
      if ((saved?.name ?? null) !== (active?.name ?? null) || saved?.switchedAt !== active?.switchedAt) throw new Error('Claude refused the session account state change. The account was not switched.')
      local.mirror = { ...local.mirror, active }
      local.expiresAt = material.expiresAt
      timerChanged = true
      scheduleExpiry($, name, now)
    } catch (error) {
      const rollbackProblems: string[] = []
      local.mirror = previous.mirror
      local.expiresAt = previous.expiresAt
      local.accountReport = previous.report
      local.transitionProblem = previous.problem
      if (stateAttempted) {
        try {
          await update($, activeAtom, () => previous.active)
          const saved = await read($, activeAtom)
          if ((saved?.name ?? null) !== (previous.active?.name ?? null) || saved?.switchedAt !== previous.active?.switchedAt) rollbackProblems.push('account state')
        } catch { rollbackProblems.push('account state') }
      }
      for (const [variableName, before] of [...precedingValues.entries()].reverse()) {
        try { await setManagedChecked($, variableName, before) } catch { rollbackProblems.push(variableName) }
      }
      if (timerChanged) {
        try { scheduleExpiry($, previous.mirror.active?.name ?? LOGIN_NAME, await $.clock.now()) } catch { rollbackProblems.push('renewal timer') }
      }
      if (rollbackProblems.length > 0) {
        await enterLockout($, ACCOUNT_RECOVERY)
        throw new Error(`${message(error)} Rollback could not restore ${rollbackProblems.join(', ')}. ${ACCOUNT_RECOVERY}`)
      }
      $.ui.status(previous.report ? reportStatus(previous.report) : undefined)
      throw error
    }
    // Committed: everything after this point reports, and never fails the switch.
    local.transitionGeneration += 1
    local.committedSelection = Math.max(local.committedSelection, sequence)
    if (local.transitionProblem) await leaveLockout($)
    taken = { name, generation: local.transitionGeneration, attempt: local.commitAttempts }
    local.accountReport = keepsReport && local.accountReport
      ? { ...local.accountReport, generation: taken.generation }
      : { name, generation: taken.generation, email: 'Loading account', tier: 'Unknown', rateLimits: [], problem: LOADING_USAGE }
    $.ui.status(reportStatus(local.accountReport))
  } finally { local.committingAccount = false; releaseCommit() }
  if (!isQuiet) local.renewalFailures.delete(name)
  if (!keepsReport) await refreshReport($, taken, account, material.secret)
  if (isQuiet) return ''
  if (local.committedSelection !== sequence) return 'A newer account choice superseded this selection. The newer account was kept.'
  const reported = local.accountReport?.name === name && local.accountReport.email !== 'Unknown' ? local.accountReport.email : undefined
  const email = reported ?? await loginEmail(machineIo($), account.loginDir).catch(() => undefined)
  const gateway = await foreignGateway($)
  const notice = gateway ? ` This session sends its requests to ${gateway}, not api.anthropic.com, so that host receives the account's token.` : ''
  return name === LOGIN_NAME
    ? `This session is back on this machine's /login. Other sessions were not touched.`
    : `This session now uses ${name} (${account.kind}${email ? `, ${email}` : ''}) from its next request, for its subagents and any claude -p it starts. Other sessions keep their own account.${notice}`
}

/** The host this session sends requests to when it is not Anthropic's own API (a gateway), else undefined. */
async function foreignGateway($: EngineInterface): Promise<string | undefined> {
  const base = await $.env.get('ANTHROPIC_BASE_URL')
  if (!base) return undefined
  try {
    const host = new URL(base).host
    return host && host !== 'api.anthropic.com' ? host : undefined
  } catch { return 'an address Claude could not parse' }
}

/**
 * After a reload (state kept) or a /clear (module kept), the account this
 * process holds is put back in both. Fail closed: when it cannot be put back,
 * requests stay refused until a verified selection rather than leaving the
 * environment on an account the reports do not show.
 */
async function restore($: EngineInterface): Promise<void> {
  if (await lockoutProblem($)) return
  // A selection the person commits while this restore awaits must not be undone by it.
  const startedAt = local.committedSelection
  let kept: ActiveAccount | null = null
  try {
    const saved = await read($, activeAtom)
    kept = saved ?? local.mirror.active
    if (!kept) {
      // The machine login: take the launch values now, before anything changes them.
      await originalsOf($).catch(error => $.ui.log(`The launch environment was not recorded yet: ${message(error)}`, { to: 'debug' }))
      return
    }
    await originalsOf($)
    if (local.committedSelection !== startedAt) return
    if (!saved) await update($, activeAtom, () => kept)
    local.mirror = { ...local.mirror, active: kept }
    await switchTo($, kept.name, true, startedAt)
  } catch (error) {
    if (local.committedSelection !== startedAt) return
    const problem = `The session account${kept ? ` ${kept.name}` : ''} could not be put back (${message(error).replace(/\.$/, '')}). ${ACCOUNT_RECOVERY}`
    await enterLockout($, problem)
    $.ui.toast(problem)
  }
}

function formatLimits(limits: { label: string; percent: number; resetsAt?: string }[]): string {
  if (limits.length === 0) return 'No usage windows were reported.'

  return limits
    .map(limit => {
      const at = limit.resetsAt ? new Date(limit.resetsAt) : undefined
      const when = at && !Number.isNaN(at.getTime()) ? `, resets ${at.toLocaleString()}` : ''

      return `${limit.label} ${Math.round(limit.percent)}%${when}`
    })
    .join('\n')
}

async function usageText($: EngineInterface): Promise<string> {
  const problem = await lockoutProblem($)
  if (problem) return problem
  const taken = selection()
  const { name, account: kept } = sessionAccount()
  const account = kept ?? (await loadConfig($)).config.accounts[name]
  if (!account) return `No account named ${name}.`
  if (!(KINDS as readonly string[]).includes(account.kind)) return 'Rice Accounts supports Anthropic OAuth accounts only. This provider entry is retained for compatibility; use rice-multi-models for providers.'
  let token: string
  if (account.kind === 'login') {
    const login = await loginToken($)
    if ('problem' in login) return login.problem
    token = login.token
  } else {
    const machine = await machineOf($)
    const material = await materialFor(machineIo($), name, account, pathsFor(machine.claudeDir), machine)
    if (!material.secret) return `${name} has no token. Run /rice-account setup ${name}.`
    token = material.secret
  }
  local.usageCheckedAt = await $.clock.now()
  const response = await $.http.fetch(USAGE_URL, oauthInit({ token }))
  if (!response.ok) return `${name}: the usage lookup answered HTTP ${response.status}${account.kind === 'claudeai-token' ? ' (setup tokens may not reach it)' : ''}.`
  const body: unknown = JSON.parse(response.text)
  const report = local.accountReport
  if (report && report.name === name && isCurrent(taken)) {
    local.accountReport = { ...report, rateLimits: reportedLimits(response.text), isStale: false, problem: undefined }
    $.ui.status(reportStatus(local.accountReport))
  }

  return `${name} usage:\n${formatLimits(parseUsage(body))}`
}

function selectedReportProblem(detail: string | undefined): string {
  return local.transitionProblem ?? `The selected session account report is unavailable${detail ? ` (${detail.replace(/\.$/, '')})` : ''}. The machine login was not reported in its place. Retry, or run /rice-account check.`
}

async function statusText($: EngineInterface): Promise<string> {
  const problem = await lockoutProblem($)
  if (problem) return problem
  const [version, model, cwd] = await Promise.all([$.session.version(), $.session.model(), $.session.cwd()])
  const report = local.accountReport
  const name = local.mirror.active?.name ?? LOGIN_NAME
  const selected = report && report.name === name
    ? `Session account: ${report.name}\nEmail: ${report.email}\nPlan: ${report.tier}`
    : name === LOGIN_NAME ? 'Session account: machine login' : `Session account: ${name}\nEmail: loading\nPlan: loading`
  return `${selected}\nClaude Code: ${version.version}\nModel: ${model}\nWorking directory: ${cwd}\n\n${await usageText($)}\n\nRice Accounts reports this session selection. The machine login is unchanged.`
}

async function checkText($: EngineInterface, name: string): Promise<string> {
  const { config } = await loadConfig($)
  const current = sessionAccount()
  const account = name === current.name && current.account ? current.account : config.accounts[name]
  if (!account) return `No account named ${name}.`
  if (!(KINDS as readonly string[]).includes(account.kind)) return 'Rice Accounts supports Anthropic OAuth accounts only. This provider entry is retained; use rice-multi-models for providers.'
  if (account.kind === 'login') {
    const login = await loginToken($)
    if ('problem' in login) return `login: ${login.problem}`
    const response = await $.http.fetch(PROFILE_URL, oauthInit({ token: login.token }))
    if (!response.ok) return `login: the profile lookup answered HTTP ${response.status}.`
    return `login: signed in as ${parseProfile(response.text).email}.`
  }
  const machine = await machineOf($)
  const material = await materialFor(machineIo($), name, account, pathsFor(machine.claudeDir), machine)
  const response = await $.http.fetch(PROFILE_URL, oauthInit({ token: material.secret ?? '' }))
  if (!response.ok) return `${name}: token found; the profile lookup answered HTTP ${response.status}.`
  const owner = parseProfile(response.text)

  return `${name}: signed in as ${owner.email}${owner.organizationName ? ` (${owner.organizationName})` : ''}.`
}

async function listText($: EngineInterface): Promise<string> {
  const { config, problems } = await loadConfig($)
  const rows = await accountRows($)
  const lines = rows.map(row => `${row.selected ? '*' : ' '} ${describeAccount(row.name, config.accounts[row.name]!)} | ${row.email} | ${row.tier}${row.selected ? ' [this session]' : ''}`)
  const notes = problems.length > 0 ? `\nSkipped in accounts.json: ${problems.join('; ')}.` : ''

  return `${lines.join('\n')}${notes}\n\n/rice-account <name> switches this session only. /rice-account add <name> [kind] saves another (default: claudeai). /rice-account help lists every subcommand.`
}

async function accountRows($: EngineInterface): Promise<AccountRow[]> {
  const { config } = await loadConfig($)
  const machine = await machineOf($)
  const io = machineIo($)
  const source = await loginSource($)
  const current = local.mirror.active?.name ?? LOGIN_NAME
  return Promise.all(Object.entries(config.accounts).filter(([, account]) => (KINDS as readonly string[]).includes(account.kind)).map(async ([name, account]) => ({
    name, kind: account.kind, selected: name === current, ...await accountIdentity(io, account, machine, source),
  })))
}

function parseOptions(words: readonly string[]): Record<string, string> {
  const options: Record<string, string> = {}
  for (const word of words) {
    const at = word.indexOf('=')
    if (at <= 0 || at === word.length - 1) throw new Error('Expected key=value for each option; credentials are entered in the terminal helper.')
    const key = word.slice(0, at)
    if (!(ADD_OPTIONS as readonly string[]).includes(key)) throw new Error(`Unknown option: ${key}.`)
    if (options[key] !== undefined) throw new Error(`Repeated option: ${key}.`)
    options[key] = word.slice(at + 1)
  }

  return options
}

const PROVIDER_ENTRY = 'Rice Accounts supports Anthropic OAuth accounts only. This provider entry is retained; use rice-multi-models for providers.'

function withPeriod(text: string): string {
  return /[.!?:]$/.test(text.trimEnd()) || text.includes('\n') ? text : `${text.trimEnd()}.`
}

async function platformOf($: EngineInterface): Promise<'win32' | 'posix'> {
  return (await variable($, 'OS')) === 'Windows_NT' ? 'win32' : 'posix'
}

async function runCommand($: EngineInterface, args: string): Promise<string> {
  const parsed = parseCommand(args)
  try {
    switch (parsed.kind) {
      case 'picker':
        if (await openAccountPicker(() => $.ui.open({ id: ACCOUNT_PICKER_ID, title: 'Choose account', focus: true, closeOnEscape: true }))) return 'Choose an account in the account list. This changes only this session.'
        return await listText($)
      case 'help':
        return helpText()
      case 'refused':
        return parsed.text
      case 'list':
        return await listText($)
      case 'usage':
        return await usageText($)
      case 'check':
        return await checkText($, parsed.name ?? local.mirror.active?.name ?? LOGIN_NAME)
      case 'default':
        return await switchTo($, (await loadConfig($)).config.default)
      case 'setup-native':
        return `Use this plugin inside ordinary claude: it installs no launcher. ${legacyCleanupText((await machineOf($)).claudeDir, await platformOf($))}`
      case 'setup': {
        const { config } = await loadConfig($)
        const account = config.accounts[parsed.name]
        if (!account) return `${parsed.name} is not saved. Run /rice-account add ${parsed.name} first.`
        if (!(KINDS as readonly string[]).includes(account.kind)) return PROVIDER_ENTRY
        if (parsed.name === LOGIN_NAME) return 'The built-in login uses this machine\'s Claude Code authentication. Run claude auth login in a terminal.'
        return setupText($.plugin.root, (await machineOf($)).claudeDir, parsed.name, false, await platformOf($))
      }
      case 'add': {
        const [word, ...tail] = parsed.rest
        const kindWord = word !== undefined && !word.includes('=') ? word : undefined
        const usage = `Usage: /rice-account add <name> [kind] [key=value ...]\nDefault kind: claudeai\nKinds: ${KINDS.filter(each => each !== 'login').join(', ')}\nOptions: label=, service= (setup tokens only). Configure provider accounts in rice-multi-models.`
        if (kindWord !== undefined && (kindWord === 'login' || !(KINDS as readonly string[]).includes(kindWord))) return usage
        // Options are checked before accounts.json is locked or read.
        const options = parseOptions(kindWord !== undefined ? tail : parsed.rest)
        const machine = await machineOf($)
        const outcome = await editConfig($, config => {
          const kind: string = kindWord ?? config.accounts[parsed.name]?.kind ?? 'claudeai'
          if (kind === 'login' || !(KINDS as readonly string[]).includes(kind)) return { result: { usage: true, isNew: false } }
          const added = addAccount(config, parsed.name, kind as Kind, options, pathsFor(machine.claudeDir))
          return { config: added.config, result: { usage: false, isNew: !config.accounts[parsed.name] } }
        })
        if (outcome.usage) return usage
        return setupText($.plugin.root, machine.claudeDir, parsed.name, outcome.isNew, await platformOf($))
      }
      case 'remove': {
        const name = parsed.name
        if (local.mirror.active?.name === name) return `${name} is this session's account. Switch to another account first, for example /rice-account login.`
        const refusal = (config: Config): string | undefined => {
          const account = config.accounts[name]
          if (config.legacy && Object.hasOwn(config.legacy, name) || account && !(KINDS as readonly string[]).includes(account.kind)) return 'This provider entry is retained. Rice Accounts manages OAuth accounts only.'
          if (name === LOGIN_NAME) return "This machine's login cannot be removed."
          if (!account) return `No account named ${name}.`
          return undefined
        }
        // Refused before any lock is taken; checked again inside it.
        const early = refusal(await writableConfig($))
        if (early) return early
        const removed = await editConfig($, config => {
          const refused = refusal(config)
          return refused ? { result: { refused, account: undefined } } : { config: removeAccount(config, name), result: { refused, account: config.accounts[name] } }
        })
        if (removed.refused) return removed.refused
        const account = removed.account
        const cleanup =
          account?.kind === 'claudeai'
            ? `\nIts native login is retained. To sign it out in a terminal: ${signOutHint(account.loginDir ?? '', await platformOf($))}`
            : account?.secret
              ? '\nIts credential is retained in the OS keyring. Remove it with your OS credential manager when no account uses it.'
              : ''

        return `Removed ${name} from accounts.json. Sessions already using it keep it until they switch.${cleanup}`
      }
      case 'set-default': {
        const name = parsed.name
        const isUnsaved = (config: Config) => !config.accounts[name] || !(KINDS as readonly string[]).includes(config.accounts[name]!.kind)
        const unsaved = `${name} is not a saved OAuth account. Run /rice-account list to see the saved accounts.`
        if (isUnsaved(await writableConfig($))) return unsaved
        const refused = await editConfig($, config => isUnsaved(config) ? { result: true } : { config: { ...config, default: name }, result: false })
        if (refused) return unsaved
        return `The saved default account is now ${name}. /rice-account default switches this session to it; new sessions still start on this machine's login.`
      }
      case 'switch':
        return await switchTo($, parsed.name)
    }
  } catch (error) {
    return withPeriod(message(error).replace(/^(?:rice-session-accounts:\s*)+/, ''))
  }
}

/**
 * /clear empties `$.state` while the process keeps the selected account's
 * environment and goes on under a new session id with no `session.start`. At
 * that `session.end` the account's name (never a credential) is left in the
 * plugin store; the next prompt puts the state back from memory and removes it.
 * A load that finds it while the state is empty is a reload in between, which
 * can no longer tell the environment's header from a launch value.
 */
const CLEAR_KEY = 'cleared-with-account'
const CLEAR_WINDOW_MS = 15 * 60 * 1000

async function clearedWithAccount($: EngineInterface): Promise<boolean> {
  try {
    const kept = await $.store.get(CLEAR_KEY)
    if (kept === undefined || kept === null) return false
    await $.store.delete(CLEAR_KEY)
    const at = typeof kept === 'object' && kept !== null && 'at' in kept && typeof kept.at === 'number' ? kept.at : 0
    return (await $.clock.now()) - at < CLEAR_WINDOW_MS
  } catch (error) {
    $.ui.log(`The /clear record was not read: ${message(error)}`, { to: 'debug' })
    return false
  }
}

/**
 * What a failed account guard refuses with. A hook that threw or overran
 * cannot say the account is confirmed, so it refuses; one asked in place of a
 * re-entry was never run, and refuses only on a lockout this module holds.
 */
function whenFailed(failure: HookFailure): string | undefined {
  return String(failure.kind) === 're-entry' ? local.transitionProblem : local.transitionProblem ?? ACCOUNT_RECOVERY
}

/** Whether /usage and /status answer for the session selection rather than natively. */
async function reportsSelection($: EngineInterface): Promise<boolean> {
  return Boolean(local.accountReport || await lockoutProblem($) || await activeAccount($))
}

/**
 * Refuses a child `claude` while the session account is unconfirmed. Everything else,
 * and every child while the account is confirmed, passes through unchanged.
 */
function registerLockoutGuard(on: On): void {
  on('process.run', async ($, e, next) => {
    if (argvInvokesClaude(e.argv)) {
      const problem = await lockoutProblem($)
      if (problem) return { deny: problem }
    }
    return next(e)
  }).catch((_host, e, next) => next.called || !argvInvokesClaude(e.argv) ? next(e) : { deny: GUARD_FAILED })

  on('process.spawn', async function* ($, e, next) {
    if (argvInvokesClaude(e.argv)) {
      const problem = await lockoutProblem($)
      if (problem) return { deny: problem }
    }
    return yield* next(e)
  }).catch(async function* (_host, e, next) {
    if (next.called || !argvInvokesClaude(e.argv)) return yield* next(e)
    return { deny: GUARD_FAILED }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (commandInvokesClaude(e.command)) {
      const problem = await lockoutProblem($)
      if (problem) return { deny: problem }
    }
    return next(e)
  }).catch((_host, e, next) => next.called || !commandInvokesClaude(e.command) ? next(e) : { deny: GUARD_FAILED })
}

export const register: Register = on => {
  registerLockoutGuard(on)
  on('ui.render', { component: 'Pane' }, ($, e, next) => {
    if (e.requestId !== ACCOUNT_PICKER_ID) return next(e)
    return renderAccountPicker($.ui.resolve(e), () => accountRows($), name => switchTo($, name), {
      invalidate: () => $.ui.invalidate('ui.render'),
      log: text => $.ui.log(text),
      close: () => $.ui.close({ id: ACCOUNT_PICKER_ID }),
      surface: e.surface,
    })
  })

  on('session.start', async ($, e, next) => {
    // Reached only by a fresh load of this module (first start, reload,
    // respawn, enable; never /clear): start from nothing held in memory, then
    // take the safety state back from `$.state` before anything else runs.
    local.renewal?.cancel()
    local = freshModule()
    let problem: string | null
    try { problem = await read($, problemAtom) } catch (error) { problem = `The kept account state could not be read (${message(error).replace(/\.$/, '')}). ${ACCOUNT_RECOVERY}` }
    local.authorizations.restore(await read($, authorizationsAtom).catch(() => null))
    // A handle another plugin received while this load was starting is kept with the rest.
    const table = local.authorizations.snapshot()
    if (table.native.length > 0 || table.issued.length > 0) await keepAuthorizations($)
    const active = await read($, activeAtom).catch(() => null)
    if (active) local.mirror = { ...local.mirror, active }
    if (problem) {
      local.transitionProblem = problem
      $.ui.status(LOCKOUT_STATUS)
    }
    local.isStarted = true
    // /clear empties `$.state` while the process keeps the selected account's environment; a
    // reload before the next turn then finds a generated bearer it can no longer attribute.
    if (!problem && !active && !(await read($, originalsAtom).catch(() => null)) && await clearedWithAccount($)) {
      await enterLockout($, ACCOUNT_RECOVERY)
      $.ui.toast(ACCOUNT_RECOVERY)
    }
    const started = await next(e)
    // Saved names for the typeahead from the start, not only after a first lookup.
    await loadConfig($).catch(error => $.ui.log(`accounts.json was not read: ${message(error)}`, { to: 'debug' }))
    // Putting the account back comes before anything that could fail without bearing on it.
    await restore($)
    await $.command.register({
      name: 'rice-account',
      description: 'Choose the Claude OAuth account for this session by email and plan, or add, set up and check accounts',
      argumentHint: ARGUMENT_HINT,
    }).catch(error => $.ui.log(`The /rice-account command was not registered: ${message(error)}`, { to: 'debug' }))

    return started
  })

  on('turn.start', async ($, e, next) => {
    // /clear empties the state while this module keeps the account: put it
    // back, and keep a lockout and the authorization table for a later reload.
    if (local.mirror.active && !(await read($, activeAtom))) await restore($)
    await $.store.delete(CLEAR_KEY).catch(() => {})
    if (local.transitionProblem && !(await read($, problemAtom))) await enterLockout($, local.transitionProblem)
    const table = local.authorizations.snapshot()
    if ((table.native.length > 0 || table.issued.length > 0) && !(await read($, authorizationsAtom))) await keepAuthorizations($)
    const active = local.mirror.active
    if (active && !local.transitionProblem && local.expiresAt !== undefined && local.expiresAt - EXPIRY_MARGIN_MS <= (await $.clock.now())) await renewIfActive($, active.name)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' && local.mirror.active) {
      await $.store.set(CLEAR_KEY, { name: local.mirror.active.name, at: await $.clock.now() }).catch(error => $.ui.log(`The /clear record was not kept: ${message(error)}`, { to: 'debug' }))
    }
    return next(e)
  })

  on('command.run', { command: 'rice-account' }, async ($, e) => ({ text: await runCommand($, e.args) }))

  on('session.authorize', async ($, e, next) => {
    const problem = await lockoutProblem($)
    if (problem) return { deny: problem }
    if (!(await activeAccount($))) {
      const result = await next(e)
      if (result.value && local.authorizations.trackNative(next.origin.plugin, result.value.handle)) await keepAuthorizations($)
      return result
    }
    if (local.committingAccount) return { deny: refusalText(ACCOUNT_CHANGING) }
    const active = await activeAccount($)
    if (!(await currentAccessToken($, active))) return { deny: refusalText('The selected session account has no OAuth credential.') }
    if (local.transitionProblem) return { deny: local.transitionProblem }
    if (local.committingAccount || !active) return { deny: refusalText(ACCOUNT_CHANGED) }
    const { authorization, isNew } = local.authorizations.issue(next.origin.plugin)
    if (isNew) await keepAuthorizations($)
    return { value: authorization }
  }).catch((_host, e, next) => next.called ? next(e) : { deny: refusalText(next.error.message) })

  on('http.fetch', async ($, e, next) => {
    const isOwn = next.origin.plugin === PLUGIN
    const problem = await lockoutProblem($)
    const auth = e.init?.auth
    if (problem && !isOwn && (auth !== undefined || /^https:\/\/api\.anthropic\.com(?:[/:?#]|$)/i.test(e.url))) return { deny: problem }
    if (auth === undefined) return next(e)
    const selected = await activeAccount($)
    if (!local.authorizations.recognizes(auth)) {
      // A handle Claude would fill with the machine credential must not reach
      // the network while another account is selected.
      if (selected) return { deny: refusalText(UNKNOWN_HANDLE) }
      return next(e)
    }
    if (!selected && !local.authorizations.owns(auth)) return next(e)
    await local.commitTail
    if (local.transitionProblem && !isOwn) return { deny: local.transitionProblem }
    if (local.committingAccount) throw new Error(ACCOUNT_CHANGING)
    const taken = selection()
    const token = await currentAccessToken($, await activeAccount($))
    const isDisabled = Boolean(await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'))
    if (local.transitionProblem && !isOwn) return { deny: local.transitionProblem }
    if (!isCurrent(taken)) throw new Error(ACCOUNT_CHANGED)
    const init = local.authorizations.prepare(e.url, e.init, next.origin.plugin, token, isDisabled)
    return next({ ...e, init })
  }).catch((_host, e, next) => next.called ? next(e) : { deny: refusalText(next.error.message) })

  on('session.*', async ($, e, next) => {
    const result = await next(e)
    if (String(next.event) !== 'session.usage') return result
    if (await lockoutProblem($)) return withReportedLimits(result, [])
    const active = await activeAccount($)
    const report = local.accountReport
    if (!report && !active) return result
    // Never the machine login's windows while another account is selected.
    if (!report || report.name !== (active?.name ?? LOGIN_NAME)) return withReportedLimits(result, [])
    return withReportedLimits(result, report.rateLimits)
  }).catch(async (_host, e, next) => {
    const result = await next(e)
    return String(next.event) === 'session.usage' ? withReportedLimits(result, []) : result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // Subagents' turns share the main loop's account: one lookup covers them.
    if (e.agentId !== undefined) return result
    await refreshAfterTurn($).catch(error => $.ui.log(`The usage refresh after a turn failed: ${message(error)}`, { to: 'debug' }))
    return result
  })

  // A failed hook is skipped, and the native command would then report the
  // machine account. Answer with the selected account's problem instead.
  on('command.run', { command: 'usage' }, async ($, e, next) => {
    if (!(await reportsSelection($))) return next(e)
    return { text: await usageText($) }
  }).catch((_host, e, next) => next.called ? next(e) : { text: selectedReportProblem(next.error.message) })

  on('command.run', { command: 'status' }, async ($, e, next) => {
    if (!(await reportsSelection($))) return next(e)
    return { text: await statusText($) }
  }).catch((_host, e, next) => next.called ? next(e) : { text: selectedReportProblem(next.error.message) })

  // Every engine event that sends a model request on the session account, or
  // spends it, is refused while the account is unconfirmed. turn.step answers
  // in place of the request; the rest refuse or skip with the lockout text.
  // A guard that fails refuses too (`whenFailed`).
  on('model.*', async ($, e, next) => {
    const problem = await lockoutProblem($)
    return problem ? { deny: problem } : next(e)
  }).catch((_host, e, next) => {
    const problem = next.called ? undefined : whenFailed(next.error)
    return problem ? { deny: problem } : next(e)
  })

  on('session.compact', async ($, e, next) => {
    const problem = await lockoutProblem($)
    return problem ? { skip: problem } : next(e)
  }).catch((_host, e, next) => {
    const problem = next.called ? undefined : whenFailed(next.error)
    return problem ? { skip: problem } : next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const problem = await lockoutProblem($)
    return problem ? { deny: problem } : next(e)
  }).catch((_host, e, next) => {
    const problem = next.called ? undefined : whenFailed(next.error)
    return problem ? { deny: problem } : next(e)
  })

  // WebFetch summarizes with a model request and WebSearch sends one of its own.
  on('tool.call', { tool: 'WebFetch' }, async ($, e, next) => {
    const problem = await lockoutProblem($)
    return problem ? { deny: problem } : next(e)
  }).catch((_host, e, next) => {
    const problem = next.called ? undefined : whenFailed(next.error)
    return problem ? { deny: problem } : next(e)
  })

  on('tool.call', { tool: 'WebSearch' }, async ($, e, next) => {
    const problem = await lockoutProblem($)
    return problem ? { deny: problem } : next(e)
  }).catch((_host, e, next) => {
    const problem = next.called ? undefined : whenFailed(next.error)
    return problem ? { deny: problem } : next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const answer = await lockoutProblem($)
    if (!answer) return yield* next(e)
    yield { kind: 'text', index: 0, text: answer }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
  }).catch(async function* (_host, e, next) {
    const answer = next.called ? undefined : whenFailed(next.error)
    if (!answer) return yield* next(e)
    yield { kind: 'text', index: 0, text: answer }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
  })

  on('prompt.autocomplete', async ($, e, next) => {
    const found = await next(e)
    const rows = completions(e.text, e.start, e.token, local.knownNames, KINDS.filter(kind => kind !== 'login'))
    return rows.length > 0 ? { suggestions: [...found.suggestions, ...rows] } : found
  })
}
