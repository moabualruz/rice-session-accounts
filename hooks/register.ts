import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ActiveAccount, EnvSnapshot } from '../types'
import { loginEmail, materialFor } from './accounts'
import type { Machine } from './accounts'
import { ADD_OPTIONS, addAccount, defaultConfig, describeAccount, KINDS, LOGIN_NAME, parseConfig, pathsFor, removeAccount, serializeConfig, UNPARSED_CONFIG } from './config'
import type { AccountConfig, Config, Kind } from './config'
import { headerToken, MANAGED, planEnv } from './env'
import type { Managed, Originals } from './env'
import type { EnvName, Io } from './io'
import { message } from './io'
import { readLogin } from './credentials'
import { setupText, shellQuote } from './setup'
import { accountIdentity } from './identity'
import { ACCOUNT_PICKER_ID, openAccountPicker, renderAccountPicker } from './picker'
import type { AccountRow } from './picker'
import { registerDescendantAuth } from './descendants'
import { EXPIRY_MARGIN_MS, oauthInit, parseProfile, parseUsage, PROFILE_URL, USAGE_URL } from './oauth'
import { SessionAuthorizations } from './session-auth'

const PLUGIN = 'rice-session-accounts'
const activeAtom = atom({ plugin: 'rice-session-accounts', key: 'active' } as const, null)
const originalsAtom = atom({ plugin: 'rice-session-accounts', key: 'originals' } as const, null)

/**
 * The module's copy of the session state. `$.state` survives a reload and a
 * module variable survives a /clear (which empties the state while this
 * process keeps the account it switched to); each puts the other back.
 */
let mirror: { active: ActiveAccount | null; originals: EnvSnapshot | null } = { active: null, originals: null }
let renewal: Timer | undefined
let expiresAt: number | undefined
let knownNames: string[] = [LOGIN_NAME]
let transitionGeneration = 0
let commitTail: Promise<void> = Promise.resolve()
type ReportedLimit = { kind: string; percentUsed: number; resetsAt?: string }
type AccountReport = { name: string; generation: number; email: string; tier: string; rateLimits: ReportedLimit[]; problem?: string }
let accountReport: AccountReport | undefined
const sessionAuthorizations = new SessionAuthorizations()
let committingAccount = false
let transitionProblem: string | undefined
const ACCOUNT_RECOVERY = 'The session account is not confirmed. Run /rice-account login or select a saved account again before continuing.'
const ACCOUNT_AUTH_RETRY = 'Session account authentication could not be prepared. Retry the request after the account selection completes, or use /rice-account login to recover.'

// Claude 2.1.296 follows `$` only into helpers declared in this module.
async function syncDescendantAuth($: EngineInterface): Promise<void> {
  const token = await currentAccessToken($)
  await setDescendantAuth($, token || undefined)
}

async function currentAccessToken($: EngineInterface): Promise<string | undefined> {
  return mirror.active ? headerToken(await $.env.get('ANTHROPIC_CUSTOM_HEADERS')) : $.env.get('CLAUDE_CODE_OAUTH_TOKEN')
}

function refusedEnvironment(outcome: unknown): boolean {
  return typeof outcome === 'object' && outcome !== null && 'deny' in outcome && typeof outcome.deny === 'string'
}

async function setDescendantAuth($: EngineInterface, token: string | undefined): Promise<void> {
  if (await $.env.get('RICE_SESSION_ACCOUNTS_OAUTH_RELAY') === token) return
  const outcome: unknown = await $.env.set('RICE_SESSION_ACCOUNTS_OAUTH_RELAY', token)
  if (refusedEnvironment(outcome) || await $.env.get('RICE_SESSION_ACCOUNTS_OAUTH_RELAY') !== token) throw new Error('Claude refused the session descendant credential change. The account was not switched.')
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
    case 'FORCE_WINDOWS_CREDMAN':
      return $.env.get('FORCE_WINDOWS_CREDMAN')
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
    log: text => $.ui.log(`${PLUGIN}: ${text}`, { to: 'debug' }),
  }
}

