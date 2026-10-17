/**
 * The /rice-account command line: its subcommands, their argument counts,
 * the help text and the typeahead rows. Pure; register.ts runs the result.
 */

export const COMMAND = 'rice-account'

type Subcommand = { name: string; usage: string; summary: string; min: number; max: number; takesName?: true }

/** Every subcommand, in the order help lists them. `max` -1 takes any number. */
export const SUBCOMMANDS: readonly Subcommand[] = [
  { name: 'use', usage: 'use <name>', summary: 'Switch this session to a saved account (also reaches an account named like a subcommand).', min: 1, max: 1, takesName: true },
  { name: 'list', usage: 'list', summary: 'List the saved accounts with their email and plan.', min: 0, max: 0 },
  { name: 'usage', usage: 'usage', summary: "Show the session account's usage limits.", min: 0, max: 0 },
  { name: 'check', usage: 'check [name]', summary: "Check that an account's login answers (default: the session account).", min: 0, max: 1, takesName: true },
  { name: 'add', usage: 'add <name> [kind] [label=...] [service=...]', summary: 'Save an account (kind claudeai, the default, or claudeai-token) and print its terminal setup command.', min: 1, max: -1 },
  { name: 'setup', usage: 'setup <name>', summary: "Print a saved account's terminal setup command again.", min: 1, max: 1, takesName: true },
  { name: 'remove', usage: 'remove <name>', summary: 'Remove a saved account from accounts.json; its login is kept.', min: 1, max: 1, takesName: true },
  { name: 'default', usage: 'default', summary: 'Switch this session to the saved default account.', min: 0, max: 0 },
  { name: 'set-default', usage: 'set-default <name>', summary: 'Change the saved default account; new sessions still start on the machine login.', min: 1, max: 1, takesName: true },
  { name: 'setup-native', usage: 'setup-native', summary: 'Withdrawn: Rice Accounts runs inside ordinary claude.', min: 0, max: -1 },
  { name: 'help', usage: 'help', summary: 'Show this list.', min: 0, max: -1 },
]

const HELP_WORDS = new Set(['help', '--help', '-h', '?'])

export const ARGUMENT_HINT = '[<name> | use <name> | list | usage | check [name] | add <name> [kind] | setup <name> | remove <name> | default | set-default <name> | setup-native | help]'

export function usageLine(name: string): string {
  const found = SUBCOMMANDS.find(each => each.name === name)
  return `Usage: /${COMMAND} ${found?.usage ?? '<name>'}\nRun /${COMMAND} help to list every subcommand.`
}

export function helpText(): string {
  const rows: [string, string][] = [
    ['', 'Choose an account in a list. This changes only this session.'],
    ['<name>', 'Switch this session to a saved account; login is the machine login.'],
    ...SUBCOMMANDS.map(each => [each.usage, each.summary] as [string, string]),
  ]
  const width = Math.max(...rows.map(([usage]) => usage.length))
  const lines = rows.map(([usage, summary]) => `/${COMMAND}${usage ? ` ${usage}` : ''}${' '.repeat(width - usage.length + 2)}${summary}`)
  return `Rice Accounts chooses the Claude OAuth account for this session only. Other sessions keep their own account.\n\n${lines.join('\n')}`
}

export type Parsed =
  | { kind: 'picker' }
  | { kind: 'help' }
  | { kind: 'switch'; name: string }
  | { kind: 'refused'; text: string }
  | { kind: 'list' | 'usage' | 'default' | 'setup-native' }
  | { kind: 'check'; name?: string }
  | { kind: 'setup' | 'remove' | 'set-default'; name: string }
  | { kind: 'add'; name: string; rest: string[] }

/** Reads the words after /rice-account, refusing a wrong argument count with the usage line. */
export function parseCommand(args: string): Parsed {
  const [first, ...rest] = args.trim().split(/\s+/).filter(Boolean)
  if (first === undefined) return { kind: 'picker' }
  if (HELP_WORDS.has(first)) return { kind: 'help' }
  const subcommand = SUBCOMMANDS.find(each => each.name === first)
  if (!subcommand) {
    if (rest.length > 0) return { kind: 'refused', text: `Usage: /${COMMAND} <name> or /${COMMAND} use <name>\nRun /${COMMAND} help to list every subcommand.` }
    return { kind: 'switch', name: first }
  }
  if (rest.length < subcommand.min || subcommand.max >= 0 && rest.length > subcommand.max) return { kind: 'refused', text: usageLine(subcommand.name) }
  switch (subcommand.name) {
    case 'use': return { kind: 'switch', name: rest[0]! }
    case 'list': return { kind: 'list' }
    case 'usage': return { kind: 'usage' }
    case 'default': return { kind: 'default' }
    case 'setup-native': return { kind: 'setup-native' }
    case 'check': return rest[0] === undefined ? { kind: 'check' } : { kind: 'check', name: rest[0] }
    case 'setup': return { kind: 'setup', name: rest[0]! }
    case 'remove': return { kind: 'remove', name: rest[0]! }
    case 'set-default': return { kind: 'set-default', name: rest[0]! }
    case 'add': return { kind: 'add', name: rest[0]!, rest: rest.slice(1) }
    default: return { kind: 'help' }
  }
}

export type Suggestion = { text: string; description: string }

/**
 * Typeahead rows for the token being typed after /rice-account: subcommands
 * and saved names first, then names after a subcommand that takes one, and
 * the account kinds after `add <name>`.
 */
export function completions(text: string, start: number, token: string, names: readonly string[], kinds: readonly string[]): Suggestion[] {
  const prefix = `/${COMMAND} `
  if (!text.startsWith(prefix) || start < prefix.length) return []
  const before = text.slice(prefix.length, start).trim().split(/\s+/).filter(Boolean)
  let rows: Suggestion[] = []
  if (before.length === 0) {
    rows = [
      ...SUBCOMMANDS.map(each => ({ text: each.name, description: each.summary })),
      ...names.filter(name => !SUBCOMMANDS.some(each => each.name === name)).map(name => ({ text: name, description: 'Switch this session to this account.' })),
    ]
  } else if (before.length === 1 && SUBCOMMANDS.find(each => each.name === before[0])?.takesName) {
    rows = names.map(name => ({ text: name, description: `${before[0]} ${name}` }))
  } else if (before.length === 2 && before[0] === 'add') {
    rows = kinds.map(kind => ({ text: kind, description: kind === 'claudeai' ? 'A browser login in its own folder (default).' : 'A one-year token from claude setup-token.' }))
  }
  return rows.filter(row => row.text.startsWith(token) && row.text !== token)
}
