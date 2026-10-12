import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ActiveAccount, EnvSnapshot } from '../types'
import { loginEmail, materialFor } from './accounts'
import type { Machine } from './accounts'
import { addAccount, defaultConfig, describeAccount, KINDS, LOGIN_NAME, parseConfig, pathsFor, removeAccount, serializeConfig } from './config'
import type { AccountConfig, Config, Kind } from './config'
import { MANAGED, planEnv } from './env'
import type { Managed, Originals } from './env'
import type { EnvName, Io } from './io'
import { message } from './io'
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
let remap: Record<string, string> = {}
let knownNames: string[] = [LOGIN_NAME]

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
  knownNames = Object.keys(loaded.config.accounts)

  return loaded
}

async function saveConfig($: EngineInterface, config: Config): Promise<void> {
  const paths = pathsFor((await machineOf($)).claudeDir)
  await $.fs.write(paths.config, serializeConfig(config))
  knownNames = Object.keys(config.accounts)
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

    return `No account named ${name}. Saved: ${Object.keys(config.accounts).join(', ')}${extra}`
  }
  const machine = await machineOf($)
  const originals = await originalsOf($)
  const material = await materialFor(machineIo($), name, account, pathsFor(machine.claudeDir), machine)
  const plan = planEnv(account, material.secret, originals)
  for (const variableName of MANAGED) {
    if ((await getManaged($, variableName)) !== plan[variableName]) await setManaged($, variableName, plan[variableName])
  }
  const now = await $.clock.now()
  const active: ActiveAccount | null = name === LOGIN_NAME ? null : { name, switchedAt: now }
  mirror = { ...mirror, active }
  await update($, activeAtom, () => active)
  remap = account.models ?? {}
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
  const machine = await machineOf($)
  const material = await materialFor(machineIo($), name, account, pathsFor(machine.claudeDir), machine)
  if (account.kind === 'claudeai' || account.kind === 'claudeai-token') {
    const response = await $.http.fetch(PROFILE_URL, oauthInit({ token: material.secret ?? '' }))
    if (!response.ok) return `${name}: token found; the profile lookup answered HTTP ${response.status}.`
    const owner = parseProfile(response.text)

    return `${name}: signed in as ${owner.email}${owner.organizationName ? ` (${owner.organizationName})` : ''}.`
  }
  if (account.kind === 'api-key') {
    const response = await $.http.fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': material.secret ?? '', 'anthropic-version': '2023-06-01' },
    })

    return response.ok ? `${name}: the API key works.` : `${name}: the API key was refused (HTTP ${response.status}).`
  }

  return `${name}: ${material.secret ? 'secret found in the keychain; ' : ''}its credentials are checked on the first request after /rice-account ${name}.`
}

async function listText($: EngineInterface): Promise<string> {
  const { config, problems } = await loadConfig($)
  const current = mirror.active?.name ?? LOGIN_NAME
  const lines = await Promise.all(
    Object.entries(config.accounts).map(async ([name, account]) => {
      const email = account.kind === 'claudeai' ? await loginEmail(machineIo($), account.loginDir) : undefined
      const marks = [name === current ? 'this session' : '', name === config.default ? 'default' : ''].filter(Boolean).join(', ')

      return `${name === current ? '*' : ' '} ${describeAccount(name, account)}${email ? `  ${email}` : ''}${marks ? `  [${marks}]` : ''}`
    }),
  )
  const notes = problems.length > 0 ? `\nSkipped in accounts.json: ${problems.join('; ')}` : ''

  return `${lines.join('\n')}${notes}\n\n/rice-account <name> switches this session only. /rice-account add <name> <kind> saves another (kinds: ${KINDS.filter(kind => kind !== 'login').join(', ')}).`
}

function parseOptions(words: readonly string[]): Record<string, string> {
  const options: Record<string, string> = {}
  for (const word of words) {
    const at = word.indexOf('=')
    if (at > 0) options[word.slice(0, at)] = word.slice(at + 1)
  }

  return options
}

async function runCommand($: EngineInterface, args: string): Promise<string> {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const [first, ...rest] = words
  try {
    if (!first || first === 'list') return await listText($)
    if (first === 'usage') return await usageText($)
    if (first === 'check') return await checkText($, rest[0] ?? mirror.active?.name ?? LOGIN_NAME)
    if (first === 'default') return await switchTo($, (await loadConfig($)).config.default)
    if (first === 'add') {
      const [name, kind, ...more] = rest
      if (!name || !kind || !(KINDS as readonly string[]).includes(kind)) {
        return `Usage: /rice-account add <name> <kind> [key=value ...]\nKinds: ${KINDS.filter(each => each !== 'login').join(', ')}\nOptions: label=, aws_profile=, region=, project=, resource=, base_url=, service=, secret=bearer|key`
      }
      const { config } = await loadConfig($)
      const added = addAccount(config, name, kind as Kind, parseOptions(more), pathsFor((await machineOf($)).claudeDir))
      await saveConfig($, added.config)

      return `Saved ${name}. Run once in a terminal (secrets go to the keychain prompt, never into this session):\n${added.steps.join('\n')}`
    }
    if (first === 'remove') {
      const name = rest[0]
      if (!name) return 'Usage: /rice-account remove <name>'
      if (mirror.active?.name === name) return `${name} is this session's account; /rice-account default first.`
      const { config } = await loadConfig($)
      const account = config.accounts[name]
      await saveConfig($, removeAccount(config, name))
      const cleanup =
        account?.kind === 'claudeai'
          ? `\nIts login folder and keychain item stay; remove them with: CLAUDE_CONFIG_DIR="${account.loginDir}" claude auth logout`
          : account?.secret
            ? `\nIts keychain item stays; remove it with: security delete-generic-password -s ${account.secret.service} -a ${account.secret.account}`
            : ''

      return `Removed ${name} from accounts.json.${cleanup}`
    }
    if (first === 'set-default') {
      const name = rest[0]
      const { config } = await loadConfig($)
      if (!name || !config.accounts[name]) return 'Usage: /rice-account set-default <saved name>'
      await saveConfig($, { ...config, default: name })

      return `${name} is the default account now (/rice-account default switches to it). Sessions still start on this machine's /login.`
    }

    return await switchTo($, first)
  } catch (error) {
    return `${PLUGIN}: ${message(error)}`
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'rice-account',
      description: 'Switch this session to a saved Anthropic account, or list, add and check them',
      argumentHint: '[<name> | default | list | usage | check [name] | add <name> <kind> | remove <name>]',
    })
    await restore($)

    return started
  })

  on('turn.start', async ($, e, next) => {
    if (mirror.active && !(await read($, activeAtom))) await restore($)
    if (mirror.active && expiresAt !== undefined && expiresAt - EXPIRY_MARGIN_MS <= (await $.clock.now())) await renewIfActive($, mirror.active.name)

    return next(e)
  })

  on('command.run', { command: 'rice-account' }, async ($, e) => ({ text: await runCommand($, e.args) }))

  on('turn.step', async function* ($, e, next) {
    const model = remap[e.model]

    return yield* next(model ? { ...e, model } : e)
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