async function machineOf($: EngineInterface): Promise<Machine> {
  const configDir = await variable($, 'CLAUDE_CONFIG_DIR')
  const windows = await variable($, 'OS') === 'Windows_NT'
  const home = (windows ? await variable($, 'USERPROFILE') : undefined) ?? (await variable($, 'HOME')) ?? ''
  const originals = (await read($, originalsAtom)) ?? mirror.originals

  return {
    claudeDir: configDir || `${home}/.claude`,
    user: (windows ? await variable($, 'USERNAME') : undefined) ?? await variable($, 'USER'),
    storage: { configDir: configDir || undefined, secureStorageDir: originals ? originals.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? undefined : await variable($, 'CLAUDE_SECURESTORAGE_CONFIG_DIR') },
  }
}

async function loadConfig($: EngineInterface): Promise<{ config: Config; problems: string[] }> {
  const paths = pathsFor((await machineOf($)).claudeDir)
  if (!(await $.fs.exists(paths.config))) return { config: defaultConfig(), problems: [] }
  const loaded = parseConfig(await $.fs.read(paths.config))
  knownNames = Object.entries(loaded.config.accounts).filter(([, account]) => (KINDS as readonly string[]).includes(account.kind)).map(([name]) => name)

  return loaded
}

/** Defaults stand in for a file that does not parse; writing them would discard every saved entry. */
async function writableConfig($: EngineInterface): Promise<Config> {
  const { config, problems } = await loadConfig($)
  const unparsed = problems.find(problem => problem.startsWith(UNPARSED_CONFIG))
  if (unparsed) throw new Error(`${unparsed}. Repair accounts.json first; it was left unchanged.`)
  return config
}

async function saveConfig($: EngineInterface, config: Config): Promise<void> {
  const paths = pathsFor((await machineOf($)).claudeDir)
  await $.fs.write(paths.config, serializeConfig(config))
  knownNames = Object.entries(config.accounts).filter(([, account]) => (KINDS as readonly string[]).includes(account.kind)).map(([name]) => name)
}

/** The managed variables as this process started, taken once and kept across reloads and /clear. */
async function originalsOf($: EngineInterface): Promise<Originals> {
  const kept = (await read($, originalsAtom)) ?? mirror.originals
  if (kept) {
    if (!(await read($, originalsAtom))) await update($, originalsAtom, () => kept)

    return kept as Originals
  }
  const taken = {} as Originals
  for (const name of MANAGED) taken[name] = (await getManaged($, name)) ?? null
  mirror = { ...mirror, originals: taken }
  await update($, originalsAtom, () => taken)

  return taken
}

function reportStatus(report: AccountReport): string {
  const limits = report.rateLimits.map(limit => `${limit.kind === 'five_hour' ? '5h' : limit.kind === 'seven_day' ? 'wk' : limit.kind} ${Math.round(limit.percentUsed)}%`).join(', ')
  return `account ${report.name} | ${report.email} | ${report.tier}${limits ? ` | ${limits}` : ''}${report.problem ? ` | ${report.problem}` : ''}`
}

function withReportedLimits<T>(result: T, rateLimits: ReportedLimit[]): T {
  if (typeof result !== 'object' || result === null || !('value' in result) || typeof result.value !== 'object' || result.value === null) return result
  return { ...result, value: { ...result.value, rateLimits } }
}

