import type { CommandRunInput, On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

function environment(on: On, values: Record<string, string>): Map<string, string> {
  const variables = new Map(Object.entries(values))
  on('env.get', (_host, input) => ({ value: variables.get(input.name) }))
  on('env.set', (_host, input) => {
    if (input.value === undefined) variables.delete(input.name)
    else variables.set(input.name, input.value)
    return { value: undefined }
  })
  return variables
}

function fixtureCommand(args = ''): CommandRunInput {
  return { command: 'descendant-fixture', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } }
}

// The test Engine exposes events. This owned inline plugin supplies the real
// operation nouns, with its static calls scanned as native modules are.
const driver = { plugins: [{ name: 'descendant-driver', register(on: On) {
  on('command.run', { command: 'descendant-fixture' }, async ($, e) => {
    if (e.args === 'read-error') {
      try { await $.process.run(['fixture-program']); return { text: 'unexpected child execution' } }
      catch (error) { return { text: error instanceof Error ? error.message : 'operation failed' } }
    }
    if (e.args === 'explicit') await $.process.run(['fixture-program'], { env: { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-child-choice' } })
    else if (e.args === 'empty') await $.process.run(['fixture-program'], { env: { KEEP: 'yes' } })
    else if (e.args === 'spawn') {
      const output: string[] = []
      for await (const chunk of $.process.spawn({ argv: ['fixture-program'], cwd: '/fixture', input: 'input', env: { KEEP: 'yes' } })) output.push(chunk.text)
      return { text: JSON.stringify(output) }
    } else await $.process.run(['fixture-program', 'argument'], { cwd: '/fixture', stdin: 'input', timeoutMs: 1234, env: { KEEP: 'yes' } })
    return { text: 'done' }
  })
} }] }

test('process.run inherits selected OAuth after native filtering and preserves explicit caller options', driver, async ($, on) => {
  environment(on, { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-selected-oauth' })
  const inputs: unknown[] = []
  on('process.run', (_host, input) => {
    inputs.push(input)
    return { value: { exitCode: 0, stdout: 'fixture', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.command.run(fixtureCommand())
  expect(inputs).toEqual([{ argv: ['fixture-program', 'argument'], init: { cwd: '/fixture', stdin: 'input', timeoutMs: 1234, env: { KEEP: 'yes', CLAUDE_CODE_OAUTH_TOKEN: 'fixture-selected-oauth' } } }])
})

test('a failed authentication read refuses the child before its executable is reached', driver, async ($, on) => {
  let executions = 0
  on('env.get', () => { throw new Error('injected environment read failure') })
  on('process.run', () => {
    executions += 1
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const returned = await $.command.run(fixtureCommand('read-error'))
  expect(returned.text ?? '').toContain('Account authentication could not be prepared')
  expect(executions).toBe(0)
})

test('an explicit child OAuth override takes precedence over its parent session', driver, async ($, on) => {
  environment(on, { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-selected-oauth' })
  let env: unknown
  on('process.run', (_host, input) => {
    env = input.init?.env
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.command.run(fixtureCommand('explicit'))
  expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'fixture-child-choice' })
})

test('streamed children inherit selected OAuth and keep their input and environment', driver, async ($, on) => {
  environment(on, { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-selected-oauth' })
  let seen: unknown
  on('process.spawn', async function* (_host, input) {
    seen = input
    yield { stream: 'stdout', text: 'fixture-stream' }
    return { value: { code: 0, signal: null } }
  })
  const returned = await $.command.run(fixtureCommand('spawn'))
  expect(JSON.parse(returned.text ?? '[]')).toEqual(['fixture-stream'])
  expect(seen).toEqual({ argv: ['fixture-program'], cwd: '/fixture', input: 'input', env: { KEEP: 'yes', CLAUDE_CODE_OAUTH_TOKEN: 'fixture-selected-oauth' } })
})

test('Bash receives only a static environment reference and keeps the original command intact', async ($, on) => {
  const env = environment(on, { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-selected-oauth' })
  let command = ''
  on('tool.call', { tool: 'Bash' }, (_host, input) => {
    command = input.command
    return { result: { stdout: 'fixture', stderr: '', interrupted: false, isImage: false } }
  })
  await $.tool.call({ tool: 'Bash', command: 'printf fixture; exit 7' })
  expect(command).toBe('export CLAUDE_CODE_OAUTH_TOKEN="${RICE_SESSION_ACCOUNTS_OAUTH_RELAY-}"; unset RICE_SESSION_ACCOUNTS_OAUTH_RELAY;\nprintf fixture; exit 7')
  expect(command.includes('fixture-selected-oauth')).toBe(false)
  expect(env.get('RICE_SESSION_ACCOUNTS_OAUTH_RELAY')).toBe('fixture-selected-oauth')
})

test('returning to an account without an environment OAuth token leaves child inputs unchanged', driver, async ($, on) => {
  environment(on, {})
  let init: unknown
  let command = ''
  on('process.run', (_host, input) => {
    init = input.init
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'Bash' }, (_host, input) => {
    command = input.command
    return { result: { stdout: '', stderr: '', interrupted: false, isImage: false } }
  })
  await $.command.run(fixtureCommand('empty'))
  await $.tool.call({ tool: 'Bash', command: 'printf baseline' })
  expect(init).toEqual({ env: { KEEP: 'yes' } })
  expect(command).toBe('printf baseline')
})
