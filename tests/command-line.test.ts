import { expect, test } from 'claude-code/testing'

import { ARGUMENT_HINT, completions, helpText, parseCommand, SUBCOMMANDS } from '../hooks/command-line'

const NAMES = ['login', 'personal', 'work', 'list']
const KINDS = ['claudeai', 'claudeai-token']

test('every subcommand is in the help text and the argument hint', async () => {
  const help = helpText()
  for (const subcommand of SUBCOMMANDS) {
    expect(help).toContain(`/rice-account ${subcommand.usage}`)
    expect(ARGUMENT_HINT).toContain(subcommand.name)
  }
  for (const name of ['use', 'default', 'set-default', 'setup-native', 'help']) expect(SUBCOMMANDS.some(each => each.name === name)).toBe(true)
  expect(ARGUMENT_HINT).toContain('<name>')
})

test('words parse into one action, and a wrong count of arguments is refused with the usage line', async () => {
  expect(parseCommand('')).toEqual({ kind: 'picker' })
  for (const word of ['help', '--help', '-h', '?']) expect(parseCommand(word)).toEqual({ kind: 'help' })
  expect(parseCommand('personal')).toEqual({ kind: 'switch', name: 'personal' })
  expect(parseCommand('  use   list ')).toEqual({ kind: 'switch', name: 'list' })
  expect(parseCommand('check')).toEqual({ kind: 'check' })
  expect(parseCommand('check work')).toEqual({ kind: 'check', name: 'work' })
  expect(parseCommand('add work claudeai-token label=Work')).toEqual({ kind: 'add', name: 'work', rest: ['claudeai-token', 'label=Work'] })
  expect(parseCommand('setup-native /any/old/path')).toEqual({ kind: 'setup-native' })
  for (const args of ['list x', 'usage x', 'default x', 'check a b', 'use', 'use a b', 'setup', 'remove', 'set-default', 'add', 'personal extra']) {
    const parsed = parseCommand(args)
    expect(parsed.kind, args).toBe('refused')
    expect(parsed.kind === 'refused' ? parsed.text : '').toContain('Usage: /rice-account')
  }
})

test('the typeahead offers subcommands and names, then names after a subcommand that takes one', async () => {
  const offered = (text: string) => {
    const start = text.lastIndexOf(' ') + 1
    return completions(text, start, text.slice(start), NAMES, KINDS).map(row => row.text)
  }
  expect(offered('/rice-account li')).toEqual(['list'])
  expect(offered('/rice-account se')).toEqual(['setup', 'set-default', 'setup-native'])
  expect(offered('/rice-account pe')).toEqual(['personal'])
  expect(offered('/rice-account w')).toEqual(['work'])
  expect(offered('/rice-account use l')).toEqual(['login', 'list'])
  expect(offered('/rice-account check w')).toEqual(['work'])
  expect(offered('/rice-account remove p')).toEqual(['personal'])
  expect(offered('/rice-account add new claudeai-')).toEqual(['claudeai-token'])
  expect(offered('/rice-account list x')).toEqual([])
  expect(offered('/rice-account list')).toEqual([])
  expect(offered('/other li')).toEqual([])
})