async function refreshReport($: EngineInterface, name: string, account: AccountConfig, machine: Machine, generation: number, secret?: string): Promise<void> {
  const identity = await accountIdentity(machineIo($), account, machine)
  let token = secret
  if (account.kind === 'login') {
    token = await $.env.get('CLAUDE_CODE_OAUTH_TOKEN')
    if (!token && !(await $.env.get('ANTHROPIC_API_KEY')) && !(await $.env.get('ANTHROPIC_AUTH_TOKEN'))) {
      token = (await readLogin(machineIo($), { storage: machine.storage, defaultConfigDir: machine.claudeDir, user: machine.user }))?.claudeAiOauth.accessToken
    }
  }
  let rateLimits: ReportedLimit[] = [], problem: string | undefined
  try {
    if (!token) problem = 'usage unavailable'
    else {
      const response = await $.http.fetch(USAGE_URL, oauthInit({ token }))
      if (!response.ok) problem = `usage unavailable (HTTP ${response.status})`
      else rateLimits = parseUsage(JSON.parse(response.text)).map(limit => ({
        kind: limit.label === '5h' ? 'five_hour' : limit.label === 'wk' ? 'seven_day' : limit.label,
        percentUsed: limit.percent,
        ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}),
      }))
    }
  } catch { problem = 'usage unavailable' }
  // A request begun for A can complete after B has been selected. Native
  // response headers have the same race, so selected-account reports use the
  // selected account's usage endpoint and discard superseded results.
  if (generation !== transitionGeneration || name !== (mirror.active?.name ?? LOGIN_NAME)) return
  accountReport = { name, generation, ...identity, rateLimits, problem }
  $.ui.status(reportStatus(accountReport))
}

function scheduleRenewal($: EngineInterface, name: string, now: number): void {
  renewal?.cancel()
  renewal = undefined
  if (expiresAt === undefined) return
  const wait = Math.max(30_000, expiresAt - EXPIRY_MARGIN_MS - now)
  renewal = $.clock.after(wait, () => {
    void renewIfActive($, name)
  })
}

async function renewIfActive($: EngineInterface, name: string): Promise<void> {
  if (transitionProblem || mirror.active?.name !== name) return
  await switchTo($, name, true).catch((error: unknown) => {
    $.ui.log(`${PLUGIN}: could not renew ${name}: ${message(error)}`, { to: 'debug' })
    $.ui.toast(`${PLUGIN}: could not renew ${name}: ${message(error)}`)
  })
}

