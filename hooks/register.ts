import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ActiveAccount, EnvSnapshot } from '../types'
import { loginEmail, materialFor } from './accounts'
import type { Machine } from './accounts'
import { ADD_OPTIONS, addAccount, defaultConfig, describeAccount, KINDS, LOGIN_NAME, parseConfig, pathsFor, removeAccount, serializeConfig } from './config'
import type { AccountConfig, Config, Kind } from './config'
import { MANAGED, planEnv } from './env'
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

// Claude 2.1.296 follows `$` only into helpers declared in this module.
async function syncDescendantAuth($: EngineInterface): Promise<void> {
  const token = await $.env.get('CLAUDE_CODE_OAUTH_TOKEN')
  const current = await $.env.get('RICE_SESSION_ACCOUNTS_OAUTH_RELAY')
  if (current !== (token || undefined)) await $.env.set('RICE_SESSION_ACCOUNTS_OAUTH_RELAY', token || undefined)
}

async function variable($: EngineInterface, name: EnvName): Promise<string | undefined> {
  switch (name) {
    case 'HOME':
      return $.env.get('HOME')
    case 'USER':
      return $.env.get('USER')
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
    case 'CLAUDE_CODE_OAUTH_TOKEN':
      return $.env.get('CLAUDE_CODE_OAUTH_TOKEN')
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

async function setManaged($: EngineInterface, name: Managed, value: string | undefined): Promise<void> {
  switch (name) {
    case 'ANTHROPIC_API_KEY':
      return $.env.set('ANTHROPIC_API_KEY', value)
    case 'ANTHROPIC_AUTH_TOKEN':
      return $.env.set('ANTHROPIC_AUTH_TOKEN', value)
    case 'CLAUDE_CODE_OAUTH_TOKEN':
      return $.env.set('CLAUDE_CODE_OAUTH_TOKEN', value)
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
  const home = (await variable($, 'HOME')) ?? ''

  return {
    claudeDir: configDir || `${home}/.claude`,
    user: await variable($, 'USER'),
    storage: { configDir: configDir || undefined, secureStorageDir: await variable($, 'CLAUDE_SECURESTORAGE_CONFIG_DIR') },
  }
}

async function loadConfig($: EngineInterface): Promise<{ config: Config; problems: string[] }> {
  const paths = pathsFor((await machineOf($)).claudeDir)
  if (!(await $.fs.exists(paths.config))) return { config: defaultConfig(), problems: [] }
  const loaded = parseConfig(await $.fs.read(paths.config))
  knownNames = Object.entries(loaded.config.accounts).filter(([, account]) => (KINDS as readonly string[]).includes(account.kind)).map(([name]) => name)

  return loaded
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

function statusText(name: string, account: AccountConfig): string | undefined {
  return name === LOGIN_NAME ? undefined : `account ${name}${account.label ? ` (${account.label})` : ''}`
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
  if (mirror.active?.name !== name) return
  await switchTo($, name, true).catch((error: unknown) => {
    $.ui.log(`${PLUGIN}: could not renew ${name}: ${message(error)}`, { to: 'debug' })
    $.ui.toast(`${PLUGIN}: could not renew ${name}: ${message(error)}`)
  })
}

/** Puts this process on an account: its secret read, the managed variables set, the state and status updated. */
async function switchTo($: EngineInterface, name: string, isQuiet = false): Promise<string> {
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
  const plan = planEnv(account, material.secret, originals)
  for (const variableName of MANAGED) {
    if ((await getManaged($, variableName)) !== plan[variableName]) await setManaged($, variableName, plan[variableName])
  }
  await syncDescendantAuth($)
  const now = await $.clock.now()
  const active: ActiveAccount | null = name === LOGIN_NAME ? null : { name, switchedAt: now }
  mirror = { ...mirror, active }
  await update($, activeAtom, () => active)
  expiresAt = material.expiresAt
  scheduleRenewal($, name, now)
  $.ui.status(statusText(name, account))
  if (isQuiet) return ''
  const email = account.kind === 'claudeai' ? await loginEmail(machineIo($), account.loginDir) : undefined

  return name === LOGIN_NAME
    ? "This session is back on this machine's /login. Other sessions were not touched."
    : `This session now uses ${name} (${account.kind}${email ? `, ${email}` : ''}) from its next request, for its subagents and any claude -p it starts. Other sessions keep their own account.`
}

/** After a reload (state kept) or a /clear (module kept), the account this process holds is put back in both. */
async function restore($: EngineInterface): Promise<void> {
  await originalsOf($)
  const kept = (await read($, activeAtom)) ?? mirror.active
  if (!kept) return
  if (!(await read($, activeAtom))) await update($, activeAtom, () => kept)
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
  const name = mirror.active?.name ?? LOGIN_NAME
  const { config } = await loadConfig($)
  const account = config.accounts[name]
  if (!account) return `No account named ${name}.`
  if (!(KINDS as readonly string[]).includes(account.kind)) return 'Rice Accounts supports Anthropic OAuth accounts only. This provider entry is retained for compatibility; use rice-multi-models for providers.'
  let init
  if (account.kind === 'login') {
    const handle = (await $.session.authorize())?.handle
    if (!handle) return 'This session has no Anthropic credential to look usage up with.'
    init = oauthInit({ handle })
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
    if (first === 'setup') {
      const name = rest[0]
      const { config } = await loadConfig($)
      if (!name || !config.accounts[name] || rest.length !== 1) return 'Usage: /rice-account setup <saved name>'
      if (!(KINDS as readonly string[]).includes(config.accounts[name]!.kind)) return 'Rice Accounts supports Anthropic OAuth accounts only. This provider entry is retained; use rice-multi-models for providers.'
      if (name === LOGIN_NAME) return 'The built-in login uses this machine\'s Claude Code authentication. Run claude auth login in a terminal.'
      return setupText($.plugin.root, (await machineOf($)).claudeDir, name)
    }
    if (first === 'add') {
      const [name, word, ...tail] = rest
      const { config } = await loadConfig($)
      const kind = word && !word.includes('=') ? word : config.accounts[name ?? '']?.kind ?? 'claudeai'
      const more = word?.includes('=') ? [word, ...tail] : tail
      if (!name || kind === 'login' || !(KINDS as readonly string[]).includes(kind)) {
        return `Usage: /rice-account add <name> [kind] [key=value ...]\nDefault kind: claudeai\nKinds: ${KINDS.filter(each => each !== 'login').join(', ')}\nOptions: label=, service= (setup tokens only). Configure provider accounts in rice-multi-models.`
      }
      const machine = await machineOf($)
      const added = addAccount(config, name, kind as Kind, parseOptions(more), pathsFor(machine.claudeDir))
      if (added.config !== config) await saveConfig($, added.config)

      return setupText($.plugin.root, machine.claudeDir, name, !config.accounts[name])
    }
    if (first === 'remove') {
      const name = rest[0]
      if (!name) return 'Usage: /rice-account remove <name>'
      if (mirror.active?.name === name) return `${name} is this session's account; /rice-account login first.`
      const { config } = await loadConfig($)
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
      const { config } = await loadConfig($)
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
  registerDescendantAuth(on)
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
      argumentHint: '[<name> | list | setup <name> | check [name] | add <name> [kind] | remove <name>]',
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

  on('prompt.autocomplete', async ($, e, next) => {
    const found = await next(e)
    if (!e.text.startsWith('/rice-account ') || e.start <= '/rice-account'.length) return found
    const rows = knownNames
      .filter(name => name.startsWith(e.token) && name !== e.token)
      .map(name => ({ text: name, description: 'switch this session to it' }))

    return { suggestions: [...found.suggestions, ...rows] }
  })
}
