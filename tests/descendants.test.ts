import type { CommandRunInput, On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { argvInvokesClaude, commandInvokesClaude } from '../hooks/descendants'
import { oauthHeaders } from '../hooks/env'

const PROBLEM = 'The session account is not confirmed. Run /rice-account login or select a saved account again before continuing.'

function fixtureCommand(args = ''): CommandRunInput {
  return { command: 'descendant-fixture', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } }
}

/** A selected account's environment: the bearer rides only the supported header override. */
function environment(on: On, values: Record<string, string>): { variables: Map<string, string>; writes: string[] } {
  const variables = new Map(Object.entries(values))
  const writes: string[] = []
  on('env.get', (_host, input) => ({ value: variables.get(input.name) }))
  on('env.set', (_host, input) => {
    writes.push(input.name)
    if (input.value === undefined) variables.delete(input.name)
    else variables.set(input.name, input.value)
    return { value: {} }
  })
  return { variables, writes }
}

/** The unconfirmed-account problem as a previous load of the module left it in `$.state`. */
function lockedOut(on: On): void {
  on('state.get', { plugin: 'rice-session-accounts', key: 'problem' }, () => ({ value: { value: PROBLEM, version: 1 } }))
}

function result(exitCode = 0) {
  return { value: { exitCode, stdout: 'fixture', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}

// The test Engine exposes events. This owned inline plugin supplies the real
// operation nouns, with its static calls scanned as native modules are.
const driver = { plugins: [{ name: 'descendant-driver', register(on: On) {
  on('command.run', { command: 'descendant-fixture' }, async ($, e) => {
    const outcome = async (run: () => Promise<unknown>) => {
      try { await run(); return 'started' } catch (error) { return error instanceof Error ? error.message : String(error) }
    }
    if (e.args === 'claude-run') return { text: await outcome(() => $.process.run(['claude', '-p', 'owned'])) }
    if (e.args === 'claude-shell') return { text: await outcome(() => $.process.run(['/bin/sh', '-c', 'cd /fixture && claude -p owned'])) }
    if (e.args === 'claude-spawn') return { text: await outcome(async () => { for await (const _chunk of $.process.spawn({ argv: ['/opt/tools/claude', '-p', 'owned'] })) {} }) }
    if (e.args === 'plain-spawn') return { text: await outcome(async () => { for await (const _chunk of $.process.spawn({ argv: ['fixture-program'], env: { KEEP: 'yes' } })) {} }) }
    if (e.args === 'plain-run') return { text: await outcome(() => $.process.run(['fixture-program', 'argument'], { cwd: '/fixture', stdin: 'input', timeoutMs: 1234, env: { KEEP: 'yes' } })) }
    return { text: 'unknown fixture' }
  })
} }] }

test('shell command lines that run claude are recognized wherever it is a command word', async () => {
  for (const command of [
    'claude -p hi', '/usr/local/bin/claude -p hi', '"claude" --version', 'cd /tmp && claude -p x', 'printf x | claude -p',
    'FOO=1 claude', 'env -u CLAUDECODE claude -p', 'timeout 10 claude', 'sudo -n claude', 'nice -n 5 claude', 'echo $(claude -p x)',
    'echo `claude -p x`', '(claude -p x)', 'true; claude', 'npx claude', 'C:\\Tools\\claude.exe -p', 'claude.cmd -p', 'x || claude', 'exec claude',
    'printf a\nclaude -p b',
  ]) expect(commandInvokesClaude(command), command).toBe(true)
  for (const command of ['printf claude', 'echo claude is here', 'git commit -m claude', 'claudette', 'ls ~/.claude', 'cat claude.md', 'grep -r claude .', 'which claude-code', '']) {
    expect(commandInvokesClaude(command), command).toBe(false)
  }
})

test('argument vectors that start claude are recognized directly, through wrappers and through a shell', async () => {
  for (const argv of [
    ['claude', '-p', 'x'], ['/opt/bin/claude'], ['C:\\bin\\claude.exe', '-p'], ['claude.cmd'], ['env', '-u', 'CLAUDECODE', 'claude'],
    ['/bin/sh', '-c', 'claude -p x'], ['bash', '-lc', 'cd x && claude'], ['cmd.exe', '/c', 'claude', '-p'], ['pwsh', '-Command', 'claude -p'],
  ]) expect(argvInvokesClaude(argv), argv.join(' ')).toBe(true)
  for (const argv of [
    [], ['node', '-e', 'console.log("claude")'], ['/usr/bin/security', 'find-generic-password', '-s', 'Claude Code-credentials'],
    ['/bin/sh', '-c', 'mkdir -p "$(dirname "$0")" && mkdir "$0"', '/fixture/locks/claude.lock'], ['git', 'log'], ['/usr/bin/uname', '-s'],
  ]) expect(argvInvokesClaude(argv), argv.join(' ')).toBe(false)
})

test('Bash keeps the exact command text and never receives a credential relay', async ($, on) => {
  const env = environment(on, { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-launch-oauth', ANTHROPIC_CUSTOM_HEADERS: oauthHeaders(undefined, 'fixture-selected-oauth') })
  const commands: string[] = []
  on('tool.call', { tool: 'Bash' }, (_host, input) => {
    commands.push(input.command)
    return { result: { stdout: 'fixture', stderr: '', interrupted: false, isImage: false } }
  })
  for (const command of ['printf fixture; exit 7', 'claude -p owned', 'printf "${HOME}"']) await $.tool.call({ tool: 'Bash', command })
  expect(commands).toEqual(['printf fixture; exit 7', 'claude -p owned', 'printf "${HOME}"'])
  expect(commands.some(command => command.includes('fixture-selected-oauth') || command.includes('RICE_SESSION_ACCOUNTS'))).toBe(false)
  expect(env.writes).toEqual([])
  expect(env.variables.has('RICE_SESSION_ACCOUNTS_OAUTH_RELAY')).toBe(false)
})

test('process children keep their caller options and environment unchanged', driver, async ($, on) => {
  const env = environment(on, { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-launch-oauth', ANTHROPIC_CUSTOM_HEADERS: oauthHeaders(undefined, 'fixture-selected-oauth') })
  const runs: unknown[] = [], spawns: unknown[] = []
  on('process.run', (_host, input) => { runs.push(input); return result() })
  on('process.spawn', async function* (_host, input) {
    spawns.push(input)
    yield { stream: 'stdout', text: 'fixture-stream' }
    return { value: { code: 0, signal: null } }
  })
  expect((await $.command.run(fixtureCommand('plain-run'))).text).toBe('started')
  expect((await $.command.run(fixtureCommand('plain-spawn'))).text).toBe('started')
  expect((await $.command.run(fixtureCommand('claude-run'))).text).toBe('started')
  expect(runs[0]).toEqual({ argv: ['fixture-program', 'argument'], init: { cwd: '/fixture', stdin: 'input', timeoutMs: 1234, env: { KEEP: 'yes' } } })
  expect((runs[1] as { argv: readonly string[]; init?: { env?: Record<string, string> } }).argv).toEqual(['claude', '-p', 'owned'])
  expect((runs[1] as { init?: { env?: Record<string, string> } }).init?.env).toBe(undefined)
  expect((spawns[0] as { argv: readonly string[]; env?: Record<string, string> }).argv).toEqual(['fixture-program'])
  expect((spawns[0] as { env?: Record<string, string> }).env).toEqual({ KEEP: 'yes' })
  expect(env.writes).toEqual([])
})

test('while the account is unconfirmed, a child claude is refused and nothing else is', driver, async ($, on) => {
  lockedOut(on)
  environment(on, { ANTHROPIC_CUSTOM_HEADERS: oauthHeaders(undefined, 'fixture-unconfirmed') })
  let runs = 0, spawns = 0
  const commands: string[] = []
  on('process.run', () => { runs += 1; return result() })
  on('process.spawn', async function* () { spawns += 1; return { value: { code: 0, signal: null } } })
  on('tool.call', { tool: 'Bash' }, (_host, input) => {
    commands.push(input.command)
    return { result: { stdout: 'fixture', stderr: '', interrupted: false, isImage: false } }
  })
  for (const probe of ['claude-run', 'claude-shell', 'claude-spawn']) expect((await $.command.run(fixtureCommand(probe))).text ?? '', probe).toContain('session account is not confirmed')
  expect([runs, spawns]).toEqual([0, 0])
  expect((await $.command.run(fixtureCommand('plain-run'))).text).toBe('started')
  expect((await $.command.run(fixtureCommand('plain-spawn'))).text).toBe('started')
  expect([runs, spawns]).toEqual([1, 1])
  const refused = await $.tool.call({ tool: 'Bash', command: 'cd /fixture && claude -p owned' })
  expect(JSON.stringify(refused)).toContain('session account is not confirmed')
  await $.tool.call({ tool: 'Bash', command: 'printf allowed' })
  expect(commands).toEqual(['printf allowed'])
})

test('a damaged stored lockout refuses a child claude and passes other children', driver, async ($, on) => {
  on('state.get', { plugin: 'rice-session-accounts', key: 'problem' }, () => ({ value: { value: 42, version: 1 } }))
  environment(on, {})
  let runs = 0
  on('process.run', () => { runs += 1; return result() })
  expect((await $.command.run(fixtureCommand('claude-run'))).text ?? '').toContain('not confirmed')
  expect(runs).toBe(0)
  expect((await $.command.run(fixtureCommand('plain-run'))).text).toBe('started')
  expect(runs).toBe(1)
})

test('claude is found after shell keywords, eval, redirections, quoting and env -S', async () => {
  for (const command of [
    'if claude -p x; then echo ok; fi', 'while true; do claude -p x; done', '! claude -p x', 'eval claude -p x', 'eval "claude -p x"',
    '>out.txt claude -p x', '2>&1 claude -p x', '> out.txt claude -p x', 'exec -a worker claude -p x', 'c\\laude -p x', '"claude" -p x',
    '"/opt/My Tools/claude" -p x', "'/opt/My Tools/claude.exe' -p x", 'env -S "claude -p x"', 'env --split-string="claude -p x"',
    'npx @anthropic-ai/claude-code -p x', 'claude.ps1 -p x', 'cmd /c call claude -p x', '~/.local/share/claude/versions/2.1.302 -p x',
  ]) expect(commandInvokesClaude(command), command).toBe(true)
  for (const command of ['echo "run claude later"', "printf 'claude;claude'", 'echo claude | cat', 'git log --grep=claude', 'cat "My Tools/claude notes.txt"', 'ls .claude', 'x=claude; echo $x']) {
    expect(commandInvokesClaude(command), command).toBe(false)
  }
})

test('argument vectors reach claude through env -S and a shell -c', async () => {
  expect(argvInvokesClaude(['env', '-S', 'claude -p x'])).toBe(true)
  expect(argvInvokesClaude(['/bin/sh', '-c', 'eval "claude -p x"'])).toBe(true)
  expect(argvInvokesClaude(['/usr/bin/env', 'FOO=1', '/opt/tools/claude', '-p'])).toBe(true)
  expect(argvInvokesClaude(['git', 'status'])).toBe(false)
})