/** Puts this process on an account: its secret read, the managed variables set, the state and status updated. */
async function switchTo($: EngineInterface, name: string, isQuiet = false): Promise<string> {
  const generation = isQuiet ? transitionGeneration : ++transitionGeneration
  const { config, problems } = await loadConfig($)
  const account = config.accounts[name]
  if (!account) {
    const extra = problems.length > 0 ? ` (accounts.json: ${problems.join('; ')})` : ''

    throw new Error(`No account named ${name}. Saved: ${Object.keys(config.accounts).join(', ')}${extra}`)
  }
  if (!(KINDS as readonly string[]).includes(account.kind)) throw new Error('Rice Accounts switches Anthropic OAuth accounts only. Configure provider accounts in rice-multi-models. This saved entry was kept.')
  const machine = await machineOf($)
  const originals = await originalsOf($)
  const material = await materialFor(machineIo($), name, account, pathsFor(machine.claudeDir), machine)
  // Credential refresh may finish after the person selected another account.
  // Prepare in parallel, then serialize environment/state commits and reject old work.
  const preceding = commitTail
  let releaseCommit = () => {}
  commitTail = new Promise<void>(resolve => { releaseCommit = resolve })
  await preceding
  try {
    if (generation !== transitionGeneration || isQuiet && mirror.active?.name !== name) {
      if (isQuiet) return ''
      throw new Error('Another account choice superseded this switch. The newer selection was kept.')
    }
    const plan = planEnv(account, material.secret, originals)
    const previousMirror = mirror
    const previousActive = (await read($, activeAtom)) ?? null
    const previousExpiresAt = expiresAt
    const previousReport = accountReport
    const previousProblem = transitionProblem
    const previousRelay = await $.env.get('RICE_SESSION_ACCOUNTS_OAUTH_RELAY')
    committingAccount = true
    const precedingValues = new Map<Managed, string | undefined>()
    let stateAttempted = false, timerChanged = false, now: number | undefined
    try {
      for (const variableName of MANAGED) {
        const previous = await getManaged($, variableName)
        if (previous === plan[variableName]) continue
        precedingValues.set(variableName, previous)
        const outcome = await setManaged($, variableName, plan[variableName])
        if (refusedEnvironment(outcome) || (await getManaged($, variableName)) !== plan[variableName]) throw new Error(`Claude refused the session environment change for ${variableName}. The account was not switched.`)
      }
      await setDescendantAuth($, account.kind === 'login' ? plan.CLAUDE_CODE_OAUTH_TOKEN : material.secret)
      now = await $.clock.now()
      const active: ActiveAccount | null = name === LOGIN_NAME ? null : { name, switchedAt: now }
      stateAttempted = true
      await update($, activeAtom, () => active)
      const saved = await read($, activeAtom)
      if ((saved?.name ?? null) !== (active?.name ?? null) || saved?.switchedAt !== active?.switchedAt) throw new Error('Claude refused the session account state change. The account was not switched.')
      mirror = { ...mirror, active }
      expiresAt = material.expiresAt
      timerChanged = true
      scheduleRenewal($, name, now)
      accountReport = { name, generation, email: 'Loading account', tier: 'Unknown', rateLimits: [], problem: 'loading usage' }
      $.ui.status(reportStatus(accountReport))
      transitionProblem = undefined
    } catch (error) {
      const rollbackProblems: string[] = []
      mirror = previousMirror
      expiresAt = previousExpiresAt
      accountReport = previousReport
      transitionProblem = previousProblem
      if (stateAttempted) {
        try {
          await update($, activeAtom, () => previousActive)
          const saved = await read($, activeAtom)
          if ((saved?.name ?? null) !== (previousActive?.name ?? null) || saved?.switchedAt !== previousActive?.switchedAt) rollbackProblems.push('account state')
        } catch { rollbackProblems.push('account state') }
      }
      for (const [variableName, previous] of [...precedingValues.entries()].reverse()) {
        try {
          const outcome = await setManaged($, variableName, previous)
          if (refusedEnvironment(outcome) || await getManaged($, variableName) !== previous) rollbackProblems.push(variableName)
        } catch { rollbackProblems.push(variableName) }
      }
      try { await setDescendantAuth($, previousRelay) } catch { rollbackProblems.push('descendant credentials') }
      if (timerChanged) {
        try { scheduleRenewal($, previousMirror.active?.name ?? LOGIN_NAME, now ?? await $.clock.now()) } catch { rollbackProblems.push('renewal timer') }
      }
      if (rollbackProblems.length > 0) {
        accountReport = undefined
        transitionProblem = ACCOUNT_RECOVERY
        $.ui.status('account switch incomplete | use /rice-account login to recover')
        throw new Error(`${message(error)} Rollback could not restore ${rollbackProblems.join(', ')}. ${ACCOUNT_RECOVERY}`)
      }
      $.ui.status(previousReport ? reportStatus(previousReport) : undefined)
      throw error
    }
  } finally { committingAccount = false; releaseCommit() }
  await refreshReport($, name, account, machine, generation, material.secret)
  if (isQuiet) return ''
  if (generation !== transitionGeneration) return 'A newer account choice superseded this selection. The newer account was kept.'
  const email = accountReport?.name === name ? accountReport.email : await loginEmail(machineIo($), account.loginDir)
  return name === LOGIN_NAME
    ? `This session is back on this machine's /login. Other sessions were not touched.`
    : `This session now uses ${name} (${account.kind}${email ? `, ${email}` : ''}) from its next request, for its subagents and any claude -p it starts. Other sessions keep their own account.`
}

/** After a reload (state kept) or a /clear (module kept), the account this process holds is put back in both. */
async function restore($: EngineInterface): Promise<void> {
  if (transitionProblem) return
  await originalsOf($)
  const kept = (await read($, activeAtom)) ?? mirror.active
  if (!kept) return
  if (!(await read($, activeAtom))) await update($, activeAtom, () => kept)
  mirror = { ...mirror, active: kept }
  await switchTo($, kept.name, true).catch((error: unknown) => {
    $.ui.toast(`${PLUGIN}: could not keep ${kept.name}: ${message(error)}`)
  })
}

function formatLimits(limits: { label: string; percent: number; resetsAt?: string }[]): string {
  if (limits.length === 0) return 'no usage windows reported'

  return limits
    .map(limit => {
      const at = limit.resetsAt ? new Date(limit.resetsAt) : undefined
      const when = at && !Number.isNaN(at.getTime()) ? `, resets ${at.toLocaleString()}` : ''

      return `${limit.label} ${Math.round(limit.percent)}%${when}`
    })
    .join('\n')
}

async function usageText($: EngineInterface): Promise<string> {
  if (transitionProblem) return transitionProblem
  const name = mirror.active?.name ?? LOGIN_NAME
  const { config } = await loadConfig($)
  const account = config.accounts[name]
  if (!account) return `No account named ${name}.`
  if (!(KINDS as readonly string[]).includes(account.kind)) return 'Rice Accounts supports Anthropic OAuth accounts only. This provider entry is retained for compatibility; use rice-multi-models for providers.'
  let init
  if (account.kind === 'login') {
    const token = await $.env.get('CLAUDE_CODE_OAUTH_TOKEN')
    if (token) init = oauthInit({ token })
    else {
      const machine = await machineOf($)
      const stored = await readLogin(machineIo($), { storage: machine.storage, defaultConfigDir: machine.claudeDir, user: machine.user })
      if (stored) init = oauthInit({ token: stored.claudeAiOauth.accessToken })
      else {
        const handle = (await $.session.authorize())?.handle
        if (!handle) return 'This session has no Anthropic credential to look usage up with.'
        init = oauthInit({ handle })
      }
    }
  } else if (account.kind === 'claudeai' || account.kind === 'claudeai-token') {
    const machine = await machineOf($)
    const material = await materialFor(machineIo($), name, account, pathsFor(machine.claudeDir), machine)
    if (!material.secret) return `${name} has no token.`
    init = oauthInit({ token: material.secret })
  } else {
    return `${name} is a ${account.kind} account: its limits are on the provider's own console.`
  }
  const response = await $.http.fetch(USAGE_URL, init)
  if (!response.ok) return `${name}: the usage lookup answered HTTP ${response.status}${account.kind === 'claudeai-token' ? ' (setup tokens may not reach it)' : ''}.`

  return `${name} usage:\n${formatLimits(parseUsage(JSON.parse(response.text)))}`
}

function selectedReportProblem(detail: string | undefined): string {
  return transitionProblem ?? `The selected session account report is unavailable${detail ? ` (${detail.replace(/\.$/, '')})` : ''}. The machine login was not reported in its place. Retry, or run /rice-account check.`
}

async function statusText($: EngineInterface): Promise<string> {
  if (transitionProblem) return transitionProblem
  const [version, model, cwd] = await Promise.all([$.session.version(), $.session.model(), $.session.cwd()])
  const report = accountReport
  const selected = report ? `Session account: ${report.name}\nEmail: ${report.email}\nPlan: ${report.tier}` : 'Session account: machine login'
  return `${selected}\nClaude Code: ${version.version}\nModel: ${model}\nWorking directory: ${cwd}\n\n${await usageText($)}\n\nRice Accounts reports this session selection. The machine login is unchanged.`
}

async function checkText($: EngineInterface, name: string): Promise<string> {
  const { config } = await loadConfig($)
  const account = config.accounts[name]
  if (!account) return `No account named ${name}.`
  if (!(KINDS as readonly string[]).includes(account.kind)) return 'Rice Accounts supports Anthropic OAuth accounts only. This provider entry is retained; use rice-multi-models for providers.'
  const machine = await machineOf($)
  if (account.kind === 'login') {
    const stored = await readLogin(machineIo($), { storage: machine.storage, defaultConfigDir: machine.claudeDir, user: machine.user })
    if (!stored) return 'This machine has no saved Claude OAuth login. Run claude auth login in a terminal.'
    const response = await $.http.fetch(PROFILE_URL, oauthInit({ token: stored.claudeAiOauth.accessToken }))
    if (!response.ok) return `login: the profile lookup answered HTTP ${response.status}.`
    return `login: signed in as ${parseProfile(response.text).email}.`
  }
  const material = await materialFor(machineIo($), name, account, pathsFor(machine.claudeDir), machine)
  if (account.kind === 'claudeai' || account.kind === 'claudeai-token') {
    const response = await $.http.fetch(PROFILE_URL, oauthInit({ token: material.secret ?? '' }))
    if (!response.ok) return `${name}: token found; the profile lookup answered HTTP ${response.status}.`
    const owner = parseProfile(response.text)

    return `${name}: signed in as ${owner.email}${owner.organizationName ? ` (${owner.organizationName})` : ''}.`
  }
  return `${name}: OAuth account is ready.`
}

async function listText($: EngineInterface): Promise<string> {
  const { config, problems } = await loadConfig($)
  const rows = await accountRows($)
  const lines = rows.map(row => `${row.selected ? '*' : ' '} ${describeAccount(row.name, config.accounts[row.name]!)} | ${row.email} | ${row.tier}${row.selected ? ' [this session]' : ''}`)
  const notes = problems.length > 0 ? `\nSkipped in accounts.json: ${problems.join('; ')}` : ''

  return `${lines.join('\n')}${notes}\n\n/rice-account <name> switches this session only. /rice-account add <name> [kind] saves another (default: claudeai). /rice-account setup <name> resumes setup.`
}

async function accountRows($: EngineInterface): Promise<AccountRow[]> {
  const { config } = await loadConfig($)
  const machine = await machineOf($)
  const io = machineIo($)
  const current = mirror.active?.name ?? LOGIN_NAME
  return Promise.all(Object.entries(config.accounts).filter(([, account]) => (KINDS as readonly string[]).includes(account.kind)).map(async ([name, account]) => ({
    name, kind: account.kind, selected: name === current, ...await accountIdentity(io, account, machine),
  })))
}

function parseOptions(words: readonly string[]): Record<string, string> {
  const options: Record<string, string> = {}
  for (const word of words) {
    const at = word.indexOf('=')
    if (at <= 0 || at === word.length - 1) throw new Error('Expected key=value for each option; credentials are entered in the terminal helper.')
    const key = word.slice(0, at)
    if (!(ADD_OPTIONS as readonly string[]).includes(key)) throw new Error(`Unknown option: ${key}`)
    if (options[key] !== undefined) throw new Error(`Repeated option: ${key}`)
    options[key] = word.slice(at + 1)
  }

  return options
}

async function runCommand($: EngineInterface, args: string): Promise<string> {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const [first, ...rest] = words
  try {
    if (!first) {
      if (await openAccountPicker(() => $.ui.open({ id: ACCOUNT_PICKER_ID, title: 'Choose account', focus: true, closeOnEscape: true }))) return 'Choose an account in the account list. This changes only this session.'
      return await listText($)
    }
    if (first === 'list') return await listText($)
    if (first === 'usage') return await usageText($)
    if (first === 'check') return await checkText($, rest[0] ?? mirror.active?.name ?? LOGIN_NAME)
    if (first === 'default') return await switchTo($, (await loadConfig($)).config.default)
    if (first === 'setup-native') {
      return 'Use this plugin inside ordinary claude. The previous launcher installation path is withdrawn.'
    }
    if (first === 'setup') {
      const name = rest[0]
      const { config } = await loadConfig($)
      if (!name || !config.accounts[name] || rest.length !== 1) return 'Usage: /rice-account setup <saved name>'
      if (!(KINDS as readonly string[]).includes(config.accounts[name]!.kind)) return 'Rice Accounts supports Anthropic OAuth accounts only. This provider entry is retained; use rice-multi-models for providers.'
      if (name === LOGIN_NAME) return 'The built-in login uses this machine\'s Claude Code authentication. Run claude auth login in a terminal.'
      return setupText($.plugin.root, (await machineOf($)).claudeDir, name, false, (await variable($, 'OS')) === 'Windows_NT' ? 'win32' : 'posix')
    }
    if (first === 'add') {
      const [name, word, ...tail] = rest
      const config = await writableConfig($)
      const kind = word && !word.includes('=') ? word : config.accounts[name ?? '']?.kind ?? 'claudeai'
      const more = word?.includes('=') ? [word, ...tail] : tail
      if (!name || kind === 'login' || !(KINDS as readonly string[]).includes(kind)) {
        return `Usage: /rice-account add <name> [kind] [key=value ...]\nDefault kind: claudeai\nKinds: ${KINDS.filter(each => each !== 'login').join(', ')}\nOptions: label=, service= (setup tokens only). Configure provider accounts in rice-multi-models.`
      }
      const machine = await machineOf($)
      const added = addAccount(config, name, kind as Kind, parseOptions(more), pathsFor(machine.claudeDir))
      if (added.config !== config) await saveConfig($, added.config)

      return setupText($.plugin.root, machine.claudeDir, name, !config.accounts[name], (await variable($, 'OS')) === 'Windows_NT' ? 'win32' : 'posix')
    }
    if (first === 'remove') {
      const name = rest[0]
      if (!name) return 'Usage: /rice-account remove <name>'
      if (mirror.active?.name === name) return `${name} is this session's account; /rice-account login first.`
      const config = await writableConfig($)
      const account = config.accounts[name]
      if (config.legacy && Object.hasOwn(config.legacy, name) || account && !(KINDS as readonly string[]).includes(account.kind)) return 'This provider entry is retained. Rice Accounts manages OAuth accounts only.'
      await saveConfig($, removeAccount(config, name))
      const cleanup =
        account?.kind === 'claudeai'
          ? `\nIts native login is retained. To sign it out in a terminal: env -u CLAUDECODE CLAUDE_CONFIG_DIR=${shellQuote(account.loginDir ?? '')} CLAUDE_SECURESTORAGE_CONFIG_DIR=${shellQuote(account.loginDir ?? '')} claude auth logout`
          : account?.secret
            ? '\nIts credential is retained in the OS keyring. Remove it with your OS credential manager when no account uses it.'
            : ''

      return `Removed ${name} from accounts.json.${cleanup}`
    }
    if (first === 'set-default') {
      const name = rest[0]
      const config = await writableConfig($)
      if (!name || !config.accounts[name] || !(KINDS as readonly string[]).includes(config.accounts[name]!.kind) || rest.length !== 1) return 'This legacy command expects a saved OAuth account name. Use /rice-account <name> to switch this session.'
      await saveConfig($, { ...config, default: name })

      return `The legacy /rice-account default target is ${name}. Use /rice-account ${name} to switch this session. New sessions still start on this machine's normal Claude login.`
    }

    if (rest.length > 0) return 'Usage: /rice-account <saved name> or /rice-account setup <saved name>'
    return await switchTo($, first)
  } catch (error) {
    return message(error).replace(/^(?:rice-session-accounts:\s*)+/, '')
  }
}

export const register: Register = on => {
  registerDescendantAuth(on, () => transitionProblem)
  on('ui.render', { component: 'Pane' }, ($, e, next) => {
    if (e.requestId !== ACCOUNT_PICKER_ID) return next(e)
    return renderAccountPicker($.ui.resolve(e), () => accountRows($), name => switchTo($, name), {
      invalidate: () => $.ui.invalidate('ui.render'),
      log: text => $.ui.log(text),
      close: () => $.ui.close({ id: ACCOUNT_PICKER_ID }),
    })
  })
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'rice-account',
      description: 'Choose a Claude OAuth account by email and tier, or add, set up and check accounts',
      argumentHint: '[<name> | list | usage | setup <name> | check [name] | add <name> [kind] | remove <name>]',
    })
    await restore($)
    await syncDescendantAuth($)

    return started
  })

  on('turn.start', async ($, e, next) => {
    if (mirror.active && !(await read($, activeAtom))) await restore($)
    if (mirror.active && expiresAt !== undefined && expiresAt - EXPIRY_MARGIN_MS <= (await $.clock.now())) await renewIfActive($, mirror.active.name)

    return next(e)
  })

  on('command.run', { command: 'rice-account' }, async ($, e) => ({ text: await runCommand($, e.args) }))

  on('session.authorize', async ($, e, next) => {
    if (transitionProblem) return { value: null }
    if (!mirror.active) {
      const result = await next(e)
      if (result.value) sessionAuthorizations.trackNative(next.origin.plugin, result.value.handle)
      return result
    }
    if (committingAccount || !(await currentAccessToken($))) return { value: null }
    if (transitionProblem || committingAccount || !mirror.active) return { value: null }
    return { value: sessionAuthorizations.issue(next.origin.plugin) }
  }).catch((_host, e, next) => next.called ? next(e) : { value: null })

  on('http.fetch', async ($, e, next) => {
    if (transitionProblem && next.origin.plugin !== PLUGIN) return { deny: transitionProblem }
    if (!sessionAuthorizations.recognizes(e.init?.auth)) return next(e)
    if (!mirror.active && !sessionAuthorizations.owns(e.init?.auth)) return next(e)
    await commitTail
    if (transitionProblem) return { deny: transitionProblem }
    if (committingAccount) throw new Error('The session account is changing. Authorize it again when the selection completes.')
    const name = mirror.active?.name
    const generation = transitionGeneration
    let token = await currentAccessToken($)
    if (!name && !token) {
      const machine = await machineOf($)
      token = (await readLogin(machineIo($), { storage: machine.storage, defaultConfigDir: machine.claudeDir, user: machine.user }))?.claudeAiOauth.accessToken
    }
    const disabled = Boolean(await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'))
    if (transitionProblem) return { deny: transitionProblem }
    if (committingAccount || generation !== transitionGeneration || name !== mirror.active?.name) throw new Error('The session account changed while preparing this request. Retry the request.')
    const init = sessionAuthorizations.prepare(e.url, e.init, next.origin.plugin, token, disabled)
    return next({ ...e, init })
  }).catch((_host, e, next) => next.called ? next(e) : { deny: ACCOUNT_AUTH_RETRY })

  on('session.*', async (_$, e, next) => {
    const result = await next(e)
    if (String(next.event) === 'session.usage' && transitionProblem) return withReportedLimits(result, [])
    if (String(next.event) !== 'session.usage' || !accountReport || accountReport.name !== (mirror.active?.name ?? LOGIN_NAME)) return result
    return withReportedLimits(result, accountReport.rateLimits)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (accountReport && !transitionProblem) {
      const name = mirror.active?.name ?? LOGIN_NAME
      const { config } = await loadConfig($)
      const account = config.accounts[name]
      if (account) await refreshReport($, name, account, await machineOf($), transitionGeneration, await currentAccessToken($))
    }
    return result
  })

  // A failed hook is skipped, and the native command would then report the
  // machine account. Answer with the selected account's problem instead.
  on('command.run', { command: 'usage' }, async ($, e, next) => {
    if (!accountReport && !transitionProblem) return next(e)
    return { text: await usageText($) }
  }).catch((_host, e, next) => next.called ? next(e) : { text: selectedReportProblem(next.error.message) })

  on('command.run', { command: 'status' }, async ($, e, next) => {
    if (!accountReport && !transitionProblem) return next(e)
    return { text: await statusText($) }
  }).catch((_host, e, next) => next.called ? next(e) : { text: selectedReportProblem(next.error.message) })

  on('model.*', (_$, e, next) => transitionProblem ? { deny: transitionProblem } : next(e))

  on('turn.step', async function* (_$, e, next) {
    if (!transitionProblem) return yield* next(e)
    const answer = transitionProblem
    yield { kind: 'text', index: 0, text: answer }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
  })

  on('prompt.autocomplete', async ($, e, next) => {
    const found = await next(e)
    if (!e.text.startsWith('/rice-account ') || e.start <= '/rice-account'.length) return found
    const rows = knownNames
      .filter(name => name.startsWith(e.token) && name !== e.token)
      .map(name => ({ text: name, description: 'switch this session to it' }))

    return { suggestions: [...found.suggestions, ...rows] }
  })
}
